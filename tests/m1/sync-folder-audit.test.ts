/**
 * ADR-81 H8: the sync folder audit — three lists, read-only.
 *
 * Deletion stays on the device that deleted (ADR-10, ADR-78), so the sync
 * folder only grows, and people want to know what it holds that nobody lists
 * any more. The audit answers with: ① conversations deleted here and the
 * history their records name in the sync folder; ② sessions there that no
 * record in this vault names — labelled as ambiguous, because they are; and
 * ③ records left in `.claude/sessions`, which Claudian 2.3.6 stopped reading.
 * It never writes: not the sync folder, not the vault, not a CLI's folder.
 *
 * Through the real runtime and the real adapters. The deletion in ① is made
 * the way Claudian 2.3.20 makes one (`tests/helpers/claudian-2320.ts`).
 */
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type HarnessOptions, RuntimeHarness } from "../helpers/runtime-harness";
import { deleteRecord, saveRecord, store } from "../helpers/claudian-2320";
import type { SyncFolderAudit } from "../../src/orchestration/sync-folder-audit";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const S3 = "33333333-3333-4333-8333-333333333333";
const S4 = "44444444-4444-4444-8444-444444444444";
const T1 = "01a003f8-172e-7421-b159-ee512a76e87d";
const T2 = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const G1 = "55555555-5555-4555-8555-555555555555";
const CONV = "conv-1786422687897-15ktes7p9";
const CONV2 = "conv-1786422687898-2abcdefgh";
const CONV3 = "conv-1786422687899-3abcdefgh";
const OTHER_DEVICE = RuntimeHarness.deviceKey("other-device");
const DATE = ["2026", "08", "15"] as const;
const rollout = (id: string) => `rollout-2026-08-15T14-49-45-${id}.jsonl`;
const EARLIER = '{"type":"user","n":1}\n{"type":"assistant","n":2}\n';
const CURRENT = '{"type":"user","n":3}\n';

const machines: RuntimeHarness[] = [];
afterEach(async () => {
  while (machines.length) await machines.pop()?.dispose();
});

async function machine(options: HarnessOptions = {}): Promise<{ m: RuntimeHarness; ws: string }> {
  const m = await RuntimeHarness.create(options);
  machines.push(m);
  await m.configure();
  await m.installClaudian("2.3.20");
  await fsp.mkdir(store(m), { recursive: true });
  const status = await m.runtime.refresh();
  await m.runtime.syncNow();
  return { m, ws: status.workspaceId as string };
}

async function write(target: string, text: string): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, text);
}

async function audit(m: RuntimeHarness): Promise<SyncFolderAudit> {
  const outcome = await m.runtime.auditSyncFolder();
  if (!outcome.ok) throw new Error(`audit refused: ${outcome.reason}`);
  return outcome.audit;
}

/** Every file under a directory: path, size, mtime and content hash. */
async function snapshot(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(`${path.relative(root, full)}/`);
        await walk(full);
      } else {
        const stat = await fsp.lstat(full);
        const hash = createHash("sha256").update(await fsp.readFile(full)).digest("hex");
        out.push(`${path.relative(root, full)} ${stat.size} ${stat.mtimeMs} ${hash}`);
      }
    }
  }
  await walk(root);
  return out.sort();
}

describe("① conversations deleted on this device", () => {
  it("are listed with the history files their records name in the sync folder, and those are not listed again", async () => {
    const { m, ws } = await machine();
    await m.runtime.setProvider("claudian", { enabled: true });
    await m.runtime.refresh();
    // An earlier session another device pushed, and the current one, here.
    await write(m.replicaPath(ws, S1), EARLIER);
    await write(m.sessionPath(S2), CURRENT);
    await saveRecord(m, CONV, {
      providerId: "claude",
      title: "Plan the trip",
      sessionId: S2,
      providerState: { previousProviderSessionIds: [S1] },
    });
    await m.settle();
    expect(await fsp.readFile(m.replicaPath(ws, S2), "utf8")).toBe(CURRENT);

    await deleteRecord(m, CONV);
    await m.settle();

    const result = await audit(m);
    expect(result.held).toHaveLength(1);
    const [held] = result.held;
    expect(held).toMatchObject({ conversationId: CONV, kind: "deleted-here", title: "Plan the trip", recordProvider: "claude" });
    expect(held?.sessions.map((s) => [s.providerId, s.sessionId, s.here]).sort()).toEqual([
      ["claude-code", S1, "here"],
      ["claude-code", S2, "here"],
    ]);
    expect(held?.totalBytes).toBe(EARLIER.length + CURRENT.length);
    // Shown under ①, so not counted again as "no record".
    expect(result.unrecorded.map((s) => s.sessionId)).not.toContain(S1);
    expect(result.unrecorded.map((s) => s.sessionId)).not.toContain(S2);
  }, 60_000);
});

