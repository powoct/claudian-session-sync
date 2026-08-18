/**
 * Getting a version back (architecture §9.3, M3).
 *
 * Invariant I1 says every version this plugin overwrites stays recoverable,
 * and until now that was true only on disk: the backups were there, correct
 * and rotated conservatively, and recovering one meant finding
 * `~/.claudian-session-sync/backups/<ws>/<provider>[/remote]/` and copying a
 * `.bak` file back by hand. A guarantee a user cannot exercise is a guarantee
 * in name only, so this is the read half of §9.3.
 *
 * Three rules shape everything here.
 *
 * **The index is not consulted.** `index.jsonl` is written best-effort
 * (`backup-writer.ts`), so a restore that needed it would be a restore a lost
 * line could block. Every fact a row shows comes from the file's name and its
 * bytes; the index only ever adds the action that produced it, and its absence
 * costs a column rather than a row.
 *
 * **Restoring is an overwrite**, so it obeys the overwrite rules rather than a
 * private version of them: the target's current content is backed up first and
 * no backup means no restore (I1), the write goes through the same path mint
 * as the engine's, and putting a version back into the sync folder requires
 * the same readiness a push does.
 *
 * **Where it goes is found, never guessed.** A backup's name carries only the
 * original's basename, and for a provider that shards by date that is not
 * enough to rebuild a path. So the target is located among files that actually
 * exist; when it cannot be, the command refuses and offers the folder instead.
 * Deriving Codex's date directories from the timestamp inside its file name
 * would be exactly the guess §6.4 declines to make.
 */
import type { FsGateway } from "../infra/fs-gateway";
import type { BackupRequest } from "../infra/backup-writer";
import { QUARANTINE_DIR } from "./conflict-commands";
import { parseBackupName } from "../infra/backup-store";
import type { LogicalId } from "../domain/types";
import type { MintOutcome } from "./sync-engine";
import type { ProviderAdapter } from "../providers/provider-adapter";

/** Only ever compared and displayed as a prefix (§11.1). */
export interface BackupEntry {
  /** Stable handle for the UI to hand back; the absolute path of the copy. */
  readonly path: string;
  readonly name: string;
  readonly providerId: string;
  /** Basename of the file it preserves. */
  readonly originalName: string;
  readonly takenAtMs: number;
  readonly sizeBytes: number;
  readonly lineCount: number;
  readonly hashPrefix: string;
  /** True when it preserves a version that lived in the sync folder. */
  readonly remote: boolean;
  /** From the index when it is readable; "" when it is not. */
  readonly action: string;
  /**
   * Where this would be written back, or null when no such file exists any
   * more on the side it came from. A null is not an error — it is the reason
   * the restore button is not offered for that row.
   */
  readonly neutralRel: string | null;
  /**
   * How the backup's bytes compare with what occupies its own place now.
   * Decides whether there is anything to do and what has to be preserved
   * first — not what the next sync will make of it.
   */
  readonly liveRelation: "identical" | "differs" | "absent" | "unknown";
  /**
   * Hash prefix of what is live in that place, captured while listing.
   *
   * Re-verified immediately before the write: the row described a *change*
   * from these bytes to the backup's, and if the live side moved on since,
   * the user is agreeing to something they were not shown. (The backup file
   * is the immutable half of that pair; this is the volatile one.)
   */
  readonly liveHashPrefix: string | null;
  /**
   * What the next pass will do with the restored bytes — computed against the
   * **other** side, because that is the pair the decision table consults.
   * Comparing with the side being written to would describe a comparison that
   * never happens.
   */
  readonly outcome:
    | "nothing"
    | "will-be-undone"
    | "will-propagate"
    | "will-conflict"
    | "whole-file"
    | "unknown";
}

export type RestoreOutcome =
  | {
      readonly ok: true;
      readonly neutralRel: string;
      /** Null when nothing was there to preserve — see `created`. */
      readonly backupPath: string | null;
      /** True when the file was absent and this put it back rather than over. */
      readonly created: boolean;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "unknown-backup"
        | "backup-unreadable"
        | "backup-changed"
        | "target-not-located"
        | "target-changed"
        | "target-exists"
        | "remote-not-ready"
        | "sync-in-progress"
        | "path-rejected"
        | "backup-failed"
        | "write-failed";
    };

