/**
 * ADR-82: the files-per-pass budget is spent by groups that read, and a group
 * it keeps turning away is let through.
 *
 * Round 10 of real-machine acceptance (2026-10-14) stopped twice on the same
 * cause: with `maxFilesPerPass` at 3, three unchanged Claude Code sessions —
 * each answered from the E1 cache, reading and writing nothing — spent the
 * whole budget on every pass, in the same order every pass, and everything
 * after them waited for ever. A peer's new Codex rollout never left the
 * machine (A3); five conversations deleted in Claudian were never judged
 * (D2). The default of 200 only moves the edge: a workspace with more
 * sessions than that loses the ones listed last, and the ones listed last
 * are a peer's new sessions and the conversation records.
 *
 * Through the real runtime, on a real filesystem.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PassReport } from "../../src/orchestration/pass-report";
import { RuntimeHarness } from "../helpers/runtime-harness";

const machines: RuntimeHarness[] = [];
afterEach(async () => {
  while (machines.length) await machines.pop()?.dispose();
});

const sid = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const NEW = "22222222-2222-4222-8222-222222222222";

async function machine(): Promise<{ m: RuntimeHarness; ws: string }> {
  const m = await RuntimeHarness.create();
  machines.push(m);
  await m.configure();
  const ws = (await m.runtime.refresh()).workspaceId as string;
  return { m, ws };
}

async function pass(m: RuntimeHarness): Promise<PassReport> {
  await m.runtime.syncNow();
  m.advanceClock(95_000);
  return m.runtime.lastPassReport() as PassReport;
}

const exists = (target: string) =>
  fsp
    .lstat(target)
    .then(() => true)
    .catch(() => false);

/** A session a peer pushed: in the sync folder, never on this machine. */
async function fromPeer(m: RuntimeHarness, ws: string, id: string): Promise<void> {
  await fsp.mkdir(path.dirname(m.replicaPath(ws, id)), { recursive: true });
  await fsp.writeFile(m.replicaPath(ws, id), '{"uuid":"p0","type":"user","text":"from the peer"}\n');
}

describe("the files-per-pass budget", () => {
  it("is not spent by sessions that have not changed, so a peer's new one lands as soon as it is settled", async () => {
    const { m, ws } = await machine();
    for (let n = 0; n < 6; n++) await m.appendSession(sid(n), 2);
    await m.settle();
    await m.runtime.updateSettings({ maxFilesPerPass: 2 });
    // Settled, so every one of the six answers from the cache from now on.
    await pass(m);

    await fromPeer(m, ws, NEW);
    const reports = [await pass(m), await pass(m)];

    expect(await exists(m.sessionPath(NEW)), "starved by six unchanged sessions").toBe(true);
    for (const report of reports) {
      expect(report.actions.filter((a) => a.reason === "budget-exhausted")).toEqual([]);
    }
    // All six, less the one the pass's random scrub sample reads in full.
    expect(reports[1]?.actions.filter((a) => a.reason === "e1-cache-hit").length).toBeGreaterThanOrEqual(5);
  }, 60_000);

  it("still binds when more sessions need reading than it allows", async () => {
    // The setting keeps its meaning: four sessions arriving at once with a
    // budget of two take two passes, not one.
    const { m, ws } = await machine();
    await m.runtime.updateSettings({ maxFilesPerPass: 2 });
    for (let n = 0; n < 4; n++) await fromPeer(m, ws, sid(n));

    await m.settle();

    const landed = await Promise.all([0, 1, 2, 3].map((n) => exists(m.sessionPath(sid(n)))));
    expect(landed.filter(Boolean).length).toBeGreaterThan(0);
    const report = m.runtime.lastPassReport() as PassReport;
    const applied = report.actions.filter((a) => a.action === "PULL_NEW" && a.result === "APPLIED");
    expect(applied.length).toBeLessThanOrEqual(2);
    // And none of them waits for ever.
    for (let i = 0; i < 3; i++) await pass(m);
    for (let n = 0; n < 4; n++) expect(await exists(m.sessionPath(sid(n))), sid(n)).toBe(true);
  }, 60_000);

  it("lets a session it keeps turning away through, when others need reading every pass", async () => {
    // A pair in conflict is read on every pass and never converges. With as
    // many of those as the budget allows ahead of it, a session listed after
    // them would wait for ever; the allowance for the starved bounds the wait.
    const { m, ws } = await machine();
    for (let n = 0; n < 3; n++) await m.appendSession(sid(n), 2);
    await m.settle();
    for (let n = 0; n < 3; n++) {
      await m.appendRaw(sid(n), `{"uuid":"here${n}","type":"user","text":"this machine"}\n`);
      await fsp.appendFile(m.replicaPath(ws, sid(n)), `{"uuid":"there${n}","type":"user","text":"the peer"}\n`);
    }
    await m.settle();
    const conflicts = (m.runtime.lastPassReport() as PassReport).actions.filter((a) => a.action === "CONFLICT");
    expect(conflicts.length + (await m.runtime.conflicts()).length).toBeGreaterThan(0);
    await m.runtime.updateSettings({ maxFilesPerPass: 1 });

    await fromPeer(m, ws, NEW);
    let turnedAway = 0;
    for (let i = 0; i < 9 && !(await exists(m.sessionPath(NEW))); i++) {
      const report = await pass(m);
      if (report.actions.some((a) => a.neutralRel.endsWith(`${NEW}.jsonl`) && a.reason === "budget-exhausted")) {
        turnedAway += 1;
      }
    }

    expect(turnedAway, "the conflicts ahead of it must have been spending the budget").toBeGreaterThan(0);
    expect(await exists(m.sessionPath(NEW)), "never let through").toBe(true);
  }, 120_000);
});
