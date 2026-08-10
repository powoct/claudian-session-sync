/**
 * Conflict identity and quarantine layout (architecture §8.1).
 *
 * Conflict state is derived from content, never stored. Putting `conflict:
 * true` in the manifest looks simpler and fails in two directions at once: lose
 * the manifest and every pass generates a fresh quarantine copy forever; keep a
 * stale manifest and a session stays frozen after the user has already fixed it
 * by hand.
 *
 * Deriving the identity from the two hashes gives all of that for free:
 *
 *   - the manifest can be deleted with no change in behaviour — the same pair
 *     of contents yields the same directory, which already exists, so the pass
 *     is a NOOP;
 *   - the moment either side changes, the id changes, so the old conflict
 *     simply stops being computed and the session resumes normal handling;
 *   - both machines compute the same id from the same bytes, so there is no
 *     path-level race and last-writer-wins is harmless.
 *
 * Quarantine is a **copy**. Neither original is touched, which is what makes a
 * mistaken conflict cost a confusing report rather than a lost conversation.
 */
import type { LogicalId } from "./types";

/** Enough to make a collision irrelevant; short enough to appear in a path. */
export const CONFLICT_ID_LENGTH = 16;

export interface ConflictSides {
  readonly logicalId: LogicalId;
  readonly localHash: string;
  readonly remoteHash: string;
}

/**
 * sha256 over the logical id and both hashes, smaller hash first, truncated.
 *
 * Ordered by hash rather than by side, because "local" and "remote" are swapped
 * between the two machines — ordering by side would give the same disagreement
 * two different identities and therefore two quarantine directories.
 */
export function conflictId(sides: ConflictSides, hash: (input: string) => string): string {
  const [first, second] =
    sides.localHash <= sides.remoteHash
      ? [sides.localHash, sides.remoteHash]
      : [sides.remoteHash, sides.localHash];
  return stripPrefix(hash(`${sides.logicalId} ${first} ${second}`)).slice(0, CONFLICT_ID_LENGTH);
}

export interface QuarantineCopy {
  readonly name: string;
  /** The full hash (as `hashBytes` renders it) of the branch this copy holds. */
  readonly hash: string;
}

export interface QuarantineLayout {
  readonly dir: readonly string[];
  /** One copy per branch, ordered by hash — identical on every machine. */
  readonly copies: readonly QuarantineCopy[];
  readonly meta: string;
}

/**
 * `.quarantine/<workspaceId>/<provider>/<conflictId>/`
 *
 * Inside the sync directory rather than the home state directory: the point is
 * that a user on *either* machine can find both branches, and only the sync
 * directory reaches both.
 *
 * Everything in the directory is machine-neutral. The copies are named by the
 * hash of their content (`branch-<hash8>`), never `local-`/`remote-`: those
 * words swap meaning between the two machines, and the directory is shared —
 * both machines detect the same disagreement (same conflict id, by
 * construction) and write into the same place. Viewpoint-relative names made
 * the second machine's write a second *pair*, and a reader could then pair a
 * "local" copy with a "remote" copy of the same branch. Hash-derived names
 * make the second machine's writes byte-identical to the first's, so the
 * shared directory converges instead of accumulating.
 */
export function quarantineLayout(input: {
  readonly workspaceId: string;
  readonly providerId: string;
  readonly conflictId: string;
  readonly localHash: string;
  readonly remoteHash: string;
  readonly extension: string;
}): QuarantineLayout {
  const ordered =
    stripPrefix(input.localHash) <= stripPrefix(input.remoteHash)
      ? [input.localHash, input.remoteHash]
      : [input.remoteHash, input.localHash];
  return {
    dir: [".quarantine", input.workspaceId, input.providerId, input.conflictId],
    copies: ordered.map((hash) => ({
      name: `branch-${shortHash(hash)}${input.extension}`,
      hash,
    })),
    meta: "meta.json",
  };
}

/**
 * What is recorded alongside the copies.
 *
 * Sizes, line counts, hash prefixes and timestamps — the §11.1 whitelist and
 * nothing else. No field here can carry a line of conversation, and
 * `detectedBy` is a machine id prefix rather than a hostname, which would be a
 * string another machine wrote.
 *
 * Schema 2 is machine-neutral: branches are ordered by hash, with no
 * `local`/`remote` labels. Which branch is "this machine's" is a question
 * about the present, answered by hashing the live files at read time — a
 * label frozen at detection is wrong on the other machine from the start and
 * wrong on this one as soon as the file moves.
 */
export interface ConflictBranchMeta {
  readonly hashPrefix: string;
  readonly size: number;
  readonly lineCount: number;
}

export interface ConflictMeta {
  readonly schemaVersion: 2;
  readonly logicalId: string;
  readonly conflictId: string;
  /** Ordered by hash prefix, mirroring the copy files. */
  readonly branches: readonly ConflictBranchMeta[];
  readonly detectedBy: string;
  readonly detectedAt: string;
}

export function buildConflictMeta(input: {
  readonly logicalId: LogicalId;
  readonly conflictId: string;
  readonly localHash: string;
  readonly remoteHash: string;
  readonly localSize: number;
  readonly remoteSize: number;
  readonly localLineCount: number;
  readonly remoteLineCount: number;
  readonly machineIdPrefix: string;
  readonly detectedAtIso: string;
}): ConflictMeta {
  const local: ConflictBranchMeta = {
    hashPrefix: shortHash(input.localHash),
    size: input.localSize,
    lineCount: input.localLineCount,
  };
  const remote: ConflictBranchMeta = {
    hashPrefix: shortHash(input.remoteHash),
    size: input.remoteSize,
    lineCount: input.remoteLineCount,
  };
  const branches =
    stripPrefix(input.localHash) <= stripPrefix(input.remoteHash) ? [local, remote] : [remote, local];
  return {
    schemaVersion: 2,
    logicalId: input.logicalId,
    conflictId: input.conflictId,
    branches,
    detectedBy: input.machineIdPrefix,
    detectedAt: input.detectedAtIso,
  };
}

/**
 * How a user gets out of a conflict (§8.1). M1 ships all three — shipping
 * detection without resolution would leave the plugin able to notice a problem
 * and unable to end it.
 *
 * Neither choice destroys the other branch: the abandoned version stays in
 * quarantine and in the backup area.
 */
export type ConflictResolution = "keep-local" | "keep-remote" | "reveal";

export function resolutionAction(
  resolution: ConflictResolution,
): "PUSH_OVERWRITE" | "PULL_OVERWRITE" | null {
  if (resolution === "keep-local") return "PUSH_OVERWRITE";
  if (resolution === "keep-remote") return "PULL_OVERWRITE";
  return null;
}

function stripPrefix(hash: string): string {
  return hash.startsWith("sha256:") ? hash.slice(7) : hash;
}

/** `sha256:<hex>` → first 8 hex chars, the display form used everywhere here. */
export function shortHash(hash: string): string {
  return stripPrefix(hash).slice(0, 8);
}