export interface RestoreCommandDeps {
  readonly fs: FsGateway;
  readonly joinPath: (...parts: string[]) => string;
  readonly workspaceId: string;
  readonly replicaRoot: string;
  readonly backupsDir: string;
  readonly providers: ReadonlyArray<{ readonly adapter: ProviderAdapter; readonly root: string }>;
  readonly mintWritePath: (target: string) => Promise<MintOutcome>;
  readonly backup: (request: BackupRequest) => Promise<{ readonly path: string | null }>;
  readonly hashBytes: (bytes: Uint8Array) => string;
  readonly mayWriteRemote: () => boolean;
}

/**
 * How many backups are described in full, newest first.
 *
 * Describing one means reading it — the hash is its identity and the line
 * count is how a user tells two versions apart — and comparing it with both
 * live sides, which is what lets a row say what the next sync will do. That is
 * unavoidable per row and must therefore be bounded per *listing*: an
 * unbounded one reads every backup and both live sides of every session every
 * time the dialog opens, which against the measured workload (a 23 MiB Codex
 * rollout, three backups per direction) is hundreds of megabytes to paint a
 * screen — and on a cloud drive with on-demand files, reads that hydrate the
 * whole replica side as a side effect.
 *
 * Names carry their own timestamp, so the newest can be chosen before anything
 * is opened. Nothing is hidden by this: the dialog shows a bounded page and
 * says how many older ones remain in the folder.
 */
export const DEFAULT_LIST_LIMIT = 60;

/**
 * Every backup this workspace holds, newest first.
 *
 * Walks `backups/<workspaceId>/<provider>[/remote]`, which is the layout
 * `backupDirFor` writes — and only providers that are enabled right now, since
 * a disabled provider has no adapter to locate targets with and offering a
 * restore that cannot be performed is worse than not listing it.
 */
export async function listBackups(
  deps: RestoreCommandDeps,
  options: { readonly limit?: number; readonly only?: string } = {},
): Promise<BackupEntry[]> {
  const limit = options.limit ?? DEFAULT_LIST_LIMIT;
  const entries: BackupEntry[] = [];

  // Pass one: names only. Cheap enough to do over the whole history, which is
  // what makes "newest first" true of the history rather than of whatever
  // happened to be read first.
  const candidates: Array<{
    provider: RestoreCommandDeps["providers"][number];
    remote: boolean;
    dir: string;
    name: string;
    path: string;
    parsed: NonNullable<ReturnType<typeof parseBackupName>>;
  }> = [];
  for (const provider of deps.providers) {
    for (const remote of [false, true]) {
      const dir = remote
        ? deps.joinPath(deps.backupsDir, deps.workspaceId, provider.adapter.id, "remote")
        : deps.joinPath(deps.backupsDir, deps.workspaceId, provider.adapter.id);
      for (const item of await deps.fs.readDir(dir).catch(() => [])) {
        if (!item.isFile) continue;
        const parsed = parseBackupName(item.name);
        if (parsed === null) continue;
        const path = deps.joinPath(dir, item.name);
        if (options.only !== undefined && options.only !== path) continue;
        candidates.push({ provider, remote, dir, name: item.name, path, parsed });
      }
    }
  }
  candidates.sort((a, b) => b.parsed.takenAtMs - a.parsed.takenAtMs);

  // Pass two: read only what will be described. Both caches are per listing —
  // rows of one session share its live sides, and one directory's index is
  // read once however many of its rows survive the cut.
  const sidesByRel = new Map<string, { local: Uint8Array | null; remote: Uint8Array | null }>();
  const actionsByDir = new Map<string, Map<string, string>>();
  const locators = new Map<string, (originalName: string) => string | null>();

  for (const candidate of candidates.slice(0, limit)) {
    const { provider, remote, dir, name, path, parsed } = candidate;
    let actions = actionsByDir.get(dir);
    if (!actions) {
      actions = await readActions(deps, dir);
      actionsByDir.set(dir, actions);
    }
    let located = locators.get(provider.adapter.id);
    if (!located) {
      located = await locator(deps, provider);
      locators.set(provider.adapter.id, located);
    }

    const bytes = await deps.fs.readFile(path).catch(() => null);
    if (bytes === null) continue;

    const neutralRel = located(parsed.originalName);
    const sidesKey = `${provider.adapter.id}\u0000${neutralRel ?? ""}`;
    let sides = sidesByRel.get(sidesKey);
    if (!sides) {
      sides = await readSides(deps, provider, neutralRel);
      sidesByRel.set(sidesKey, sides);
    }
    const own = remote ? sides.remote : sides.local;
    const other = remote ? sides.local : sides.remote;
    entries.push({
      path,
      name,
      providerId: provider.adapter.id,
      originalName: parsed.originalName,
      takenAtMs: parsed.takenAtMs,
      sizeBytes: bytes.length,
      lineCount: countLines(bytes),
      hashPrefix: shortHash(deps.hashBytes(bytes)),
      remote,
      action: actions.get(name) ?? "",
      neutralRel,
      liveRelation:
        neutralRel === null
          ? "unknown"
          : own === null
            ? "absent"
            : deps.hashBytes(own) === deps.hashBytes(bytes)
              ? "identical"
              : "differs",
      liveHashPrefix: own === null ? null : shortHash(deps.hashBytes(own)),
      outcome: predict(deps, bytes, other, neutralRel, provider),
    });
  }

  // Already newest-first from the candidate sort, which ran over the whole
  // history rather than over the page.
  return entries;
}

