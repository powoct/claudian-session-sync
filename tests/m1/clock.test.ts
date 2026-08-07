/**
 * Clock and IdGen (testing.md §3 requirement 4).
 *
 * Small, but not ceremonial: the domain layer is forbidden from calling
 * `Date.now()` or `Math.random()` precisely so that a stability decision can be
 * replayed, and that only holds if the test doubles really are deterministic.
 */
import { describe, expect, it } from "vitest";
import { cryptoIdGen, fixedClock, sequentialIdGen, systemClock } from "../../src/infra/clock";

describe("systemClock", () => {
  it("reports a plausible wall clock", () => {
    const now = systemClock().nowMs();
    expect(now).toBeGreaterThan(1_600_000_000_000);
    expect(Number.isFinite(now)).toBe(true);
  });
});

describe("fixedClock", () => {
  it("does not move on its own", () => {
    const clock = fixedClock(1000);
    expect(clock.nowMs()).toBe(1000);
    expect(clock.nowMs()).toBe(1000);
  });

  it("moves only when told", () => {
    const clock = fixedClock(1000);
    clock.advance(500);
    expect(clock.nowMs()).toBe(1500);
    clock.set(42);
    expect(clock.nowMs()).toBe(42);
  });

  it("can move backwards, which is a case the ledger must survive", () => {
    const clock = fixedClock(1000);
    clock.advance(-900);
    expect(clock.nowMs()).toBe(100);
  });
});

describe("sequentialIdGen", () => {
  it("produces valid lowercase UUID v4s", () => {
    const ids = sequentialIdGen();
    const uuid = ids.uuid();
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("never repeats", () => {
    const ids = sequentialIdGen();
    const seen = new Set(Array.from({ length: 100 }, () => ids.uuid()));
    expect(seen.size).toBe(100);
  });

  it("replays identically from the same seed, so a failure names the same paths", () => {
    expect(sequentialIdGen(7).uuid()).toBe(sequentialIdGen(7).uuid());
    expect(sequentialIdGen(7).token(4)).toBe(sequentialIdGen(7).token(4));
  });

  it("produces tokens of the requested byte length in hex", () => {
    expect(sequentialIdGen().token(4)).toHaveLength(8);
    expect(sequentialIdGen().token(3)).toHaveLength(6);
  });
});

describe("cryptoIdGen", () => {
  it("passes the injected uuid through", () => {
    const ids = cryptoIdGen(
      () => "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      (n) => new Uint8Array(n).fill(0xab),
    );
    expect(ids.uuid()).toBe("3f2504e0-4f89-41d3-9a0c-0305e82c3301");
  });

  it("hex-encodes bytes with padding, so a leading zero is not dropped", () => {
    const ids = cryptoIdGen(
      () => "x",
      (n) => new Uint8Array(n).fill(0x0a),
    );
    expect(ids.token(3)).toBe("0a0a0a");
  });
});
