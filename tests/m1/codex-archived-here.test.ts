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
import { createCodexAdapter } from "../../src/providers/codex/adapter";
import { RuntimeHarness } from "../helpers/runtime-harness";
import { World, WORKSPACE_ID } from "../helpers/world";

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

  // A bulk archive is many rollouts at once, and a standing state: charging
  // each one every pass would hold back whatever is planned after them. The
  // replica is walked in directory order, which is the filesystem's, so the
  // two names swap roles: whichever order the walk takes, one of the two cases
  // plans the archived rollout first.
  it.each([
    ["first", rollout(SID, "10-00-00"), rollout(OTHER, "11-00-00")],
    ["second", rollout(OTHER, "11-00-00"), rollout(SID, "10-00-00")],
  ])("does not take a share of the files-per-pass budget (%s naming)", async (_label, archivedName, incoming) => {
    const { m, replica } = await machine();
    await m.runtime.updateSettings({ maxFilesPerPass: 1 });
    await write(archivedPath(m, archivedName), LINES);
    await write(replica(archivedName), LINES);
    await write(replica(incoming), LINES);

    for (let pass = 0; pass < 3; pass++) {
      await m.runtime.syncNow();
      m.advanceClock(95_000);
      expect(rowFor(m, archivedName)?.action).toBe("SKIP_ARCHIVED_HERE");
      expect(rowFor(m, incoming)?.reason).not.toBe("budget-exhausted");
    }
    expect(await fsp.readFile(activePath(m, incoming), "utf8")).toBe(LINES);
  }, 30_000);

  it("counts only a plain file — a directory in the archive is not an archived rollout", async () => {
    const { m, replica } = await machine();
    const name = rollout(SID);
    await fsp.mkdir(archivedPath(m, name), { recursive: true });
    await write(replica(name), LINES);

    await m.settle();

    expect(await fsp.readFile(activePath(m, name), "utf8")).toBe(LINES);
  }, 30_000);

  it("plans as before when anything is already at the active path", async () => {
    // A copy in `sessions/` this vault has no record for is not listed, but it
    // is there, and it is the copy Codex reads: a peer's turns must reach it.
    const { m, replica } = await machine();
    const name = rollout(SID);
    await write(activePath(m, name), LINES);
    await write(archivedPath(m, name), LINES);
    await write(replica(name), LINES + MORE);

    await m.settle();

    expect(rowFor(m, name)?.action).not.toBe("SKIP_ARCHIVED_HERE");
    expect(await fsp.readFile(activePath(m, name), "utf8")).toBe(LINES + MORE);
  }, 30_000);

  it("plans as before when the archive cannot be asked about", async () => {
    // A file where the archive folder should be: the question fails, and a
    // failed question must not withhold anything.
    const { m, replica } = await machine();
    const name = rollout(SID);
    await write(path.join(codexHome(m), "archived_sessions"), "not a folder");
    await write(replica(name), LINES);

    await m.settle();

    expect(await fsp.readFile(activePath(m, name), "utf8")).toBe(LINES);
  }, 30_000);

  it("is caught when Codex archives it after this pass listed sessions/", async () => {
    // Claudian archives at startup and in bulk, so a pass can list a rollout
    // that is gone by the time it gets to it. A copy landed then would occupy
    // the path the rule looks at, and end the rule for that rollout for good.
    let armed = false;
    let listed = false;
    const name = rollout(SID);
    const m = await RuntimeHarness.create({
      beforeReadDir: async (target) => {
        if (!armed) return;
        if (target === path.dirname(activePath(m, name))) {
          listed = true;
          return;
        }
        if (listed && target.startsWith(m.syncDir)) {
          armed = false;
          await archive(m, name);
        }
      },
    });
    machines.push(m);
    await m.configure();
    await m.runtime.setProvider("codex", { enabled: true });
    await m.runtime.refresh();
    await record(m, SID);
    await write(activePath(m, name), LINES);
    await m.settle();

    armed = true;
    await m.runtime.syncNow();
    expect(listed && !armed).toBe(true);
    expect(rowFor(m, name)?.action).toBe("SKIP_ARCHIVED_HERE");
    await m.settle();
    expect(await exists(activePath(m, name))).toBe(false);
  }, 30_000);

  it("is looked for beside sessions/ as configured, not beside where a symlink points", async () => {
    // Codex archives into CODEX_HOME/archived_sessions without resolving
    // anything, and `sessions/` on another disk is a common setup.
    const { m, replica } = await machine();
    const name = rollout(SID);
    const elsewhere = path.join(m.homedir, "bigdisk", "codex-sessions");
    await fsp.mkdir(elsewhere, { recursive: true });
    await fsp.mkdir(codexHome(m), { recursive: true });
    await fsp.symlink(elsewhere, path.join(codexHome(m), "sessions"), "junction");
    await write(archivedPath(m, name), LINES);
    await write(replica(name), LINES);

    await m.settle();

    expect(rowFor(m, name)?.action).toBe("SKIP_ARCHIVED_HERE");
    expect(await exists(path.join(elsewhere, ...DATE, name))).toBe(false);
  }, 30_000);

  it("keeps watching the sync folder's copy, so it emptying still stops the pass", async () => {
    // Archived before this machine ever synced it: nothing else has recorded
    // that the sync folder's copy had content (NR-8, decision table #14).
    const { m, replica } = await machine();
    const name = rollout(SID);
    await write(archivedPath(m, name), LINES);
    await write(replica(name), LINES);
    await m.settle();

    await fsp.writeFile(replica(name), "");
    await m.runtime.syncNow();

    const status = await m.runtime.refresh();
    expect(status.notReadyReason).toBe("NR-8-remote-regression");
  }, 30_000);
});

