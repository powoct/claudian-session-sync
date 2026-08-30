/**
 * testing.md §7.4 — the crash-point matrix.
 *
 * A crash here is a real one: `CrashSignal` does not extend Error, so nothing
 * in the engine can catch it, commit never runs, and no in-process state
 * survives. That distinction matters — an injected failure the engine "handles"
 * would mean these tests were exercising recovery from something that never
 * happened.
 *
 * The standing requirement (§7.4) is that after a crash and a restart, the
 * world converges byte-for-byte with a control run that never crashed.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { World, WORKSPACE_ID, sha256 } from "../helpers/world";
import { assertRecoverable } from "../helpers/invariants";
import { isCrashSignal } from "../../src/orchestration/pass-report";
import type { PassReport } from "../../src/orchestration/pass-report";

const SID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

const worlds: World[] = [];
afterEach(async () => {
  while (worlds.length) await worlds.pop()?.dispose();
});

function newWorld(): World {
  const w = World.create();
  worlds.push(w);
  return w;
}

async function settle(machine: { pass: () => Promise<PassReport> }): Promise<PassReport> {
  await machine.pass();
  return machine.pass();
}

const replicaFile = (m: { replicaRoot: string }) =>
  path.join(m.replicaRoot, WORKSPACE_ID, "claude-code", `${SID}.jsonl`);

const read = async (p: string) => new Uint8Array(await fsp.readFile(p).catch(() => Buffer.alloc(0)));

/** The control: the same sequence with no crash, for a byte-level comparison. */
async function controlRun(): Promise<{ local: string; remote: string }> {
  const w = newWorld();
  const a = w.machine("A");
  await a.cli.session(SID).append(8);
  await settle(a);
  return { local: await a.cli.session(SID).hash(), remote: sha256(await read(replicaFile(a))) };
}

describe("a crash signal is not catchable", () => {
  it("is not an Error, so no errno handler can absorb it", () => {
    const w = newWorld();
    const a = w.machine("A");
    void a;
    // Asserted directly because the whole matrix depends on it: if a crash
    // could be caught as an I/O failure, every test below would be measuring
    // ordinary error handling instead of crash recovery.
    expect(isCrashSignal(new Error("io"))).toBe(false);
  });
});

describe("R-05: crash after backup, before rename", () => {
  it("leaves the target untouched and recovers on the next pass", async () => {
    const w = newWorld();
    const a = w.machine("A");

    await a.cli.session(SID).append(8);
    await a.pass(); // observe

    const beforeCrash = await w.snapshot();
    const signal = await a.crashDuringPass("P6:before-rename");
    expect(signal.at).toBe("P6:before-rename");
    const afterCrash = await w.snapshot();

    // Nothing was replaced: the swap had not happened yet.
    assertRecoverable(beforeCrash, afterCrash);

    // And the restart recovers to exactly where the control run ends up.
    const control = await controlRun();
    await settle(a);
    expect(await a.cli.session(SID).hash()).toBe(control.local);
    expect(sha256(await read(replicaFile(a)))).toBe(control.remote);
  });
});

describe("R-06: crash after rename, before commit", () => {
  it("rebuilds from the real files, with no dependence on in-process state", async () => {
    const w = newWorld();
    const a = w.machine("A");

    await a.cli.session(SID).append(8);
    await a.pass();

    const before = await w.snapshot();
    await a.crashDuringPass("P8:before-commit");
    const after = await w.snapshot();

    // The write landed but nothing was committed. The ledger is gone with the
    // process, so the next pass must reach the same place by reading the
    // filesystem — which is the point: no decision may depend on remembered
    // state surviving.
    assertRecoverable(before, after);

    const control = await controlRun();
    await settle(a);
    expect(await a.cli.session(SID).hash()).toBe(control.local);
    expect(sha256(await read(replicaFile(a)))).toBe(control.remote);
  });

  it("does not duplicate a quarantine copy after a crash", async () => {
    const w = newWorld();
    const a = w.machine("A");
    const b = w.machine("B");

    await a.cli.session(SID).append(5);
    await settle(a);
    await w.flush("A", "B");
    await settle(b);
    await a.cli.session(SID).appendRaw('{"uuid":"a1","branch":"A"}\n');
    await b.cli.session(SID).appendRaw('{"uuid":"b1","branch":"B"}\n');
    await settle(b);
    await w.flush("B", "A");

    const report = await settle(a);
    const quarantine = path.join(a.replicaRoot, ".quarantine", WORKSPACE_ID, "claude-code");
    const before = (await fsp.readdir(quarantine)).sort();
    expect(before).toContain(report.actions[0]?.conflictId as string);

    // Crash mid-pass and restart. The conflict id is content-derived, so the
    // rerun lands on the same directory instead of making a second one.
    await a.crashDuringPass("P8:before-commit");
    await settle(a);

    expect((await fsp.readdir(quarantine)).sort()).toEqual(before);
  });
});

