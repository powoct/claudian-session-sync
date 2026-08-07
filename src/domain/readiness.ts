/**
 * The remote readiness state machine (architecture §9.6).
 *
 * The problem it solves is specific and, left unsolved, catastrophic: a cloud
 * drive that has created the folder but not yet downloaded its contents is
 * indistinguishable, from a directory listing, from a folder whose contents
 * were deleted. Treat the second reading as true and the plugin pushes this
 * machine's entire history into an empty directory, where it collides with what
 * the other machine actually had.
 *
 * So an empty or shrinking sync directory is never interpreted. It stops the
 * pass and asks.
 *
 * The whole machine rests on one property of M1/M2: deletion is not
 * propagated, so a workspace subtree's file count only ever grows. That makes
 * any decrease suspicious enough to act on, and lets the thresholds be
 * sensitive rather than cautious.
 */

export type ReadinessState = "UNCONFIGURED" | "PROBING" | "AWAIT_INIT" | "READY" | "NOT_READY";

/**
 * NR-1..NR-9. Which of these fired decides whether recovery can be automatic.
 */
export type NotReadyReason =
  /** root.json is gone. */
  | "NR-1-root-missing"
  /** root.json names a different sync directory than the one we know. */
  | "NR-2-root-id-mismatch"
  | "NR-3-root-corrupt"
  | "NR-4-format-too-new"
  /** The workspace subtree vanished although we recorded files in it. */
  | "NR-5-workspace-subtree-missing"
  | "NR-6-file-count-dropped"
  | "NR-7-byte-count-dropped"
  /** A remote file that had content is now zero bytes (decision table #14). */
  | "NR-8-remote-regression"
  /** The sync directory cannot be stat'd — drive unmounted, letter changed. */
  | "NR-9-sync-dir-unreachable";

/**
 * Which reasons may clear themselves.
 *
 * NR-6 and NR-7 are usually hydration in progress, so waiting is both correct
 * and what a user would want. NR-9 is a drive that comes back.
 *
 * Everything else means "the remote is no longer the remote I knew", and
 * accepting that automatically would silently ratify a cloud drive having
 * emptied or rolled back the folder. Those need a human.
 */
const SELF_CLEARING: ReadonlySet<NotReadyReason> = new Set([
  "NR-6-file-count-dropped",
  "NR-7-byte-count-dropped",
  "NR-9-sync-dir-unreachable",
]);

export function isSelfClearing(reason: NotReadyReason): boolean {
  return SELF_CLEARING.has(reason);
}

export interface ReadinessThresholds {
  /** Consecutive passes of non-decreasing counts before READY. Default 2. */
  readonly probes: number;
  /** Minimum span those probes must cover. Default 90s. */
  readonly minAgeMs: number;
  readonly shrinkFilesAbs: number;
  readonly shrinkFilesPct: number;
  readonly shrinkBytesPct: number;
  readonly shrinkBytesAbsMB: number;
}

export const DEFAULT_READINESS: ReadinessThresholds = {
  probes: 2,
  minAgeMs: 90_000,
  shrinkFilesAbs: 3,
  shrinkFilesPct: 0.1,
  shrinkBytesPct: 0.25,
  shrinkBytesAbsMB: 1,
};

export interface Counts {
  readonly files: number;
  readonly bytes: number;
}

export interface RemoteRecord {
  readonly state: ReadinessState;
  readonly rootId: string | null;
  readonly lastKnownCounts: Counts;
  readonly consecutiveStableProbes: number;
  readonly firstProbeMs: number | null;
  readonly notReadyReason: NotReadyReason | null;
}

export interface ReadinessObservation {
  /** False when the directory cannot be stat'd at all (NR-9). */
  readonly reachable: boolean;
  /** Absent, unparseable, or the id and format it declares. */
  readonly root:
    | { readonly status: "missing" }
    | { readonly status: "corrupt" }
    | { readonly status: "ok"; readonly rootId: string; readonly formatVersion: number };
  /** True when the whole sync directory contains nothing at all. */
  readonly syncDirEmpty: boolean;
  readonly workspaceSubtreeExists: boolean;
  readonly counts: Counts;
  /** A remoteRegression was seen this pass (decision table #14). */
  readonly remoteRegression: boolean;
  readonly nowMs: number;
}

export interface ReadinessVerdict {
  readonly state: ReadinessState;
  readonly reason: NotReadyReason | null;
  readonly record: RemoteRecord;
  /** True when the pass may write. Only READY permits it. */
  readonly mayWrite: boolean;
}

export const INITIAL_REMOTE_RECORD: RemoteRecord = {
  state: "UNCONFIGURED",
  rootId: null,
  lastKnownCounts: { files: 0, bytes: 0 },
  consecutiveStableProbes: 0,
  firstProbeMs: null,
  notReadyReason: null,
};

/**
 * Evaluates readiness for one pass.
 *
 * Pure: it takes what was observed and what was remembered and returns the new
 * state. Nothing here reads a clock or a filesystem, which is what makes the
 * NR table exhaustively testable.
 */
