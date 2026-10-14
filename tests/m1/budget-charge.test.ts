/**
 * ADR-82: the files-per-pass budget is spent by groups that read, and a group
 * it keeps turning away is let through.
 *
 * Round 10 of real-machine acceptance (2026-10-14) stopped twice on the same
 * cause: with `maxFilesPerPass` at 3, three unchanged sessions — each answered
 * from the E1 cache, reading and writing nothing — spent the whole budget on
 * every pass, in the same order every pass, and everything after them waited
 * for ever. A peer's new Codex rollout never left the machine (A3); five
 * conversations deleted in Claudian were never judged (D2). The default of
 * 200 only moves the edge: a workspace with more sessions than that loses the
 * ones listed last, and the ones listed last are a peer's new sessions and
 * the conversation records.
 *
 * Through the real runtime, on a real filesystem.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  STARVATION_PASSES,
  STARVED_ALLOWANCE_FILES,
  servedFromAllowance,
} from "../../src/domain/budget";
import type { ActionEntry, PassReport } from "../../src/orchestration/pass-report";
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

async function pass(m: RuntimeHarness, options: { verifyAll?: boolean } = {}): Promise<PassReport> {
  await m.runtime.syncNow(options);
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

const rowOf = (report: PassReport, id: string): ActionEntry | undefined =>
  report.actions.find((a) => a.neutralRel.endsWith(`${id}.jsonl`));
const landedIn = (report: PassReport) =>
  report.actions.filter((a) => a.action === "PULL_NEW" && a.result === "APPLIED");
const turnedAwayIn = (report: PassReport) => report.actions.filter((a) => a.reason === "budget-exhausted");

/** Three sessions in conflict: read on every pass, never converging. */
async function threeConflicts(m: RuntimeHarness, ws: string): Promise<void> {
  for (let n = 0; n < 3; n++) await m.appendSession(sid(n), 2);
  await m.settle();
  for (let n = 0; n < 3; n++) {
    await m.appendRaw(sid(n), `{"uuid":"here${n}","type":"user","text":"this machine"}\n`);
    await fsp.appendFile(m.replicaPath(ws, sid(n)), `{"uuid":"there${n}","type":"user","text":"the peer"}\n`);
  }
  await m.settle();
  expect((await m.runtime.conflicts()).length).toBeGreaterThan(0);
}

