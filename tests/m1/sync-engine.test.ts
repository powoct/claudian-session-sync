/**
 * testing.md §7.2 — the L2 scenarios, on the dual-replica world.
 *
 * These are the tests that cover the ground between "the decision table is
 * implemented correctly" and "the plugin works": a file moved back and forth
 * between two machines, a half-transferred delivery, a fork, and the case where
 * an external tool swaps a file for a same-size divergent one behind our back.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PassReport } from "../../src/orchestration/pass-report";
import { World, WORKSPACE_ID, sha256 } from "../helpers/world";
import {
  assertConflictFrozen,
  assertEveryOverwriteBacked,
  assertInventoryPreserved,
  assertRecoverable,
} from "../helpers/invariants";

const SID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

let world: World | null = null;
afterEach(async () => {
  await world?.dispose();
  world = null;
});

function newWorld(): World {
  world = World.create();
  return world;
}

const replicaFile = (machine: { replicaRoot: string }, sid = SID) =>
  path.join(machine.replicaRoot, WORKSPACE_ID, "claude-code", `${sid}.jsonl`);

const read = async (target: string) =>
  new Uint8Array(await fsp.readFile(target).catch(() => Buffer.alloc(0)));

/**
 * Runs a pass twice and returns the second report.
 *
 * The first sight of any file is observation-only by design (§5.5): with no
 * ledger entry nothing is stable, so every action that needs stability defers
 * and the pass establishes the observations the next one will act on. Losing
 * the ledger costs a slow round, never a wrong decision — which is why almost
 * every scenario below needs two passes to reach its action.
 */
async function settle(machine: { pass: (o?: { dryRun?: boolean }) => Promise<PassReport> }) {
  await machine.pass();
  return machine.pass();
}

describe("S-01: a new local session reaches the other machine", () => {
  it("pushes, transports, and lands", async () => {
    const w = newWorld();
    const a = w.machine("A");
    const b = w.machine("B");

    await a.cli.session(SID).append(10);
    const original = await a.cli.session(SID).hash();

    const pushReport = await settle(a);
    expect(pushReport.actions.map((x) => x.action)).toContain("PUSH_NEW");
    expect(sha256(await read(replicaFile(a)))).toBe(original);

    await w.flush("A", "B");
    const pullReport = await settle(b);

    expect(pullReport.actions.map((x) => x.action)).toContain("PULL_NEW");
    expect(await b.cli.session(SID).hash()).toBe(original);
    // The CLI on B can now see it, which is what I3 is about.
    expect(await b.cli.list()).toContain(`${SID}.jsonl`);
  });
});

describe("S-02: continuing a conversation on the second machine", () => {
  it("carries the extension back, and the pair converges", async () => {
    const w = newWorld();
    const a = w.machine("A");
    const b = w.machine("B");

    await a.cli.session(SID).append(10);
    await settle(a);
    await w.flush("A", "B");
    await settle(b);

    // B continues the conversation: a strict append, as the CLI always does.
    await b.cli.session(SID).append(5);
    const extended = await b.cli.session(SID).hash();

    const report = await settle(b);
    expect(report.actions.map((x) => x.action)).toContain("PUSH_OVERWRITE");

    await w.flush("B", "A");
    const back = await settle(a);
    expect(back.actions.map((x) => x.action)).toContain("PULL_OVERWRITE");

    expect(await a.cli.session(SID).hash()).toBe(extended);
    assertEveryOverwriteBacked(back);
  });
});

/**
 * R-04b — the write window of a `*_NEW` action.
 *
 * `PULL_NEW` asserts the local file does not exist, and A8 confirmed that a few
 * syscalls earlier. The gap that remains is not exotic: starting a conversation
 * on this machine is exactly what creates a session file. A replacing rename
 * would destroy it silently and with no backup — `*_NEW` never takes one,
 * because by its own premise there is nothing to preserve.
 *
 * So the premise is enforced where nothing can slip in behind it: the syscall.
 */
