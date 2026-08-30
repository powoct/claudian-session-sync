/**
 * testing.md §5.5 — stability judgement.
 *
 * The cases that matter are the clock ones. Every "file is recent" heuristic
 * this replaced failed on exactly these: a sync tool that preserves a future
 * mtime, a machine whose clock stepped backwards, and a filesystem whose
 * timestamps are too coarse to notice a second append.
 */
import { describe, expect, it } from "vitest";
import {
  type E0Signature,
  allowsPullNewFastPath,
  judgeStability,
  signatureKey,
  signaturesEqual,
} from "../../src/domain/stability";

const NOW = 1_700_000_000_000;
const QUIET_MS = 20_000;
const SKEW_MS = 5_000;

const sig = (overrides: Partial<E0Signature> = {}): E0Signature => ({
  size: 4096,
  mtimeMs: NOW - 60_000,
  ctimeMs: NOW - 60_000,
  ino: 12345,
  tailHash: "aaaa",
  ...overrides,
});

const judge = (overrides: Partial<Parameters<typeof judgeStability>[0]> = {}) => {
  const base = sig();
  return judgeStability({
    o2: base,
    ledger: { sig: base, firstSeenMs: NOW - QUIET_MS - 1 },
    nowMs: NOW,
    quietMs: QUIET_MS,
    clockSkewToleranceMs: SKEW_MS,
    ...overrides,
  });
};

describe("judgeStability — the settled case", () => {
  it("calls a file stable once the same signature has held for the quiet window", () => {
    const verdict = judge();
    expect(verdict.stable).toBe(true);
    expect(verdict.reason).toBeUndefined();
    expect(verdict.flags).toEqual([]);
  });

  it("preserves the original first sighting so the wait does not restart", () => {
    // A file observed every pass would otherwise never become actionable.
    const firstSeenMs = NOW - QUIET_MS - 1;
    expect(judge({ ledger: { sig: sig(), firstSeenMs } }).firstSeenMs).toBe(firstSeenMs);
  });
});

describe("judgeStability — not settled yet", () => {
  it("defers when the signature has not been held long enough", () => {
    const verdict = judge({ ledger: { sig: sig(), firstSeenMs: NOW - 1_000 } });
    expect(verdict.stable).toBe(false);
    expect(verdict.reason).toBe("quiet-window-not-elapsed");
    // The wait continues from the original sighting, not from now.
    expect(verdict.firstSeenMs).toBe(NOW - 1_000);
  });

  it("defers and restarts the clock when it changed since the previous pass", () => {
    const verdict = judge({ ledger: { sig: sig({ size: 1 }), firstSeenMs: NOW - 999_999 } });
    expect(verdict.stable).toBe(false);
    expect(verdict.reason).toBe("changed-since-last-pass");
    expect(verdict.firstSeenMs).toBe(NOW);
  });

  it("treats a missing ledger entry as unstable, always", () => {
    // Fail-safe: losing the ledger degrades a pass to observation. Reading "no
    // record" as "settled" would let a lost file act as permission to write.
    const verdict = judge({ ledger: null });
    expect(verdict.stable).toBe(false);
    expect(verdict.reason).toBe("no-ledger-entry");
  });
});

describe("judgeStability — clocks (§9.1.2)", () => {
  it("does not defer forever on a future mtime", () => {
    // A sync tool that preserves the source machine's mtime produces these.
    // Dropping the mtime component keeps the other four working.
    const future = sig({ mtimeMs: NOW + 3_600_000 });
    const verdict = judge({
      o2: future,
      ledger: { sig: future, firstSeenMs: NOW - QUIET_MS - 1 },
    });

    expect(verdict.stable).toBe(true);
    expect(verdict.flags).toContain("futureMtime");
  });

  it("tolerates a small clock skew without flagging it", () => {
    const slightlyAhead = sig({ mtimeMs: NOW + SKEW_MS - 1 });
    const verdict = judge({
      o2: slightlyAhead,
      ledger: { sig: slightlyAhead, firstSeenMs: NOW - QUIET_MS - 1 },
    });
    expect(verdict.flags).not.toContain("futureMtime");
  });

  it("still detects a real change while ignoring a future mtime", () => {
    const future = sig({ mtimeMs: NOW + 3_600_000 });
    const verdict = judge({
      ledger: { sig: future, firstSeenMs: NOW - QUIET_MS - 1 },
      o2: { ...future, size: 9999 },
    });
    expect(verdict.stable).toBe(false);
    expect(verdict.reason).toBe("changed-since-last-pass");
  });

  it("recovers from the clock stepping backwards instead of waiting forever", () => {
    // firstSeenMs recorded in the future: the window restarts from now, which
    // is a bounded wait rather than a permanent defer.
    const verdict = judge({ ledger: { sig: sig(), firstSeenMs: NOW + 3_600_000 } });
    expect(verdict.stable).toBe(false);
    expect(verdict.reason).toBe("quiet-window-not-elapsed");
    expect(verdict.flags).toContain("clockRolledBack");
    expect(verdict.firstSeenMs).toBe(NOW);
  });
});

