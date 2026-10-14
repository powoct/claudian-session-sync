/**
 * ADR-79: a Codex rollout archived on this machine stays archived.
 *
 * Archiving a thread — in Codex, or in Claudian 2.3.11 and later, by hand, in
 * bulk or on a timer — renames its rollout from `sessions/Y/M/D/` into the
 * flat `archived_sessions/` beside it (codex-rs `archive_thread.rs`). Before
 * this, the next pass saw a rollout the sync folder had and `sessions/` did
 * not, read that as "not here yet", and landed a second copy (OQ-35). Nothing
 * was lost; the CLI was left with two files for one thread, and on unarchive
 * Codex's own rename replaced the copy, turning anything a peer had added into
 * a shrink.
 *
 * Through the real runtime and the real Codex adapter, on a real filesystem:
 * the path the archive is found on is part of what is under test.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PassReport } from "../../src/orchestration/pass-report";
import { RuntimeHarness } from "../helpers/runtime-harness";

const SID = "01a003f8-172e-7421-b159-ee512a76e87d";
const OTHER = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const rollout = (id: string, time = "14-49-45") => `rollout-2026-08-15T${time}-${id}.jsonl`;
const DATE = ["2026", "08", "15"] as const;

const machines: RuntimeHarness[] = [];
afterEach(async () => {
  while (machines.length) await machines.pop()?.dispose();
});

const codexHome = (m: RuntimeHarness) => path.join(m.homedir, ".codex");
const activePath = (m: RuntimeHarness, name: string) => path.join(codexHome(m), "sessions", ...DATE, name);
const archivedPath = (m: RuntimeHarness, name: string) => path.join(codexHome(m), "archived_sessions", name);
const exists = (target: string) =>
  fsp
    .lstat(target)
    .then(() => true)
    .catch(() => false);

async function machine(): Promise<{ m: RuntimeHarness; replica: (name: string) => string }> {
  const m = await RuntimeHarness.create();
  machines.push(m);
  await m.configure();
  await m.runtime.setProvider("codex", { enabled: true });
  const status = await m.runtime.refresh();
  const workspaceId = status.workspaceId as string;
  return { m, replica: (name) => path.join(m.syncDir, workspaceId, "codex", ...DATE, name) };
}

/** The vault's Claudian record for a Codex thread — what admits it for pushing. */
async function record(m: RuntimeHarness, threadId: string): Promise<void> {
  const store = path.join(m.vaultRoot, ".claudian", "sessions");
  await fsp.mkdir(store, { recursive: true });
  await fsp.writeFile(
    path.join(store, `conv-1786422687897-${threadId.slice(0, 8)}.meta.json`),
    JSON.stringify({ id: `conv-1786422687897-${threadId.slice(0, 8)}`, providerId: "codex", sessionId: threadId }),
  );
}

async function write(target: string, text: string): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, text);
}

/** What `thread/archive` does to the file. */
async function archive(m: RuntimeHarness, name: string): Promise<void> {
  await fsp.mkdir(path.dirname(archivedPath(m, name)), { recursive: true });
  await fsp.rename(activePath(m, name), archivedPath(m, name));
}

/** What `thread/unarchive` does: back under its date, and touched. */
async function unarchive(m: RuntimeHarness, name: string): Promise<void> {
  await fsp.mkdir(path.dirname(activePath(m, name)), { recursive: true });
  await fsp.rename(archivedPath(m, name), activePath(m, name));
  const now = new Date();
  await fsp.utimes(activePath(m, name), now, now);
}

const rowFor = (m: RuntimeHarness, name: string) =>
  (m.runtime.lastPassReport() as PassReport).actions.find((a) => a.neutralRel.endsWith(name));

const LINES = '{"type":"session_meta"}\n{"type":"user"}\n';
const MORE = '{"type":"assistant"}\n';

