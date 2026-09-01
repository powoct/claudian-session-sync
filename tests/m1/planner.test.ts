/**
 * testing.md §5.2 — the decision table.
 *
 * Two of these are the most important tests in the project. U-07 guards the
 * shape "more lines wins" takes when it loses data; U-18 guards the shape "use
 * the cached hash" takes when it loses data. If someone simplifies away the
 * prefix check or reintroduces a manifest hash, these two must be the first
 * things to go red.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type Action,
  type PlanInput,
  type PrefixRelation,
  type SideFacts,
  plan,
  MALFORMED_TAIL_PASSES,
  shrankBelowConvergedBase,
} from "../../src/domain/planner";

const MAX_BYTES = 20 * 1024 * 1024;

const side = (overrides: Partial<SideFacts> = {}): SideFacts => ({
  exists: true,
  size: 4096,
  observedHash: "hash-l",
  stable: true,
  tail: "lf-terminated",
  isPlaceholder: false,
  ...overrides,
});

const absent = (): SideFacts => side({ exists: false, size: 0, observedHash: "" });

/** Per-side builders, so an override never silently inherits the other side's hash. */
const L = (overrides: Partial<SideFacts> = {}): SideFacts => side({ observedHash: "hash-l", ...overrides });
const R = (overrides: Partial<SideFacts> = {}): SideFacts => side({ observedHash: "hash-r", ...overrides });

const input = (overrides: Partial<PlanInput> = {}): PlanInput => ({
  remote: "ready",
  local: L(),
  remoteSide: R(),
  relation: "divergent",
  conflictKnown: false,
  maxFileSizeBytes: MAX_BYTES,
  hints: { remoteHadNonZeroSize: false },
  history: {
    truncatedTailPasses: 0,
    localShrankBelowConverged: false,
    remoteShrankBelowConverged: false,
  },
  ...overrides,
});

const actionOf = (overrides: Partial<PlanInput> = {}): Action => plan(input(overrides)).action;

describe("§5.2.1 basic cells", () => {
  it("U-01: local only -> PUSH_NEW", () => {
    expect(actionOf({ remoteSide: absent(), relation: "n/a" })).toBe("PUSH_NEW");
  });

  it("U-02: remote only -> PULL_NEW", () => {
    expect(actionOf({ local: absent(), relation: "n/a" })).toBe("PULL_NEW");
  });

  it("U-03: identical -> NOOP", () => {
    expect(actionOf({ remoteSide: R({ observedHash: "hash-l" }), relation: "equal" })).toBe("NOOP");
  });

  it("U-04: local strictly extends remote -> PUSH_OVERWRITE", () => {
    expect(actionOf({ relation: "l-extends-r" })).toBe("PUSH_OVERWRITE");
  });

  it("U-05: remote strictly extends local -> PULL_OVERWRITE", () => {
    expect(actionOf({ relation: "r-extends-l" })).toBe("PULL_OVERWRITE");
  });

  it("U-06: same length, different content -> CONFLICT", () => {
    expect(actionOf({ relation: "divergent" })).toBe("CONFLICT");
  });

  /**
   * U-07, core test 1 of 2.
   *
   * Both sides share a history and then fork; the remote branch is longer. The
   * rule this replaced ("more lines wins") would let the longer branch
   * overwrite the shorter one, and the three exchanges on the local machine
   * would vanish with no error and no backup anyone would think to look for.
   */
  it("U-07: a longer fork is still a CONFLICT, not an overwrite", () => {
    const result = plan(
      input({
        local: L({ size: 108 * 120, observedHash: "fork-a" }),
        remoteSide: R({ size: 115 * 120, observedHash: "fork-b" }),
        relation: "divergent",
      }),
    );

    expect(result.action).toBe("CONFLICT");
    expect(result.action).not.toBe("PULL_OVERWRITE");
  });

  it("U-08: unstable local -> DEFER", () => {
    expect(actionOf({ local: L({ stable: false }), relation: "r-extends-l" })).toBe("DEFER");
  });

  it("U-09: unstable remote -> DEFER", () => {
    expect(actionOf({ remoteSide: R({ stable: false }), relation: "l-extends-r" })).toBe("DEFER");
  });

  it("U-10: oversized -> SKIP_TOO_LARGE", () => {
    expect(actionOf({ local: L({ size: 25 * 1024 * 1024 }), remoteSide: absent() })).toBe(
      "SKIP_TOO_LARGE",
    );
  });

  it("U-13: an already-quarantined pair -> NOOP carrying conflictKnown", () => {
    // Not a CONFLICT_KNOWN action: a separate action name would make the
    // stable-conflict invariant unreachable. It is a NOOP with a flag.
    const result = plan(input({ conflictKnown: true, relation: "divergent" }));
    expect(result.action).toBe("NOOP");
    expect(result.conflictKnown).toBe(true);
  });
});

