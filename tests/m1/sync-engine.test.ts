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

describe("S-03: an unchanged session does nothing", () => {
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

describe("U-07 at the engine level: a fork is never resolved by overwriting", () => {
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

describe("S-08: a half-transferred file is never treated as content", () => {
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
});

describe("S-10: a zero-byte delivery never overwrites content", () => {
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

describe("an externally rewritten file is re-observed before it is trusted", () => {
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