describe("a conflict on a rollout archived here since", () => {
  it("cannot be resolved until it is unarchived, and says so", async () => {
    const { m, replica } = await machine();
    const name = rollout(SID);
    await record(m, SID);
    await write(activePath(m, name), LINES);
    await m.settle();
    await fsp.appendFile(activePath(m, name), '{"type":"here"}\n');
    await fsp.appendFile(replica(name), '{"type":"there"}\n');
    await m.settle();
    expect(rowFor(m, name)?.action).toBe("CONFLICT");

    await archive(m, name);
    await m.settle();

    const entry = (await m.runtime.conflicts()).find((c) => c.neutralRel.endsWith(name));
    expect(entry?.localArchived).toBe(true);
    const outcome = await m.runtime.resolve(entry?.conflictId as string, "keep-remote");
    expect(outcome).toEqual({ ok: false, reason: "local-archived" });
    expect(await exists(activePath(m, name))).toBe(false);
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

  it("is predicted as usual when the archive entry is not a plain file", async () => {
    const { m } = await machine();
    const name = rollout(SID);
    await record(m, SID);
    await write(activePath(m, name), LINES);
    await m.settle();
    await fsp.appendFile(activePath(m, name), MORE);
    await m.settle();
    await fsp.rm(activePath(m, name));
    await fsp.mkdir(archivedPath(m, name), { recursive: true });

    const row = (await m.runtime.backups()).find((entry) => entry.remote && entry.originalName === name);
    expect(row?.outcome).toBe("will-propagate");
  }, 30_000);
});

describe("restoring this machine's older version of an archived rollout", () => {
  it("is refused: it would put a second, active copy beside the archived one", async () => {
    const { m, replica } = await machine();
    const name = rollout(SID);
    await record(m, SID);
    await write(activePath(m, name), LINES);
    await m.settle();
    // A pull over this machine's copy is what leaves a local backup.
    await fsp.appendFile(replica(name), MORE);
    await m.settle();
    await archive(m, name);
    await m.settle();

    const row = (await m.runtime.backups()).find((entry) => !entry.remote && entry.originalName === name);
    expect(row?.outcome).toBe("archived-here");
    const outcome = await m.runtime.restore(row?.path as string, row?.hashPrefix as string, null);
    expect(outcome).toEqual({ ok: false, reason: "target-archived" });
    expect(await exists(activePath(m, name))).toBe(false);
  }, 30_000);
});

describe("the last look before a file is created", () => {
  it("withholds a pull the plan made before the rollout turned up in the archive", async () => {
    // The pre-budget check and the write are a whole read apart, and Codex can
    // archive in between. The engine's only seam there is the barrier after
    // planning, so the archive copy appears at that point: what is under test
    // is that the write asks again, not how the copy got there.
    const world = World.create();
    try {
      const machine = world.machine("A");
      await machine.initialiseSyncDir();
      const codex = path.join(machine.localRoot, "codex-home");
      const sessions = path.join(codex, "sessions");
      await fsp.mkdir(sessions, { recursive: true });
      const name = rollout(SID);
      const remote = path.join(machine.replicaRoot, WORKSPACE_ID, "codex", ...DATE, name);
      await write(remote, LINES);

      const adapter = createCodexAdapter({
        providerRoot: sessions,
        vaultRealPath: machine.vaultPath,
        joinPath: (...parts) => path.join(...parts),
        dirnameOf: (target: string) => path.dirname(target),
        listDir: async (target) =>
          (await fsp.readdir(target, { withFileTypes: true }).catch(() => [])).map((entry) => ({
            name: entry.name,
            isFile: entry.isFile(),
          })),
        statFile: async (target) => {
          const stat = await fsp.stat(target).catch(() => null);
          return stat ? { mtimeMs: stat.mtimeMs } : null;
        },
        readTextFile: async (target) => fsp.readFile(target, "utf8").catch(() => null),
      });

      await machine.pass({ extraAdapters: [adapter] }); // first sight: the copy has to hold still
      const report = await machine.pass({
        extraAdapters: [adapter],
        barrier: async (point, context) => {
          if (point === "P4:planned" && context.neutralRel?.endsWith(name)) {
            await write(path.join(codex, "archived_sessions", name), LINES);
          }
        },
      });

      const row = report.actions.find((a) => a.neutralRel.endsWith(name));
      expect(row).toMatchObject({ action: "SKIP_ARCHIVED_HERE", reason: "archived-here" });
      expect(await exists(path.join(sessions, ...DATE, name))).toBe(false);
    } finally {
      await world.dispose();
    }
  }, 30_000);
});
