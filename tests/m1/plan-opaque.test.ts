/**
 * architecture §7.2b + ADR-48 — the opaque-file decision table.
 *
 * The one idea under test: with no prefix relation to lean on, the only
 * automatic overwrite is the converged-base fast-forward — the side being
 * overwritten still holds, byte for byte, the content this machine witnessed
 * both sides agree on. Everything else with two differing sides is a human's
 * call, and a missing base degrades to exactly that, never to a guess.
 */
import { describe, expect, it } from "vitest";
import { type OpaquePlanInput, planOpaque } from "../../src/domain/planner";
import type { SideFacts } from "../../src/domain/planner";

const side = (over: Partial<SideFacts> = {}): SideFacts => ({
  exists: true,
  size: 512,
  observedHash: "sha256:aaaa",
  stable: true,
  tail: "lf-terminated",
  isPlaceholder: false,
  ...over,
});

const ABSENT = side({ exists: false, size: 0, observedHash: "" });

const input = (over: Partial<OpaquePlanInput> = {}): OpaquePlanInput => ({
  remote: "ready",
  local: side(),
  remoteSide: side(),
  conflictKnown: false,
  maxFileSizeBytes: 64 * 1024 * 1024,
  lastConvergedHash: null,
  displacedPushWitness: false,
  ...over,
});

describe("the ladder above content questions", () => {
  it.each([
    ["unsupported format", input({ remote: "unsupported-format" }), "SKIP_UNSUPPORTED_FORMAT"],
    ["remote not ready", input({ remote: "not-ready" }), "SKIP_REMOTE_NOT_READY"],
    ["oversize local", input({ local: side({ size: 65 * 1024 * 1024 }) }), "SKIP_TOO_LARGE"],
    ["placeholder", input({ remoteSide: side({ isPlaceholder: true }) }), "SKIP_PLACEHOLDER"],
    ["unstable side", input({ local: side({ stable: false }) }), "DEFER"],
  ] as const)("%s", (_label, planInput, action) => {
    expect(planOpaque(planInput).action).toBe(action);
  });

  it("defers a zero-byte side instead of treating it as absent or empty-prefix", () => {
    // §7.2b #8. For a whole-file format, zero bytes is most plausibly a write
    // caught mid-flight. The append table's "empty is a prefix of everything"
    // reasoning does not transfer: there is no prefix here.
    expect(planOpaque(input({ local: side({ size: 0 }) })).action).toBe("DEFER");
    expect(planOpaque(input({ remoteSide: side({ size: 0 }) })).action).toBe("DEFER");
    expect(planOpaque(input({ local: side({ size: 0 }) })).reason).toBe("opaque-zero-byte-side");
  });

  it("does not look at tails — an opaque blob has no lines to be truncated", () => {
    const noLf = input({
      local: side({ tail: "truncated" }),
      remoteSide: side({ tail: "truncated" }),
    });
    expect(planOpaque(noLf).action).toBe("NOOP");
  });
});

describe("convergence and one-sided presence", () => {
  it("says NOOP when the hashes agree", () => {
    const result = planOpaque(input());
    expect(result.action).toBe("NOOP");
    expect(result.reason).toBe("content-identical");
  });

  it("keeps a known conflict quiet, like the append table does", () => {
    const result = planOpaque(input({ conflictKnown: true, remoteSide: side({ observedHash: "sha256:bbbb" }) }));
    expect(result.action).toBe("NOOP");
    expect(result.conflictKnown).toBe(true);
  });

  it("pushes a local-only file and pulls a remote-only one", () => {
    expect(planOpaque(input({ remoteSide: ABSENT })).action).toBe("PUSH_NEW");
    expect(planOpaque(input({ local: ABSENT })).action).toBe("PULL_NEW");
  });
});