describe("§5.2.2 tail integrity (U-11)", () => {
  it("U-11a/b: a complete final record without a newline is ordinary content", () => {
    // Treating "no trailing LF" as "incomplete" would defer good files forever.
    expect(actionOf({ local: L({ tail: "complete-no-lf" }), relation: "l-extends-r" })).toBe(
      "PUSH_OVERWRITE",
    );
  });

  it("U-11c: a half-written record -> DEFER, flagged", () => {
    const result = plan(input({ local: L({ tail: "truncated" }), relation: "l-extends-r" }));
    expect(result.action).toBe("DEFER");
    expect(result.flags).toContain("truncatedTail");
  });

  it("U-11c: a truncated remote defers too", () => {
    expect(actionOf({ remoteSide: R({ tail: "truncated" }), relation: "r-extends-l" })).toBe("DEFER");
  });

  it("U-11d: a tail that stays broken becomes visible instead of looping silently", () => {
    const result = plan(
      input({
        local: L({ tail: "truncated" }),
        history: { truncatedTailPasses: MALFORMED_TAIL_PASSES , localShrankBelowConverged: false, remoteShrankBelowConverged: false},
      }),
    );
    expect(result.action).toBe("DEFER");
    expect(result.flags).toContain("malformedTail");
  });
});

describe("§5.2.3 zero-byte files (U-12)", () => {
  it("U-12a: empty local, unstable remote -> DEFER", () => {
    expect(
      actionOf({ local: L({ size: 0 }), remoteSide: R({ stable: false }), relation: "r-extends-l" }),
    ).toBe("DEFER");
  });

  it("U-12b: empty local, stable remote -> PULL_OVERWRITE, not PULL_NEW", () => {
    // Zero bytes is not "absent": it is the empty prefix, so this is the
    // overwrite branch and it goes through the ordinary backup path.
    expect(actionOf({ local: L({ size: 0 }), relation: "r-extends-l" })).toBe("PULL_OVERWRITE");
  });

  it("U-12c: empty remote, unstable -> DEFER, never PUSH_OVERWRITE", () => {
    const action = actionOf({ remoteSide: R({ size: 0, stable: false }), relation: "l-extends-r" });
    expect(action).toBe("DEFER");
    expect(action).not.toBe("PUSH_OVERWRITE");
  });

  it("U-12d: empty remote, stable, never had content -> PUSH_OVERWRITE", () => {
    expect(actionOf({ remoteSide: R({ size: 0 }), relation: "l-extends-r" })).toBe("PUSH_OVERWRITE");
  });

  it("U-12e: empty remote that used to have content -> DEFER + remoteRegression", () => {
    // The sync tool emptying a file is a symptom, not an instruction.
    const result = plan(
      input({
        remoteSide: R({ size: 0 }),
        relation: "l-extends-r",
        hints: { remoteHadNonZeroSize: true },
      }),
    );
    expect(result.action).toBe("DEFER");
    expect(result.flags).toContain("remoteRegression");
  });

  it("U-12f: both empty -> NOOP_EMPTY", () => {
    expect(actionOf({ local: L({ size: 0 }), remoteSide: R({ size: 0 }), relation: "equal" })).toBe(
      "NOOP_EMPTY",
    );
  });

  it("U-12g: empty local, remote absent -> SKIP_EMPTY", () => {
    expect(actionOf({ local: L({ size: 0 }), remoteSide: absent(), relation: "n/a" })).toBe(
      "SKIP_EMPTY",
    );
  });

  it("U-12h: a cloud placeholder -> SKIP_PLACEHOLDER", () => {
    expect(actionOf({ remoteSide: R({ size: 0, isPlaceholder: true }) })).toBe("SKIP_PLACEHOLDER");
  });

  it("overrides a caller that claims a zero-byte side diverged", () => {
    // The byte-comparison layer cannot legitimately produce this, so if it ever
    // does, the safe reading is the one that is true by definition: the empty
    // side is a prefix. Overwriting an empty file loses nothing, and it is
    // backed up either way.
    expect(actionOf({ local: L({ size: 0 }), relation: "divergent" })).toBe("PULL_OVERWRITE");
    expect(actionOf({ remoteSide: R({ size: 0 }), relation: "divergent" })).toBe("PUSH_OVERWRITE");
  });

  it("a zero-byte side never produces CONFLICT, whatever relation is claimed", () => {
    // Absolute assertion: zero bytes is a prefix of every possible file, so
    // divergence is not a thing it can be in. Asserted against a caller that
    // insists otherwise.
    for (const relation of ["equal", "divergent", "l-extends-r", "r-extends-l"] as const) {
      expect(actionOf({ local: L({ size: 0 }), relation })).not.toBe("CONFLICT");
      expect(actionOf({ remoteSide: R({ size: 0 }), relation })).not.toBe("CONFLICT");
      expect(
        actionOf({ local: L({ size: 0 }), remoteSide: R({ size: 0 }), relation }),
      ).not.toBe("CONFLICT");
    }
  });
});

