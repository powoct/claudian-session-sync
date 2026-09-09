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

/**
 * Every name the engine has ever given a quarantined copy.
 *
 * `branch-<hash8>` is current (`domain/conflict.ts`); `local-`/`remote-` are
 * the pre-fix pair a directory on a real machine may still hold, and the
 * regression test for those exists because such directories must keep
 * resolving. Anything else in the directory came from somewhere else.
 */
const COPY_PREFIXES = ["branch-", "local-", "remote-"] as const;

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
  /** Why the pass called it a conflict, when the directory records it (ADR-57). */
  readonly reason: string | null;
  /** The sync tool's own copy of this file, when that was the evidence. */
  readonly externalCopy: string | null;
  /**
   * Where this frozen pair stands against what is on disk right now.
   *
   * Replaces a boolean called `superseded`, whose sole clause — no branch on
   * either side — got the commonest ending exactly backwards. A resolved
   * conflict *converges*, and the surviving bytes are by definition equal to
   * one of the archived branches, so the branch matched a live side and the
   * entry stayed "unresolved" forever. Convergence was the very condition that
   * kept it in the list. Measured 2026-09-09: 47 directories had converged
   * byte-for-byte on both sides and every one still offered live buttons,
   * while the status bar — counting what passes judged — correctly said 1.
   *
   * Nothing is stored. The verdict is per-machine and reversible: the same
   * directory is `settled` here and `in-dispute` on the peer that still holds
   * the other branch, and flips back if that peer pushes it. A marker written
   * into the directory would suppress a genuine recurrence under the same id.
   */
  readonly standing: ConflictStanding;
}

export type ConflictStanding =
  /** A branch is live on one side or the other, and they do not agree. */
  | "in-dispute"
  /** One archived branch is on *both* sides: there is nothing left to choose. */
  | "settled"
  /** Both sides were read, and neither holds either branch any more. */
  | "moved-on"
  /** Neither side could be read, so nothing at all is known about them. */
  | "unreadable";

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
  /**
   * Both sides already hold the same version, so there is nothing to overwrite.
   *
   * The panel greys these buttons, but the palette commands read the same list
   * and no entry flag at all — so without this the click still took a backup,
   * rotated one away, rewrote identical bytes, bumped an mtime the sync tool
   * then re-transfers, and reported success.
   */
  | "sides-agree"
  | "remote-not-ready"
  /** A pass is applying right now — the same lock a pass takes (§9.4). */
  | "sync-in-progress"
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

  // From the freshly re-listed entry above, never from what the panel drew: a
  // list a minute old is exactly what the palette commands act on. Placed
  // before the readiness gate deliberately — sending someone off to fix sync
  // readiness for a write that would change nothing is the worse refusal.
  if (entry.standing === "settled") return { ok: false, reason: "sides-agree" };

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

  // Only the engine's own copies, and only when the path was not recorded.
  // `readDir` is unsorted, so "the first entry" could be a `.DS_Store` — which
  // Finder writes into this very directory the moment someone clicks "Show me
  // both" — and `extensionOf(".DS_Store")` returns ".DS_Store", producing a
  // neutralRel that resolves nowhere and dropping a live conflict into the
  // unreadable bucket.
  const extension =
    recordedRel === null
      ? extensionOf(
          [...byHash.values()].find((copy) =>
            COPY_PREFIXES.some((prefix) => copy.copyName.startsWith(prefix)),
          )?.copyName ?? "",
        )
      : "";
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
    reason: typeof meta.reason === "string" ? meta.reason : null,
    externalCopy: typeof meta.externalCopy === "string" ? meta.externalCopy : null,
    logicalIdPrefix: logicalId.slice(0, 8),
    detectedAt,
    directory,
    neutralRel,
    branches,
    standing: standingOf(branches, localHash, remoteHash),
  };
}

/**
 * The four endings, in the only order that is correct.
 *
 * **`settled` must be tested first.** A converged entry's surviving branch also
 * satisfies the `in-dispute` clause below, so testing that first calls
 * convergence a live fork — which is precisely the bug this replaces.
 *
 * **Written over the branch flags, never over `localHash === remoteHash`.**
 * That spelling is the obvious refactor and it is unsafe twice over. `hashOf`
 * collapses *absent*, *unreadable* (the state `kept-unreadable` exists for),
 * *provider switched off on this machine* (`localPathFor` returns null before
 * any I/O) and *this rel does not resolve here* into one null — and in the
 * worst case both nulls come from a single cause, so `null === null` would
 * announce that two files it cannot even find agree. Going through the flags
 * also rules out the pair of zero-byte reads a dehydrating cloud client
 * produces, since `hash(empty) === hash(empty)` is a real, equal, non-null
 * hash but matches no archived branch.
 *
 * What `settled` proves is worth stating exactly, because it is the whole
 * safety argument for greying the buttons: if a branch is on both sides then
 * `localHash === remoteHash === branch.hash`, and `resolveConflict` writes the
 * bytes it read from the kept side onto the other — which already holds them.
 * No keep button can change a byte in this state, so disabling them removes no
 * remedy. A torn read (local at t1, remote at t2) can only reach a false
 * `settled` by the CLI appending locally after t1, which lands on the
 * one-side-moved shape where keep-local would refuse `branch-moved` anyway and
 * keep-remote would truncate a longer file. Harmless, not impossible.
 */
function standingOf(
  branches: readonly ConflictBranchView[],
  localHash: string | null,
  remoteHash: string | null,
): ConflictStanding {
  if (branches.some((branch) => branch.onThisMachine && branch.inSyncFolder)) return "settled";
  if (branches.some((branch) => branch.onThisMachine || branch.inSyncFolder)) return "in-dispute";
  // Split apart on purpose. One sentence used to cover both "both sides moved
  // past this pair" (observed) and "neither side could be read" (nothing
  // observed), and the second is where the old code told a user with a live
  // fork on disk that it was over — a schema-2 directory under a nested
  // provider rebuilds a path that resolves to nothing, so both reads come back
  // null while both files sit there disagreeing.
  return localHash === null || remoteHash === null ? "unreadable" : "moved-on";
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