describe("a rollout archived on this machine", () => {
  it("is not copied back into sessions/, and the archive is left exactly as it was", async () => {
    const { m, replica } = await machine();
    const name = rollout(SID);
    await record(m, SID);
    await write(activePath(m, name), LINES);
    await m.settle();
    expect(await fsp.readFile(replica(name), "utf8")).toBe(LINES);

    await archive(m, name);
    await m.settle();

    expect(await exists(activePath(m, name))).toBe(false);
    expect(rowFor(m, name)).toMatchObject({ action: "SKIP_ARCHIVED_HERE", reason: "archived-here" });
    expect(await fsp.readFile(archivedPath(m, name), "utf8")).toBe(LINES);
    expect(await fsp.readdir(path.join(codexHome(m), "archived_sessions"))).toEqual([name]);
    expect(await fsp.readFile(replica(name), "utf8")).toBe(LINES);
  }, 30_000);

  it("syncs again once unarchived, with what another device added meanwhile", async () => {
    const { m, replica } = await machine();
    const name = rollout(SID);
    await record(m, SID);
    await write(activePath(m, name), LINES);
    await m.settle();
    await archive(m, name);
    await m.settle();

    // A peer that never archived it keeps the conversation going.
    await fsp.appendFile(replica(name), MORE);
    await m.settle();
    expect(rowFor(m, name)?.action).toBe("SKIP_ARCHIVED_HERE");

    await unarchive(m, name);
    await m.settle();
    expect(await fsp.readFile(activePath(m, name), "utf8")).toBe(LINES + MORE);
    expect(await exists(archivedPath(m, name))).toBe(false);
  }, 30_000);

  it("is not landed when it was archived here before the sync folder ever had it", async () => {
    // A thread archived long before this plugin was installed, which a peer
    // that still has it active pushes now. It is on this machine all the same.
    const { m, replica } = await machine();
    const name = rollout(SID);
    await write(archivedPath(m, name), LINES);
    await write(replica(name), LINES + MORE);

    await m.settle();

    expect(await exists(activePath(m, name))).toBe(false);
    expect(rowFor(m, name)?.action).toBe("SKIP_ARCHIVED_HERE");
    expect(await fsp.readFile(archivedPath(m, name), "utf8")).toBe(LINES);
  }, 30_000);

  it("does not take a share of the files-per-pass budget", async () => {
    // A bulk archive is many rollouts at once, and a standing state: charging
    // each one every pass would hold back whatever sorts after them. Local
    // groups are planned first, so one admitted local rollout spends the whole
    // budget before the archived one is reached.
    const { m, replica } = await machine();
    await m.runtime.updateSettings({ maxFilesPerPass: 1 });
    const local = rollout(OTHER, "10-00-00");
    await record(m, OTHER);
    await write(activePath(m, local), LINES);
    const name = rollout(SID);
    await write(archivedPath(m, name), LINES);
    await write(replica(name), LINES);

    await m.runtime.syncNow();

    expect(rowFor(m, local)?.reason).not.toBe("budget-exhausted");
    expect(rowFor(m, name)).toMatchObject({ action: "SKIP_ARCHIVED_HERE", result: "SKIPPED_POLICY" });
  }, 30_000);

  it("counts only a plain file — a directory in the archive is not an archived rollout", async () => {
    const { m, replica } = await machine();
    const name = rollout(SID);
    await fsp.mkdir(archivedPath(m, name), { recursive: true });
    await write(replica(name), LINES);

    await m.settle();

    expect(await fsp.readFile(activePath(m, name), "utf8")).toBe(LINES);
  }, 30_000);
});

describe("restoring an older version of an archived rollout into the sync folder", () => {
  it("says the next sync will not copy it here", async () => {
    const { m } = await machine();
    const name = rollout(SID);
    await record(m, SID);
    await write(activePath(m, name), LINES);
    await m.settle();
    // An overwrite of the sync folder's copy is what leaves a remote backup.
    await fsp.appendFile(activePath(m, name), MORE);
    await m.settle();
    await archive(m, name);
    await m.settle();

    const row = (await m.runtime.backups()).find((entry) => entry.remote && entry.originalName === name);
    expect(row).toBeDefined();
    expect(row?.outcome).toBe("archived-here");
  }, 30_000);
});
