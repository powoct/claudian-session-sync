/**
 * The decision table (architecture §7.2).
 *
 * One session, two sides, one action. Evaluated as a priority ladder, not a
 * table scan: the order is normative and the tests assert it, because every
 * dangerous outcome in this system is a rule firing later than it should.
 *
 *   1 format version → 2 remote readiness → 3 size → 4 placeholder →
 *   5 stability → 6 known conflict → 7 equal content → 8 divergence →
 *   9 prefix → 10 one side only
 *
 * The input type carries only facts observed *this pass*. There is deliberately
 * no field a cached hash could arrive in — that is the U-18 failure mode, where
 * a manifest's remembered hash lets the planner conclude "still a prefix" about
 * bytes that were replaced behind its back, and silently overwrite them. The
 * one manifest-derived value allowed anywhere near this function is a boolean
 * that can only ever push a decision toward DEFER (rule EV-1).
 */
import type { TailState } from "./merge-policy";

export type Action =
  | "PUSH_NEW"
  | "PULL_NEW"
  | "PUSH_OVERWRITE"
  | "PULL_OVERWRITE"
  | "CONFLICT"
  | "NOOP"
  | "NOOP_EMPTY"
  | "DEFER"
  | "SKIP_EMPTY"
  | "SKIP_TOO_LARGE"
  | "SKIP_PLACEHOLDER"
  | "SKIP_REMOTE_NOT_READY"
  | "SKIP_UNSUPPORTED_FORMAT";

export type RemoteReadiness = "ready" | "not-ready" | "unsupported-format";

/** How the two sides' bytes relate. "n/a" when one of them is absent. */
export type PrefixRelation = "equal" | "l-extends-r" | "r-extends-l" | "divergent" | "n/a";

export type PlanFlag =
  /** A remote file that once had content is now zero bytes (§9.6 input). */
  | "remoteRegression"
  /** A side's last record is incomplete; it may not be an overwrite source. */
  | "truncatedTail"
  /** Same, and it has stayed that way long enough that a human should see it. */
  | "malformedTail"
  /** A new remote session landed without waiting out the quiet window (§9.1.3). */
  | "pullNewFastPath";

/**
 * What one side looks like right now.
 *
 * Every field is an observation from this pass. `observedHash` is over bytes
 * read this pass or it is not set at all — never a remembered value.
 */
export interface SideFacts {
  readonly exists: boolean;
  readonly size: number;
  readonly observedHash: string;
  readonly stable: boolean;
  readonly tail: TailState;
  readonly isPlaceholder: boolean;
}

/**
 * Manifest-derived input, quarantined into its own field.
 *
 * Rule EV-1: the manifest is a hint, never an authority. A value in here may
 * only ever make a decision *more* conservative — the single member is a
 * boolean whose only effect is to turn a write into a DEFER. It is a separate
 * object rather than a loose field so that adding anything hash-shaped here
 * looks as wrong as it is.
 */
export interface DeferOnlyHints {
  /** The manifest recorded this remote file at non-zero size in the past. */
  readonly remoteHadNonZeroSize: boolean;
  /** Consecutive passes in which this side's tail failed to parse. */
  readonly truncatedTailPasses: number;
}

export interface PlanInput {
  readonly remote: RemoteReadiness;
  readonly local: SideFacts;
  readonly remoteSide: SideFacts;
  readonly relation: PrefixRelation;
  /** A deterministic quarantine directory for this exact pair already exists. */
  readonly conflictKnown: boolean;
  readonly maxFileSizeBytes: number;
  /** All §9.1.3 conditions met; the only route to a write from unstable input. */
  readonly pullNewFastPath: boolean;
  readonly hints: DeferOnlyHints;
}

export interface PlanResult {
  readonly action: Action;
  /** Stable code naming the rule that fired; goes into the report verbatim. */
  readonly reason: string;
  readonly flags: readonly PlanFlag[];
  /** Only meaningful on NOOP — there is no CONFLICT_KNOWN action. */
  readonly conflictKnown: boolean;
}

/** Passes that a tail may stay unparseable before a human is told (U-11d). */
export const MALFORMED_TAIL_PASSES = 5;