/** How many backups exist in total, for the "and N older ones" line. */
export async function countBackups(deps: RestoreCommandDeps): Promise<number> {
  let total = 0;
  for (const provider of deps.providers) {
    for (const remote of [false, true]) {
      const dir = remote
        ? deps.joinPath(deps.backupsDir, deps.workspaceId, provider.adapter.id, "remote")
        : deps.joinPath(deps.backupsDir, deps.workspaceId, provider.adapter.id);
      for (const item of await deps.fs.readDir(dir).catch(() => [])) {
        if (item.isFile && parseBackupName(item.name) !== null) total += 1;
      }
    }
  }
  return total;
}

export async function restoreBackup(
  deps: RestoreCommandDeps,
  backupPath: string,
  expectedHashPrefix: string,
  /**
   * What the row said was live in that place — `null` for "nothing was".
   *
   * Passed in rather than recomputed, and that distinction is the whole
   * guard: re-deriving it here would compare the present with the present and
   * agree every time. What has to be checked is that the world still matches
   * what the user was *shown* when they decided.
   */
  expectedLiveHashPrefix: string | null,
): Promise<RestoreOutcome> {
  // Re-listed rather than trusted: the row was drawn at some earlier moment,
  // and everything about it — where the file belongs, whether it is still
  // there — is a claim about now.
  // Re-described rather than trusted — the row is a claim about an earlier
  // moment — but scoped to this one backup: re-reading the whole history to
  // answer a question about one file is what made the dialog expensive.
  const entry = (await listBackups(deps, { only: backupPath, limit: 1 }))[0];
  if (!entry) return { ok: false, reason: "unknown-backup" };
  if (entry.neutralRel === null) return { ok: false, reason: "target-not-located" };
  if (entry.remote && !deps.mayWriteRemote()) return { ok: false, reason: "remote-not-ready" };

  // Read once, before anything else touches the directory: rotation is asked
  // to spare this file below, but bytes already in hand cannot be rotated away
  // by any path at all.
  const bytes = await deps.fs.readFile(backupPath).catch(() => null);
  if (bytes === null) return { ok: false, reason: "backup-unreadable" };
  // The dialog described a specific version. If these are no longer those
  // bytes, the user is agreeing to something other than what they read.
  if (shortHash(deps.hashBytes(bytes)) !== expectedHashPrefix) {
    return { ok: false, reason: "backup-changed" };
  }

  const provider = deps.providers.find((p) => p.adapter.id === entry.providerId);
  if (!provider) return { ok: false, reason: "target-not-located" };
  const targetPath = entry.remote
    ? deps.joinPath(deps.replicaRoot, deps.workspaceId, entry.neutralRel)
    : await provider.adapter.targetPathFor(entry.neutralRel);

  const minted = await deps.mintWritePath(targetPath);
  if (!minted.ok) return { ok: false, reason: "path-rejected" };

  // The other half of the staleness check. The row promised a change *from*
  // specific live bytes, and those are the volatile half of the pair — the
  // backup cannot move, the session can. A file that changed since the list
  // was drawn means the sentence the user read no longer describes what this
  // would do.
  const before = await deps.fs.readFile(targetPath).catch(() => null);
  if (livePrefix(deps, before) !== expectedLiveHashPrefix) {
    return { ok: false, reason: "target-changed" };
  }

  if (before === null) {
    // Nothing there to preserve, so I1 is not implicated: this is a creation,
    // not an overwrite, and it commits with no-replace so a pass that lands
    // the session first wins rather than being silently clobbered.
    const written = await deps.fs.writeFileNoReplace(minted.value, bytes).catch(() => null);
    if (written === null) return { ok: false, reason: "write-failed" };
    if (!written.ok) {
      return { ok: false, reason: written.reason === "target-exists" ? "target-exists" : "write-failed" };
    }
    return { ok: true, neutralRel: entry.neutralRel, backupPath: null, created: true };
  }

  // I1 applies to the restore itself: whatever is there now is a version this
  // command is about to destroy, and a user who restores the wrong row must be
  // able to undo that too.
  const saved = await deps.backup({
    sourcePath: targetPath,
    workspaceId: deps.workspaceId,
    providerId: entry.providerId,
    // Derived, never the file name: `logicalId` is a typed slot and the
    // basename is not one for every provider (Codex's carries a timestamp).
    logicalId: (provider.adapter.classifyNeutral(entry.neutralRel)?.logicalId ??
      entry.originalName) as LogicalId,
    remote: entry.remote,
    action: "RESTORE",
    // Rotation would otherwise find this very file reproducible from the copy
    // just taken (which is longer, by construction) and delete the row the
    // user clicked.
    protectName: entry.name,
  });
  if (saved.path === null) return { ok: false, reason: "backup-failed" };

  // Verified overwrite, as §9.2 requires of every other overwrite in the
  // system: the backup above and the write below are two operations, and a
  // CLI mid-turn can append between them. Those appends would be in no backup
  // and in no restored version — the one way this command could destroy bytes
  // that exist nowhere else.
  const still = await deps.fs.readFile(targetPath).catch(() => null);
  if (livePrefix(deps, still) !== expectedLiveHashPrefix) {
    return { ok: false, reason: "target-changed" };
  }

  try {
    await deps.fs.writeFileAtomic(minted.value, bytes);
  } catch {
    return { ok: false, reason: "write-failed" };
  }
  return { ok: true, neutralRel: entry.neutralRel, backupPath: saved.path, created: false };
}

