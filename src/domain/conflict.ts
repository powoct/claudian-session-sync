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

export interface QuarantineLayout {
  readonly dir: readonly string[];
  readonly localCopy: string;
  readonly remoteCopy: string;
  readonly meta: string;
}

/**
 * `.quarantine/<workspaceId>/<provider>/<conflictId>/`
 *
 * Inside the sync directory rather than the home state directory: the point is
 * that a user on *either* machine can find both branches, and only the sync
 * directory reaches both.
 */
export function quarantineLayout(input: {
  readonly workspaceId: string;
  readonly providerId: string;
  readonly conflictId: string;
  readonly localHash: string;
  readonly remoteHash: string;
  readonly extension: string;
}): QuarantineLayout {
  return {
    dir: [".quarantine", input.workspaceId, input.providerId, input.conflictId],
    localCopy: `local-${shortHash(input.localHash)}${input.extension}`,
    remoteCopy: `remote-${shortHash(input.remoteHash)}${input.extension}`,
    meta: "meta.json",
  };
}

/**
 * What is recorded alongside the two copies.
 *
 * Sizes, line counts, hash prefixes and timestamps — the §11.1 whitelist and
 * nothing else. No field here can carry a line of conversation, and
 * `detectedBy` is a machine id prefix rather than a hostname, which would be a
 * string another machine wrote.
 */
export interface ConflictMeta {
  readonly schemaVersion: 1;
  readonly logicalId: string;
  readonly conflictId: string;
  readonly localHashPrefix: string;
  readonly remoteHashPrefix: string;
  readonly localSize: number;
  readonly remoteSize: number;
  readonly localLineCount: number;
  readonly remoteLineCount: number;
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
  return {
    schemaVersion: 1,
    logicalId: input.logicalId,
    conflictId: input.conflictId,
    localHashPrefix: shortHash(input.localHash),
    remoteHashPrefix: shortHash(input.remoteHash),
    localSize: input.localSize,
    remoteSize: input.remoteSize,
    localLineCount: input.localLineCount,
    remoteLineCount: input.remoteLineCount,
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

function shortHash(hash: string): string {
  return stripPrefix(hash).slice(0, 8);
}
