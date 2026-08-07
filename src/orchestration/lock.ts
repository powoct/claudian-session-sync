/**
 * Pass mutual exclusion (architecture §4.2, testing.md §7.4 R-09/R-10).
 *
 * Two distinct problems, and conflating them is how this goes wrong:
 *
 *  - **Two passes inside one plugin instance** (a timer firing while a manual
 *    sync runs). Cheap to prevent, and the second must do *nothing* rather than
 *    wait — a queued duplicate would run against observations taken before the
 *    first pass wrote anything.
 *  - **Two Obsidian windows on the same vault**, each with its own instance.
 *    Only a file on disk can arbitrate that.
 *
 * The lock is advisory and this is stated plainly: it reduces overlap, it does
 * not prevent it. A stale lock must be stealable — a crashed process leaves one
 * behind, and a plugin that refuses to sync until the user finds and deletes a
 * file is worse than one that occasionally overlaps.
 *
 * Stealing is what makes the epoch necessary. Once a lock has been taken from
 * an owner, that owner may still be running and about to write. The epoch lets
 * every write check "am I still the holder?" and abort if not, which is the
 * difference between a stealable lock and a broken one.
 */

export interface LockFile {
  readonly pid: number;
  readonly machineId: string;
  /** Bumped every time the lock changes hands. Writes carry the epoch they saw. */
  readonly epoch: number;
  readonly acquiredAtMs: number;
  /** Refreshed while a pass runs, so staleness is observable. */
  readonly heartbeatMs: number;
}

/** A lock unrefreshed for this long is presumed abandoned. */
export const STALE_AFTER_MS = 60_000;

export type AcquireOutcome =
  | { readonly ok: true; readonly lock: LockFile; readonly stolenFrom?: LockFile }
  | { readonly ok: false; readonly reason: "LOCK_HELD"; readonly heldBy: LockFile }
  | { readonly ok: false; readonly reason: "ALREADY_RUNNING" };

export interface AcquireInput {
  readonly existing: LockFile | null;
  readonly nowMs: number;
  readonly pid: number;
  readonly machineId: string;
  /** True when this instance already has a pass in flight. */
  readonly inProcessBusy: boolean;
  readonly staleAfterMs?: number;
}

/**
 * Decides whether this pass may start.
 *
 * In-process check first: it is the common case and needs no filesystem at all.
 * Returning ALREADY_RUNNING rather than queueing is deliberate — a queued pass
 * would begin from observations taken before the running one wrote.
 */
export function decideAcquire(input: AcquireInput): AcquireOutcome {
  if (input.inProcessBusy) return { ok: false, reason: "ALREADY_RUNNING" };

  const staleAfter = input.staleAfterMs ?? STALE_AFTER_MS;
  const existing = input.existing;

  if (existing === null) {
    return { ok: true, lock: fresh(input, 1) };
  }

  // Our own lock from a previous run in this process's lifetime: reclaim it
  // rather than treating ourselves as a competitor.
  const ours = existing.pid === input.pid && existing.machineId === input.machineId;
  const stale = input.nowMs - existing.heartbeatMs > staleAfter;

  if (!ours && !stale) {
    return { ok: false, reason: "LOCK_HELD", heldBy: existing };
  }

  // Every takeover bumps the epoch, including reclaiming our own: the previous
  // holder may still be mid-write, and this is what invalidates it.
  const lock = fresh(input, existing.epoch + 1);
  return stale && !ours ? { ok: true, lock, stolenFrom: existing } : { ok: true, lock };
}

/**
 * May a write proceed, given the lock as it stands right now?
 *
 * Called immediately before each write. The failure it prevents: this pass
 * acquired the lock, another instance judged it stale and stole it, and both
 * are now writing the same file. Comparing epochs catches that; comparing pids
 * would not, since the original holder's pid is still its own.
 */
export function mayWrite(held: LockFile, current: LockFile | null): boolean {
  if (current === null) return false; // Someone removed it; assume we lost it.
  return current.epoch === held.epoch && current.pid === held.pid;
}

export function heartbeat(lock: LockFile, nowMs: number): LockFile {
  return { ...lock, heartbeatMs: nowMs };
}

export function isStale(lock: LockFile, nowMs: number, staleAfterMs = STALE_AFTER_MS): boolean {
  return nowMs - lock.heartbeatMs > staleAfterMs;
}

/**
 * Parses a lock file, treating anything malformed as absent.
 *
 * A corrupt lock must not wedge the plugin permanently: an unreadable file is
 * indistinguishable from a half-written one, and the safe reading — given that
 * the lock is advisory anyway — is that nobody holds it.
 */
export function parseLockFile(raw: unknown): LockFile | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (
    typeof v.pid !== "number" ||
    typeof v.machineId !== "string" ||
    typeof v.epoch !== "number" ||
    typeof v.acquiredAtMs !== "number" ||
    typeof v.heartbeatMs !== "number"
  ) {
    return null;
  }
  return {
    pid: v.pid,
    machineId: v.machineId,
    epoch: v.epoch,
    acquiredAtMs: v.acquiredAtMs,
    heartbeatMs: v.heartbeatMs,
  };
}

function fresh(input: AcquireInput, epoch: number): LockFile {
  return {
    pid: input.pid,
    machineId: input.machineId,
    epoch,
    acquiredAtMs: input.nowMs,
    heartbeatMs: input.nowMs,
  };
}