describe("§5.2.6 a side that fell below the last convergence (OQ-14, ADR-61)", () => {
  // Measured, not imagined: a Grok rewind truncates chat_history.jsonl in
  // place (165,566 -> 159,924 B, 69 -> 53 lines) and `/compact` rewrites it
  // wholesale. The append table reads "shorter, and contained by the other
  // side" as "behind" and fast-forwards — which undoes the user's rewind, and
  // did so in an end-to-end repro with no notice at all.
  const shrunk = (overrides: Partial<PlanInput> = {}): PlanInput =>
    input({
      local: L({ size: 140 }),
      remoteSide: R({ size: 210 }),
      relation: "r-extends-l",
      history: {
        truncatedTailPasses: 0,
        localShrankBelowConverged: true,
        remoteShrankBelowConverged: false,
      },
      ...overrides,
    });

  it("refuses the fast-forward that would undo it, and says which", () => {
    const decision = plan(shrunk());
    expect(decision.action).toBe("CONFLICT");
    expect(decision.reason).toBe("local-shrank-below-converged");
    expect(decision.flags).toContain("shrankBelowConverged");
  });

  it("still fast-forwards when the local side merely lagged", () => {
    // The ordinary case, and by far the common one: the peer appended, this
    // machine is behind. Nothing shrank, so nothing changes.
    expect(actionOf({ local: L({ size: 140 }), remoteSide: R({ size: 210 }), relation: "r-extends-l" })).toBe(
      "PULL_OVERWRITE",
    );
  });

  it("guards the mirror, so a resolved rewind is not resurrected by an idle peer", () => {
    // Without this, the fix only relocates the defect: A rewinds, the user
    // resolves keep-local, A pushes — and B, still holding the pre-rewind
    // version, pushes it straight back.
    const decision = plan(
      input({
        local: L({ size: 210 }),
        remoteSide: R({ size: 140 }),
        relation: "l-extends-r",
        history: {
          truncatedTailPasses: 0,
          localShrankBelowConverged: false,
          remoteShrankBelowConverged: true,
        },
      }),
    );
    expect(decision.action).toBe("CONFLICT");
    expect(decision.reason).toBe("remote-shrank-below-converged");
  });

  it("leaves the zero-byte remote on DEFER, which is a transport symptom", () => {
    // A remote that had content and is now empty stays #9's existing guard:
    // that is the sync tool mid-write, not somebody's rewind, and DEFER is the
    // answer that waits for it instead of asking the user about it.
    expect(
      plan(
        input({
          local: L({ size: 210 }),
          remoteSide: R({ size: 0 }),
          relation: "l-extends-r",
          hints: { remoteHadNonZeroSize: true },
          history: {
            truncatedTailPasses: 0,
            localShrankBelowConverged: false,
            remoteShrankBelowConverged: true,
          },
        }),
      ).reason,
    ).toBe("remote-regressed-to-empty");
  });
});

