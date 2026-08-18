/**
 * What opening the restore dialog costs (§9.5, and the 2026-08-18 evaluation).
 *
 * Describing a row means reading the backup — its hash is its identity — and
 * both live sides, which is what lets the row say what the next sync will do.
 * That is unavoidable per row, and therefore has to be bounded per listing.
 * Unbounded it read every backup and every session's two sides on every open:
 * against the measured workload (a 23 MiB Codex rollout, three backups per
 * direction) hundreds of megabytes to paint a screen, and on a cloud drive
 * with on-demand files, reads that hydrate the replica side as a side effect.
 *
 * So: a bounded page of the newest, the live sides read once per session
 * rather than once per row, and a restore that re-describes one backup instead
 * of the whole history.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  DEFAULT_LIST_LIMIT,
  countBackups,
  listBackups,
  restoreBackup,
} from "../../src/orchestration/restore-commands";
import type { RestoreCommandDeps } from "../../src/orchestration/restore-commands";
import { createNodeFsGateway } from "../../src/infra/node-fs-gateway";
import { createClaudeCodeAdapter } from "../../src/providers/claude-code/adapter";
import { backupFileName, backupStamp } from "../../src/infra/backup-store";
import type { SafeAbsolutePath } from "../../src/domain/types";
import { makeRealTmpDir, removeTree } from "../helpers/fs-cleanup";

const WS = "ws-0000";
const sid = (n: number) => `3f2504e0-4f89-41d3-9a0c-${String(n).padStart(12, "0")}`;
const hash = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const roots: string[] = [];
afterEach(() => {
  while (roots.length) removeTree(roots.pop() as string);
});

/** `sessions` sessions, each with `perSession` local backups and a live file. */
async function world(sessions: number, perSession: number) {
  const root = makeRealTmpDir("restore-listing");
  roots.push(root);
  const vault = path.join(root, "vault");
  const projects = path.join(root, "projects");
  const projectDir = path.join(projects, "escaped");
  const backupsDir = path.join(root, "backups");
  const replicaRoot = path.join(root, "replica");
  await fsp.mkdir(projectDir, { recursive: true });
  await fsp.mkdir(path.join(backupsDir, WS, "claude-code"), { recursive: true });
  await fsp.mkdir(path.join(vault, ".claudian", "sessions"), { recursive: true });

  const paths: string[] = [];
  for (let s = 0; s < sessions; s++) {
    const id = sid(s);
    const name = `${id}.jsonl`;
    // A live file, its Claudian record (admission), and its backups.
    await fsp.writeFile(path.join(projectDir, name), `{"live":${s}}\n`.repeat(4));
    await fsp.writeFile(
      path.join(vault, ".claudian", "sessions", `conv-${s}.meta.json`),
      JSON.stringify({ id: `conv-${s}`, providerId: "claude", sessionId: id }),
    );
    for (let b = 0; b < perSession; b++) {
      const backupName = backupFileName(name, backupStamp(1_700_000_000_000 + s * 1000 + b), b);
      const target = path.join(backupsDir, WS, "claude-code", backupName);
      await fsp.writeFile(target, `{"old":${b}}\n`.repeat(3));
      paths.push(target);
    }
  }

  let readFiles = 0;
  const gateway = createNodeFsGateway({
    ids: { uuid: () => "id", token: () => "tok" },
    platform: process.platform,
    pid: process.pid,
    sleep: async () => undefined,
  });
  const fs: RestoreCommandDeps["fs"] = {
    ...gateway,
    readFile: async (target) => {
      readFiles += 1;
      return gateway.readFile(target);
    },
  };

  const adapter = createClaudeCodeAdapter({
    providerRoot: projects,
    vaultRealPath: vault,
    customDirName: "escaped",
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

  const deps: RestoreCommandDeps = {
    fs,
    joinPath: (...parts) => path.join(...parts),
    workspaceId: WS,
    replicaRoot,
    backupsDir,
    providers: [{ adapter, root: projects }],
    mintWritePath: async (target) => ({ ok: true, value: target as SafeAbsolutePath }),
    backup: async () => ({ path: path.join(root, "b.bak") }),
    hashBytes: hash,
    mayWriteRemote: () => true,
  };
  return { deps, paths, reads: () => readFiles, reset: () => (readFiles = 0) };
}

describe("the listing is a bounded page of the newest", () => {
  it("describes at most the limit, newest first", async () => {
    const { deps } = await world(10, 3); // 30 backups
    const page = await listBackups(deps, { limit: 5 });

    expect(page).toHaveLength(5);
    const times = page.map((entry) => entry.takenAtMs);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    // Newest of the *history*, not of whatever was read first: the newest
    // backup overall must be in the page.
    const all = await listBackups(deps, { limit: 1000 });
    expect(page[0]?.path).toBe(all[0]?.path);
  });

  it("reads far less for a small page than for a large one", async () => {
    const { deps, reset, reads } = await world(10, 3);

    reset();
    await listBackups(deps, { limit: 3 });
    const small = reads();

    reset();
    await listBackups(deps, { limit: 30 });
    const large = reads();

    expect(small).toBeLessThan(large);
    // And the small page must not be paying for the whole history: 30 backups
    // plus their live sides is well over 40 reads.
    expect(small).toBeLessThan(20);
  });

  it("reads each session's live sides once however many of its rows appear", async () => {
    // One session with three backups: without the per-listing cache each row
    // re-read both live sides.
    const { deps, reset, reads } = await world(1, 3);

    reset();
    const page = await listBackups(deps, { limit: 10 });

    expect(page).toHaveLength(3);
    // 3 backups + 1 index + 1 local live + 1 remote live (absent, still a
    // call) = 6. Anything near 9+ means the sides are being re-read per row.
    expect(reads()).toBeLessThanOrEqual(7);
  });

  it("still says how many it did not describe", async () => {
    const { deps } = await world(10, 3);
    expect(await countBackups(deps)).toBe(30);
    expect((await listBackups(deps)).length).toBeLessThanOrEqual(DEFAULT_LIST_LIMIT);
  });
});

describe("restoring one backup", () => {
  it("does not re-describe the whole history to do it", async () => {
    const { deps, paths, reset, reads } = await world(10, 3);
    const entry = (await listBackups(deps, { limit: 100 })).find(
      (candidate) => candidate.path === paths[0],
    );
    expect(entry).toBeTruthy();

    reset();
    const outcome = await restoreBackup(
      deps,
      entry?.path as string,
      entry?.hashPrefix as string,
      entry?.liveHashPrefix ?? null,
    );

    expect(outcome.ok).toBe(true);
    // One backup, its session's two sides, the index, plus the write path's
    // own reads — nothing proportional to the other 29 backups.
    expect(reads()).toBeLessThan(12);
  });
});