describe("the files-per-pass budget", () => {
  it("is not spent by sessions that have not changed, so a peer's new one lands as soon as it is settled", async () => {
    const { m, ws } = await machine();
    for (let n = 0; n < 6; n++) await m.appendSession(sid(n), 2);
    await m.settle();
    // Three: one for the pass's random scrub sample (one file at this size),
    // which is a read and is charged, one for the new session, one spare.
    await m.runtime.updateSettings({ maxFilesPerPass: 3 });
    await pass(m);

    await fromPeer(m, ws, NEW);
    const reports = [await pass(m), await pass(m)];

    expect(await exists(m.sessionPath(NEW)), "starved by six unchanged sessions").toBe(true);
    for (const report of reports) expect(turnedAwayIn(report)).toEqual([]);
    expect(reports[1]?.actions.filter((a) => a.reason === "e1-cache-hit").length).toBeGreaterThanOrEqual(5);
  }, 60_000);

  it("still binds when more sessions need reading than it allows", async () => {
    // The setting keeps its meaning: four sessions arriving at once with a
    // budget of two are not all read in one pass.
    const { m, ws } = await machine();
    await m.runtime.updateSettings({ maxFilesPerPass: 2 });
    for (let n = 0; n < 4; n++) await fromPeer(m, ws, sid(n));

    const reports: PassReport[] = [];
    for (let i = 0; i < 6; i++) reports.push(await pass(m));

    const first = reports.find((report) => landedIn(report).length > 0) as PassReport;
    expect(first, "nothing ever landed").toBeDefined();
    expect(landedIn(first)).toHaveLength(2);
    expect(turnedAwayIn(first).map((a) => a.action)).toEqual(["DEFER", "DEFER"]);
    // And none of them waits for ever.
    for (let n = 0; n < 4; n++) expect(await exists(m.sessionPath(sid(n))), sid(n)).toBe(true);
  }, 60_000);

  it("is not spent on files still settling, which are not read", async () => {
    // Three sessions started here this pass are seen for the first time on
    // the only side they have, so not read and not charged; the peer's
    // session behind them, settled, has room.
    const { m, ws } = await machine();
    await m.appendSession(sid(0), 2);
    await m.settle();
    await m.runtime.updateSettings({ maxFilesPerPass: 1 });
    await fromPeer(m, ws, NEW);
    await pass(m); // The peer's session, seen for the first time.
    for (let n = 1; n <= 3; n++) await m.appendSession(sid(n), 1);

    const report = await pass(m);

    expect(rowOf(report, sid(1))).toMatchObject({ action: "DEFER" });
    expect(rowOf(report, NEW)).toMatchObject({ action: "PULL_NEW", result: "APPLIED" });
  }, 60_000);

  it("is not spent on a file over the size limit, which is not read either", async () => {
    // The planner skips it from the stat alone; reading it whole on every
    // pass, and charging the budget for that, decided nothing.
    const { m, ws } = await machine();
    await m.appendSession(sid(0), 1);
    await m.appendRaw(sid(0), `{"uuid":"big","type":"user","text":"${"x".repeat(1_100_000)}"}\n`);
    await m.runtime.updateSettings({ maxFileSizeMB: 1, maxFilesPerPass: 1 });
    await m.settle();
    await fromPeer(m, ws, NEW);
    m.reads.length = 0;

    const reports = [await pass(m), await pass(m)];

    expect(rowOf(reports[1] as PassReport, sid(0))).toMatchObject({ action: "SKIP_TOO_LARGE" });
    expect(await exists(m.sessionPath(NEW))).toBe(true);
    for (const report of reports) expect(turnedAwayIn(report)).toEqual([]);
    expect(m.reads.filter((read) => read.endsWith(`${sid(0)}.jsonl`))).toEqual([]);
  }, 60_000);

  it(`lets a session it keeps turning away through after exactly ${STARVATION_PASSES} passes`, async () => {
    // Pairs in conflict are read on every pass and never converge. With as
    // many of them as the budget allows ahead of it, a session listed after
    // them would wait for ever; the allowance for the starved bounds the wait.
    const { m, ws } = await machine();
    await threeConflicts(m, ws);
    await m.runtime.updateSettings({ maxFilesPerPass: 1 });

    await fromPeer(m, ws, NEW);
    const outcomes: string[] = [];
    for (let i = 0; i < 12 && !(await exists(m.sessionPath(NEW))); i++) {
      const row = rowOf(await pass(m), NEW);
      outcomes.push(row?.reason === "budget-exhausted" ? "away" : (row?.action ?? "none"));
    }

    // Seen once while it settles, then turned away, then let through.
    const ready = outcomes.slice(outcomes.indexOf("away"));
    expect(ready).toEqual([...Array<string>(STARVATION_PASSES).fill("away"), "PULL_NEW"]);
  }, 120_000);

  it(`serves at most ${STARVED_ALLOWANCE_FILES} starved files a pass, longest-waiting first, and says so`, async () => {
    const { m, ws } = await machine();
    await m.runtime.updateSettings({ maxFilesPerPass: 1 });
    const count = STARVED_ALLOWANCE_FILES + 5;
    for (let n = 0; n < count; n++) await fromPeer(m, ws, sid(100 + n));

    const reports: PassReport[] = [];
    for (let i = 0; i < STARVATION_PASSES + 5; i++) reports.push(await pass(m));

    const perPass = reports.map((report) => landedIn(report).length);
    // The budget's one, and the allowance's twenty, never more.
    for (const landed of perPass) expect(landed).toBeLessThanOrEqual(1 + STARVED_ALLOWANCE_FILES);
    expect(Math.max(...perPass), "the allowance was never used").toBeGreaterThan(1);
    for (let n = 0; n < count; n++) expect(await exists(m.sessionPath(sid(100 + n))), `session ${n}`).toBe(true);
    const notices = reports.flatMap((report) => report.notices).join("\n");
    expect(notices).toContain(`waited ${STARVATION_PASSES} or more syncs in a row`);
  }, 120_000);

  it("reads nothing in full while the sync folder is not ready", async () => {
    // The planner skips every pair from that verdict alone; reading each
    // stable file whole first, and charging it, decided nothing.
    const { m } = await machine();
    for (let n = 0; n < 3; n++) await m.appendSession(sid(n), 2);
    await m.settle();
    for (let n = 0; n < 3; n++) await m.appendRaw(sid(n), `{"uuid":"more${n}","type":"user","text":"later"}\n`);
    await pass(m);
    const rootPath = path.join(m.syncDir, ".aiss", "root.json");
    const root = JSON.parse(await fsp.readFile(rootPath, "utf8")) as Record<string, unknown>;
    await fsp.writeFile(rootPath, JSON.stringify({ ...root, rootId: "somewhere-else" }));
    m.reads.length = 0;

    const report = await pass(m);

    expect(report.actions.filter((a) => a.action === "SKIP_REMOTE_NOT_READY").length).toBeGreaterThan(0);
    expect(m.reads.filter((read) => read.endsWith(".jsonl"))).toEqual([]);
  }, 60_000);

  it("verifies on a later pass what Verify all could not fit into this one", async () => {
    // T7 is a read, and a read is charged; a file the budget turned away is
    // read the next time it has room (T3) instead of being quietly dropped.
    const { m } = await machine();
    for (let n = 0; n < 8; n++) await m.appendSession(sid(n), 2);
    await m.settle();
    await m.runtime.updateSettings({ maxFilesPerPass: 2 });
    await pass(m);

    const reports = [await pass(m, { verifyAll: true })];
    for (let i = 0; i < 4; i++) reports.push(await pass(m));

    expect(turnedAwayIn(reports[0] as PassReport).length).toBeGreaterThan(0);
    for (let n = 0; n < 8; n++) {
      const verified = reports.some((report) => rowOf(report, sid(n))?.reason === "content-identical");
      expect(verified, `session ${n} was never read in full`).toBe(true);
    }
  }, 60_000);
});

