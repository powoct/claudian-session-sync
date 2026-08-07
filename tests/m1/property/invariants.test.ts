/**
 * testing.md §7.3 — the invariants as properties, over randomised histories.
 *
 * The scenario tests cover the sequences someone thought of. These cover the
 * ones nobody did: arbitrary interleavings of appends, passes and transport
 * events, with I1 checked after every single mutation rather than only at the
 * end — a violation that is repaired by a later step is still a violation, and
 * checking only the final state would miss it.
 *
 * Run through `fcAssert`, never `fc.assert` (lint enforces this): a nightly
 * failure has to leave a seed and a shrunk counterexample behind, or the run is
 * a log line nobody can act on.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { World, WORKSPACE_ID, sha256 } from "../../helpers/world";
import { fcAssert } from "../../helpers/fast-check";
import { assertInventoryPreserved, assertRecoverable } from "../../helpers/invariants";

const SID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

const worlds: World[] = [];
afterEach(async () => {
  while (worlds.length) await worlds.pop()?.dispose();
});

/** One step a machine or the transport can take. */
type Step =
  | { readonly kind: "append"; readonly on: "A" | "B"; readonly lines: number }
  | { readonly kind: "pass"; readonly on: "A" | "B" }
  | { readonly kind: "flush"; readonly from: "A" | "B" }
  | { readonly kind: "flush-truncated"; readonly from: "A" | "B"; readonly keep: number };

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.record({
    kind: fc.constant("append" as const),
    on: fc.constantFrom("A" as const, "B" as const),
    lines: fc.integer({ min: 1, max: 4 }),
  }),
  fc.record({ kind: fc.constant("pass" as const), on: fc.constantFrom("A" as const, "B" as const) }),
  fc.record({ kind: fc.constant("flush" as const), from: fc.constantFrom("A" as const, "B" as const) }),
  fc.record({
    kind: fc.constant("flush-truncated" as const),
    from: fc.constantFrom("A" as const, "B" as const),
    keep: fc.integer({ min: 0, max: 200 }),
  }),
);

/**
 * Replays a history, asserting I1 after every mutation.
 *
 * Returns the failure as a string rather than throwing, so fast-check shrinks
 * on the property's return value and reports the smallest failing history.
 */
async function replay(steps: readonly Step[]): Promise<string | null> {
  const w = World.create();
  worlds.push(w);
  const a = w.machine("A");
  const b = w.machine("B");
  const of = (name: "A" | "B") => (name === "A" ? a : b);

  await a.cli.session(SID).append(2);

  for (const [index, step] of steps.entries()) {
    const before = await w.snapshot();
    try {
      if (step.kind === "append") await of(step.on).cli.session(SID).append(step.lines);
      else if (step.kind === "pass") await of(step.on).pass();
      else if (step.kind === "flush") await w.flush(step.from, step.from === "A" ? "B" : "A");
      else await w.flush(step.from, step.from === "A" ? "B" : "A", { truncateBytes: step.keep });
    } catch (error) {
      return `step ${index} (${step.kind}) threw: ${String(error)}`;
    }

    const after = await w.snapshot();
    try {
      // A CLI append legitimately extends a file, which is allowed by I1
      // (equality and extension both count as surviving).
      assertRecoverable(before, after);
    } catch (error) {
      return `I1 violated at step ${index} (${JSON.stringify(step)}): ${String(error)}`;
    }
  }
  return null;
}

describe("I1: no version ever becomes unrecoverable", () => {
  it("holds across arbitrary interleavings of writes, passes and deliveries", async () => {
    // Sync, because fcAssert wraps the synchronous fc.check — the property
    // collects its histories first and replays them in one go below.
    const histories: Step[][] = [];
    fcAssert(
      "I1-collect-histories",
      fc.property(fc.array(stepArb, { minLength: 1, maxLength: 8 }), (steps) => {
        histories.push([...steps]);
        return true;
      }),
      { numRuns: 25, seed: 20260808 },
    );

    for (const history of histories.slice(0, 25)) {
      const failure = await replay(history);
      expect(failure, `history: ${JSON.stringify(history)}`).toBeNull();
    }
  }, 300_000);
});

describe("I2a: repeated passes converge and then stop changing anything", () => {
  it("reaches a fixed point after enough rounds without new writes", async () => {
    const w = World.create();
    worlds.push(w);
    const a = w.machine("A");
    const b = w.machine("B");

    await a.cli.session(SID).append(6);

    // Enough rounds for any pending observation to settle.
    for (let round = 0; round < 5; round++) {
      await a.pass();
      await w.flush("A", "B");
      await b.pass();
      await w.flush("B", "A");
    }
    await a.pass();
    await b.pass();

    const before = await w.snapshot();
    const reportA = await a.pass();
    const reportB = await b.pass();
    const after = await w.snapshot();

    // Converged means "nothing left to do", not "an overwrite that happens to
    // produce identical bytes".
    for (const report of [reportA, reportB]) {
      for (const action of report.actions) {
        expect(["NOOP", "DEFER"], JSON.stringify(action)).toContain(action.action);
      }
    }
    assertRecoverable(before, after);
    assertInventoryPreserved(before, after);
  }, 120_000);
});

describe("I2b: a conflict is a stable end state, not a loop", () => {
  it("stays conflicted without producing new copies or new writes", async () => {
    const w = World.create();
    worlds.push(w);
    const a = w.machine("A");
    const b = w.machine("B");

    await a.cli.session(SID).append(4);
    await a.pass();
    await a.pass();
    await w.flush("A", "B");
    await b.pass();
    await b.pass();

    await a.cli.session(SID).appendRaw('{"uuid":"a","branch":"A"}\n');
    await b.cli.session(SID).appendRaw('{"uuid":"b","branch":"B"}\n');
    await b.pass();
    await b.pass();
    await w.flush("B", "A");
    await a.pass();
    const conflicted = await a.pass();
    expect(conflicted.actions[0]?.action).toBe("CONFLICT");

    const quarantine = path.join(a.replicaRoot, ".quarantine", WORKSPACE_ID, "claude-code");
    const dirsAfterFirst = (await fsp.readdir(quarantine)).sort();
    const localHash = await a.cli.session(SID).hash();
    const remoteHash = sha256(
      new Uint8Array(
        await fsp
          .readFile(path.join(a.replicaRoot, WORKSPACE_ID, "claude-code", `${SID}.jsonl`))
          .catch(() => Buffer.alloc(0)),
      ),
    );

    // Five more passes change nothing: both branches stay put and the
    // content-derived id keeps landing on the same directory.
    for (let i = 0; i < 5; i++) await a.pass();

    expect((await fsp.readdir(quarantine)).sort()).toEqual(dirsAfterFirst);
    expect(await a.cli.session(SID).hash()).toBe(localHash);
    expect(
      sha256(
        new Uint8Array(
          await fsp
            .readFile(path.join(a.replicaRoot, WORKSPACE_ID, "claude-code", `${SID}.jsonl`))
            .catch(() => Buffer.alloc(0)),
        ),
      ),
    ).toBe(remoteHash);
  }, 120_000);
});
