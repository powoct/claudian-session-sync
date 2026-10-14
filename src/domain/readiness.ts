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
 *
 * Bytes grow too, but only where files are appended to. Claudian's records are
 * rewritten whole, and since Claudian 2.3.8 a rewrite strips the images out of
 * them — a vault's records can drop from tens of megabytes to a few kilobytes
 * in one save, with nothing wrong anywhere (OQ-36). So the byte count leaves
 * that subtree out (ADR-80); its files still count.
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

/**
 * Top-level directories of a workspace subtree whose bytes are not counted
 * (ADR-80). Their files are.
 *
 * The provider id, spelled out rather than imported: the domain does not
 * depend on providers, and the neutral layout fixes the name anyway (§5.1).
 */
export const BYTES_NOT_COUNTED_UNDER: ReadonlySet<string> = new Set(["claudian"]);

/**
 * What `Counts.bytes` measures. 1: every file in the subtree (until ADR-80);
 * 2: every file outside `BYTES_NOT_COUNTED_UNDER`.
 *
 * Recorded beside the high-water mark because the two are only comparable on
 * the same basis — a mark taken on 1 is larger by however much the records
 * weighed, and compared against a reading taken on 2 it is the very drop
 * ADR-80 exists to stop reporting.
 */
export const BYTE_COUNT_BASIS = 2;
/** What a `remote.json` that does not say has. */
export const LEGACY_BYTE_COUNT_BASIS = 1;

export interface RemoteRecord {
  readonly state: ReadinessState;
  readonly rootId: string | null;
  readonly lastKnownCounts: Counts;
  /** The basis `lastKnownCounts.bytes` was measured on (ADR-80). */
  readonly byteCountBasis: number;
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
  byteCountBasis: BYTE_COUNT_BASIS,
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

  // A byte mark taken on another basis is not a mark on this one, and there is
  // no converting it: how much of it the records were is not recorded anywhere.
  // So the first reading that got this far becomes the mark (ADR-80). Not
  // earlier — an unreachable directory reads as zero, and a refusal above has
  // not established that this reading describes the directory at all.
  //
  // And it starts probing over. The reading that sets the mark cannot also be
  // the one that clears it — compared with itself, it would let a READY device
  // write on the very pass NR-7 is blind. As probe one, it has to hold for
  // `minAgeMs` first, so a drop still under way is caught on the next pass. A
  // drop that had already finished before the update is not caught: that is
  // the cost of a mark that cannot be converted. The file mark is kept, so
  // NR-6 is not blind, and NR-8 does not use marks.
  const rebased: RemoteRecord =
    previous.byteCountBasis === BYTE_COUNT_BASIS
      ? previous
      : {
          ...previous,
          lastKnownCounts: { files: previous.lastKnownCounts.files, bytes: observed.counts.bytes },
          byteCountBasis: BYTE_COUNT_BASIS,
          consecutiveStableProbes: 0,
          firstProbeMs: null,
        };

  const shrink = detectShrink(rebased.lastKnownCounts, observed.counts, thresholds);
  if (shrink) return notReady(rebased, shrink, observed);

  // Counts are holding or growing. Two consecutive probes spanning minAgeMs is
  // the observable proxy for "hydration finished" — there is no API that says
  // so, and a single reading cannot distinguish a settled folder from one that
  // is halfway through downloading.
  const firstProbeMs = rebased.firstProbeMs ?? observed.nowMs;
  const probes = rebased.consecutiveStableProbes + 1;
  const spanned = observed.nowMs - firstProbeMs;
  const settled = probes >= thresholds.probes && spanned >= thresholds.minAgeMs;

  const record: RemoteRecord = {
    state: settled ? "READY" : "PROBING",
    rootId: observed.root.rootId,
    lastKnownCounts: maxCounts(rebased.lastKnownCounts, observed.counts),
    byteCountBasis: BYTE_COUNT_BASIS,
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

/**
 * Counts only ever rise, because M1 does not propagate deletion — and bytes
 * are counted only where files are appended to (ADR-80).
 */
function maxCounts(a: Counts, b: Counts): Counts {
  return { files: Math.max(a.files, b.files), bytes: Math.max(a.bytes, b.bytes) };
}

/** What the user may do about a NOT_READY, per §9.6.3. */
export function recoveryOptions(reason: NotReadyReason): readonly string[] {
  return isSelfClearing(reason)
    ? ["wait"]
    : ["confirm-this-directory-is-correct", "re-initialise-this-directory"];
}