describe("R-04b: the local CLI creates the same file during a PULL_NEW", () => {
  it("loses the race rather than the file", async () => {
    const w = newWorld();
    const a = w.machine("A");
    const b = w.machine("B");

    await a.cli.session(SID).append(10);
    await settle(a);
    await w.flush("A", "B");

    // First pass observes; the second is the one that would write.
    await b.pass();

    const theirs = '{"uuid":"local","type":"user","text":"typed on B"}\n';
    let injected = false;
    const report = await b.pass({
      barrier: async (point) => {
        // Inside W1: A8 has passed, the rename has not happened yet.
        if (point !== "P6:before-rename" || injected) return;
        injected = true;
        await b.cli.session(SID).appendRaw(theirs);
      },
    });

    expect(injected, "the barrier must have fired, or this asserts nothing").toBe(true);

    const entry = report.actions.find((x) => x.action === "PULL_NEW");
    expect(entry?.result).toBe("ABORTED_PRECONDITION");
    // What the user typed is still there, byte for byte.
    expect(Buffer.from(await b.cli.session(SID).bytes()).toString("utf8")).toBe(theirs);

    // And the next pass resolves it with bytes, which is the right machinery
    // for two real files — this pass simply was not it.
    const next = await settle(b);
    expect(next.actions.map((x) => x.action)).not.toContain("PULL_NEW");
  });
});

describe("a converged session does nothing", () => {
  it("reaches NOOP and stays there", async () => {
    const w = newWorld();
    const a = w.machine("A");

    await a.cli.session(SID).append(4);
    await settle(a);

    const before = await w.snapshot();
    const second = await a.pass();
    const after = await w.snapshot();

    expect(second.actions.map((x) => x.action)).toEqual(["NOOP"]);
    assertRecoverable(before, after);
  });
});

/**
 * U-18b — the integration form of the most important test in the project.
 *
 * The failure it guards: the manifest remembers remote R0's hash; an external
 * tool replaces the file with a *same-size*, divergent R1; the local file is an
 * extension of R0. Anything reusing the remembered hash concludes "R1 is still
 * a prefix of local" and pushes over it, and R1 is gone with no error and no
 * backup anyone would look for.
 *
 * Same size and same mtime are restored deliberately, so nothing cheap can tell
 * the two apart — only reading the bytes this pass can.
 */
describe("U-18b: same size, same mtime, divergent content", () => {
  it("reports CONFLICT and overwrites nothing", async () => {
    const w = newWorld();
    const a = w.machine("A");

    await a.cli.session(SID).append(10);
    await settle(a); // R0 is now in A's replica

    const remotePath = replicaFile(a);
    const r0 = await read(remotePath);
    const statBefore = await fsp.stat(remotePath);

    // A keeps talking, so local strictly extends R0.
    await a.cli.session(SID).append(3);
    const localExtended = await a.cli.session(SID).hash();

    // An external tool swaps in a divergent file of exactly the same length,
    // and restores the timestamps.
    const r1 = Buffer.from(r0);
    r1[r1.length - 20] = r1[r1.length - 20] === 0x41 ? 0x42 : 0x41;
    await fsp.writeFile(remotePath, r1);
    await fsp.utimes(remotePath, statBefore.atime, statBefore.mtime);

    const statAfter = await fsp.stat(remotePath);
    expect(statAfter.size).toBe(statBefore.size);
    // utimes round-trips through a Date, so sub-millisecond precision is lost.
    // Within a millisecond is more than close enough: the point is that no
    // cheap signal — size, mtime, or a remembered hash — can tell R0 from R1.
    expect(Math.abs(statAfter.mtimeMs - statBefore.mtimeMs)).toBeLessThan(2);
    expect(sha256(new Uint8Array(r1))).not.toBe(sha256(r0));

    const before = await w.snapshot();
    const report = await settle(a);
    const after = await w.snapshot();

    expect(report.actions.map((x) => x.action)).toEqual(["CONFLICT"]);
    // Both sides frozen: R1's bytes survive, and so does the local extension.
    expect(sha256(await read(remotePath))).toBe(sha256(new Uint8Array(r1)));
    expect(await a.cli.session(SID).hash()).toBe(localExtended);

    assertRecoverable(before, after);
    assertInventoryPreserved(before, after);
    assertConflictFrozen(before, after, (loc) => loc.includes(SID));
  });
});

