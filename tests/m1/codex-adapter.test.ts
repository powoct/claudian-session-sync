/**
 * architecture §6.4 and OQ-11 — the Codex adapter.
 *
 * The interesting assertions are all about *not* syncing things. Codex keeps
 * every project's sessions in one global tree, so an adapter that simply
 * listed what it found would push conversations from unrelated projects into
 * this vault's workspace the first time someone ticked a checkbox. The scope
 * comes from the vault's own Claudian conversation records — a directory that
 * is inside the vault, and therefore cannot describe another one.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCodexAdapter } from "../../src/providers/codex/adapter";
import { rolloutLogicalId, isCodexSessionId } from "../../src/providers/codex/rollout-name";
import { makeRealTmpDir, removeTree } from "../helpers/fs-cleanup";
import { World, WORKSPACE_ID } from "../helpers/world";

const SID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const OTHER = "9a1b2c3d-4e5f-4a1b-8c2d-3e4f5a6b7c8d";
const rollout = (id: string) => `rollout-2026-08-06T12-43-59-${id}.jsonl`;

const roots: string[] = [];
afterEach(() => {
  while (roots.length) removeTree(roots.pop() as string);
});

async function world(options: { readonly recorded?: readonly string[]; readonly store?: string } = {}) {
  const root = makeRealTmpDir("codex-adapter");
  roots.push(root);
  const vault = path.join(root, "vault");
  const sessions = path.join(root, "codex", "sessions");
  await fsp.mkdir(sessions, { recursive: true });

  const storeDir = path.join(vault, ...(options.store ?? ".claudian/sessions").split("/"));
  if (options.recorded !== undefined) {
    await fsp.mkdir(storeDir, { recursive: true });
    for (const [index, id] of options.recorded.entries()) {
      await fsp.writeFile(
        path.join(storeDir, `conv-17864226878${index}-abc.meta.json`),
        JSON.stringify({
          id: `conv-17864226878${index}-abc`,
          providerId: "codex",
          sessionId: id,
          providerState: {
            threadId: id,
            // Deliberately a path from another machine — it must be ignored.
            // (Spelled without a real home prefix so the secrets gate, which
            // rejects `/Users/<name>` and `/home/<name>` in committed files,
            // stays a useful signal rather than something to work around.)
            sessionFilePath: `D:\\elsewhere\\.codex\\sessions\\2026\\08\\06\\${rollout(id)}`,
          },
        }),
      );
    }
  }

  const adapter = createCodexAdapter({
    providerRoot: sessions,
    vaultRealPath: vault,
    joinPath: (...parts) => path.join(...parts),
    listDir: async (dir) =>
      (await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])).map((entry) => ({
        name: entry.name,
        isFile: entry.isFile(),
      })),
    statFile: async (target) => {
      const stat = await fsp.stat(target).catch(() => null);
      return stat ? { mtimeMs: stat.mtimeMs } : null;
    },
    readTextFile: async (target) => fsp.readFile(target, "utf8").catch(() => null),
  });

  const plant = async (id: string, date = ["2026", "08", "06"]) => {
    const dir = path.join(sessions, ...date);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, rollout(id)), '{"type":"session_meta"}\n');
  };

  return { adapter, sessions, vault, storeDir, plant };
}

describe("which sessions belong to this vault (OQ-11)", () => {
  it("lists only the ones this vault has a conversation record for", async () => {
    const { adapter, plant } = await world({ recorded: [SID] });
    await plant(SID);
    await plant(OTHER); // another project's conversation, same machine

    const groups = await adapter.listSessions();

    expect(groups.map((g) => g.logicalId)).toEqual([SID]);
  });

  it("syncs nothing at all when the vault has no records", async () => {
    // Fail closed. The failure mode of the scope lookup must be "too few",
    // never "every conversation on this machine".
    const { adapter, plant } = await world({ recorded: [] });
    await plant(SID);

    expect(await adapter.listSessions()).toEqual([]);
  });

  it("syncs nothing when the store is missing entirely, and says so", async () => {
    const { adapter, plant } = await world();
    await plant(SID);

    expect(await adapter.listSessions()).toEqual([]);
    expect(await adapter.healthCheck()).toMatchObject({ ok: false });
  });

  it("reads the legacy .claude/sessions location too", async () => {
    const { adapter, plant } = await world({ recorded: [SID], store: ".claude/sessions" });
    await plant(SID);

    expect((await adapter.listSessions()).map((g) => g.logicalId)).toEqual([SID]);
  });

  it("ignores records belonging to another provider", async () => {
    const { adapter, storeDir, plant } = await world({ recorded: [SID] });
    await fsp.writeFile(
      path.join(storeDir, "conv-999-other.meta.json"),
      JSON.stringify({ providerId: "claude-code", sessionId: OTHER }),
    );
    await plant(SID);
    await plant(OTHER);

    expect((await adapter.listSessions()).map((g) => g.logicalId)).toEqual([SID]);
  });

  it("survives a half-written record, because Claudian rewrites them in place", async () => {
    const { adapter, storeDir, plant } = await world({ recorded: [SID] });
    await fsp.writeFile(path.join(storeDir, "conv-torn.meta.json"), '{"providerId": "codex", "ses');
    await plant(SID);

    expect((await adapter.listSessions()).map((g) => g.logicalId)).toEqual([SID]);
  });

  it("refuses an id that is not a session id shape", async () => {
    const { adapter, storeDir, plant } = await world({ recorded: [] });
    await fsp.writeFile(
      path.join(storeDir, "conv-bad.meta.json"),
      JSON.stringify({ providerId: "codex", sessionId: "../../../etc/passwd" }),
    );
    await plant(SID);

    expect(await adapter.listSessions()).toEqual([]);
  });
});

describe("the shape of a Codex session", () => {
  it("keeps the date directories in the neutral path", async () => {
    const { adapter, plant } = await world({ recorded: [SID] });
    await plant(SID, ["2026", "08", "06"]);

    const [group] = await adapter.listSessions();

    expect(group?.files[0]?.neutralRel).toBe(`codex/2026/08/06/${rollout(SID)}`);
  });

  it("puts a landed file back in the same relative place", async () => {
    const { adapter, sessions } = await world({ recorded: [SID] });

    expect(await adapter.targetPathFor(`codex/2026/08/06/${rollout(SID)}`)).toBe(
      path.join(sessions, "2026", "08", "06", rollout(SID)),
    );
  });

  it("takes the id from the tail of the name, whatever the prefix is", () => {
    expect(rolloutLogicalId(`rollout-2026-08-06T12-43-59-${SID}.jsonl`)).toBe(SID);
    expect(rolloutLogicalId(`rollout-2026-08-06T12:43:59.123Z-${SID}.jsonl`)).toBe(SID);
    expect(rolloutLogicalId(`somethingelse-${SID}.jsonl`)).toBe(SID);
    expect(rolloutLogicalId(`${SID}.jsonl`)).toBe(SID);
  });

  it.each([
    ["a backup", `rollout-2026-08-06T12-43-59-${SID}.jsonl.bak`],
    ["a Syncthing conflict copy", `rollout-x-${SID}.sync-conflict-20260807-120000-AB.jsonl`],
    ["an uppercase id", `rollout-x-${SID.toUpperCase()}.jsonl`],
    ["the sqlite state db", "state_5.sqlite"],
    ["the legacy index", "session_index.jsonl"],
    ["credentials", "auth.json"],
  ])("does not treat %s as a session", (_label, name) => {
    expect(rolloutLogicalId(name)).toBeNull();
  });

  it("refuses a neutral path that is not this provider's shape", async () => {
    const { adapter } = await world({ recorded: [SID] });
    for (const rel of [
      `codex/${rollout(SID)}`, // flat
      `codex/2026/08/${rollout(SID)}`, // too shallow
      `codex/2026/08/06/07/${rollout(SID)}`, // too deep
      `codex/2026/08/xx/${rollout(SID)}`, // not a date
      `claude-code/2026/08/06/${rollout(SID)}`, // another provider's subtree
      `codex/2026/08/06/${SID}.jsonl.bak`,
    ]) {
      expect(adapter.classifyNeutral(rel), rel).toBeNull();
    }
  });

  it("accepts a pulled session even before the vault record arrives", async () => {
    // Scope governs what leaves this machine. The replica's `codex/` subtree
    // is written only by this plugin, from the other machine's already-scoped
    // push — filtering here too would make a legitimate pull look like a
    // foreign file for as long as the vault takes to catch up.
    const { adapter } = await world({ recorded: [] });

    expect(adapter.classifyNeutral(`codex/2026/08/06/${rollout(SID)}`)).toEqual({
      logicalId: SID,
      role: "primary",
      mode: "append-jsonl",
    });
  });

  it("does not walk outside the date tree", async () => {
    const { adapter, sessions, plant } = await world({ recorded: [SID, OTHER] });
    await plant(SID);
    // Codex moves archived rollouts to a sibling of `sessions/`; a stray
    // directory inside it must not be walked either.
    await fsp.mkdir(path.join(sessions, "notadate"), { recursive: true });
    await fsp.writeFile(path.join(sessions, "notadate", rollout(OTHER)), "x\n");
    await fsp.writeFile(path.join(sessions, rollout(OTHER)), "x\n");

    expect((await adapter.listSessions()).map((g) => g.logicalId)).toEqual([SID]);
  });
});

describe("session id validation", () => {
  it.each([SID, OTHER])("accepts a uuid: %s", (id) => {
    expect(isCodexSessionId(id)).toBe(true);
  });

  it.each(["", "../etc", SID.toUpperCase(), `${SID}x`, 42, null, undefined])(
    "rejects %s",
    (value) => {
      expect(isCodexSessionId(value)).toBe(false);
    },
  );
});

describe("a real pass with the Codex adapter registered", () => {
  it("pushes a scoped session and leaves an unscoped one alone", async () => {
    // End to end through the engine, because the unit tests above prove the
    // adapter's answers and not that anything asks it the question.
    const world = World.create();
    try {
      const machine = world.machine("A");
      await machine.initialiseSyncDir();

      const sessions = path.join(machine.localRoot, "codex-home", "sessions");
      const dir = path.join(sessions, "2026", "08", "06");
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, rollout(SID)), '{"type":"session_meta"}\n');
      await fsp.writeFile(path.join(dir, rollout(OTHER)), '{"type":"session_meta"}\n');

      const store = path.join(machine.vaultPath, ".claudian", "sessions");
      await fsp.mkdir(store, { recursive: true });
      await fsp.writeFile(
        path.join(store, "conv-1.meta.json"),
        JSON.stringify({ providerId: "codex", sessionId: SID }),
      );

      const adapter = createCodexAdapter({
        providerRoot: sessions,
        vaultRealPath: machine.vaultPath,
        joinPath: (...parts) => path.join(...parts),
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

      await machine.pass({ extraAdapters: [adapter] });
      const report = await machine.pass({ extraAdapters: [adapter] });

      const applied = report.actions.filter((a) => a.result === "APPLIED").map((a) => a.neutralRel);
      expect(applied).toEqual([`codex/2026/08/06/${rollout(SID)}`]);
      const landed = path.join(
        machine.replicaRoot,
        WORKSPACE_ID,
        "codex",
        "2026",
        "08",
        "06",
        rollout(SID),
      );
      expect(await fsp.readFile(landed, "utf8")).toBe('{"type":"session_meta"}\n');
      // The other project's conversation never left this machine.
      expect(report.actions.map((a) => a.neutralRel)).not.toContain(
        `codex/2026/08/06/${rollout(OTHER)}`,
      );
    } finally {
      await world.dispose();
    }
  }, 30_000);
});
