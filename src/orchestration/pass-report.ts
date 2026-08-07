/**
 * What a pass reports (architecture §7.1, §11.2).
 *
 * Two constraints are structural rather than conventional:
 *
 *  - **No field here may carry file content.** Not `content`, not `bytes`, not
 *    `lines: string[]`, not a `sample` or a `head` or a `tail`. Runtime
 *    redaction only catches the places someone remembered to redact; a type
 *    with nowhere to put a conversation cannot leak one, however the report is
 *    serialised. testing.md §8.4 asserts this at the type level.
 *  - **Every action explains itself.** The report is the primary output of a
 *    dry run and the only way a user can audit what happened, so each entry
 *    carries the four facts the decision rested on rather than a message.
 */
import type { Action, PlanFlag } from "../domain/planner";
import type { PathViolation } from "../domain/types";

export type ActionResult =
  | "APPLIED"
  | "DEFERRED"
  /** A precondition moved during apply; cancelled deliberately, replanned next pass. */
  | "ABORTED_PRECONDITION"
  | "SKIPPED_BUDGET"
  | "SKIPPED_POLICY"
  | "FAILED_IO"
  /** The backup could not be written, so the overwrite it protected was cancelled. */
  | "FAILED_BACKUP";

/** Only FAILED_* count as errors; the rest are ordinary outcomes (§7.1). */
export function isErrorResult(result: ActionResult): boolean {
  return result === "FAILED_IO" || result === "FAILED_BACKUP";
}

/**
 * Why an action was chosen — the four-tuple of §11, never free text.
 *
 * Sizes and line counts are safe to report; bytes are not. Hashes appear as
 * their first 8 hex characters only.
 */
export interface DecisionEvidence {
  readonly localLines: number | null;
  readonly remoteLines: number | null;
  readonly relation: string;
  readonly stability: string;
  readonly localHashPrefix: string | null;
  readonly remoteHashPrefix: string | null;
}

export interface ActionEntry {
  readonly providerId: string;
  /** First 8 characters — never the whole id (§11.1). */
  readonly logicalIdPrefix: string;
  /** Root symbol plus relative path; never a bare absolute path. */
  readonly neutralRel: string;
  readonly action: Action;
  readonly result: ActionResult;
  readonly reason: string;
  readonly flags: readonly PlanFlag[];
  readonly conflictKnown: boolean;
  readonly evidence: DecisionEvidence;
  /**
   * Present on every applied `*_OVERWRITE`. Its absence there is an
   * implementation bug, and testing.md §1.2 I1-a asserts it directly.
   */
  readonly backupPath?: string;
  /** Set when the deterministic quarantine directory was created or reused. */
  readonly conflictId?: string;
  readonly errorCode?: string;
}

export interface ViolationEntry {
  readonly rootSymbol: string;
  readonly relativePath: string;
  readonly violation: PathViolation;
  readonly detail?: string;
}

export type PassOutcome = "ok" | "partial" | "failed" | "aborted";

export interface PassReport {
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  readonly outcome: PassOutcome;
  readonly dryRun: boolean;
  /** Set when the pass stopped before P1; nothing was written on either side. */
  readonly abortReason?: string;
  readonly actions: readonly ActionEntry[];
  readonly violations: readonly ViolationEntry[];
  readonly notices: readonly string[];
}

/**
 * The observation points of §9.1.4 and the crash points of testing.md §7.4.
 *
 * `SyncEngine` awaits a barrier at each one. In production every barrier is a
 * no-op that returns synchronously; in tests they are where a crash, a
 * concurrent write or an overlapping pass gets injected. Without them the race
 * and crash matrices cannot be written at all — which is why they are part of
 * the engine's contract rather than a testing afterthought.
 */
export type HookPoint =
  | "P0:preflight-done"
  | "P1:discover-done"
  | "P2:o1-taken"
  | "P2:o2-taken"
  | "P3:bytes-read"
  | "P3:o3-taken"
  | "P4:planned"
  | "P5:guarded"
  | "P6:before-backup"
  | "P6:after-backup"
  | "P6:before-rename"
  | "P6:after-rename"
  | "P7:reconciled"
  | "P8:before-commit"
  | "P8:committed";

export type Barrier = (point: HookPoint, context: { readonly neutralRel?: string }) => Promise<void>;

/** Production barrier: returns without yielding, so it costs nothing. */
export const noopBarrier: Barrier = () => Promise.resolve();

/**
 * A crash signal that is deliberately not an Error.
 *
 * `SyncEngine` has no catch-all (testing.md §3 requirement 9), and the
 * error handling it does have is keyed on known errno values. A crash injected
 * by a test must therefore be unable to look like an I/O failure, or the engine
 * would "handle" it and the crash-point matrix would be testing recovery from
 * something that never happened.
 */
export class CrashSignal {
  readonly isCrashSignal = true;
  constructor(readonly at: HookPoint) {}
}

export function isCrashSignal(value: unknown): value is CrashSignal {
  return typeof value === "object" && value !== null && "isCrashSignal" in value;
}

/** Short, stable prefix for ids in reports (§11.1). */
export function idPrefix(id: string): string {
  return id.slice(0, 8);
}

export function hashPrefix(hash: string): string {
  const bare = hash.startsWith("sha256:") ? hash.slice(7) : hash;
  return bare.slice(0, 8);
}