function livePrefix(deps: RestoreCommandDeps, bytes: Uint8Array | null): string | null {
  return bytes === null ? null : shortHash(deps.hashBytes(bytes));
}

/**
 * Basename → the neutral path of a file that exists on that side now.
 *
 * Built once per directory rather than per row: it lists the provider and
 * walks the replica subtree, and a backup directory holding twenty rows would
 * otherwise do that twenty times.
 */
async function locator(
  deps: RestoreCommandDeps,
  provider: RestoreCommandDeps["providers"][number],
): Promise<(originalName: string) => string | null> {
  const byBasename = new Map<string, string>();

  for (const group of await provider.adapter.listSessions().catch(() => [])) {
    for (const file of group.files) {
      byBasename.set(baseNameOf(file.neutralRel), file.neutralRel);
    }
  }
  await walkReplica(deps, provider.adapter, byBasename);

  return (originalName) => {
    const known = byBasename.get(originalName);
    if (known !== undefined) return known;
    // Flat fallback: for a provider whose layout is one directory deep, the
    // basename *is* the whole relative path, and the adapter's own classifier
    // is the authority on whether that shape is one of its own.
    const flat = `${provider.adapter.id}/${originalName}`;
    return provider.adapter.classifyNeutral(flat) === null ? null : flat;
  };
}