export function plan(input: PlanInput): PlanResult {
  const { local, remoteSide: remote, hints } = input;
  const flags: PlanFlag[] = [];

  // 1 — the neutral layout is from a newer version of this plugin. Reading it
  // is guesswork and writing it would corrupt it for the machine that can.
  if (input.remote === "unsupported-format") {
    return result("SKIP_UNSUPPORTED_FORMAT", "format-version-unsupported", flags);
  }

  // 2 — a sync directory that is empty, half-hydrated or not the one we know is
  // indistinguishable from "the other machine deleted everything". Never write.
  if (input.remote === "not-ready") {
    return result("SKIP_REMOTE_NOT_READY", "remote-not-ready", flags);
  }

  // 3 — before divergence can be claimed, the whole file has to have been read.
  if (local.size > input.maxFileSizeBytes || remote.size > input.maxFileSizeBytes) {
    return result("SKIP_TOO_LARGE", "over-size-limit", flags);
  }

  // 4 — a cloud placeholder's bytes are not here. Reading it would trigger a
  // download mid-pass; trusting its size would be worse.
  if (local.isPlaceholder || remote.isPlaceholder) {
    return result("SKIP_PLACEHOLDER", "cloud-placeholder", flags);
  }

  // 5 — stability, with exactly one exception in the whole system.
  const fastPath = !local.exists && remote.exists && input.pullNewFastPath;
  if (!fastPath) {
    const truncated = tailIsTruncated(local) || tailIsTruncated(remote);
    if (truncated) {
      flags.push("truncatedTail");
      if (hints.truncatedTailPasses >= MALFORMED_TAIL_PASSES) flags.push("malformedTail");
      return result("DEFER", "tail-not-parseable", flags);
    }
    if ((local.exists && !local.stable) || (remote.exists && !remote.stable)) {
      return result("DEFER", "side-unstable", flags);
    }
  } else {
    flags.push("pullNewFastPath");
  }

  // Zero-byte normalisation, before any relation is trusted.
  //
  // Zero bytes is not "absent" — it is the empty prefix of every possible file,
  // so it can never diverge from anything. Any implementation that reports
  // CONFLICT for a zero-byte side has a bug, so rather than trusting the
  // relation handed in, it is recomputed here.
  const bothEmpty = local.exists && remote.exists && local.size === 0 && remote.size === 0;
  if (bothEmpty) {
    return result("NOOP_EMPTY", "both-sides-empty", flags);
  }

  const relation = normaliseRelation(input);

  // 6 — this exact pair of contents has already been quarantined. Re-copying it
  // every pass would pile up identical files forever.
  if (input.conflictKnown) {
    return { action: "NOOP", reason: "conflict-already-known", flags, conflictKnown: true };
  }

  // 7 — nothing to do.
  if (local.exists && remote.exists && local.observedHash === remote.observedHash) {
    return result("NOOP", "content-identical", flags);
  }

  // 8 — genuinely forked. Neither side may overwrite the other, whichever is
  // longer: this is the case "more lines wins" used to lose data on.
  if (relation === "divergent") {
    return result("CONFLICT", "divergent-content", flags);
  }

  // 9 — one side strictly contains the other.
  if (relation === "l-extends-r") {
    // A remote file that had content and is now empty is a symptom of the sync
    // tool misbehaving, not of the user emptying a session. Overwriting it
    // would make this machine's copy authoritative on the strength of the other
    // side having broken.
    if (remote.exists && remote.size === 0 && hints.remoteHadNonZeroSize) {
      flags.push("remoteRegression");
      return result("DEFER", "remote-regressed-to-empty", flags);
    }
    return result("PUSH_OVERWRITE", "local-extends-remote", flags);
  }
  if (relation === "r-extends-l") {
    return result("PULL_OVERWRITE", "remote-extends-local", flags);
  }

  // 10 — only one side has it.
  if (local.exists && !remote.exists) {
    // An empty local file is not worth publishing; there is nothing in it.
    if (local.size === 0) return result("SKIP_EMPTY", "local-empty-not-published", flags);
    return result("PUSH_NEW", "local-only", flags);
  }
  if (!local.exists && remote.exists) {
    if (remote.size === 0) return result("SKIP_EMPTY", "remote-empty-not-landed", flags);
    return result("PULL_NEW", "remote-only", flags);
  }

  // Neither side exists: nothing to plan. Reached only from a stale work list.
  return result("NOOP", "neither-side-exists", flags);
}

/**
 * Recomputes the relation when a side is empty.
 *
 * The caller derives `relation` from a byte comparison, which is right whenever
 * there are bytes. With zero on one side the answer is a matter of definition,
 * and defining it here is what makes "a zero-byte file never produces CONFLICT"
 * true by construction rather than by everyone remembering.
 */
function normaliseRelation(input: PlanInput): PrefixRelation {
  const { local, remoteSide: remote } = input;
  if (!local.exists || !remote.exists) return "n/a";
  if (local.size === 0 && remote.size === 0) return "equal";
  if (local.size === 0) return "r-extends-l";
  if (remote.size === 0) return "l-extends-r";
  return input.relation;
}

function tailIsTruncated(side: SideFacts): boolean {
  return side.exists && side.size > 0 && side.tail === "truncated";
}

function result(action: Action, reason: string, flags: readonly PlanFlag[]): PlanResult {
  return { action, reason, flags, conflictKnown: false };
}
