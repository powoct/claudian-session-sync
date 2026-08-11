/**
 * The three ways out of a conflict (architecture §8.1) — S-04c.
 *
 * Detection without resolution would leave the plugin able to notice a problem
 * and unable to end it, so M1 ships all three. What they share is the rule that
 * makes them safe to offer at all: **neither branch is destroyed.** The
 * abandoned version stays in quarantine, and the side being overwritten is
 * backed up first, exactly as any other overwrite is.
 *
 * Nothing in the quarantine directory is trusted to say which branch is
 * whose. The directory is shared between machines and its copies are named by
 * content hash; "this machine's version" is decided here, at read time, by
 * hashing the live files. The alternative — believing a `local-`/`remote-`
 * label frozen at detection — is wrong on the other machine from the start
 * (the labels swap), and wrong on this one as soon as anything appends to the
 * session, which is exactly what locked resolution on the second machine
 * during the M1 acceptance run.
 *
 * Resolution therefore verifies one thing: the side the user chose to KEEP
 * must currently hold one of the quarantined branches — the version whose
 * line counts and sizes they were just shown. The side being overwritten may
 * hold anything at all; whatever it holds is backed up before it goes.
 */
import { shortHash } from "../domain/conflict";
import type { ConflictResolution } from "../domain/conflict";
import { resolutionAction } from "../domain/conflict";
import type { LogicalId } from "../domain/types";
import type { FsGateway } from "../infra/fs-gateway";
import { readJson } from "../infra/json-file";
import type { BackupRequest } from "../infra/backup-writer";
import type { MintOutcome } from "./sync-engine";

export const QUARANTINE_DIR = ".quarantine";

export interface ConflictBranchView {
  /** Full hash as `hashBytes` renders it; compared, never displayed. */
  readonly hash: string;
  readonly hashPrefix: string;
  readonly size: number;
  readonly lineCount: number;
  readonly copyName: string;
  /** The session file on this machine currently holds exactly these bytes. */
  readonly onThisMachine: boolean;
  /** The sync folder's copy currently holds exactly these bytes. */
  readonly inSyncFolder: boolean;
}

export interface ConflictEntry {
  readonly conflictId: string;
  readonly providerId: string;
  readonly logicalId: string;
  readonly logicalIdPrefix: string;
  readonly detectedAt: string;
  /** Absolute path of the quarantine directory, for `reveal`. */
  readonly directory: string;
  /**
   * The path in dispute. From the meta file when it recorded one (schema 3),
   * otherwise rebuilt from the id — which is only correct for a flat provider,
   * and is exactly why schema 3 records it.
   */
  readonly neutralRel: string;
  /** Ordered by hash, like the copy files. */
  readonly branches: readonly ConflictBranchView[];
  /**
   * Neither live side matches any branch — the disagreement this directory
   * froze is over (resolved, or superseded by a fresh pair the next pass will
   * quarantine under its own id). Kept listable for `reveal`; the keep
   * buttons cannot act on it.
   */
  readonly superseded: boolean;
}

export interface ConflictCommandDeps {
  readonly fs: FsGateway;
  readonly joinPath: (...parts: string[]) => string;
  readonly workspaceId: string;
  readonly replicaRoot: string;
  /** Where a neutral-relative path lands on this machine, per provider. */
  readonly localPathFor: (providerId: string, neutralRel: string) => Promise<string | null>;
  /**
   * The same validator the engine writes through.
   *
   * Shared on purpose: a resolution is an overwrite of a session file, so it
   * gets the same containment walk and the same branded type. A second,
   * "simpler" write path here would be a second place for a traversal to land.
   */
  readonly mintWritePath: (target: string) => Promise<MintOutcome>;
  readonly backup: (request: BackupRequest) => Promise<{ readonly path: string | null }>;
  readonly hashBytes: (bytes: Uint8Array) => string;
  /** False unless the remote is READY; keeping local writes to the sync dir. */
  readonly mayWriteRemote: () => boolean;
}

export type ResolveOutcome =
  | {
      readonly ok: true;
      readonly action: "PUSH_OVERWRITE" | "PULL_OVERWRITE";
      readonly backupPath: string | null;
      /** What the pass calls this file — so the caller can settle its books. */
      readonly neutralRel: string;
    }
  | { readonly ok: true; readonly action: "REVEAL"; readonly directory: string }
  | { readonly ok: false; readonly reason: ResolveFailure };

