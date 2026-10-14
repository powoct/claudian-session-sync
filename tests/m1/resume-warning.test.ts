/**
 * ADR-81 H10: say so when a Claude conversation's history has not arrived.
 *
 * Sending in a Claude conversation whose current transcript is not on this
 * machine fails with "no conversation found", and Claudian then deletes the
 * conversation (every session it names missing) or resets it (some missing),
 * on its own (`ClaudeConversationHistoryService`, the R2 path). The record
 * travels with the vault and the transcript with the sync folder, so the
 * window is this plugin's to point at: after every pass, a listed Claude
 * conversation whose current transcript is in the sync folder and not here is
 * named in the report, and the first time, in a pop-up.
 *
 * Through the real runtime. Records are written the way Claudian 2.3.20 writes
 * them (compact JSON), in the layers it reads.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PassReport } from "../../src/orchestration/pass-report";
import { type HarnessOptions, RuntimeHarness } from "../helpers/runtime-harness";
import { saveRecord, store } from "../helpers/claudian-2320";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const CONV = "conv-1786422687897-15ktes7p9";
const CONV2 = "conv-1786422687898-2abcdefgh";
const DEVICE = RuntimeHarness.deviceKey("this-device");
const OTHER_DEVICE = RuntimeHarness.deviceKey("other-device");
const LINES = '{"type":"user","text":"hi"}\n';

const machines: RuntimeHarness[] = [];
afterEach(async () => {
  while (machines.length) await machines.pop()?.dispose();
});

async function machine(options: HarnessOptions = {}): Promise<{ m: RuntimeHarness; ws: string }> {
  const m = await RuntimeHarness.create(options);
  machines.push(m);
  await m.configure();
  const status = await m.runtime.refresh();
  return { m, ws: status.workspaceId as string };
}

/** A transcript only the sync folder has — another device pushed it. */
async function inFolder(m: RuntimeHarness, ws: string, sessionId: string, text = LINES): Promise<void> {
  await fsp.mkdir(path.dirname(m.replicaPath(ws, sessionId)), { recursive: true });
  await fsp.writeFile(m.replicaPath(ws, sessionId), text);
}

async function here(m: RuntimeHarness, sessionId: string): Promise<void> {
  await fsp.writeFile(m.sessionPath(sessionId), LINES);
}

const warnings = (m: RuntimeHarness) =>
  (m.runtime.lastPassReport() as PassReport).notices.filter((n) => n.startsWith("History not here yet"));

describe("a listed Claude conversation whose history is still in the sync folder only", () => {
  it("is named after the pass, with a pop-up, and not once the transcript has landed", async () => {
    const { m, ws } = await machine();
    await saveRecord(m, CONV, { providerId: "claude", sessionId: S1 });
    await inFolder(m, ws, S1);

    // The first pass only probes the sync folder, so nothing lands yet.
    await m.runtime.syncNow();
    expect(await fsp.lstat(m.sessionPath(S1)).catch(() => null)).toBeNull();
    const lines = warnings(m);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(CONV);
    expect(lines[0]).toContain(`claude-code/${S1}.jsonl`);
    expect(m.runtime.takeAnnouncement()).toContain("History for 1 Claude conversation(s)");

    m.advanceClock(95_000);
    await m.settle();
    expect(await fsp.readFile(m.sessionPath(S1), "utf8")).toBe(LINES);
    expect(warnings(m)).toEqual([]);
    expect(m.runtime.takeAnnouncement() ?? "").not.toContain("History for");
  }, 30_000);

  it("says nothing when the transcript is here, or when the sync folder does not have it either", async () => {
    const { m, ws } = await machine();
    await saveRecord(m, CONV, { providerId: "claude", sessionId: S1 });
    await saveRecord(m, CONV2, { providerId: "claude", sessionId: S2 });
    await here(m, S1);
    await inFolder(m, ws, S1);
    // S2 is nowhere: nothing is on its way, so "wait" would promise nothing.

    await m.runtime.syncNow();
    expect(warnings(m)).toEqual([]);
    expect(m.runtime.takeAnnouncement()).toBeNull();
  });

  it("pops up once per conversation, names it every pass, and says what held the transcript back", async () => {
    const { m, ws } = await machine();
    await m.runtime.updateSettings({ maxFileSizeMB: 1 });
    await saveRecord(m, CONV, { providerId: "claude", sessionId: S1 });
    await inFolder(m, ws, S1, `${"x".repeat(1024 * 1024)}\n`);

    await m.settle();
    expect(m.runtime.takeAnnouncement()).toContain("History for 1 Claude conversation(s)");
    expect(warnings(m)).toHaveLength(1);
    expect(warnings(m)[0]).toContain("This pass: SKIP_TOO_LARGE (over-size-limit).");

    await m.runtime.syncNow();
    expect(warnings(m)).toHaveLength(1);
    expect(m.runtime.takeAnnouncement()).toBeNull();

    // A second conversation in the same state is news again.
    await saveRecord(m, CONV2, { providerId: "claude", sessionId: S2 });
    await inFolder(m, ws, S2);
    await m.runtime.syncNow();
    expect(warnings(m)).toHaveLength(2);
    expect(m.runtime.takeAnnouncement()).toContain("History for 2 Claude conversation(s)");

    // A restart is when Claudian reopens its tabs: worth saying again.
    m.restart();
    await m.runtime.refresh();
    await m.runtime.syncNow();
    expect(m.runtime.takeAnnouncement()).toContain("History for");
  }, 30_000);
});