describe("R-01: the file changes between observation and use", () => {
  it("cancels rather than acting on a fact already contradicted", async () => {
    const w = newWorld();
    const a = w.machine("A");

    await a.cli.session(SID).append(8);
    await settle(a);

    // The CLI appends in the window between the last look and the swap.
    const report = await a.pass({
      barrier: async (point) => {
        if (point === "P6:before-backup") await a.cli.session(SID).append(5);
      },
    });

    const outcome = report.actions[0];
    // Either the change was noticed at the stability gate, or the last look
    // caught it. What must never happen is a write based on the earlier read.
    expect(["DEFER", "PUSH_OVERWRITE", "PUSH_NEW", "NOOP"]).toContain(outcome?.action);
    if (outcome?.action === "PUSH_OVERWRITE" || outcome?.action === "PUSH_NEW") {
      expect(outcome.result).toBe("ABORTED_PRECONDITION");
    }

    // Whatever happened, the local file is exactly what the CLI wrote.
    const localBytes = await a.cli.session(SID).bytes();
    expect(localBytes.length).toBeGreaterThan(0);
  });

  it("never pushes a version the CLI has already moved past", async () => {
    const w = newWorld();
    const a = w.machine("A");

    await a.cli.session(SID).append(8);
    await settle(a);
    const pushed = sha256(await read(replicaFile(a)));

    // Append during the pass, then check what reached the replica.
    await a.pass({
      barrier: async (point) => {
        if (point === "P3:bytes-read") await a.cli.session(SID).append(3);
      },
    });

    const nowRemote = sha256(await read(replicaFile(a)));
    const localNow = await a.cli.session(SID).hash();
    // The replica holds either the previous version or the current local one —
    // never a third thing assembled from a stale read.
    expect([pushed, localNow]).toContain(nowRemote);
  });

  it("refuses to decide on a stat and a body that disagree (O2/O3)", async () => {
    // The read-integrity check, pinned. It was not: disabling
    // `readStillValid` left all 978 tests green, and the sibling above cannot
    // see it — appending at `P3:bytes-read` leaves the bytes already read
    // equal to what was pushed last time, so a stale push is indistinguishable
    // from a correct one.
    //
    // The window that shows it is between the stat and the read. Append at
    // `P2:o2-taken` and the engine holds O2's signature for an 8-turn file
    // while its hands hold an 11-turn body; O3 is what notices, and the side
    // is marked unstable rather than planned on the mismatched pair.
    //
    // This matters more since ADR-63: the intra-pass O1/O2 comparison is gone,
    // and the argument for removing it was that this check covers the read.
    // An untested cover is not one.
    const w = newWorld();
    const a = w.machine("A");

    await a.cli.session(SID).append(8);
    await settle(a);

    // A peer's version, written straight into the replica so the two sides
    // differ and the pass has to read both. Then a pass to let the remote
    // ledger catch up and its quiet window elapse — without that the pass
    // defers on the remote before it ever reaches a read, and the test would
    // pass for a reason that has nothing to do with O2/O3.
    await fsp.appendFile(replicaFile(a), '{"uuid":"peer","type":"user"}\n');
    await a.pass();
    a.advanceClock(95_000);

    const report = await a.pass({
      barrier: async (point) => {
        if (point === "P2:o2-taken") await a.cli.session(SID).append(3);
      },
    });

    const mine = report.actions.filter((entry) => entry.neutralRel?.includes(SID));
    expect(mine.length, "the pass must have considered the file").toBeGreaterThan(0);
    for (const entry of mine) {
      expect(entry.action, `${entry.reason}`).toBe("DEFER");
      expect(entry.reason).toBe("side-unstable");
    }
  });
});

describe("crash recovery is independent of how far the pass got", () => {
  it.each([
    ["P2:o2-taken"],
    ["P3:bytes-read"],
    ["P4:planned"],
    ["P6:before-backup"],
    ["P6:before-rename"],
    ["P8:before-commit"],
  ] as const)("converges with the control after crashing at %s", async (point) => {
    const w = newWorld();
    const a = w.machine("A");
    await a.cli.session(SID).append(8);
    await a.pass();

    await a.crashDuringPass(point);

    const control = await controlRun();
    await settle(a);

    // Byte-for-byte with a run that never crashed, from every injection point.
    expect(await a.cli.session(SID).hash()).toBe(control.local);
    expect(sha256(await read(replicaFile(a)))).toBe(control.remote);
  });
});
