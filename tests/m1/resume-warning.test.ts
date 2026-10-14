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
 * named in the report — and, on the first answer after a start or once it
 * has been at risk for two answers running, in a pop-up.
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
const S3 = "33333333-3333-4333-8333-333333333333";
const CONV = "conv-1786422687897-15ktes7p9";
const CONV2 = "conv-1786422687898-2abcdefgh";
const CONV3 = "conv-1786422687899-3abcdefgh";
const DEVICE = RuntimeHarness.deviceKey("this-device");
const OTHER_DEVICE = RuntimeHarness.deviceKey("other-device");
const LINES = '{"type":"user","text":"hi"}\n';
const LARGE = `${"x".repeat(1024 * 1024)}\n`;
const POPUP = "History has not reached this device yet for";

const machines: RuntimeHarness[] = [];
afterEach(async () => {
  while (machines.length) await machines.pop()?.dispose();
});

/**
 * A machine set up earlier and started now: Obsidian launched with the plugin
 * configured, so the next real pass is the first this run — the one Claudian
 * has just read every record on disk before.
 */
async function machine(options: HarnessOptions = {}): Promise<{ m: RuntimeHarness; ws: string }> {
  const m = await RuntimeHarness.create(options);
  machines.push(m);
  await m.configure();
  m.restart();
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

const notices = (m: RuntimeHarness) => (m.runtime.lastPassReport() as PassReport).notices;
/** One line per conversation named; the "N more" and "could not check" lines are not these. */
const warnings = (m: RuntimeHarness) => notices(m).filter((n) => n.startsWith("History not here yet: Claude conversation"));
const popup = (m: RuntimeHarness) => m.runtime.takeAnnouncement() ?? "";

describe("a listed Claude conversation whose history is still in the sync folder only", () => {
  it("is named after the pass, with a pop-up, and not on the pass that brings the transcript", async () => {
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
    expect(lines[0]).toContain("(shared)");
    expect(popup(m)).toContain(`${POPUP} 1 Claude conversation(s)`);

    m.advanceClock(95_000);
    await m.runtime.syncNow();
    const report = m.runtime.lastPassReport() as PassReport;
    expect(report.actions.find((a) => a.neutralRel === `claude-code/${S1}.jsonl`)?.action).toBe("PULL_NEW");
    expect(await fsp.readFile(m.sessionPath(S1), "utf8")).toBe(LINES);
    expect(notices(m).filter((n) => n.startsWith("History not here yet"))).toEqual([]);
    expect(popup(m)).not.toContain(POPUP);
  }, 30_000);

  it("names the conversation by title in the pop-up only — the report and every file keep ids", async () => {
    const { m, ws } = await machine();
    const SENTINEL = "Sentinel title 7f3a — never in a report";
    await saveRecord(m, CONV, { providerId: "claude", sessionId: S1, title: SENTINEL });
    await inFolder(m, ws, S1);

    await m.runtime.syncNow();
    expect(warnings(m)).toHaveLength(1);
    expect(notices(m).some((n) => n.includes(SENTINEL))).toBe(false);
    expect(popup(m)).toContain(`"${SENTINEL}"`);
    const leaked: string[] = [];
    async function scan(dir: string): Promise<void> {
      for (const entry of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await scan(full);
        else if ((await fsp.readFile(full, "utf8")).includes(SENTINEL)) leaked.push(full);
      }
    }
    await scan(m.homedir);
    await scan(m.syncDir);
    expect(leaked).toEqual([]);
  });

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

  it("warns on a new machine, whose Claude projects folder does not exist yet", async () => {
    const { m, ws } = await machine();
    await fsp.rm(m.projectDir, { recursive: true });
    await saveRecord(m, CONV, { providerId: "claude", sessionId: S1 });
    await inFolder(m, ws, S1);

    await m.runtime.syncNow();
    expect(warnings(m)).toHaveLength(1);
    expect(popup(m)).toContain(`${POPUP} 1`);
  });
});

describe("the pop-up", () => {
  it("comes once per conversation, the report names it every pass and says what held the transcript back", async () => {
    const { m, ws } = await machine();
    await m.runtime.updateSettings({ maxFileSizeMB: 1 });
    await saveRecord(m, CONV, { providerId: "claude", sessionId: S1 });
    await inFolder(m, ws, S1, LARGE);

    await m.settle();
    expect(popup(m)).toContain(`${POPUP} 1 Claude conversation(s)`);
    expect(warnings(m)).toHaveLength(1);
    expect(warnings(m)[0]).toContain("This pass: SKIP_TOO_LARGE (over-size-limit).");

    await m.runtime.syncNow();
    expect(warnings(m)).toHaveLength(1);
    expect(m.runtime.takeAnnouncement()).toBeNull();

    // A restart is when Claudian reads its records again and reopens tabs.
    m.restart();
    await m.runtime.refresh();
    await m.runtime.syncNow();
    expect(popup(m)).toContain(`${POPUP} 1`);
  }, 30_000);

  it("waits a pass for a conversation that arrives while running — Claudian does not list it until restarted", async () => {
    const { m, ws } = await machine();
    await m.settle();
    // A new conversation shared from another device: record and transcript
    // arrive together, and the transcript lands a pass later.
    await saveRecord(m, CONV, { providerId: "claude", sessionId: S1 });
    await inFolder(m, ws, S1);

    await m.runtime.syncNow();
    expect(warnings(m)).toHaveLength(1);
    expect(m.runtime.takeAnnouncement()).toBeNull();
    m.advanceClock(95_000);
    await m.runtime.syncNow();
    expect(warnings(m)).toEqual([]);
    expect(m.runtime.takeAnnouncement()).toBeNull();
  }, 30_000);

  it("comes for one that arrives while running once it is still at risk a pass later, naming only that one", async () => {
    const { m, ws } = await machine();
    await m.runtime.updateSettings({ maxFileSizeMB: 1 });
    await saveRecord(m, CONV, { providerId: "claude", sessionId: S1 });
    await inFolder(m, ws, S1, LARGE);
    await m.settle();
    expect(popup(m)).toContain(`${POPUP} 1`);

    await saveRecord(m, CONV2, { providerId: "claude", sessionId: S2, title: "Second" });
    await inFolder(m, ws, S2, LARGE);
    await m.runtime.syncNow();
    expect(warnings(m)).toHaveLength(2);
    expect(m.runtime.takeAnnouncement()).toBeNull();
    await m.runtime.syncNow();
    const text = popup(m);
    expect(text).toContain(`${POPUP} 1 Claude conversation(s): "Second".`);
  }, 30_000);

  it("comes again for a conversation that was safe and is at risk again", async () => {
    const { m, ws } = await machine();
    await m.runtime.updateSettings({ maxFileSizeMB: 1 });
    await saveRecord(m, CONV, { providerId: "claude", sessionId: S1 });
    await inFolder(m, ws, S1);
    await m.runtime.syncNow();
    expect(popup(m)).toContain(`${POPUP} 1`);
    m.advanceClock(95_000);
    await m.runtime.syncNow();
    expect(warnings(m)).toEqual([]);

    // Continued on another device in a new session, its transcript held back.
    await saveRecord(m, CONV, { providerId: "claude", sessionId: S2 });
    await inFolder(m, ws, S2, LARGE);
    await m.runtime.syncNow();
    expect(warnings(m)).toHaveLength(1);
    await m.runtime.syncNow();
    expect(popup(m)).toContain(`${POPUP} 1`);
  }, 30_000);

  it("is replaced, not queued: one nobody showed is gone once the transcript has landed", async () => {
    const { m, ws } = await machine();
    await saveRecord(m, CONV, { providerId: "claude", sessionId: S1 });
    await inFolder(m, ws, S1);
    // A pass a command started — nobody takes its pop-up.
    await m.runtime.syncNow();
    m.advanceClock(95_000);
    await m.runtime.syncNow();
    expect(warnings(m)).toEqual([]);
    expect(m.runtime.takeAnnouncement()).toBeNull();
  }, 30_000);

  it("keeps quiet through a pass that could not look, and does not come back after it", async () => {
    let failing = false;
    const deviceDir = (m: RuntimeHarness) => path.join(store(m), "devices", DEVICE);
    const holder: { m?: RuntimeHarness } = {};
    const { m, ws } = await machine({
      claudianDeviceKey: DEVICE,
      beforeReadDir: async (target) => {
        if (failing && holder.m && path.resolve(target) === path.resolve(deviceDir(holder.m))) {
          throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
        }
      },
    });
    holder.m = m;
    await m.runtime.updateSettings({ maxFileSizeMB: 1 });
    await fsp.mkdir(deviceDir(m), { recursive: true });
    await saveRecord(m, CONV, { providerId: "claude", sessionId: S1 });
    await inFolder(m, ws, S1, LARGE);
    await m.runtime.syncNow();
    expect(popup(m)).toContain(`${POPUP} 1`);

    failing = true;
    await m.runtime.syncNow();
    failing = false;
    expect(warnings(m)).toEqual([]);
    expect(notices(m)).toContain(
      "History not here yet: this pass could not check (a folder did not answer); the last check named 1 Claude conversation(s).",
    );
    expect(m.runtime.takeAnnouncement()).toBeNull();

    // Two answers running is what a pop-up needs; nothing has changed.
    for (let i = 0; i < 2; i += 1) {
      await m.runtime.syncNow();
      expect(warnings(m)).toHaveLength(1);
      expect(m.runtime.takeAnnouncement()).toBeNull();
    }
  }, 30_000);

  it("keeps a conversation whose record is caught mid-write as it was", async () => {
    const { m, ws } = await machine();
    await m.runtime.updateSettings({ maxFileSizeMB: 1 });
    await saveRecord(m, CONV, { providerId: "claude", sessionId: S1 });
    await inFolder(m, ws, S1, LARGE);
    await m.runtime.syncNow();
    expect(popup(m)).toContain(`${POPUP} 1`);

    await fsp.writeFile(path.join(store(m), `${CONV}.meta.json`), '{"id":"conv-17864');
    await m.runtime.syncNow();
    expect(warnings(m)).toHaveLength(1);
    await saveRecord(m, CONV, { providerId: "claude", sessionId: S1 });
    for (let i = 0; i < 2; i += 1) {
      await m.runtime.syncNow();
      expect(warnings(m)).toHaveLength(1);
      expect(m.runtime.takeAnnouncement()).toBeNull();
    }
  }, 30_000);
});

describe("the report", () => {
  it("names twenty conversations, the most recently active first, and counts the rest", async () => {
    const { m, ws } = await machine();
    const ids: string[] = [];
    for (let i = 0; i < 22; i += 1) {
      const conv = `conv-17864226879${String(i).padStart(2, "0")}-${"a".repeat(8)}${String.fromCharCode(97 + i)}`;
      const sid = `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`;
      ids.push(conv);
      await saveRecord(m, conv, { providerId: "claude", sessionId: sid, title: `T${i}`, lastActivityAt: 1_000 + i });
      await inFolder(m, ws, sid);
    }

    await m.runtime.syncNow();
    const named = warnings(m);
    expect(named).toHaveLength(20);
    expect(named.map((line) => ids.find((id) => line.includes(id)))).toEqual([...ids].reverse().slice(0, 20));
    expect(notices(m)).toContain("History not here yet: 2 more Claude conversation(s) like the above, less recent.");
    expect(popup(m)).toContain(`${POPUP} 22 Claude conversation(s): "T21", "T20", "T19" and 19 more.`);
  }, 30_000);
});

describe("which conversations count", () => {
  it("reads this device's folder and the shared layer, the device copy winning — never another device's", async () => {
    const { m, ws } = await machine({ claudianDeviceKey: DEVICE });
    await saveRecord(m, CONV, { providerId: "claude", sessionId: S1 }, { device: DEVICE });
    await saveRecord(m, CONV2, { providerId: "claude", sessionId: S2 }, { device: OTHER_DEVICE });
    await saveRecord(m, CONV3, { providerId: "claude", sessionId: S3 });
    await inFolder(m, ws, S1);
    await inFolder(m, ws, S2);
    await inFolder(m, ws, S3);

    await m.runtime.syncNow();
    const lines = warnings(m);
    expect(lines).toHaveLength(2);
    const device = lines.find((line) => line.includes(CONV));
    const shared = lines.find((line) => line.includes(CONV3));
    expect(device).not.toContain("(shared)");
    expect(shared).toContain("(shared)");
    expect(shared).toContain("the change would reach your other devices with the vault");
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

  it("skips what Claudian would refuse to list: an id that is not the file's name, a name it does not index", async () => {
    const { m, ws } = await machine();
    await fsp.mkdir(store(m), { recursive: true });
    await fsp.writeFile(
      path.join(store(m), `${CONV}.meta.json`),
      JSON.stringify({ id: "conv-other-1", providerId: "claude", sessionId: S1 }),
    );
    await fsp.writeFile(
      path.join(store(m), "backup copy.meta.json"),
      JSON.stringify({ id: "backup copy", providerId: "claude", sessionId: S2 }),
    );
    await inFolder(m, ws, S1);
    await inFolder(m, ws, S2);

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

  it("looks for the transcript in the projects folder the Claude Code provider is set to use", async () => {
    const { m, ws } = await machine();
    const elsewhere = path.join(m.root, "claude-elsewhere");
    const dir = path.join(elsewhere, path.basename(m.projectDir));
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `${S1}.jsonl`), LINES);
    await m.runtime.setProvider("claude-code", { enabled: true, rootOverride: elsewhere });
    await saveRecord(m, CONV, { providerId: "claude", sessionId: S1 });
    await inFolder(m, ws, S1);

    await m.runtime.syncNow();
    expect(warnings(m)).toEqual([]);
    await fsp.rm(path.join(dir, `${S1}.jsonl`));
    await m.runtime.syncNow();
    expect(warnings(m)).toHaveLength(1);
  });
});

describe("the session a send would resume", () => {
  it("is the conversation's sessionId; when providerSessionId names another, a failed resume is preserved", async () => {
    const { m, ws } = await machine();
    // Resumes S2, which is here: no R2 at all.
    await saveRecord(m, CONV, { providerId: "claude", sessionId: S2, providerState: { providerSessionId: S1 } });
    // Resumes S3, which is not here — but R2 compares against S1 and preserves.
    await saveRecord(m, CONV2, { providerId: "claude", sessionId: S3, providerState: { providerSessionId: S1 } });
    await here(m, S2);
    await here(m, S1);
    await inFolder(m, ws, S1);
    await inFolder(m, ws, S3);

    await m.runtime.syncNow();
    expect(warnings(m)).toEqual([]);
  });

  it("is providerSessionId once sessionId is cleared — a fork that has sent included", async () => {
    const { m, ws } = await machine();
    await saveRecord(m, CONV, {
      providerId: "claude",
      sessionId: null,
      providerState: { providerSessionId: S2, forkSource: { sessionId: S1, resumeAt: "m1" } },
    });
    await here(m, S1);
    await inFolder(m, ws, S2);

    await m.runtime.syncNow();
    expect(warnings(m)).toHaveLength(1);
    expect(warnings(m)[0]).toContain(`claude-code/${S2}.jsonl`);
  });

  it("is a fork's source until the fork has sent — only a source Claudian can fork from", async () => {
    const { m, ws } = await machine();
    await saveRecord(m, CONV, {
      providerId: "claude",
      sessionId: null,
      providerState: { forkSource: { sessionId: S1, resumeAt: "m1" } },
    });
    // No resume point: Claudian does not fork from it, and resumes nothing.
    await saveRecord(m, CONV2, { providerId: "claude", sessionId: null, providerState: { forkSource: { sessionId: S2 } } });
    await inFolder(m, ws, S1);
    await inFolder(m, ws, S2);

    await m.runtime.syncNow();
    expect(warnings(m)).toHaveLength(1);
    expect(warnings(m)[0]).toContain(CONV);
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

  it("is nothing usable for a record with no session, or an id Claudian would not put in a path", async () => {
    const { m, ws } = await machine();
    // No `sessionId` key: Claudian defaults it to the record's own id, which
    // names no transcript.
    await saveRecord(m, CONV, { providerId: "claude" });
    // A legal file name, and one Claudian's `isPathSafeId` refuses.
    await saveRecord(m, CONV2, { providerId: "claude", sessionId: "a.b" });
    await inFolder(m, ws, "a.b");

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
});

describe("a dry run", () => {
  it("names the conversations in its report and changes nothing the next real pass decides", async () => {
    const { m, ws } = await machine();
    await saveRecord(m, CONV, { providerId: "claude", sessionId: S1 });
    await inFolder(m, ws, S1);

    await m.runtime.syncNow({ dryRun: true });
    expect(warnings(m)).toHaveLength(1);
    expect(m.runtime.takeAnnouncement()).toBeNull();

    await m.runtime.syncNow();
    expect(popup(m)).toContain(`${POPUP} 1`);
  });
});
