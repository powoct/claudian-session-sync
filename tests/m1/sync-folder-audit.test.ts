/**
 * ADR-81 H8: the sync folder audit — three lists, read-only.
 *
 * Deletion stays on the device that deleted (ADR-10, ADR-78), so the sync
 * folder only grows, and people want to know what it holds that nobody lists
 * any more. The audit answers with: ① conversations this device keeps off
 * itself and the history their records name in the sync folder; ② sessions
 * there that no record in this vault names — labelled as ambiguous, because
 * they are; and ③ records left in `.claude/sessions`, which Claudian 2.3.6
 * stopped reading. It never writes: not the sync folder, not the vault, not a
 * CLI's folder — and it does not look in the folder of a CLI switched off here.
 *
 * Through the real runtime and the real adapters. The deletion in ① is made
 * the way Claudian 2.3.20 makes one (`tests/helpers/claudian-2320.ts`).
 */
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type HarnessOptions, RuntimeHarness } from "../helpers/runtime-harness";
import { assignToDevice, deleteRecord, legacyPeerDelete, saveRecord, store } from "../helpers/claudian-2320";
import { type SyncFolderAudit, auditSyncFolder } from "../../src/orchestration/sync-folder-audit";
import { createNodeFsGateway } from "../../src/infra/node-fs-gateway";
import { sequentialIdGen } from "../../src/infra/clock";
import { makeRealTmpDir, removeTree } from "../helpers/fs-cleanup";

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
const DEVICE = RuntimeHarness.deviceKey("this-device");
const OTHER_DEVICE = RuntimeHarness.deviceKey("other-device");
const DATE = ["2026", "08", "15"] as const;
const rollout = (id: string) => `rollout-2026-08-15T14-49-45-${id}.jsonl`;
const EARLIER = '{"type":"user","n":1}\n{"type":"assistant","n":2}\n';
const CURRENT = '{"type":"user","n":3}\n';

const machines: RuntimeHarness[] = [];
afterEach(async () => {
  while (machines.length) await machines.pop()?.dispose();
});

async function machine(
  options: HarnessOptions & { readonly claudian?: string } = {},
): Promise<{ m: RuntimeHarness; ws: string }> {
  const m = await RuntimeHarness.create(options);
  machines.push(m);
  await m.configure();
  await m.installClaudian(options.claudian ?? "2.3.20");
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

const ids = (sessions: ReadonlyArray<{ sessionId: string }>) => sessions.map((s) => s.sessionId);

/** Every entry under a directory: path, size, mtime — directories' included — and content hash. */
async function snapshot(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name);
      const stat = await fsp.lstat(full);
      if (entry.isDirectory()) {
        // A file written and removed again leaves its folder's mtime moved.
        out.push(`${path.relative(root, full)}/ ${stat.mtimeMs}`);
        await walk(full);
      } else {
        const hash = createHash("sha256").update(await fsp.readFile(full)).digest("hex");
        out.push(`${path.relative(root, full)} ${stat.size} ${stat.mtimeMs} ${hash}`);
      }
    }
  }
  out.push(`./ ${(await fsp.lstat(root)).mtimeMs}`);
  await walk(root);
  return out.sort();
}