describe("the converged-base fast-forward (ADR-48)", () => {
  const diverged = (base: string | null) =>
    input({
      local: side({ observedHash: "sha256:new-local" }),
      remoteSide: side({ observedHash: "sha256:old-base" }),
      lastConvergedHash: base,
    });

  it("pushes when the remote still holds the last convergence this machine saw", () => {
    const result = planOpaque(diverged("sha256:old-base"));
    expect(result.action).toBe("PUSH_OVERWRITE");
    expect(result.reason).toBe("remote-at-converged-base");
  });

  it("pulls when the local side is the one that never moved", () => {
    const result = planOpaque(
      input({
        local: side({ observedHash: "sha256:old-base" }),
        remoteSide: side({ observedHash: "sha256:new-remote" }),
        lastConvergedHash: "sha256:old-base",
      }),
    );
    expect(result.action).toBe("PULL_OVERWRITE");
    expect(result.reason).toBe("local-at-converged-base");
  });

  it("conflicts when both sides moved — a real fork is still a human's call", () => {
    const result = planOpaque(
      input({
        local: side({ observedHash: "sha256:new-local" }),
        remoteSide: side({ observedHash: "sha256:new-remote" }),
        lastConvergedHash: "sha256:old-base",
      }),
    );
    expect(result.action).toBe("CONFLICT");
    expect(result.reason).toBe("opaque-divergent-both-moved");
  });

  it("conflicts when there is no base — a lost ledger asks a human, never picks", () => {
    // §5.5's cost model, extended: losing the observations file may only make
    // things slower or more manual. If this ever auto-picked a side, a wiped
    // ledger would become a data-loss amplifier.
    const result = planOpaque(diverged(null));
    expect(result.action).toBe("CONFLICT");
    expect(result.reason).toBe("opaque-divergent-no-base");
  });

  it("never fast-forwards on a stale base that matches neither side", () => {
    expect(planOpaque(diverged("sha256:ancient")).action).toBe("CONFLICT");
  });
});

describe("§7.2b #4b, when the sync tool set this machine's version aside (OQ-18)", () => {
  // The two executions this distinguishes are byte-identical from the planner's
  // seat: a peer that edited after receiving our version, and a transport that
  // discarded our push, both leave `local == base, remote != base` with the
  // same observation history. The witness is the only input that separates
  // them, and it is computed outside from bytes read this pass.
  const BASE = "sha256:base";
  const forked = { local: side({ observedHash: BASE }), remoteSide: side({ observedHash: "sha256:theirs" }), lastConvergedHash: BASE };

  it("pulls when nothing beside it holds our bytes", () => {
    const out = planOpaque(input({ ...forked, displacedPushWitness: false }));
    expect(out).toMatchObject({ action: "PULL_OVERWRITE", reason: "local-at-converged-base" });
  });

  it("conflicts when something beside it does", () => {
    const out = planOpaque(input({ ...forked, displacedPushWitness: true }));
    expect(out).toMatchObject({ action: "CONFLICT", reason: "opaque-push-set-aside-by-sync-tool" });
  });

  it("never turns a push into anything else — #4a is not gated", () => {
    // The push is what set the base, so a discarded push always presents as
    // #4b or #4c. #4a means our push survived; and the copy reaches the
    // machine that won too, where testing it would conflict on every edit —
    // which is the claudian acceptance's one hard blocker (C4) and Grok's G5.
    const out = planOpaque(
      input({
        local: side({ observedHash: "sha256:mine-newer" }),
        remoteSide: side({ observedHash: BASE }),
        lastConvergedHash: BASE,
        displacedPushWitness: true,
      }),
    );
    expect(out).toMatchObject({ action: "PUSH_OVERWRITE", reason: "remote-at-converged-base" });
  });

  it("cannot turn a conflict into a write", () => {
    // The witness may only withhold. With both sides moved this is #4c either
    // way, which is what keeps EV-1 and §5.6 rule 3 literally true.
    for (const w of [false, true]) {
      expect(
        planOpaque(
          input({
            local: side({ observedHash: "sha256:mine" }),
            remoteSide: side({ observedHash: "sha256:theirs" }),
            lastConvergedHash: BASE,
            displacedPushWitness: w,
          }),
        ),
      ).toMatchObject({ action: "CONFLICT", reason: "opaque-divergent-both-moved" });
    }
  });
});
