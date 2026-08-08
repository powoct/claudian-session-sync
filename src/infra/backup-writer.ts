/**
 * Putting backups on disk (architecture §9.3) — the I/O half of `backup-store`.
 *
 * The pure module decides names and which versions may be dropped; this one
 * reads and writes. Keeping them apart matters most for rotation, which is the
 * only place this plugin deletes bytes on purpose: the rule that a surplus
 * version may only go once a survivor can reproduce it is worth being able to
 * test without a filesystem, and the reading needed to *answer* that question
 * is worth being able to test with one.
 *
 * Two directions that are easy to get backwards under pressure:
 *
 *  - a backup that cannot be written **cancels the overwrite** (§9.3.3). An
 *    overwrite with no way back is the case I1 exists to forbid;
 *  - a rotation that fails **changes nothing**. The way back already exists;
 *    failing to tidy up is untidy, not dangerous.
 */
import type { LogicalId, SafeAbsolutePath } from "../domain/types";
import type { FsGateway } from "./fs-gateway";
import {
  type BackupRecord,
  type RotationCandidate,
  backupDirFor,
  backupStamp,
  indexLine,
  nextBackupName,
  planRotation,
} from "./backup-store";
import type { HomeStore } from "./home-store";

/** Backups hold conversation content; the directory is no more open than 0700. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export interface BackupWriterDeps {
  readonly fs: FsGateway;
  readonly home: HomeStore;
  readonly joinPath: (...parts: string[]) => string;
  readonly hashBytes: (bytes: Uint8Array) => string;
  readonly nowMs: () => number;
  readonly randomSuffix: () => string;
  readonly keep: number;
}

export interface BackupRequest {
  readonly sourcePath: string;
  readonly workspaceId: string;
  readonly providerId: string;
  readonly logicalId: LogicalId;
  /** True when preserving the *remote* version a PUSH_OVERWRITE will destroy. */
  readonly remote: boolean;
  readonly action: string;
}

export interface BackupOutcome {
  /** Absolute path of the copy, or null — which cancels the overwrite. */
  readonly path: string | null;
  /** Set when rotation kept more than `keep` because I1 would have been broken. */
  readonly rotationDeferred?: boolean;
  readonly reason?: string;
}

export function createBackupWriter(deps: BackupWriterDeps) {
  return {
    /**
     * Copies the version about to be destroyed, then rotates.
     *
     * The copy is read into memory rather than streamed through `copyFile`
     * because the same bytes answer the rotation question — whether an older
     * backup is still reproducible — and reading the file twice to avoid
     * holding a session in memory would be a poor trade at these sizes
     * (`maxFileSizeMB` caps it).
     */
    async backup(request: BackupRequest): Promise<BackupOutcome> {
      const bytes = await readOrNull(deps.fs, request.sourcePath);
      if (bytes === null) {
        // Nothing there to preserve. Not an error in itself — but the caller
        // asked to back up something it believed existed, so it gets a null
        // and cancels rather than deciding for itself that it was fine.
        return { path: null, reason: "source-unreadable" };
      }

      const relDir = backupDirFor({
        workspaceId: request.workspaceId,
        providerId: request.providerId,
        remote: request.remote,
      });
      const dirPath = deps.joinPath(deps.home.layout.backupsDir, ...relDir);
      const dir = deps.home.mint(dirPath);
      if (!dir.ok) return { path: null, reason: `backup-dir-rejected:${dir.violation}` };
      await deps.fs.mkdirp(dir.value, DIR_MODE);

      const originalName = baseNameOf(request.sourcePath);
      const existing = new Set(
        (await deps.fs.readDir(dirPath).catch(() => [])).map((entry) => entry.name),
      );
      const name = nextBackupName(
        originalName,
        backupStamp(deps.nowMs()),
        existing,
        deps.randomSuffix,
      );
      if (name === null) return { path: null, reason: "no-free-backup-name" };

      const target = deps.home.mint(deps.joinPath(dirPath, name));
      if (!target.ok) return { path: null, reason: `backup-path-rejected:${target.violation}` };

      // Exclusive: a name we believed free being taken means something else is
      // writing here, and writing through it would destroy a backup to make a
      // backup.
      const written = await deps.fs.writeFileNoReplace(target.value, bytes, { mode: FILE_MODE });
      if (!written.ok) return { path: null, reason: `backup-write-failed:${written.reason}` };

      await appendIndex(deps, dir.value, dirPath, {
        name,
        logicalId: request.logicalId,
        createdAtMs: deps.nowMs(),
        sizeBytes: bytes.length,
        lineCount: countLines(bytes),
        hashPrefix: hashPrefixOf(deps.hashBytes(bytes)),
        action: request.action,
      });

      const rotation = await rotate(deps, dirPath, originalName, bytes);
      return { path: target.value, ...(rotation.deferred ? { rotationDeferred: true } : {}) };
    },
  };
}