describe("① conversations kept off this device", () => {
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
    expect(result.deletedHere).toBe("tracked");
    expect(result.held).toHaveLength(1);
    const [held] = result.held;
    expect(held).toMatchObject({ conversationId: CONV, kind: "deleted-here", title: "Plan the trip", recordProvider: "claude" });
    expect(held?.sessions.map((s) => [s.providerId, s.sessionId, s.here]).sort()).toEqual([
      ["claude-code", S1, "here"],
      ["claude-code", S2, "here"],
    ]);
    expect(held?.totalBytes).toBe(EARLIER.length + CURRENT.length);
    // Shown under ①, so not counted again as "no record".
    expect(ids(result.unrecorded)).not.toContain(S1);
    expect(ids(result.unrecorded)).not.toContain(S2);
  }, 60_000);

  it("do not include a record moved into a device folder, which is still a listed conversation", async () => {
    const { m, ws } = await machine({ claudianDeviceKey: DEVICE });
    await m.runtime.setProvider("claudian", { enabled: true });
    await m.runtime.refresh();
    await write(m.sessionPath(S1), CURRENT);
    await saveRecord(m, CONV, { providerId: "claude", sessionId: S1 });
    await m.settle();
    await assignToDevice(m, CONV, DEVICE);
    await m.settle();
    expect(await fsp.readFile(m.replicaPath(ws, S1), "utf8")).toBe(CURRENT);

    const result = await audit(m);
    expect(result.held).toEqual([]);
    expect(ids(result.unrecorded)).not.toContain(S1);
  }, 60_000);

  it("include one removed by an older Claudian's deletion marker, labelled as such", async () => {
    const { m, ws } = await machine({ claudian: "2.3.2" });
    await m.runtime.setProvider("claudian", { enabled: true });
    await m.runtime.refresh();
    await write(m.sessionPath(S1), CURRENT);
    await saveRecord(m, CONV, { providerId: "claude", sessionId: S1, title: "Marked" });
    await m.settle();
    await legacyPeerDelete(m, CONV);
    await m.settle();
    expect(await fsp.readFile(m.replicaPath(ws, S1), "utf8")).toBe(CURRENT);

    const result = await audit(m);
    expect(result.held.map((h) => [h.conversationId, h.kind, ids(h.sessions)])).toEqual([
      [CONV, "removed-by-tombstone", [S1]],
    ]);
  }, 60_000);

  it("do not claim a fork's source, which is another conversation's history", async () => {
    const { m, ws } = await machine();
    await m.runtime.setProvider("claudian", { enabled: true });
    await m.runtime.refresh();
    await write(m.sessionPath(S1), CURRENT);
    await saveRecord(m, CONV2, { providerId: "claude", title: "Source", sessionId: S1 });
    await saveRecord(m, CONV, {
      providerId: "claude",
      title: "Fork",
      sessionId: null,
      providerState: { forkSource: { sessionId: S1, resumeAt: "m1" } },
    });
    await m.settle();
    expect(await fsp.readFile(m.replicaPath(ws, S1), "utf8")).toBe(CURRENT);
    await deleteRecord(m, CONV);
    await m.settle();

    const result = await audit(m);
    expect(result.held.map((h) => [h.conversationId, h.sessions, h.totalBytes])).toEqual([[CONV, [], 0]]);
    expect(ids(result.unrecorded)).not.toContain(S1);
  }, 60_000);

  it("read a Codex record's thread, and a record with no provider as Claude's", async () => {
    const { m, ws } = await machine();
    await m.runtime.setProvider("claudian", { enabled: true });
    await m.runtime.refresh();
    // Both pushed by another device: admission here counts neither record.
    await write(path.join(m.syncDir, ws, "codex", ...DATE, rollout(T1)), "y".repeat(3));
    await write(m.replicaPath(ws, S1), CURRENT);
    await saveRecord(m, CONV, { providerId: "codex", sessionId: null, providerState: { threadId: T1 } });
    await saveRecord(m, CONV2, { sessionId: S1 });
    await m.settle();
    await deleteRecord(m, CONV);
    await deleteRecord(m, CONV2);
    await m.settle();

    const result = await audit(m);
    const rows = Object.fromEntries(result.held.map((h) => [h.conversationId, [h.recordProvider, ids(h.sessions)]]));
    expect(rows).toEqual({ [CONV]: ["codex", [T1]], [CONV2]: ["claude", [S1]] });
  }, 60_000);

  it("say why the list is empty when this device does not track deletions", async () => {
    const { m } = await machine();
    expect((await audit(m)).deletedHere).toBe("records-provider-off");
    await m.runtime.setProvider("claudian", { enabled: true });
    await m.runtime.refresh();
    expect((await audit(m)).deletedHere).toBe("tracked");
  });

  it("count a held record the sync folder no longer has, and do not read one larger than Max file size", async () => {
    const { m, ws } = await machine();
    await m.runtime.setProvider("claudian", { enabled: true });
    await m.runtime.refresh();
    await saveRecord(m, CONV, { providerId: "codex", sessionId: null, title: "Gone" });
    await saveRecord(m, CONV2, { providerId: "codex", sessionId: null, title: "Large" });
    await m.settle();
    await deleteRecord(m, CONV);
    await deleteRecord(m, CONV2);
    await m.settle();
    await fsp.rm(path.join(m.syncDir, ws, "claudian", `${CONV}.meta.json`));
    await m.runtime.updateSettings({ maxFileSizeMB: 1 });
    await fsp.writeFile(
      path.join(m.syncDir, ws, "claudian", `${CONV2}.meta.json`),
      JSON.stringify({ id: CONV2, providerId: "codex", title: "Large", pad: "x".repeat(1024 * 1024) }),
    );

    const result = await audit(m);
    expect(result.heldNotInFolder).toBe(1);
    expect(result.held.map((h) => [h.conversationId, h.title, h.recordProvider])).toEqual([[CONV2, null, null]]);
  }, 60_000);
});

