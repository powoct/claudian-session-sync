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
  /** A side has dropped below the last convergence this machine witnessed. */
  | "shrankBelowConverged";

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
 * Rule EV-1: the manifest is a hint, never an authority. Its single member is a
 * boolean whose only possible effect is to turn a write into a DEFER — it can
 * make a decision more conservative and nothing else. It lives in a named
 * object rather than as a loose field so that adding anything hash-shaped here
 * looks as wrong as it is.
 *
 * Deliberately holds *only* manifest-derived values. The manifest is written by
 * other machines and read as untrusted text (architecture §5.2); mixing a local
 * observation into this object would be an invitation to feed remote strings
 * into a decision path that is supposed to rest on what this machine saw.
 */
export interface DeferOnlyHints {
  /** The manifest recorded this remote file at non-zero size in the past. */
  readonly remoteHadNonZeroSize: boolean;
}

/**
 * This machine's own observation history, from the local ledger.
 *
 * Separate from `DeferOnlyHints` on purpose: same shape of influence, entirely
 * different provenance. Nothing here has crossed a network or a sync directory.
 */
export interface LocalHistory {
  /** Consecutive passes in which a side's tail failed to parse. */
  readonly truncatedTailPasses: number;
  /**
   * This side is now shorter than the last convergence this machine witnessed,
   * and the other side still contains that convergence (OQ-14, ADR-61).
   *
   * Booleans rather than the base size itself, deliberately. A number named
   * `convergedSize` sitting in `PlanInput` is one careless edit away from
   * `if (local.size > convergedSize) PUSH_OVERWRITE` — a remembered quantity
   * authorising a write, which is the whole of what EV-1 forbids. A flag named
   * for the veto it feeds cannot be read that way.
   */
  readonly localShrankBelowConverged: boolean;
  readonly remoteShrankBelowConverged: boolean;
}

/**
 * Has a side fallen below the point both sides last agreed on?
 *
 * The prefix relation proves *containment of bytes* and is read as "the
 * shorter side is behind". For a file the user deliberately shortened — a Grok
 * rewind, a `/compact`, a restored backup — that reading is exactly wrong: the
 * short side is not behind, it is where the user chose to be, and
 * fast-forwarding undoes the choice silently (OQ-14, reproduced end to end).
 *
 * Three conjuncts, none decorative:
 *
 * - `sideSize < convergedSize` — this side has gone backwards past a point it
 *   once held. Nothing about *when*; a size compared against a base, never
 *   against the other side.
 * - `convergedSize <= otherSize` — the base still sits inside the side that
 *   would win. This is what makes the sentence "dropped below something the
 *   other side still contains" true rather than merely arithmetic, and it
 *   bounds a corrupt base to a no-op instead of a permanent conflict.
 * - `sideSize > 0` — a zero-byte side is damage or a half-finished transfer,
 *   never a rewind, and the table's standing rule is that it never produces a
 *   CONFLICT. It has no branch to quarantine either.
 *
 * Only ever narrows what may overwrite: every input that fails leaves the
 * existing decision untouched. A missing base costs a manual conflict where a
 * fast-forward would have done — §5.5's "losing the ledger is slow, never
 * wrong", the same degradation ADR-48 already accepts for the base's hash.
 */
export function shrankBelowConvergedBase(input: {
  readonly sideSize: number;
  readonly otherSize: number;
  readonly convergedSize: number | null;
}): boolean {
  const { sideSize, otherSize, convergedSize } = input;
  if (convergedSize === null) return false;
  return sideSize > 0 && sideSize < convergedSize && convergedSize <= otherSize;
}

export interface PlanInput {
  readonly remote: RemoteReadiness;
  readonly local: SideFacts;
  readonly remoteSide: SideFacts;
  readonly relation: PrefixRelation;
  /** A deterministic quarantine directory for this exact pair already exists. */
  readonly conflictKnown: boolean;
  readonly maxFileSizeBytes: number;
  readonly hints: DeferOnlyHints;
  readonly history: LocalHistory;
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
  const { local, remoteSide: remote, hints, history } = input;
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