export type ResolveFailure =
  | "unknown-conflict"
  /** The side being kept holds none of the quarantined branches any more. */
  | "branch-moved"
  /**
   * The side being kept could not be read at all just now. Distinct from
   * `branch-moved` on purpose: during the acceptance re-run, transient reads
   * against files the sync tool was busy with made resolutions fail while
   * every message claimed a *state* problem — and a user told "the state
   * changed" retries differently from one told "a file was briefly locked".
   */
  | "kept-unreadable"
  | "remote-not-ready"
  | "backup-failed"
  | "path-rejected"
  | "write-failed";

/** Everything currently quarantined for this workspace, newest first. */
export async function listConflicts(deps: ConflictCommandDeps): Promise<ConflictEntry[]> {
  const base = deps.joinPath(deps.replicaRoot, QUARANTINE_DIR, deps.workspaceId);
  const providers = await deps.fs.readDir(base).catch(() => []);
  const found: ConflictEntry[] = [];

  for (const provider of providers) {
    if (!provider.isDirectory) continue;
    const providerDir = deps.joinPath(base, provider.name);
    for (const entry of await deps.fs.readDir(providerDir).catch(() => [])) {
      if (!entry.isDirectory) continue;
      const directory = deps.joinPath(providerDir, entry.name);
      const parsed = await readEntry(deps, directory, provider.name, entry.name);
      if (parsed) found.push(parsed);
    }
  }
  return found.sort((a, b) => (a.detectedAt < b.detectedAt ? 1 : -1));
}

/**
 * Applies one resolution.
 *
 * `reveal` writes nothing at all — it exists because "let me look at both and
 * decide myself" is a legitimate answer, and a plugin that only offers two
 * irreversible-looking buttons pushes people into guessing.
 */
export async function resolveConflict(
  deps: ConflictCommandDeps,
  conflictId: string,
  resolution: ConflictResolution,
): Promise<ResolveOutcome> {
  // Listed twice before giving up: the quarantine directory lives in the sync
  // folder, and the sync tool takes short exclusive locks on files it is
  // hashing or uploading. A directory that listed fine when the dialog was
  // drawn can be unreadable for the split second the click lands on — seen on
  // the real-machine re-run, where that split second turned into "already
  // resolved" and a resolution that silently did nothing.
  let entry = (await listConflicts(deps)).find((c) => c.conflictId === conflictId);
  entry ??= (await listConflicts(deps)).find((c) => c.conflictId === conflictId);
  if (!entry) return { ok: false, reason: "unknown-conflict" };

  const action = resolutionAction(resolution);
  if (action === null) return { ok: true, action: "REVEAL", directory: entry.directory };

  const keepingLocal = resolution === "keep-local";
  // Keeping local means writing into the sync directory, and that is only
  // allowed when the remote is READY — a half-hydrated directory is the one
  // place a push does real damage (§9.6.3).
  if (keepingLocal && !deps.mayWriteRemote()) return { ok: false, reason: "remote-not-ready" };

  const neutralRel = entry.neutralRel;
  const remotePath = deps.joinPath(deps.replicaRoot, deps.workspaceId, neutralRel);
  const localPath = await deps.localPathFor(entry.providerId, neutralRel);
  if (localPath === null) return { ok: false, reason: "path-rejected" };

  // The kept side must currently hold one of the quarantined branches — the
  // version the dialog just described. Deliberately nothing is checked about
  // the side being overwritten: it may have moved on (a third-party writer
  // appending to the losing branch was observed doing exactly this), and
  // whatever it holds now is backed up below before it is replaced.
  const keptPath = keepingLocal ? localPath : remotePath;
  const kept = await deps.fs.readFile(keptPath).catch(() => null);
  // Unreadable is not "moved". A file the sync tool is mid-transfer on reads
  // as absent for a moment; calling that a state change sends the user off to
  // re-sync when what they need is to try again in a few seconds.
  if (kept === null) return { ok: false, reason: "kept-unreadable" };
  const keptHash = deps.hashBytes(kept);
  const chosen = entry.branches.find((branch) => branch.hash === keptHash);
  if (!chosen) return { ok: false, reason: "branch-moved" };

  const targetPath = keepingLocal ? remotePath : localPath;
  const minted = await deps.mintWritePath(targetPath);
  if (!minted.ok) return { ok: false, reason: "path-rejected" };

  const backup = await deps.backup({
    sourcePath: targetPath,
    workspaceId: deps.workspaceId,
    providerId: entry.providerId,
    logicalId: entry.logicalId as LogicalId,
    remote: keepingLocal,
    action,
  });
  // Same rule as every other overwrite: no backup, no overwrite (§9.3.3).
  // Resolution is a user's deliberate choice, which makes it *more* worth
  // backing up, not less — they are choosing between two branches, and the one
  // they discard has to remain reachable if they change their mind.
  if (backup.path === null) return { ok: false, reason: "backup-failed" };

  try {
    await deps.fs.writeFileAtomic(minted.value, kept);
  } catch {
    return { ok: false, reason: "write-failed" };
  }

  return { ok: true, action, backupPath: backup.path, neutralRel };
}