describe("S-03 / U-07: a fork is never resolved by overwriting", () => {
  it("reports CONFLICT even though one branch is longer", async () => {
    const w = newWorld();
    const a = w.machine("A");
    const b = w.machine("B");

    await a.cli.session(SID).append(5);
    await settle(a);
    await w.flush("A", "B");
    await settle(b);

    // Both machines continue from the same point, offline.
    await a.cli.session(SID).appendRaw('{"uuid":"a1","branch":"A"}\n');
    await b.cli.session(SID).appendRaw('{"uuid":"b1","branch":"B"}\n');
    await b.cli.session(SID).appendRaw('{"uuid":"b2","branch":"B"}\n');

    const branchA = await a.cli.session(SID).hash();
    const branchB = await b.cli.session(SID).hash();

    await settle(b);
    await w.flush("B", "A");

    const before = await w.snapshot();
    const report = await settle(a);
    const after = await w.snapshot();

    // B's branch is longer. "More lines wins" would silently discard A's.
    expect(report.actions.map((x) => x.action)).toEqual(["CONFLICT"]);
    expect(await a.cli.session(SID).hash()).toBe(branchA);
    expect(sha256(await read(replicaFile(a)))).toBe(branchB);
    assertRecoverable(before, after);
  });
});

describe("S-12: a half-transferred file is never treated as content", () => {
  it("defers rather than landing a truncated record", async () => {
    const w = newWorld();
    const a = w.machine("A");
    const b = w.machine("B");

    await a.cli.session(SID).append(10);
    await settle(a);

    // The transport delivers a prefix that stops mid-record.
    const full = await read(replicaFile(a));
    await w.flush("A", "B", { truncateBytes: full.length - 15 });

    const before = await w.snapshot();
    const report = await settle(b);
    const after = await w.snapshot();

    const landed = await b.cli.session(SID).bytes();
    expect(report.actions[0]?.action).toBe("DEFER");
    expect(landed.length, "a truncated record must not land").toBe(0);
    assertRecoverable(before, after);
  });

  it("converges once the rest of the file arrives", async () => {
    // Deferring is only the right answer if it ends. A file that stays
    // deferred after a complete delivery is a stall, not caution.
    const w = newWorld();
    const a = w.machine("A");
    const b = w.machine("B");

    await a.cli.session(SID).append(10);
    await settle(a);
    const complete = await a.cli.session(SID).hash();

    const full = await read(replicaFile(a));
    await w.flush("A", "B", { truncateBytes: full.length - 15 });
    await settle(b);

    await w.flush("A", "B");
    const report = await settle(b);

    expect(report.actions.map((x) => x.action)).toContain("PULL_NEW");
    expect(await b.cli.session(SID).hash()).toBe(complete);
  });
});

/**
 * U-11d — deferring forever is a failure mode, not a safe default.
 *
 * A truncated tail defers, and that is right while a transfer is in flight.
 * But a file that has been deferring for five passes is not mid-transfer, it
 * is broken, and from a report that only ever says DEFER the two are
 * indistinguishable. The point of the counter is to make them distinguishable
 * to the person who can act on it.
 */