  // 5 — stability, with no exceptions (ADR-70).
  //
  // §9.1.3 used to carve one out: a brand-new remote session could be pulled
  // without waiting out the quiet window, on the grounds that creating a file
  // risks nothing this machine already had. It was never wired up, and it is
  // not being wired up — the condition that carried it was an intra-pass second
  // observation, which ADR-63 retired, and the signal left over (every JSONL
  // line parses) is blind to the one thing it had to catch: a half-landed
  // append-only file parses perfectly, because a prefix of it is a valid file.
  const truncated = tailIsTruncated(local) || tailIsTruncated(remote);
  if (truncated) {
    flags.push("truncatedTail");
    if (history.truncatedTailPasses >= MALFORMED_TAIL_PASSES) flags.push("malformedTail");
    return result("DEFER", "tail-not-parseable", flags);
  }
  if ((local.exists && !local.stable) || (remote.exists && !remote.stable)) {
    return result("DEFER", "side-unstable", flags);
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
    // The peer shortened it on purpose. Pushing this machine's longer copy
    // would republish the turns they just removed — the same silent undo as
    // below, one machine over, and the reason the guard is not one-sided:
    // without it a rewind resolved on A is resurrected by an idle B.
    if (history.remoteShrankBelowConverged) {
      flags.push("shrankBelowConverged");
      return result("CONFLICT", "remote-shrank-below-converged", flags);
    }
    return result("PUSH_OVERWRITE", "local-extends-remote", flags);
  }
  if (relation === "r-extends-l") {
    // OQ-14. "Shorter and contained" normally means "behind", and pulling is
    // right. It is not right when this machine's own copy has dropped below a
    // point both sides once held: that is a deliberate truncation, and the
    // fast-forward would undo it without a word. Neither side may win on
    // containment alone, so the human decides — which is what §16 always
    // claimed happened here, and did not.
    if (history.localShrankBelowConverged) {
      flags.push("shrankBelowConverged");
      return result("CONFLICT", "local-shrank-below-converged", flags);
    }
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

/**
 * The opaque-file decision table (architecture §7.2b, ADR-48).
 *
 * No prefix relation exists here, so the append table's one verifiable safety
 * condition — "the overwritten bytes are contained in the new bytes" — is
 * unavailable. Its replacement is the converged base: this machine's ledger
 * remembers the hash of the content both sides held at the last convergence
 * *it witnessed*, and a side whose bytes (read this pass) still equal that
 * base has provably not moved since. Overwriting the unmoved side loses
 * nothing that is not already the other side's past — and it is backed up
 * regardless.
 *
 * Everything else stays manual. Both sides moved, or the base is missing
 * (fresh ledger, first contact between two populated stores): CONFLICT, both
 * branches quarantined, a human picks. The base is never an authorisation
 * cache in the ADR-12 sense — both hashes under comparison come from bytes
 * read this pass; the base only tells us which of those bytes are history.
 */
export interface OpaquePlanInput {
  readonly remote: RemoteReadiness;
  readonly local: SideFacts;
  readonly remoteSide: SideFacts;
  /** This exact pair is already quarantined (same meaning as PlanInput's). */
  readonly conflictKnown: boolean;
  readonly maxFileSizeBytes: number;
  /**
   * Hash of the content both sides held at the last convergence this machine
   * witnessed, or null when it has never seen one (or the ledger was lost —
   * which degrades fast-forwards to conflicts, never picks a side).
   */
  readonly lastConvergedHash: string | null;
  /**
   * A file beside this one in the replica holds exactly this machine's current
   * bytes (OQ-18, ADR-57).
   *
   * Computed outside the planner, from bytes read this pass, in the #4b shape
   * only. Remote-written and therefore untrusted, which is why it is permitted
   * to do exactly one thing: withhold a write that would otherwise happen. It
   * can never authorise one, so EV-1 and §5.6 rule 3 stay literally true and
   * the change is safer than its absence by construction.
   */
  readonly displacedPushWitness: boolean;
}

export function planOpaque(input: OpaquePlanInput): PlanResult {
  const { local, remoteSide: remote } = input;
  const flags: PlanFlag[] = [];

  if (input.remote === "unsupported-format") {
    return result("SKIP_UNSUPPORTED_FORMAT", "format-version-unsupported", flags);
  }
  if (input.remote === "not-ready") {
    return result("SKIP_REMOTE_NOT_READY", "remote-not-ready", flags);
  }
  if (local.size > input.maxFileSizeBytes || remote.size > input.maxFileSizeBytes) {
    return result("SKIP_TOO_LARGE", "over-size-limit", flags);
  }
  if (local.isPlaceholder || remote.isPlaceholder) {
    return result("SKIP_PLACEHOLDER", "cloud-placeholder", flags);
  }
  // §7.2b #6 — same stability bar, no tail check: there are no lines here, and
  // no fast path either. The fast path exists because a session someone just
  // started is worth landing eagerly; a metadata blob is not that.
  if ((local.exists && !local.stable) || (remote.exists && !remote.stable)) {
    return result("DEFER", "side-unstable", flags);
  }
  // §7.2b #8 — zero bytes is not "absent" and not "the empty prefix" either:
  // for a whole-file format an empty file is most plausibly a write caught
  // mid-flight, and the conservative reading of that is to wait.
  if ((local.exists && local.size === 0) || (remote.exists && remote.size === 0)) {
    return result("DEFER", "opaque-zero-byte-side", flags);
  }

  if (input.conflictKnown) {
    return { action: "NOOP", reason: "conflict-already-known", flags, conflictKnown: true };
  }

  // #1 — converged. The caller records the base from this.
  if (local.exists && remote.exists && local.observedHash === remote.observedHash) {
    return result("NOOP", "content-identical", flags);
  }

  // #4a/#4b — one side still equals the last witnessed convergence.
  if (local.exists && remote.exists) {
    const base = input.lastConvergedHash;
    if (base !== null && remote.observedHash === base) {
      return result("PUSH_OVERWRITE", "remote-at-converged-base", flags);
    }
    if (base !== null && local.observedHash === base) {
      // OQ-18. Inside this branch `local === base`, so "a sibling in the
      // replica holds my local bytes" and "it holds the base" are the same
      // test — and it is positive evidence that the bytes the sync tool set
      // aside are *mine*. Without it this branch cannot tell a peer's
      // legitimate edit from the transport discarding this machine's push:
      // both present as local == base, remote != base, with identical
      // observation histories (the proof is in ADR-57). The witness is false
      // on the machine whose version won, false on an idle third machine, and
      // it clears itself the moment the local record is rewritten.
      if (input.displacedPushWitness) {
        return result("CONFLICT", "opaque-push-set-aside-by-sync-tool", flags);
      }
      return result("PULL_OVERWRITE", "local-at-converged-base", flags);
    }
    // #4c — both moved, or no base to reason from.
    return result(
      "CONFLICT",
      base === null ? "opaque-divergent-no-base" : "opaque-divergent-both-moved",
      flags,
    );
  }

  // #2/#3 — one side only. Zero-byte sides were already deferred above.
  if (local.exists && !remote.exists) return result("PUSH_NEW", "local-only", flags);
  if (!local.exists && remote.exists) return result("PULL_NEW", "remote-only", flags);

  return result("NOOP", "neither-side-exists", flags);
}