describe("a group the budget turns away part-way", () => {
  it("has one row per member: the ones read from the cache, then the rest waiting — and comes through", async () => {
    // A Grok session whose history is unchanged and whose summary is not.
    // The history members answer from the cache and are not charged; the
    // summary, last, is where the group has to be read — and there is no
    // room, because a Claude Code session in conflict ahead of it is read on
    // every pass.
    const GROK = "01a02f3c-8efb-7162-9974-a56283c564c7";
    const { m, ws } = await machine();
    await m.runtime.setProvider("grok", { enabled: true });
    await m.runtime.refresh();
    await m.appendSession(sid(0), 2);
    // Forty settled sessions besides, so the pass's one-file scrub sample
    // seldom lands on the Grok members — a sampled member has to be read, and
    // the shape this asserts needs them answered from the cache.
    for (let n = 1; n <= 40; n++) await m.appendSession(sid(200 + n), 1);
    await m.writeGrokSession(GROK, { turns: 2 });
    await m.settle();
    await m.appendRaw(sid(0), '{"uuid":"here","type":"user","text":"this machine"}\n');
    await fsp.appendFile(m.replicaPath(ws, sid(0)), '{"uuid":"there","type":"user","text":"the peer"}\n');
    await m.settle();
    await m.runtime.updateSettings({ maxFilesPerPass: 1 });
    await pass(m);
    const summary = path.join(m.grokProjectDir, GROK, "summary.json");
    const parsed = JSON.parse(await fsp.readFile(summary, "utf8")) as Record<string, unknown>;
    await fsp.writeFile(summary, JSON.stringify({ ...parsed, title: "renamed" }));

    const shapes: Array<Record<string, string>> = [];
    for (let i = 0; i < STARVATION_PASSES + 8; i++) {
      const rows = (await pass(m)).actions.filter((a) => a.neutralRel.startsWith(`grok/${GROK}/`));
      const byMember = Object.fromEntries(rows.map((a) => [a.neutralRel.split("/").pop(), `${a.action}/${a.reason}`]));
      // One row per member, never a cache hit and a deferral for the same file.
      expect(rows).toHaveLength(3);
      shapes.push(byMember);
    }

    expect(shapes).toContainEqual({
      "chat_history.jsonl": "NOOP/e1-cache-hit",
      "updates.jsonl": "NOOP/e1-cache-hit",
      "summary.json": "DEFER/budget-exhausted",
    });
    expect(JSON.parse(await fsp.readFile(path.join(m.syncDir, ws, "grok", GROK, "summary.json"), "utf8"))).toMatchObject({
      title: "renamed",
    });
  }, 60_000);
});