export function evaluateReadiness(
  previous: RemoteRecord,
  observed: ReadinessObservation,
  supportedFormatVersion: number,
  thresholds: ReadinessThresholds = DEFAULT_READINESS,
): ReadinessVerdict {
  // NR-9 first: if the directory cannot be reached, nothing else observed
  // about it means anything.
  if (!observed.reachable) {
    return notReady(previous, "NR-9-sync-dir-unreachable", observed);
  }

  if (observed.root.status === "missing") {
    // An entirely empty directory is ambiguous — brand new, or not yet
    // hydrated — so it waits for a human rather than initialising itself.
    // Auto-initialising here is the accident path: it would be immediately
    // followed by pushing this machine's whole history into it.
    if (observed.syncDirEmpty) {
      return {
        state: "AWAIT_INIT",
        reason: null,
        record: { ...previous, state: "AWAIT_INIT", notReadyReason: null },
        mayWrite: false,
      };
    }
    return notReady(previous, "NR-1-root-missing", observed);
  }
  if (observed.root.status === "corrupt") {
    // Deliberately not rebuilt: a corrupt root.json may be a partial write in
    // flight, and rewriting it would destroy the evidence and the other
    // machine's anchor at once.
    return notReady(previous, "NR-3-root-corrupt", observed);
  }
  if (observed.root.formatVersion > supportedFormatVersion) {
    return notReady(previous, "NR-4-format-too-new", observed);
  }
  if (previous.rootId !== null && previous.rootId !== observed.root.rootId) {
    return notReady(previous, "NR-2-root-id-mismatch", observed);
  }
  if (!observed.workspaceSubtreeExists && previous.lastKnownCounts.files > 0) {
    return notReady(previous, "NR-5-workspace-subtree-missing", observed);
  }
  if (observed.remoteRegression) {
    return notReady(previous, "NR-8-remote-regression", observed);
  }

  const shrink = detectShrink(previous.lastKnownCounts, observed.counts, thresholds);
  if (shrink) return notReady(previous, shrink, observed);

  // Counts are holding or growing. Two consecutive probes spanning minAgeMs is
  // the observable proxy for "hydration finished" — there is no API that says
  // so, and a single reading cannot distinguish a settled folder from one that
  // is halfway through downloading.
  const firstProbeMs = previous.firstProbeMs ?? observed.nowMs;
  const probes = previous.consecutiveStableProbes + 1;
  const spanned = observed.nowMs - firstProbeMs;
  const settled = probes >= thresholds.probes && spanned >= thresholds.minAgeMs;

  const record: RemoteRecord = {
    state: settled ? "READY" : "PROBING",
    rootId: observed.root.rootId,
    lastKnownCounts: maxCounts(previous.lastKnownCounts, observed.counts),
    consecutiveStableProbes: probes,
    firstProbeMs,
    notReadyReason: null,
  };
  return { state: record.state, reason: null, record, mayWrite: settled };
}

/**
 * A drop large enough to be worth stopping for.
 *
 * Both dimensions have an absolute floor as well as a percentage, so a
 * workspace with four files does not go NOT_READY because one arrived late.
 */
function detectShrink(
  previous: Counts,
  current: Counts,
  thresholds: ReadinessThresholds,
): NotReadyReason | null {
  const fileDrop = previous.files - current.files;
  const fileLimit = Math.max(thresholds.shrinkFilesAbs, previous.files * thresholds.shrinkFilesPct);
  if (fileDrop > fileLimit) return "NR-6-file-count-dropped";

  const byteDrop = previous.bytes - current.bytes;
  const byteLimitPct = previous.bytes * thresholds.shrinkBytesPct;
  const byteLimitAbs = thresholds.shrinkBytesAbsMB * 1024 * 1024;
  if (byteDrop > byteLimitPct && byteDrop > byteLimitAbs) return "NR-7-byte-count-dropped";

  return null;
}

function notReady(
  previous: RemoteRecord,
  reason: NotReadyReason,
  observed: ReadinessObservation,
): ReadinessVerdict {
  return {
    state: "NOT_READY",
    reason,
    record: {
      ...previous,
      state: "NOT_READY",
      notReadyReason: reason,
      // The remembered high-water mark is kept, not overwritten with the
      // reduced reading: it is the evidence the user is shown, and lowering it
      // would make the next pass consider the smaller count normal.
      lastKnownCounts: previous.lastKnownCounts,
      consecutiveStableProbes: 0,
      firstProbeMs: observed.nowMs,
    },
    mayWrite: false,
  };
}

/** Counts only ever rise, because M1 does not propagate deletion. */
function maxCounts(a: Counts, b: Counts): Counts {
  return { files: Math.max(a.files, b.files), bytes: Math.max(a.bytes, b.bytes) };
}

/** What the user may do about a NOT_READY, per §9.6.3. */
export function recoveryOptions(reason: NotReadyReason): readonly string[] {
  return isSelfClearing(reason)
    ? ["wait"]
    : ["confirm-this-directory-is-correct", "re-initialise-this-directory"];
}
