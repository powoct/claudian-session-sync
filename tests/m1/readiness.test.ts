/**
 * testing.md §5.2.4 (U-15..U-19) and architecture §9.6 — the readiness state
 * machine.
 *
 * U-15 and U-17 are the only defence against the accident this whole machine
 * exists for: a cloud folder that has been created but not yet downloaded looks
 * exactly like one whose contents were deleted, and reading it the second way
 * makes the plugin push its entire history into it.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_READINESS,
  INITIAL_REMOTE_RECORD,
  type ReadinessObservation,
  type RemoteRecord,
  evaluateReadiness,
  isSelfClearing,
  recoveryOptions,
} from "../../src/domain/readiness";

const ROOT_ID = "9f3c2a1e-4f89-41d3-9a0c-0305e82c3301";
const SUPPORTED_FORMAT = 1;
const T0 = 1_700_000_000_000;

const observed = (overrides: Partial<ReadinessObservation> = {}): ReadinessObservation => ({
  reachable: true,
  root: { status: "ok", rootId: ROOT_ID, formatVersion: 1 },
  syncDirEmpty: false,
  workspaceSubtreeExists: true,
  counts: { files: 40, bytes: 1_000_000 },
  remoteRegression: false,
  nowMs: T0,
  ...overrides,
});

const known = (overrides: Partial<RemoteRecord> = {}): RemoteRecord => ({
  ...INITIAL_REMOTE_RECORD,
  state: "READY",
  rootId: ROOT_ID,
  lastKnownCounts: { files: 40, bytes: 1_000_000 },
  consecutiveStableProbes: 5,
  firstProbeMs: T0 - 1_000_000,
  ...overrides,
});

describe("reaching READY takes time, not one lucky reading", () => {
  it("stays PROBING on the first sight of a healthy directory", () => {
    // One reading cannot distinguish a settled folder from one halfway through
    // downloading, and there is no API that reports hydration.
    const verdict = evaluateReadiness(INITIAL_REMOTE_RECORD, observed(), SUPPORTED_FORMAT);
    expect(verdict.state).toBe("PROBING");
    expect(verdict.mayWrite).toBe(false);
  });

  it("needs both enough probes and enough elapsed time", () => {
    const afterFirst = evaluateReadiness(INITIAL_REMOTE_RECORD, observed(), SUPPORTED_FORMAT).record;

    // Second probe, but immediately: the span requirement is not met.
    const tooSoon = evaluateReadiness(afterFirst, observed({ nowMs: T0 + 1000 }), SUPPORTED_FORMAT);
    expect(tooSoon.state).toBe("PROBING");

    const settled = evaluateReadiness(
      afterFirst,
      observed({ nowMs: T0 + DEFAULT_READINESS.minAgeMs }),
      SUPPORTED_FORMAT,
    );
    expect(settled.state).toBe("READY");
    expect(settled.mayWrite).toBe(true);
  });

  it("keeps probing while the count is still climbing", () => {
    let record = INITIAL_REMOTE_RECORD;
    for (const files of [5, 20, 40]) {
      record = evaluateReadiness(record, observed({ counts: { files, bytes: files * 1000 } }), SUPPORTED_FORMAT)
        .record;
    }
    // Growth is not a shrink, so nothing goes NOT_READY; the high-water mark
    // tracks upward.
    expect(record.state).not.toBe("NOT_READY");
    expect(record.lastKnownCounts.files).toBe(40);
  });
});

describe("U-16: an empty sync directory is ambiguous, so it asks", () => {
  it("goes AWAIT_INIT rather than initialising itself", () => {
    // Auto-initialising is the accident path: it would be followed immediately
    // by pushing this machine's whole history into a folder that may simply
    // not have downloaded yet.
    const verdict = evaluateReadiness(
      INITIAL_REMOTE_RECORD,
      observed({ root: { status: "missing" }, syncDirEmpty: true }),
      SUPPORTED_FORMAT,
    );
    expect(verdict.state).toBe("AWAIT_INIT");
    expect(verdict.mayWrite).toBe(false);
  });

  it("does not write anything, including root.json", () => {
    const verdict = evaluateReadiness(
      INITIAL_REMOTE_RECORD,
      observed({ root: { status: "missing" }, syncDirEmpty: true }),
      SUPPORTED_FORMAT,
    );
    // The state itself is the assertion the engine keys on; nothing about
    // AWAIT_INIT permits a write.
    expect(verdict.mayWrite).toBe(false);
    expect(verdict.record.rootId).toBeNull();
  });
});

describe("NR-1..NR-9 triggers", () => {
  it("NR-1: root.json missing while the directory has content", () => {
    const verdict = evaluateReadiness(
      known(),
      observed({ root: { status: "missing" }, syncDirEmpty: false }),
      SUPPORTED_FORMAT,
    );
    expect(verdict).toMatchObject({ state: "NOT_READY", reason: "NR-1-root-missing" });
  });

  it("NR-2: a different rootId means a different directory", () => {
    const verdict = evaluateReadiness(
      known(),
      observed({ root: { status: "ok", rootId: "11111111-4f89-41d3-9a0c-0305e82c3301", formatVersion: 1 } }),
      SUPPORTED_FORMAT,
    );
    expect(verdict.reason).toBe("NR-2-root-id-mismatch");
  });

  it("NR-3: a corrupt root.json is never rebuilt", () => {
    // It may be a partial write in flight; rewriting would destroy both the
    // evidence and the other machine's anchor.
    const verdict = evaluateReadiness(known(), observed({ root: { status: "corrupt" } }), SUPPORTED_FORMAT);
    expect(verdict.reason).toBe("NR-3-root-corrupt");
  });

  it("NR-4: a newer format version is read-only", () => {
    const verdict = evaluateReadiness(
      known(),
      observed({ root: { status: "ok", rootId: ROOT_ID, formatVersion: 99 } }),
      SUPPORTED_FORMAT,
    );
    expect(verdict.reason).toBe("NR-4-format-too-new");
  });

  it("NR-5: the workspace subtree vanished although we recorded files", () => {
    const verdict = evaluateReadiness(known(), observed({ workspaceSubtreeExists: false }), SUPPORTED_FORMAT);
    expect(verdict.reason).toBe("NR-5-workspace-subtree-missing");
  });

  it("U-17 / NR-6: a sharp drop in file count stops the pass", () => {
    // 40 files down to 2 is the half-hydrated folder. Interpreting it as
    // deletion is what must never happen.
    const verdict = evaluateReadiness(
      known(),
      observed({ counts: { files: 2, bytes: 50_000 } }),
      SUPPORTED_FORMAT,
    );
    expect(verdict.reason).toBe("NR-6-file-count-dropped");
    expect(verdict.mayWrite).toBe(false);
  });

  it("NR-6 has an absolute floor, so small workspaces are not twitchy", () => {
    const small = known({ lastKnownCounts: { files: 4, bytes: 1000 } });
    // One file late out of four is within the absolute floor of 3.
    const verdict = evaluateReadiness(small, observed({ counts: { files: 3, bytes: 900 } }), SUPPORTED_FORMAT);
    expect(verdict.state).not.toBe("NOT_READY");
  });

  it("NR-7: a large byte drop needs both a percentage and an absolute size", () => {
    const big = known({ lastKnownCounts: { files: 40, bytes: 100 * 1024 * 1024 } });
    const verdict = evaluateReadiness(
      big,
      observed({ counts: { files: 40, bytes: 10 * 1024 * 1024 } }),
      SUPPORTED_FORMAT,
    );
    expect(verdict.reason).toBe("NR-7-byte-count-dropped");

    // A big percentage of a tiny total is not evidence of anything.
    const tiny = known({ lastKnownCounts: { files: 40, bytes: 100_000 } });
    expect(evaluateReadiness(tiny, observed({ counts: { files: 40, bytes: 1000 } }), SUPPORTED_FORMAT).reason)
      .toBeNull();
  });

  it("NR-8: a remote regression feeds straight into readiness", () => {
    const verdict = evaluateReadiness(known(), observed({ remoteRegression: true }), SUPPORTED_FORMAT);
    expect(verdict.reason).toBe("NR-8-remote-regression");
  });

  it("NR-9: an unreachable directory outranks everything else observed", () => {
    // Nothing observed about a directory that cannot be stat'd means anything.
    const verdict = evaluateReadiness(
      known(),
      observed({ reachable: false, root: { status: "missing" }, counts: { files: 0, bytes: 0 } }),
      SUPPORTED_FORMAT,
    );
    expect(verdict.reason).toBe("NR-9-sync-dir-unreachable");
  });
});

describe("recovery", () => {
  it("lets hydration and a remounted drive clear themselves", () => {
    // These are usually normal progress; waiting is both correct and what a
    // user would want.
    expect(isSelfClearing("NR-6-file-count-dropped")).toBe(true);
    expect(isSelfClearing("NR-7-byte-count-dropped")).toBe(true);
    expect(isSelfClearing("NR-9-sync-dir-unreachable")).toBe(true);
  });

  it("requires a human for anything meaning 'this is not the remote I knew'", () => {
    // Clearing these automatically would silently ratify a cloud drive having
    // emptied or rolled back the folder.
    for (const reason of [
      "NR-1-root-missing",
      "NR-2-root-id-mismatch",
      "NR-3-root-corrupt",
      "NR-5-workspace-subtree-missing",
      "NR-8-remote-regression",
    ] as const) {
      expect(isSelfClearing(reason), reason).toBe(false);
      expect(recoveryOptions(reason)).toContain("confirm-this-directory-is-correct");
    }
  });

  it("recovers to READY once the count comes back", () => {
    const dropped = evaluateReadiness(
      known(),
      observed({ counts: { files: 2, bytes: 50_000 } }),
      SUPPORTED_FORMAT,
    ).record;
    expect(dropped.state).toBe("NOT_READY");

    // The high-water mark was not lowered, so "recovered" means back to 40.
    expect(dropped.lastKnownCounts.files).toBe(40);

    const first = evaluateReadiness(dropped, observed({ nowMs: T0 + 1000 }), SUPPORTED_FORMAT).record;
    const second = evaluateReadiness(
      first,
      observed({ nowMs: T0 + 1000 + DEFAULT_READINESS.minAgeMs }),
      SUPPORTED_FORMAT,
    );
    expect(second.state).toBe("READY");
  });

  it("does not lower the remembered high-water mark while NOT_READY", () => {
    // Lowering it would make the next pass consider the reduced count normal,
    // and the folder would quietly become "correct" at its smaller size.
    const dropped = evaluateReadiness(
      known(),
      observed({ counts: { files: 2, bytes: 50_000 } }),
      SUPPORTED_FORMAT,
    );
    expect(dropped.record.lastKnownCounts).toEqual({ files: 40, bytes: 1_000_000 });
  });
});

describe("only READY permits writing", () => {
  it.each([
    ["UNCONFIGURED", INITIAL_REMOTE_RECORD, observed({ reachable: false })],
    ["AWAIT_INIT", INITIAL_REMOTE_RECORD, observed({ root: { status: "missing" }, syncDirEmpty: true })],
    ["PROBING", INITIAL_REMOTE_RECORD, observed()],
    ["NOT_READY", known(), observed({ root: { status: "corrupt" } })],
  ])("refuses writes in %s", (_label, record, observation) => {
    expect(evaluateReadiness(record, observation, SUPPORTED_FORMAT).mayWrite).toBe(false);
  });
});