describe("U-11d: a tail that stays broken becomes visible", () => {
  it("keeps deferring, and says so out loud after five passes", async () => {
    const w = newWorld();
    const a = w.machine("A");
    const b = w.machine("B");

    await a.cli.session(SID).append(10);
    await settle(a);
    const full = await read(replicaFile(a));
    await w.flush("A", "B", { truncateBytes: full.length - 15 });

    let notice: string | undefined;
    let passes = 0;
    for (; passes < 12 && notice === undefined; passes++) {
      const report = await b.pass();
      // Whatever else happens, it never stops being a DEFER.
      for (const action of report.actions) expect(action.action).toBe("DEFER");
      notice = report.notices.find((line) => line.includes("incomplete"));
    }

    expect(notice, "a permanently broken tail must reach the user").toBeDefined();
    expect(notice).toContain(`claude-code/${SID}.jsonl`);
    // Not on the first pass either — that would make every mid-transfer file
    // shout, and a warning that fires constantly is one nobody reads.
    expect(passes).toBeGreaterThan(5);
    expect((await b.cli.session(SID).bytes()).length).toBe(0);
  });

  it("forgets the streak as soon as one pass sees a whole record", async () => {
    const w = newWorld();
    const a = w.machine("A");
    const b = w.machine("B");

    await a.cli.session(SID).append(10);
    await settle(a);
    const full = await read(replicaFile(a));
    await w.flush("A", "B", { truncateBytes: full.length - 15 });
    for (let i = 0; i < 4; i++) await b.pass();

    await w.flush("A", "B");
    for (let i = 0; i < 4; i++) {
      const report = await b.pass();
      expect(report.notices.filter((line) => line.includes("incomplete"))).toEqual([]);
    }
  });
});

describe("U-12c: a zero-byte delivery never overwrites content", () => {
  it("defers instead of emptying the local file", async () => {
    const w = newWorld();
    const a = w.machine("A");
    const b = w.machine("B");

    await a.cli.session(SID).append(10);
    await settle(a);
    await w.flush("A", "B");
    await settle(b);
    const landed = await b.cli.session(SID).hash();

    // The sync tool re-delivers the file as a zero-byte placeholder.
    await w.flush("A", "B", { zeroByte: true });

    const before = await w.snapshot();
    await settle(b);
    const after = await w.snapshot();

    expect(await b.cli.session(SID).hash()).toBe(landed);
    assertRecoverable(before, after);
  });
});

describe("S-05: an externally rewritten file is re-observed before it is trusted", () => {
  it("defers once after the sync tool touches it, then settles", async () => {
    const w = newWorld();
    const a = w.machine("A");
    const b = w.machine("B");

    await a.cli.session(SID).append(6);
    await settle(a);
    await w.flush("A", "B");
    await settle(b);

    // The sync tool re-delivers identical content. The bytes did not change,
    // but this machine has not watched *this* file hold still — the stability
    // ledger keys on the signature, not on the content, precisely because a
    // half-written delivery also has plausible-looking content.
    await w.flush("A", "B");

    const first = await b.pass();
    expect(first.actions.map((x) => x.reason)).toEqual(["side-unstable"]);

    const second = await b.pass();
    expect(second.actions.map((x) => x.action)).toEqual(["NOOP"]);
  });
});

describe("S-06: the transport is slow", () => {
  it("does nothing at all until the file actually arrives", async () => {
    const w = newWorld();
    const a = w.machine("A");
    const b = w.machine("B");

    await a.cli.session(SID).append(7);
    await settle(a);

    // Three passes on B while the delivery is still in flight.
    const before = await w.snapshot();
    for (let i = 0; i < 3; i++) {
      const report = await b.pass();
      expect(report.actions, "nothing has arrived, so there is nothing to say").toEqual([]);
    }
    const after = await w.snapshot();
    expect([...after.live.keys()].sort()).toEqual([...before.live.keys()].sort());

    await w.flush("A", "B");
    await settle(b);
    expect(await b.cli.session(SID).hash()).toBe(await a.cli.session(SID).hash());
  });
});