describe("② sessions with no record in this vault", () => {
  it("are listed from every provider's folder, whether or not that provider is on here", async () => {
    const { m, ws } = await machine();
    const replica = (...parts: string[]) => path.join(m.syncDir, ws, ...parts);
    await write(m.replicaPath(ws, S1), "x".repeat(10));
    await write(replica("codex", ...DATE, rollout(T1)), "y".repeat(20));
    await write(replica("grok", G1, "summary.json"), "{}");
    await write(replica("grok", G1, "chat_history.jsonl"), "z".repeat(5));
    // Not a session of any provider: no adapter recognises it, so not here.
    await write(replica("claude-code", "notes.txt"), "?");

    const result = await audit(m);
    const rows = result.unrecorded.map((s) => [s.providerId, s.sessionId, s.files.length, s.totalBytes, s.here]);
    expect(rows).toEqual([
      ["codex", T1, 1, 20, "not-here"],
      ["claude-code", S1, 1, 10, "not-here"],
      ["grok", G1, 2, 7, "not-here"],
    ]);
  });

  it("leaves out a session any record names — another device's folder and .claude/sessions included", async () => {
    const { m, ws } = await machine();
    await write(m.replicaPath(ws, S1), "x");
    await write(m.replicaPath(ws, S2), "x");
    await write(m.replicaPath(ws, S3), "x");
    await saveRecord(m, CONV, { providerId: "claude", sessionId: S1 }, { device: OTHER_DEVICE });
    const legacy = path.join(m.vaultRoot, ".claude", "sessions");
    await write(path.join(legacy, `${CONV2}.meta.json`), JSON.stringify({ id: CONV2, providerId: "claude", sessionId: S2 }));

    const result = await audit(m);
    expect(result.unrecorded.map((s) => s.sessionId)).toEqual([S3]);
  });

  it("counts a Codex rollout archived here as on this device", async () => {
    const { m, ws } = await machine();
    await write(path.join(m.syncDir, ws, "codex", ...DATE, rollout(T1)), "y");
    await write(path.join(m.syncDir, ws, "codex", ...DATE, rollout(T2)), "y");
    await write(path.join(m.homedir, ".codex", "archived_sessions", rollout(T1)), "y");
    await write(path.join(m.homedir, ".codex", "sessions", ...DATE, rollout(T2)), "y");

    const result = await audit(m);
    expect(Object.fromEntries(result.unrecorded.map((s) => [s.sessionId, s.here]))).toEqual({
      [T1]: "archived-here",
      [T2]: "here",
    });
  });

  it("says when this vault has no conversation store at all", async () => {
    const { m, ws } = await machine();
    await fsp.rm(store(m), { recursive: true });
    await write(m.replicaPath(ws, S1), "x");

    const result = await audit(m);
    expect(result.storeFound).toBe(false);
    expect(result.unrecorded.map((s) => s.sessionId)).toEqual([S1]);
  });
});

describe("③ records only in .claude/sessions", () => {
  it("are listed with the id a terminal resumes them by, unless .claudian/sessions has them or a marker hides them", async () => {
    const { m } = await machine();
    const legacy = path.join(m.vaultRoot, ".claude", "sessions");
    const put = (conv: string, body: Record<string, unknown>) =>
      write(path.join(legacy, `${conv}.meta.json`), JSON.stringify({ id: conv, ...body }));
    await put(CONV, { providerId: "claude", title: "Old one", sessionId: S1 });
    await put(CONV2, { providerId: "claude", sessionId: S2 });
    await saveRecord(m, CONV2, { providerId: "claude", sessionId: S2 }, { device: OTHER_DEVICE });
    await put(CONV3, { providerId: "claude", sessionId: S3 });
    await write(path.join(legacy, `${CONV3}.deleted.json`), "{}");
    const NO_SESSION = "conv-1786422687900-4abcdefgh";
    await put(NO_SESSION, { providerId: "claude" });

    const result = await audit(m);
    expect(result.legacyOnly).toEqual([
      { conversationId: CONV, folder: ".claude/sessions", title: "Old one", recordProvider: "claude", sessionId: S1 },
      { conversationId: NO_SESSION, folder: ".claude/sessions", title: null, recordProvider: "claude", sessionId: null },
    ]);
  });
});

describe("the audit", () => {
  it("writes nothing — sync folder, vault, CLI folders and this machine's state are byte-for-byte as before", async () => {
    const { m, ws } = await machine();
    await m.runtime.setProvider("claudian", { enabled: true });
    await write(m.sessionPath(S4), "here\n");
    await saveRecord(m, CONV, { providerId: "claude", sessionId: S4, title: "T" });
    await m.settle();
    await deleteRecord(m, CONV);
    await write(m.replicaPath(ws, S1), "x");
    await m.settle();
    const before = {
      sync: await snapshot(m.syncDir),
      vault: await snapshot(m.vaultRoot),
      home: await snapshot(m.homedir),
    };
    const ready = m.runtime.currentStatus().readiness;
    expect(ready).toBe("READY");

    const result = await audit(m);
    expect(result.held.length + result.unrecorded.length).toBeGreaterThan(0);

    expect(await snapshot(m.syncDir)).toEqual(before.sync);
    expect(await snapshot(m.vaultRoot)).toEqual(before.vault);
    expect(await snapshot(m.homedir)).toEqual(before.home);
    await m.runtime.syncNow();
    expect(m.runtime.currentStatus().readiness).toBe("READY");
  }, 60_000);

  it("refuses rather than guesses when the sync folder is not there", async () => {
    const { m } = await machine();
    await fsp.rm(m.syncDir, { recursive: true });
    expect(await m.runtime.auditSyncFolder()).toEqual({ ok: false, reason: "unreachable" });
  });

  it("refuses before the vault's sync is set up", async () => {
    const m = await RuntimeHarness.create();
    machines.push(m);
    await m.runtime.refresh();
    expect(await m.runtime.auditSyncFolder()).toEqual({ ok: false, reason: "not-set-up" });
  });
});