describe("judgeStability — coarse and lying timestamps", () => {
  /**
   * Each component, asserted against the previous pass rather than against a
   * second observation inside this one (ADR-63 removed the latter). The claim
   * is unchanged and is the load-bearing one: every component of the signature
   * is doing work, and dropping any of them would let a real change read as
   * "nothing happened".
   */
  const changedSince = (before: ReturnType<typeof sig>, after: ReturnType<typeof sig>) =>
    judge({ ledger: { sig: before, firstSeenMs: NOW - QUIET_MS - 1 }, o2: after }).reason;

  it("notices an append that shares an mtime, via size", () => {
    // FAT/exFAT have 2-second granularity: two appends inside one tick carry
    // the same mtime and only size or the trailing bytes give it away.
    const before = sig({ size: 100, tailHash: "aaaa" });
    const after = sig({ size: 200, tailHash: "aaaa" });
    expect(signaturesEqual(before, after)).toBe(false);
    expect(changedSince(before, after)).toBe("changed-since-last-pass");
  });

  it("notices a rewrite that shares an mtime and a size, via the tail hash", () => {
    const before = sig({ size: 100, tailHash: "aaaa" });
    const after = sig({ size: 100, tailHash: "bbbb" });
    expect(changedSince(before, after)).toBe("changed-since-last-pass");
  });

  it("treats a bare touch as a change, conservatively", () => {
    // Nothing about the content moved, but being wrong in this direction only
    // costs a deferred pass.
    const before = sig({ mtimeMs: NOW - 60_000 });
    const after = sig({ mtimeMs: NOW - 30_000 });
    expect(changedSince(before, after)).toBe("changed-since-last-pass");
  });

  it("notices a replaced file that kept its size and timestamps, via the inode", () => {
    expect(changedSince(sig({ ino: 1 }), sig({ ino: 2 }))).toBe("changed-since-last-pass");
  });

  it("notices a metadata-only change, via ctime", () => {
    expect(changedSince(sig({ ctimeMs: 1 }), sig({ ctimeMs: 2 }))).toBe("changed-since-last-pass");
  });
});

describe("signatureKey", () => {
  it("differs whenever any component differs", () => {
    const base = sig();
    const variants = [
      sig({ size: 1 }),
      sig({ mtimeMs: 1 }),
      sig({ ctimeMs: 1 }),
      sig({ ino: 1 }),
      sig({ tailHash: "zzzz" }),
    ];
    for (const variant of variants) {
      expect(signatureKey(variant)).not.toBe(signatureKey(base));
    }
  });

  it("can omit mtime, which is what makes the future-mtime path possible", () => {
    // A pre-hashed signature could not do this — the component is gone.
    expect(signatureKey(sig({ mtimeMs: 1 }), true)).toBe(signatureKey(sig({ mtimeMs: 2 }), true));
  });
});

describe("allowsPullNewFastPath (§9.1.3)", () => {
  const base = {
    localExists: false,
    remoteSize: 4096,
    o1: sig(),
    o2: sig(),
    fullyParsed: true,
  };

  it("allows a new remote session to land without waiting out the window", () => {
    expect(allowsPullNewFastPath(base)).toBe(true);
  });

  it("refuses when the file already exists locally", () => {
    // The asymmetry is the point: this path may only ever create, never replace.
    expect(allowsPullNewFastPath({ ...base, localExists: true })).toBe(false);
  });

  it("refuses a zero-byte remote file", () => {
    expect(allowsPullNewFastPath({ ...base, remoteSize: 0 })).toBe(false);
  });

  it("refuses when the content did not fully parse", () => {
    // A size check alone would wave through a half-transferred file.
    expect(allowsPullNewFastPath({ ...base, fullyParsed: false })).toBe(false);
  });

  it("refuses when the file moved between the two probes", () => {
    expect(allowsPullNewFastPath({ ...base, o2: sig({ size: 8192 }) })).toBe(false);
  });
});