async function walkReplica(
  deps: RestoreCommandDeps,
  adapter: ProviderAdapter,
  into: Map<string, string>,
  rel: string = adapter.id,
  depth = 1,
): Promise<void> {
  const dir = deps.joinPath(deps.replicaRoot, deps.workspaceId, ...rel.split("/"));
  for (const item of await deps.fs.readDir(dir).catch(() => [])) {
    const childRel = `${rel}/${item.name}`;
    if (item.isFile) {
      // Validated, not merely found: the replica is a directory an external
      // sync tool writes into, and an unvalidated name from it would become a
      // path this command writes to (§8.2's whole point).
      if (!into.has(item.name) && adapter.classifyNeutral(childRel) !== null) {
        into.set(item.name, childRel);
      }
      continue;
    }
    if (item.name === QUARANTINE_DIR) continue;
    if (depth < 6) await walkReplica(deps, adapter, into, childRel, depth + 1);
  }
}

/** Both sides of a neutral path, as bytes or null. */
async function readSides(
  deps: RestoreCommandDeps,
  provider: RestoreCommandDeps["providers"][number],
  neutralRel: string | null,
): Promise<{ local: Uint8Array | null; remote: Uint8Array | null }> {
  if (neutralRel === null) return { local: null, remote: null };
  const localPath = await provider.adapter.targetPathFor(neutralRel).catch(() => null);
  return {
    local: localPath === null ? null : await deps.fs.readFile(localPath).catch(() => null),
    remote: await deps.fs
      .readFile(deps.joinPath(deps.replicaRoot, deps.workspaceId, neutralRel))
      .catch(() => null),
  };
}

/**
 * What the next pass will make of the restored bytes.
 *
 * Computed against the **other** side, because that is the pair `plan()` and
 * `planOpaque()` compare. Predicting from the side being written to would
 * describe a comparison that never happens — and the calm-looking answer
 * ("this is just a local revert") is exactly the one that would be wrong when
 * the restored version turns out to *extend* the other side and propagates.
 *
 * Mode matters as much as bytes. A whole-file provider has no prefix relation
 * at all: §7.2b decides by the converged base, which this layer cannot see, so
 * the honest answer names both possibilities instead of picking the one that
 * happens to be true for append-only files.
 */
function predict(
  deps: RestoreCommandDeps,
  bytes: Uint8Array,
  other: Uint8Array | null,
  neutralRel: string | null,
  provider: RestoreCommandDeps["providers"][number],
): BackupEntry["outcome"] {
  if (neutralRel === null) return "unknown";
  const mode = provider.adapter.classifyNeutral(neutralRel)?.mode ?? null;
  if (other === null) return "will-propagate";
  if (deps.hashBytes(other) === deps.hashBytes(bytes)) return "nothing";
  if (mode !== "append-jsonl") return "whole-file";
  if (bytes.length < other.length && isPrefix(bytes, other)) return "will-be-undone";
  if (other.length < bytes.length && isPrefix(other, bytes)) return "will-propagate";
  return "will-conflict";
}

function isPrefix(shorter: Uint8Array, longer: Uint8Array): boolean {
  for (let i = 0; i < shorter.length; i++) if (shorter[i] !== longer[i]) return false;
  return true;
}

/**
 * The action column, from the index when it can be read.
 *
 * Never load-bearing: a backup with no readable index line is listed and
 * restorable exactly like any other, it just does not say which overwrite
 * produced it.
 */
async function readActions(
  deps: RestoreCommandDeps,
  dir: string,
): Promise<Map<string, string>> {
  const actions = new Map<string, string>();
  const raw = await deps.fs.readFile(deps.joinPath(dir, "index.jsonl")).catch(() => null);
  if (raw === null) return actions;
  for (const line of new TextDecoder().decode(raw).split("\n")) {
    if (line.trim() === "") continue;
    try {
      const record = JSON.parse(line) as { name?: unknown; action?: unknown };
      if (typeof record.name === "string" && typeof record.action === "string") {
        actions.set(record.name, record.action);
      }
    } catch {
      // A half-written line is a line, not a failure.
    }
  }
  return actions;
}

function baseNameOf(target: string): string {
  return target.slice(target.lastIndexOf("/") + 1);
}

function countLines(bytes: Uint8Array): number {
  let lines = 0;
  for (const byte of bytes) if (byte === 0x0a) lines += 1;
  return lines;
}

function shortHash(hash: string): string {
  const bare = hash.startsWith("sha256:") ? hash.slice(7) : hash;
  return bare.slice(0, 8);
}