describe("① a held record whose copy will not answer", () => {
  it("is listed as unreadable, not counted as gone from the sync folder", async () => {
    const root = makeRealTmpDir("aiss-h8-");
    try {
      const real = createNodeFsGateway({ ids: sequentialIdGen(), platform: process.platform, pid: process.pid, sleep: async () => undefined });
      const replicaRoot = path.join(root, "sync", "ws");
      const copy = path.join(replicaRoot, "claudian", `${CONV}.meta.json`);
      await write(copy, JSON.stringify({ id: CONV, providerId: "claude", sessionId: S1 }));
      const fs = {
        ...real,
        lstat: async (target: string) => {
          if (path.resolve(target) === copy) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
          return real.lstat(target);
        },
      };
      const hold = { kind: "deleted-here", sinceMs: 1, passes: 2, announced: true, replicaSize: 1, replicaMtimeMs: 1, replicaDigest: null, releaseRequested: false } as const;
      const result = await auditSyncFolder({
        fs,
        joinPath: path.join,
        replicaRoot,
        vaultRealPath: path.join(root, "vault"),
        providers: [],
        deletedHere: {
          status: "tracked",
          file: { schemaVersion: 1, records: { [`claudian/${CONV}.meta.json`]: { witnessedHash: "x", hold } } },
        },
        legacyStillListed: false,
        maxRecordBytes: 1024 * 1024,
      });
      expect(result.heldNotInFolder).toBe(0);
      expect(result.held.map((h) => [h.conversationId, h.recordProvider, h.sessions])).toEqual([[CONV, null, []]]);
    } finally {
      removeTree(root);
    }
  });
});