describe("which conversations count", () => {
  it("reads this device's folder and the shared layer, the device copy winning — never another device's", async () => {
    const { m, ws } = await machine({ claudianDeviceKey: DEVICE });
    await saveRecord(m, CONV, { providerId: "claude", sessionId: S1 }, { device: DEVICE });
    await saveRecord(m, CONV2, { providerId: "claude", sessionId: S2 }, { device: OTHER_DEVICE });
    await inFolder(m, ws, S1);
    await inFolder(m, ws, S2);

    await m.runtime.syncNow();
    const lines = warnings(m);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(CONV);
  });

  it("lets the device copy decide when both layers have the conversation", async () => {
    const { m, ws } = await machine({ claudianDeviceKey: DEVICE });
    // The shared copy is stale and names a session not here; Claudian loads
    // the device copy, whose session is here.
    await saveRecord(m, CONV, { providerId: "claude", sessionId: S1 });
    await saveRecord(m, CONV, { providerId: "claude", sessionId: S2 }, { device: DEVICE });
    await inFolder(m, ws, S1);
    await here(m, S2);

    await m.runtime.syncNow();
    expect(warnings(m)).toEqual([]);
  });

  it("looks only at the shared layer when this device's key cannot be read", async () => {
    const { m, ws } = await machine();
    await saveRecord(m, CONV, { providerId: "claude", sessionId: S1 }, { device: DEVICE });
    await saveRecord(m, CONV2, { providerId: "claude", sessionId: S2 });
    await inFolder(m, ws, S1);
    await inFolder(m, ws, S2);

    await m.runtime.syncNow();
    const lines = warnings(m);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(CONV2);
  });

  it("does not read .claude/sessions, which Claudian 2.3.6 stopped reading", async () => {
    const { m, ws } = await machine();
    const legacy = path.join(m.vaultRoot, ".claude", "sessions");
    await fsp.mkdir(legacy, { recursive: true });
    await fsp.writeFile(path.join(legacy, `${CONV}.meta.json`), JSON.stringify({ id: CONV, providerId: "claude", sessionId: S1 }));
    await inFolder(m, ws, S1);

    await m.runtime.syncNow();
    expect(warnings(m)).toEqual([]);
  });

  it("skips a record with an older Claudian's deletion marker beside it", async () => {
    const { m, ws } = await machine();
    await saveRecord(m, CONV, { providerId: "claude", sessionId: S1 });
    await fsp.writeFile(
      path.join(store(m), `${CONV}.deleted.json`),
      JSON.stringify({ schemaVersion: 1, conversationId: CONV, deletedAt: 1 }, null, 2),
    );
    await inFolder(m, ws, S1);

    await m.runtime.syncNow();
    expect(warnings(m)).toEqual([]);
  });

  it("counts Claude records only — a record with no provider is Claude's, a Codex one is not", async () => {
    const { m, ws } = await machine();
    await saveRecord(m, CONV, { sessionId: S1 });
    await saveRecord(m, CONV2, { providerId: "codex", sessionId: S2 });
    await inFolder(m, ws, S1);
    await inFolder(m, ws, S2);

    await m.runtime.syncNow();
    const lines = warnings(m);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(CONV);
  });
});

describe("the session a send would resume", () => {
  it("is providerSessionId before sessionId", async () => {
    const { m, ws } = await machine();
    await saveRecord(m, CONV, { providerId: "claude", sessionId: S2, providerState: { providerSessionId: S1 } });
    await here(m, S2);
    await inFolder(m, ws, S1);

    await m.runtime.syncNow();
    expect(warnings(m)).toHaveLength(1);
    expect(warnings(m)[0]).toContain(`claude-code/${S1}.jsonl`);
  });

  it("is a fork's source until the fork has sent", async () => {
    const { m, ws } = await machine();
    await saveRecord(m, CONV, {
      providerId: "claude",
      sessionId: null,
      providerState: { forkSource: { sessionId: S1, resumeAt: "m1" } },
    });
    await inFolder(m, ws, S1);

    await m.runtime.syncNow();
    expect(warnings(m)).toHaveLength(1);
  });

  it("is not an earlier session, which a send never resumes", async () => {
    const { m, ws } = await machine();
    await saveRecord(m, CONV, {
      providerId: "claude",
      sessionId: S2,
      providerState: { previousProviderSessionIds: [S1] },
    });
    await here(m, S2);
    await inFolder(m, ws, S1);

    await m.runtime.syncNow();
    expect(warnings(m)).toEqual([]);
  });

  it("is nothing usable for a record with no session, or an id that is not a file name", async () => {
    const { m, ws } = await machine();
    // No `sessionId` key: Claudian defaults it to the record's own id, which
    // names no transcript.
    await saveRecord(m, CONV, { providerId: "claude" });
    await saveRecord(m, CONV2, { providerId: "claude", sessionId: `../${S1}` });
    await inFolder(m, ws, S1);

    await m.runtime.syncNow();
    expect(warnings(m)).toEqual([]);
  });
});

describe("when there is nothing to say", () => {
  it("with the Claude Code provider off — no transcript is on its way", async () => {
    const { m, ws } = await machine();
    await m.runtime.setProvider("claude-code", { enabled: false });
    await saveRecord(m, CONV, { providerId: "claude", sessionId: S1 });
    await inFolder(m, ws, S1);

    await m.runtime.syncNow();
    expect(warnings(m)).toEqual([]);
    expect(m.runtime.takeAnnouncement()).toBeNull();
  });

  it("in a dry run, whose report is the plan", async () => {
    const { m, ws } = await machine();
    await saveRecord(m, CONV, { providerId: "claude", sessionId: S1 });
    await inFolder(m, ws, S1);

    await m.runtime.syncNow({ dryRun: true });
    expect(warnings(m)).toEqual([]);
    expect(m.runtime.takeAnnouncement()).toBeNull();
  });
});