/**
 * One quarantine directory → one entry, from its contents alone.
 *
 * Copies are identified by hashing what they hold, not by parsing their
 * names — which also swallows the two legacy shapes a pre-fix directory can
 * be in: viewpoint-named copies (`local-*`/`remote-*`), and *four* of them
 * when both machines wrote their own pair. Duplicate contents collapse to one
 * branch either way.
 */
async function readEntry(
  deps: ConflictCommandDeps,
  directory: string,
  providerId: string,
  conflictId: string,
): Promise<ConflictEntry | null> {
  const load = await readJson(deps.fs, deps.joinPath(directory, "meta.json"));
  if (load.status !== "loaded") return null;
  const meta = load.raw as Record<string, unknown>;
  const logicalId = typeof meta.logicalId === "string" ? meta.logicalId : null;
  if (logicalId === null || typeof meta.conflictId !== "string") return null;
  const detectedAt = typeof meta.detectedAt === "string" ? meta.detectedAt : "";
  // Schema 3 records the path; schema 2 did not, and rebuilding it is only
  // right for a flat provider whose file name is its id. Reading the recorded
  // one first means a directory written by a newer version stays resolvable
  // whatever shape its provider has (§8.1).
  const recordedRel = typeof meta.neutralRel === "string" ? meta.neutralRel : null;

  const byHash = new Map<string, { size: number; lineCount: number; copyName: string }>();
  for (const file of await deps.fs.readDir(directory).catch(() => [])) {
    if (!file.isFile || file.name === "meta.json") continue;
    const bytes = await deps.fs.readFile(deps.joinPath(directory, file.name)).catch(() => null);
    if (bytes === null) continue;
    const hash = deps.hashBytes(bytes);
    if (!byHash.has(hash)) {
      byHash.set(hash, { size: bytes.length, lineCount: countLines(bytes), copyName: file.name });
    }
  }
  if (byHash.size < 2) return null; // Half-transported or tampered; not resolvable.

  const extension = extensionOf([...byHash.values()][0]?.copyName ?? "");
  const neutralRel = recordedRel ?? `${providerId}/${logicalId}${extension}`;
  const localPath = await deps.localPathFor(providerId, neutralRel);
  const localHash = await hashOf(deps, localPath);
  const remoteHash = await hashOf(
    deps,
    deps.joinPath(deps.replicaRoot, deps.workspaceId, neutralRel),
  );

  const branches = [...byHash.entries()]
    .map(
      ([hash, copy]): ConflictBranchView => ({
        hash,
        hashPrefix: shortHash(hash),
        size: copy.size,
        lineCount: copy.lineCount,
        copyName: copy.copyName,
        onThisMachine: hash === localHash,
        inSyncFolder: hash === remoteHash,
      }),
    )
    .sort((a, b) => (a.hashPrefix < b.hashPrefix ? -1 : 1));

  return {
    conflictId,
    providerId,
    logicalId,
    logicalIdPrefix: logicalId.slice(0, 8),
    detectedAt,
    directory,
    neutralRel,
    branches,
    superseded: !branches.some((branch) => branch.onThisMachine || branch.inSyncFolder),
  };
}

async function hashOf(deps: ConflictCommandDeps, target: string | null): Promise<string | null> {
  if (target === null) return null;
  const bytes = await deps.fs.readFile(target).catch(() => null);
  return bytes === null ? null : deps.hashBytes(bytes);
}

/** Newline bytes only — the same rule the engine's counts and meta use. */
function countLines(bytes: Uint8Array): number {
  let lines = 0;
  for (const byte of bytes) if (byte === 0x0a) lines += 1;
  return lines;
}

function extensionOf(copyName: string): string {
  const dot = copyName.indexOf(".");
  return dot === -1 ? "" : copyName.slice(dot);
}