describe("§5.2.6 the rewind as it was actually measured (2026-08-30)", () => {
  // Not a shape, the numbers. macOS, grok 1.0.5, sandboxed GROK_HOME: a rewind
  // took chat_history.jsonl from 44,968 B / 41 lines to 39,790 B / 25 lines,
  // and `prefix-check` confirmed byte-for-byte that the short version IS the
  // long one with its tail cut off. That is the severe branch — a strict
  // prefix is exactly what the append table fast-forwards.
  const CONVERGED = 44_968;
  const REWOUND = 39_790;
  const AFTER_ONE_MORE_TURN = 41_711;

  it("refuses the fast-forward at the measured sizes", () => {
    expect(
      shrankBelowConvergedBase({
        sideSize: REWOUND,
        otherSize: CONVERGED,
        convergedSize: CONVERGED,
      }),
    ).toBe(true);
  });

  it("still refuses once the user has typed again", () => {
    // The probe found the window is narrow: one more message and the two
    // versions diverge outright, so rule #8 reaches the same answer first.
    // But `rewind_points.jsonl` grows back by whole records (515 -> 206 -> 309)
    // and may well still be a prefix of the pre-rewind file, which would put
    // it back on the fast-forward path. Being below the base catches it either
    // way, which is why the guard is not written in terms of the relation.
    expect(
      shrankBelowConvergedBase({
        sideSize: AFTER_ONE_MORE_TURN,
        otherSize: CONVERGED,
        convergedSize: CONVERGED,
      }),
    ).toBe(true);
  });

  it("also covers /compact, though divergence reaches the same answer first", () => {
    // Measured: compact took 41,711 -> 19,818 B, and `prefix-check` said NOT A
    // PREFIX — so the relation is `divergent` and rule #8 conflicts before #9a
    // is consulted at all. The guard would have fired anyway, which is the
    // useful property: it does not depend on which way the bytes happen to
    // relate. Asserted at the sizes the two sides really hold, not at a
    // combination picked to make the predicate say no.
    expect(
      shrankBelowConvergedBase({
        sideSize: 19_818,
        otherSize: AFTER_ONE_MORE_TURN,
        convergedSize: AFTER_ONE_MORE_TURN,
      }),
    ).toBe(true);
    // And rule #8 is what actually decides it, because the bytes diverge.
    expect(
      actionOf({
        local: L({ size: 19_818 }),
        remoteSide: R({ size: AFTER_ONE_MORE_TURN }),
        relation: "divergent",
      }),
    ).toBe("CONFLICT");
  });
});

describe("§5.2.6 the shrink predicate itself", () => {
  const base = { sideSize: 140, otherSize: 210, convergedSize: 210 };

  it("fires when a side dropped below a base the other side still contains", () => {
    expect(shrankBelowConvergedBase(base)).toBe(true);
  });

  it("is silent with no base — losing the ledger is slow, never wrong", () => {
    expect(shrankBelowConvergedBase({ ...base, convergedSize: null })).toBe(false);
  });

  it("is silent when the side merely lagged behind the base rather than falling below it", () => {
    expect(shrankBelowConvergedBase({ ...base, sideSize: 210, convergedSize: 140 })).toBe(false);
  });

  it("is silent when the other side does not contain the base either", () => {
    // Both sides moved off the base: that is an ordinary fork, and rule #8
    // reaches it first with the same answer. Saying yes here would also let a
    // corrupt base freeze a file in permanent conflict.
    expect(shrankBelowConvergedBase({ ...base, otherSize: 150, convergedSize: 210 })).toBe(false);
  });

  it("is silent for a zero-byte side, which is damage and never a rewind", () => {
    expect(shrankBelowConvergedBase({ ...base, sideSize: 0 })).toBe(false);
  });
});

