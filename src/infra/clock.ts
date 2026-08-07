/**
 * Time and randomness, injected (testing.md §3 requirement 4).
 *
 * The domain layer is forbidden from calling `Date.now()` or `Math.random()` by
 * lint, and this is where that ban leads: every clock read and every token comes
 * through an interface a test can pin. The stability ledger's whole premise is
 * that a decision can be replayed, which is impossible if the inputs move on
 * their own.
 */

export interface Clock {
  /** Milliseconds since the epoch, from this machine's clock. */
  nowMs(): number;
}

export interface IdGen {
  /** Lowercase UUID v4, for workspace and machine identity. */
  uuid(): string;
  /**
   * `bytes * 2` lowercase hex characters.
   *
   * Used for temp-file suffixes, where the requirement is collision resistance
   * against this machine's other instances rather than unpredictability.
   */
  token(bytes: number): string;
}

export function systemClock(): Clock {
  return { nowMs: () => Date.now() };
}

export function cryptoIdGen(randomUUID: () => string, randomBytes: (n: number) => Uint8Array): IdGen {
  return {
    uuid: () => randomUUID(),
    token: (bytes) =>
      Array.from(randomBytes(bytes), (byte) => byte.toString(16).padStart(2, "0")).join(""),
  };
}

/** Advances only when a test tells it to. */
export function fixedClock(startMs: number): Clock & { advance(ms: number): void; set(ms: number): void } {
  let now = startMs;
  return {
    nowMs: () => now,
    advance: (ms) => {
      now += ms;
    },
    set: (ms) => {
      now = ms;
    },
  };
}

/** Deterministic ids, so a failing test names the same paths every run. */
export function sequentialIdGen(seed = 0): IdGen {
  let counter = seed;
  return {
    uuid: () => {
      counter++;
      const hex = counter.toString(16).padStart(12, "0");
      return `00000000-0000-4000-8000-${hex}`;
    },
    token: (bytes) => {
      counter++;
      return counter.toString(16).padStart(bytes * 2, "0").slice(0, bytes * 2);
    },
  };
}