describe("the allowance for the starved", () => {
  it("has the bounds the architecture states (§12.2)", () => {
    // Every other test derives its expectations from these constants, so this
    // is the one place a change to them shows up as a change to the promise.
    expect(STARVATION_PASSES).toBe(5);
    expect(STARVED_ALLOWANCE_FILES).toBe(20);
  });

  const candidate = (key: string, waited: number, files = 1) => ({ key, files, waited });

  it("serves the longest-waiting first, then listing order", () => {
    const served = servedFromAllowance([
      candidate("a", STARVATION_PASSES),
      candidate("b", STARVATION_PASSES + 3),
      candidate("c", STARVATION_PASSES - 1),
      candidate("d", STARVATION_PASSES + 3),
    ]);
    expect([...served]).toEqual(["b", "d", "a"]);
  });

  it(`stops at ${STARVED_ALLOWANCE_FILES} files, so a pass's extra reads have a bound`, () => {
    const many = Array.from({ length: 30 }, (_, n) => candidate(`g${n}`, STARVATION_PASSES + (n % 3)));
    const served = servedFromAllowance(many);
    expect(served.size).toBe(STARVED_ALLOWANCE_FILES);
    // Everyone that waited longest is in; the rest wait one more pass.
    for (const { key, waited } of many) if (waited === STARVATION_PASSES + 2) expect(served.has(key)).toBe(true);
  });

  it("lets the longest-waiting group through alone even when it is larger than the allowance", () => {
    const big = STARVED_ALLOWANCE_FILES + 4;
    expect([...servedFromAllowance([candidate("big", 9, big), candidate("small", 6)])]).toEqual(["big"]);
  });

  it("passes over a group that does not fit, and keeps filling with ones that do", () => {
    const served = servedFromAllowance([
      candidate("first", 9, STARVED_ALLOWANCE_FILES - 2),
      candidate("tooBig", 8, 5),
      candidate("fits", 7, 2),
    ]);
    expect([...served]).toEqual(["first", "fits"]);
  });

  it("rotates: a group it served counts from zero, so the others come first next time", () => {
    const groups = Array.from({ length: 50 }, (_, n) => ({ key: `g${n}`, files: 1, waited: STARVATION_PASSES }));
    const servedAt = new Map<string, number>();
    for (let round = 0; round < 3; round++) {
      const served = servedFromAllowance(groups);
      for (const group of groups) {
        if (served.has(group.key)) {
          if (!servedAt.has(group.key)) servedAt.set(group.key, round);
          group.waited = 0;
        } else {
          group.waited += 1;
        }
      }
    }
    expect(servedAt.size).toBe(50);
  });
});