describe("§5.2.4 remote readiness", () => {
  it("U-15: NOT_READY downgrades everything, including a brand-new local session", () => {
    expect(actionOf({ remote: "not-ready", remoteSide: absent(), relation: "n/a" })).toBe(
      "SKIP_REMOTE_NOT_READY",
    );
  });

  it("U-18r: an unsupported format version is read-only", () => {
    expect(actionOf({ remote: "unsupported-format" })).toBe("SKIP_UNSUPPORTED_FORMAT");
  });

  it("readiness outranks size, so a NOT_READY pass never even reports SKIP_TOO_LARGE", () => {
    expect(actionOf({ remote: "not-ready", local: L({ size: 25 * 1024 * 1024 }) })).toBe(
      "SKIP_REMOTE_NOT_READY",
    );
  });
});

describe("§5.2.5 U-18 — a cached hash must not be able to reach the planner", () => {
  /**
   * U-18a, the type-level layer.
   *
   * The failure it prevents: the manifest remembers remote R0's hash; an
   * external tool replaces the file with a same-size, same-mtime, divergent R1;
   * the local file extends R0. A planner willing to use the remembered hash
   * concludes R1 is still a prefix and pushes over it, and R1 is gone. The
   * defence is that there is nowhere for that hash to be passed in.
   */
  it("has no field a remembered hash could arrive in", () => {
    expectTypeOf<PlanInput>().not.toHaveProperty("manifestHash");
    expectTypeOf<PlanInput>().not.toHaveProperty("cachedHash");
    expectTypeOf<PlanInput>().not.toHaveProperty("lastKnownHash");
    expectTypeOf<PlanInput>().not.toHaveProperty("prefixHashes");
    expectTypeOf<PlanInput>().not.toHaveProperty("generation");
  });

  it("exposes hashes only as this-pass observations", () => {
    expectTypeOf<SideFacts>().toHaveProperty("observedHash");
    expectTypeOf<SideFacts>().not.toHaveProperty("hash");
  });

  it("quarantines the one manifest-derived input, and it is a boolean", () => {
    // Rule EV-1: it may only ever make a decision more conservative.
    expectTypeOf<PlanInput["hints"]["remoteHadNonZeroSize"]>().toEqualTypeOf<boolean>();
  });

  it("U-18b: same size, different content -> CONFLICT", () => {
    const result = plan(
      input({
        local: L({ size: 4096, observedHash: "L" }),
        remoteSide: R({ size: 4096, observedHash: "R1" }),
        relation: "divergent",
      }),
    );
    expect(result.action).toBe("CONFLICT");
  });
});

describe("§5.2.7 priority regressions", () => {
  it("unstable + divergent -> DEFER, not CONFLICT", () => {
    // An unstable observation is not enough to assert divergence.
    expect(actionOf({ local: L({ stable: false }), relation: "divergent" })).toBe("DEFER");
  });

  it("oversized + divergent -> SKIP_TOO_LARGE, not CONFLICT", () => {
    // Divergence must never be concluded from a file that was not read in full.
    expect(actionOf({ local: L({ size: 25 * 1024 * 1024 }), relation: "divergent" })).toBe(
      "SKIP_TOO_LARGE",
    );
  });

  it("NOT_READY + a new local session -> SKIP_REMOTE_NOT_READY, not PUSH_NEW", () => {
    expect(actionOf({ remote: "not-ready", remoteSide: absent(), relation: "n/a" })).toBe(
      "SKIP_REMOTE_NOT_READY",
    );
  });

  it("an unstable remote defers even when nothing exists here to lose", () => {
    // §9.1.3 used to exempt exactly this shape. ADR-70 withdrew the exemption:
    // a half-landed append-only file is a valid file, so "nothing to lose" is
    // not the same as "safe to take" — the moment it lands, the user can
    // resume the session and append to a prefix, and then neither side is a
    // prefix of the other.
    const result = plan(
      input({ local: absent(), remoteSide: R({ stable: false, observedHash: "hash-r" }), relation: "n/a" }),
    );
    expect(result.action).toBe("DEFER");
    expect(result.reason).toBe("side-unstable");
  });
});