describe("S-06c: the same file is delivered three times", () => {
  it("ends where delivering it once would have", async () => {
    // Sync tools re-deliver. If a repeat did anything a single delivery does
    // not, every network hiccup would become a divergence.
    const once = newWorld();
    const onceA = once.machine("A");
    const onceB = once.machine("B");
    await onceA.cli.session(SID).append(9);
    await settle(onceA);
    await once.flush("A", "B");
    await settle(onceB);
    const expected = await onceB.cli.session(SID).hash();
    await once.dispose();

    const w = newWorld();
    const a = w.machine("A");
    const b = w.machine("B");
    await a.cli.session(SID).append(9);
    await settle(a);
    for (let i = 0; i < 3; i++) {
      await w.flush("A", "B");
      await settle(b);
    }

    expect(await b.cli.session(SID).hash()).toBe(expected);
    const settled = await b.pass();
    expect(settled.actions.map((x) => x.action)).toEqual(["NOOP"]);
  });
});

describe("U-12b: a zero-byte local file is overwritten, and backed up first", () => {
  it("keeps the empty version even though there is nothing in it", async () => {
    // The rule has no exception for "there was nothing worth keeping". Deciding
    // per file which versions deserve a backup is how the one that mattered
    // gets skipped, so zero bytes is backed up like anything else.
    const w = newWorld();
    const a = w.machine("A");
    const b = w.machine("B");

    await a.cli.session(SID).append(10);
    await settle(a);
    const content = await a.cli.session(SID).hash();
    await w.flush("A", "B");

    // B has an empty file of the same name — a CLI that created it and never
    // wrote, or a placeholder somebody left behind.
    await fsp.writeFile(b.cli.session(SID).filePath, "");
    const report = await settle(b);

    const entry = report.actions.find((x) => x.action === "PULL_OVERWRITE");
    expect(entry?.result).toBe("APPLIED");
    expect(await b.cli.session(SID).hash()).toBe(content);

    expect(entry?.backupPath, "an overwrite without a backup violates I1").toBeDefined();
    const backed = await fsp.stat(entry?.backupPath as string);
    expect(backed.size, "the zero-byte version is what was overwritten").toBe(0);
    assertEveryOverwriteBacked(report);
  });
});

describe("U-14: nothing to do", () => {
  it("reports an empty action list rather than failing", async () => {
    const w = newWorld();
    const a = w.machine("A");

    const report = await a.pass();

    expect(report.outcome).toBe("ok");
    expect(report.actions).toEqual([]);
    expect(report.violations).toEqual([]);
  });
});

describe("dry run", () => {
  it("decides everything and writes nothing", async () => {
    const w = newWorld();
    const a = w.machine("A");
    await a.cli.session(SID).append(6);

    await a.pass({ dryRun: true }); // first sight: observation only
    const before = await w.snapshot();
    const report = await a.pass({ dryRun: true });
    const after = await w.snapshot();

    expect(report.dryRun).toBe(true);
    expect(report.actions.map((x) => x.action)).toContain("PUSH_NEW");
    // The plan is produced; nothing is applied.
    expect(report.actions.every((x) => x.result !== "APPLIED")).toBe(true);
    expect([...after.live.keys()].sort()).toEqual([...before.live.keys()].sort());
  });
});

describe("convergence over repeated passes (I2a)", () => {
  it("settles and then stops changing anything", async () => {
    const w = newWorld();
    const a = w.machine("A");
    const b = w.machine("B");

    await a.cli.session(SID).append(8);
    for (let round = 0; round < 3; round++) {
      await settle(a);
      await w.flush("A", "B");
      await settle(b);
      await w.flush("B", "A");
    }

    // One pass to re-observe: the last flush rewrote A's replica, so from this
    // machine's point of view the file just changed, whatever its content.
    await a.pass();

    const before = await w.snapshot();
    const settled = await a.pass();
    const after = await w.snapshot();

    // Once converged, every further pass is a no-op — not an overwrite that
    // happens to produce the same bytes.
    expect(settled.actions.map((x) => `${x.action}:${x.result}`)).toEqual(["NOOP:APPLIED"]);
    expect(await a.cli.session(SID).hash()).toBe(await b.cli.session(SID).hash());
    assertRecoverable(before, after);
  });
});