describe("② sessions with no record in this vault", () => {
  it("are listed from every provider's folder, looked for here only for providers switched on", async () => {
    const { m, ws } = await machine();
    const replica = (...parts: string[]) => path.join(m.syncDir, ws, ...parts);
    await write(m.replicaPath(ws, S1), "x".repeat(10));
    await write(replica("codex", ...DATE, rollout(T1)), "y".repeat(20));
    await write(replica("grok", G1, "summary.json"), "{}");
    await write(replica("grok", G1, "chat_history.jsonl"), "z".repeat(5));
    // Codex is off here: its own copy is not looked for, even though it is there.
    await write(path.join(m.homedir, ".codex", "sessions", ...DATE, rollout(T1)), "y");
    // Not a session of any provider: no adapter recognises it, so not here.
    await write(replica("claude-code", "notes.txt"), "?");

    const result = await audit(m);
    const rows = result.unrecorded.map((s) => [s.providerId, s.sessionId, s.files.length, s.totalBytes, s.here]);
    expect(rows).toEqual([
      ["codex", T1, 1, 20, "unchecked"],
      ["claude-code", S1, 1, 10, "not-here"],
      ["grok", G1, 2, 7, "unchecked"],
    ]);
    expect(result).toMatchObject({ storeFound: true, recordsUnread: 0, unreadDirs: [] });
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
    expect(ids(result.unrecorded)).toEqual([S3]);
  });

  it("leaves out every session a live conversation's history is built from, not only its first id", async () => {
    const { m, ws } = await machine();
    for (const id of [S1, S2, S3, S4]) await write(m.replicaPath(ws, id), "x");
    // A rolled-over session, and one Claudian reset: the earlier ids stay in the record.
    await saveRecord(m, CONV, { providerId: "claude", sessionId: S2, providerState: { previousProviderSessionIds: [S1] } });
    await saveRecord(m, CONV2, { providerId: "claude", sessionId: null, providerState: { previousProviderSessionIds: [S3] } });
    // No provider id: Claude's, as Claudian reads it.
    await saveRecord(m, CONV3, { sessionId: S4 });
    await write(path.join(m.syncDir, ws, "codex", ...DATE, rollout(T1)), "y");
    await saveRecord(m, "conv-1786422687900-4abcdefgh", {
      providerId: "codex",
      sessionId: null,
      providerState: { previousProviderSessionIds: [T1] },
    });

    const result = await audit(m);
    expect(ids(result.unrecorded)).toEqual([]);
  });

  it("leaves out a pending fork's source even when the source conversation has no record here", async () => {
    const { m, ws } = await machine();
    await write(m.replicaPath(ws, S1), "x");
    await saveRecord(m, CONV, {
      providerId: "claude",
      sessionId: null,
      providerState: { forkSource: { sessionId: S1, resumeAt: "m1" } },
    });

    expect(ids((await audit(m)).unrecorded)).toEqual([]);
  });

  it("matches ids whatever their case, as Claudian compares them", async () => {
    const { m, ws } = await machine();
    const LETTERS = "abcdef12-abcd-4abc-8abc-abcdefabcdef";
    await write(m.replicaPath(ws, LETTERS), "x");
    await saveRecord(m, CONV, { providerId: "claude", sessionId: LETTERS.toUpperCase() });

    expect(ids((await audit(m)).unrecorded)).toEqual([]);
  });

  it("counts a Codex rollout archived here as on this device", async () => {
    const { m, ws } = await machine();
    await m.runtime.setProvider("codex", { enabled: true });
    await m.runtime.refresh();
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
    expect(ids(result.unrecorded)).toEqual([S1]);
  });

  it("says how many record folders or records could not be read, and which sync folder folders", async () => {
    let failing = false;
    const holder: { m?: RuntimeHarness; ws?: string } = {};
    const { m, ws } = await machine({
      beforeReadDir: async (target) => {
        if (!failing || !holder.m || !holder.ws) return;
        const blocked = [
          path.join(holder.m.vaultRoot, ".claude", "sessions"),
          path.join(holder.m.syncDir, holder.ws, "codex", "2026"),
        ];
        if (blocked.includes(path.resolve(target))) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
    });
    Object.assign(holder, { m, ws });
    await write(path.join(m.vaultRoot, ".claude", "sessions", `${CONV}.meta.json`), "{}");
    await write(path.join(store(m), `${CONV2}.meta.json`), '{"id": "torn');
    await write(path.join(m.syncDir, ws, "codex", ...DATE, rollout(T1)), "y");

    failing = true;
    const result = await audit(m);
    failing = false;
    expect(result.recordsUnread).toBe(2);
    expect(result.unreadDirs).toEqual(["codex/2026/"]);
  }, 60_000);
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
    expect(result.legacyStillListed).toBe(false);
  });

  it("give the session a send would resume, never a pending fork's source, and read a record with no provider as Claude's", async () => {
    const { m } = await machine({ claudian: "2.3.5" });
    const legacy = path.join(m.vaultRoot, ".claude", "sessions");
    const put = (conv: string, body: Record<string, unknown>) =>
      write(path.join(legacy, `${conv}.meta.json`), JSON.stringify({ id: conv, ...body }));
    await put(CONV, { sessionId: S2, providerState: { providerSessionId: S1 } });
    await put(CONV2, { providerId: "claude", sessionId: null, providerState: { forkSource: { sessionId: S3, resumeAt: "m" } } });

    const result = await audit(m);
    expect(result.legacyOnly.map((r) => [r.conversationId, r.recordProvider, r.sessionId])).toEqual([
      [CONV, "claude", S2],
      [CONV2, "claude", null],
    ]);
    expect(result.legacyStillListed).toBe(true);
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