describe("§5.2.7 exhaustive combinations", () => {
  const dims = {
    remote: ["ready", "not-ready", "unsupported-format"] as const,
    lExists: [true, false],
    rExists: [true, false],
    relation: ["equal", "l-extends-r", "r-extends-l", "divergent", "n/a"] as const,
    lStable: [true, false],
    rStable: [true, false],
    size: ["ok", "l-too-large", "r-too-large"] as const,
    zeroByte: ["none", "l-zero", "r-zero", "both-zero"] as const,
    tail: ["lf", "no-lf", "truncated"] as const,
    conflictKnown: [true, false],
    // Added after review: both were fixed constants, which left the
    // "never writes from an unstable side" assertion resting on two point
    // cases and a comment.
    placeholder: ["none", "l", "r"] as const,
    hadContent: [true, false],
  };

  const TAIL_STATES = {
    lf: "lf-terminated",
    "no-lf": "complete-no-lf",
    truncated: "truncated",
  } as const;

  function* combinations(): Generator<PlanInput> {
    for (const remote of dims.remote)
      for (const lExists of dims.lExists)
        for (const rExists of dims.rExists)
          for (const relation of dims.relation)
            for (const lStable of dims.lStable)
              for (const rStable of dims.rStable)
                for (const size of dims.size)
                  for (const zeroByte of dims.zeroByte)
                    for (const tail of dims.tail)
                      for (const conflictKnown of dims.conflictKnown)
                        for (const placeholder of dims.placeholder)
                            for (const hadContent of dims.hadContent) {
                        // Impossible states are filtered rather than asserted
                        // about: a relation between a file and nothing is not a
                        // case the planner can be wrong about.
                        const bothExist = lExists && rExists;
                        if (bothExist !== (relation !== "n/a")) continue;
                        if (!lExists && (zeroByte === "l-zero" || zeroByte === "both-zero")) continue;
                        if (!rExists && (zeroByte === "r-zero" || zeroByte === "both-zero")) continue;

                        const lZero = zeroByte === "l-zero" || zeroByte === "both-zero";
                        const rZero = zeroByte === "r-zero" || zeroByte === "both-zero";

                        // Also physically impossible: zero bytes is the empty
                        // prefix of every file, so a zero-byte side cannot have
                        // diverged from anything. The planner recomputes the
                        // relation rather than trusting such a claim — asserted
                        // separately below.
                        if ((lZero || rZero) && relation === "divergent") continue;

                        // A placeholder is a file that exists but whose bytes
                        // are not local; it cannot be claimed for a side that
                        // is not there at all.
                        if (placeholder === "l" && !lExists) continue;
                        if (placeholder === "r" && !rExists) continue;

                        yield {
                          remote,
                          local: {
                            exists: lExists,
                            size: lZero ? 0 : size === "l-too-large" ? MAX_BYTES + 1 : 4096,
                            observedHash: "hash-l",
                            stable: lStable,
                            tail: TAIL_STATES[tail],
                            isPlaceholder: placeholder === "l",
                          },
                          remoteSide: {
                            exists: rExists,
                            size: rZero ? 0 : size === "r-too-large" ? MAX_BYTES + 1 : 4096,
                            observedHash: "hash-r",
                            stable: rStable,
                            tail: TAIL_STATES[tail],
                            isPlaceholder: placeholder === "r",
                          },
                          relation,
                          conflictKnown,
                          maxFileSizeBytes: MAX_BYTES,
                          hints: { remoteHadNonZeroSize: hadContent },
                          history: { truncatedTailPasses: 0 , localShrankBelowConverged: false, remoteShrankBelowConverged: false},
                        };
                      }
  }

  const ALL = [...combinations()];

  it("generates a meaningful number of combinations", () => {
    // 20,736 as of ADR-70, down from twice that: the fast-path dimension was
    // binary and it is gone. The floor is deliberately just under the current
    // number, so removing another dimension trips this rather than quietly
    // halving the matrix again.
    expect(ALL.length).toBeGreaterThan(20_000);
  });

  it("always produces exactly one action", () => {
    for (const combo of ALL) {
      const result = plan(combo);
      expect(result.action, JSON.stringify(combo)).toBeTruthy();
      expect(typeof result.action).toBe("string");
    }
  });

  /**
   * The pure safety assertion, independent of every priority rule: a divergent
   * pair is never resolved by overwriting one side with the other. If a future
   * refactor reorders the ladder, this is what still holds.
   */
  it("never overwrites across a divergence", () => {
    for (const combo of ALL) {
      if (combo.relation !== "divergent") continue;
      const { action } = plan(combo);
      expect(["PUSH_OVERWRITE", "PULL_OVERWRITE"], JSON.stringify(combo)).not.toContain(action);
    }
  });

  it("never writes when the remote is not ready", () => {
    const writes: Action[] = ["PUSH_NEW", "PULL_NEW", "PUSH_OVERWRITE", "PULL_OVERWRITE", "CONFLICT"];
    for (const combo of ALL) {
      if (combo.remote === "ready") continue;
      expect(writes, JSON.stringify(combo)).not.toContain(plan(combo).action);
    }
  });

  it("never claims divergence about a file it did not read in full", () => {
    for (const combo of ALL) {
      const oversized =
        combo.local.size > combo.maxFileSizeBytes || combo.remoteSide.size > combo.maxFileSizeBytes;
      if (!oversized) continue;
      expect(plan(combo).action, JSON.stringify(combo)).not.toBe("CONFLICT");
    }
  });

  it("never produces CONFLICT with a zero-byte side", () => {
    for (const combo of ALL) {
      const hasZero =
        (combo.local.exists && combo.local.size === 0) ||
        (combo.remoteSide.exists && combo.remoteSide.size === 0);
      if (!hasZero) continue;
      expect(plan(combo).action, JSON.stringify(combo)).not.toBe("CONFLICT");
    }
  });

  it("never writes from an unstable side — there is no exemption left", () => {
    // This used to carry an exception for the §9.1.3 fast path. ADR-70 removed
    // it, so the statement is now unconditional, and that is the point of
    // keeping the test: an unstable observation authorises no write at all,
    // not even one that creates rather than replaces.
    const writes: Action[] = ["PUSH_NEW", "PULL_NEW", "PUSH_OVERWRITE", "PULL_OVERWRITE"];
    for (const combo of ALL) {
      const unstable =
        (combo.local.exists && !combo.local.stable) || (combo.remoteSide.exists && !combo.remoteSide.stable);
      if (!unstable) continue;
      expect(writes, JSON.stringify(combo)).not.toContain(plan(combo).action);
    }
  });

  it("never writes when either side is a cloud placeholder", () => {
    // Its bytes are not here: any size or hash observed about it describes a
    // stub, and reading it would pull the file down mid-pass.
    const writes: Action[] = ["PUSH_NEW", "PULL_NEW", "PUSH_OVERWRITE", "PULL_OVERWRITE", "CONFLICT"];
    for (const combo of ALL) {
      if (!combo.local.isPlaceholder && !combo.remoteSide.isPlaceholder) continue;
      expect(writes, JSON.stringify(combo)).not.toContain(plan(combo).action);
    }
  });

  it("never turns a remote regression into a push", () => {
    // A remote file that once had content and is now empty is a symptom of the
    // sync tool, not permission to declare this machine authoritative.
    for (const combo of ALL) {
      if (!combo.hints.remoteHadNonZeroSize) continue;
      if (!(combo.remoteSide.exists && combo.remoteSide.size === 0)) continue;
      if (!combo.local.exists || combo.local.size === 0) continue;
      if (combo.remote !== "ready") continue;
      if (combo.local.size > combo.maxFileSizeBytes) continue;
      if (combo.local.isPlaceholder || combo.remoteSide.isPlaceholder) continue;
      expect(plan(combo).action, JSON.stringify(combo)).not.toBe("PUSH_OVERWRITE");
    }
  });

  it("respects the priority ladder", () => {
    for (const combo of ALL) {
      const { action } = plan(combo);
      if (combo.remote === "unsupported-format") {
        expect(action).toBe("SKIP_UNSUPPORTED_FORMAT");
      } else if (combo.remote === "not-ready") {
        expect(action).toBe("SKIP_REMOTE_NOT_READY");
      } else if (
        combo.local.size > combo.maxFileSizeBytes ||
        combo.remoteSide.size > combo.maxFileSizeBytes
      ) {
        expect(action).toBe("SKIP_TOO_LARGE");
      }
    }
  });
});

describe("relation is a closed set", () => {
  it("handles every declared relation without falling through", () => {
    const relations: PrefixRelation[] = ["equal", "l-extends-r", "r-extends-l", "divergent", "n/a"];
    for (const relation of relations) {
      expect(() => plan(input({ relation }))).not.toThrow();
    }
  });
});