/**
 * Deletes surplus backups that a survivor can still reproduce.
 *
 * `newest` is the copy just written, which is also the longest version this
 * file has ever had if the session is append-only — so it is the survivor
 * everything else is checked against. A surplus version that is *not* a prefix
 * of it is a branch that exists nowhere else, and `keep = 3` deleting it would
 * make the retention setting itself a data-loss path (§9.3.3).
 */
async function rotate(
  deps: BackupWriterDeps,
  dirPath: string,
  originalName: string,
  newest: Uint8Array,
): Promise<{ deferred: boolean }> {
  const entries = await deps.fs.readDir(dirPath).catch(() => []);
  const mine = entries.filter(
    (entry) => entry.isFile && entry.name.startsWith(`${originalName}.`) && entry.name.endsWith(".bak"),
  );

  const candidates: RotationCandidate[] = [];
  for (const entry of mine) {
    const full = deps.joinPath(dirPath, entry.name);
    const st = await deps.fs.lstat(full);
    if (st === null) continue;
    const bytes = await readOrNull(deps.fs, full);
    candidates.push({
      name: entry.name,
      createdAtMs: st.mtimeMs,
      // Unreadable means we cannot prove it is reproducible, and "cannot
      // prove" must read as "keep" — the alternative deletes on ignorance.
      recoverableFromSurvivor: bytes !== null && isReproducible(bytes, newest),
    });
  }

  const plan = planRotation(candidates, deps.keep);
  for (const name of plan.deleteNames) {
    const target = deps.home.mint(deps.joinPath(dirPath, name));
    if (!target.ok) continue;
    // Rotation failure is not fatal: the way back already exists.
    await deps.fs.removeFile(target.value).catch(() => undefined);
  }
  return { deferred: plan.deferred };
}

/**
 * Can `older` be reconstructed from `survivor`? Only if its bytes are a prefix.
 *
 * Deliberately *not* `comparePrefix`. That function answers the merge
 * question, where a prefix ending mid-record is disqualifying because the next
 * machine would append to an unfinished line. Here the question is simply "are
 * these bytes still retrievable", and a version that stops mid-record is
 * retrievable from a longer one that starts with it — refusing to count it
 * would keep backups forever for a reason that does not apply.
 */
function isReproducible(older: Uint8Array, survivor: Uint8Array): boolean {
  if (older.length > survivor.length) return false;
  for (let i = 0; i < older.length; i++) if (older[i] !== survivor[i]) return false;
  return true;
}

/**
 * Appends one line to the human-facing index.
 *
 * Best-effort by design: the index is a convenience for someone digging
 * through the backup directory, and recovery never consults it. A failure here
 * must not turn a successful backup into a cancelled overwrite.
 */
async function appendIndex(
  deps: BackupWriterDeps,
  dir: SafeAbsolutePath,
  dirPath: string,
  record: BackupRecord,
): Promise<void> {
  const target = deps.home.mint(deps.joinPath(dirPath, "index.jsonl"));
  if (!target.ok) return;
  try {
    const existing = await readOrNull(deps.fs, target.value);
    const line = new TextEncoder().encode(`${indexLine(record)}\n`);
    const merged = existing === null ? line : concat(existing, line);
    await deps.fs.mkdirp(dir, DIR_MODE);
    await deps.fs.writeFileAtomic(target.value, merged, { mode: FILE_MODE });
  } catch {
    // Deliberately swallowed; see above.
  }
}

async function readOrNull(fs: FsGateway, target: string): Promise<Uint8Array | null> {
  return fs.readFile(target).catch(() => null);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function baseNameOf(target: string): string {
  const at = Math.max(target.lastIndexOf("/"), target.lastIndexOf("\\"));
  return at === -1 ? target : target.slice(at + 1);
}

function countLines(bytes: Uint8Array): number {
  let count = 0;
  for (const byte of bytes) if (byte === 0x0a) count++;
  return count;
}

function hashPrefixOf(hash: string): string {
  const bare = hash.startsWith("sha256:") ? hash.slice(7) : hash;
  return bare.slice(0, 8);
}
