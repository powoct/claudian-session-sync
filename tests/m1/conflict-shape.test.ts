/**
 * architecture §8.1 — a conflict directory has to say which file it is about.
 *
 * Schema 2 stored only the logical id, and both commands rebuilt the path as
 * `<provider>/<logicalId><ext>`. That is right for exactly one provider shape.
 * For a provider whose file name merely *contains* the id and whose layout is
 * nested — Codex — the rebuilt path points at nothing, and the failure is
 * worse than an error: both live branches read as absent, so the entry is
 * reported `superseded` and the dialog tells the user the disagreement is over
 * while both versions are sitting there.
 *
 * These run against the commands directly with injected dependencies, because
 * what is under test is the meta file's contract, not a pass.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { listConflicts, resolveConflict } from "../../src/orchestration/conflict-commands";
import type { ConflictCommandDeps } from "../../src/orchestration/conflict-commands";
import { createNodeFsGateway } from "../../src/infra/node-fs-gateway";
import type { SafeAbsolutePath } from "../../src/domain/types";
import { makeRealTmpDir, removeTree } from "../helpers/fs-cleanup";

const SID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const WS = "ws-0000";
const CONFLICT_ID = "abcdef0123456789";
/** Codex's measured shape: nested by date, id in the tail of the name. */
const NESTED_REL = `codex/2026/08/06/rollout-2026-08-06T12-43-59-${SID}.jsonl`;

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) removeTree(roots.pop() as string);
});

const hash = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const enc = (text: string) => new TextEncoder().encode(text);

const BRANCH_A = enc('{"type":"user","uuid":"a"}\n{"type":"user","uuid":"a2"}\n');
const BRANCH_B = enc('{"type":"user","uuid":"a"}\n{"type":"user","uuid":"b2"}\n');

async function world(meta: Record<string, unknown>) {
  const root = makeRealTmpDir("conflict-shape");
  roots.push(root);
  const replicaRoot = path.join(root, "replica");
  const localRoot = path.join(root, "local");

  const dir = path.join(replicaRoot, ".quarantine", WS, "codex", CONFLICT_ID);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, "branch-aaaaaaaa.jsonl"), BRANCH_A);
  await fsp.writeFile(path.join(dir, "branch-bbbbbbbb.jsonl"), BRANCH_B);
  await fsp.writeFile(path.join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);

  // Both live files still hold the two branches — the disagreement is real
  // and current, which is the whole point of the assertions below.
  const localPath = path.join(localRoot, ...NESTED_REL.split("/").slice(1));
  const remotePath = path.join(replicaRoot, WS, ...NESTED_REL.split("/"));
  for (const [target, bytes] of [
    [localPath, BRANCH_A],
    [remotePath, BRANCH_B],
  ] as const) {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, bytes);
  }

  const deps: ConflictCommandDeps = {
    fs: createNodeFsGateway({
      ids: { uuid: () => "id", token: () => "tok" },
      platform: process.platform,
      pid: process.pid,
      sleep: async () => undefined,
    }),
    joinPath: (...parts) => path.join(...parts),
    workspaceId: WS,
    replicaRoot,
    localPathFor: async (_provider, rel) => path.join(localRoot, ...rel.split("/").slice(1)),
    mintWritePath: async (target) => ({ ok: true, value: target as SafeAbsolutePath }),
    backup: async () => ({ path: path.join(root, "backup.bak") }),
    hashBytes: hash,
    mayWriteRemote: () => true,
  };
  return { deps, localPath, remotePath };
}

const metaV3 = {
  schemaVersion: 3,
  logicalId: SID,
  neutralRel: NESTED_REL,
  conflictId: CONFLICT_ID,
  branches: [
    { hashPrefix: "aaaaaaaa", size: BRANCH_A.length, lineCount: 2 },
    { hashPrefix: "bbbbbbbb", size: BRANCH_B.length, lineCount: 2 },
  ],
  detectedBy: "aaaaaaaa",
  detectedAt: "2026-08-12T00:00:00.000Z",
};

/** What the same directory looked like before schema 3: no path recorded. */
const metaV2 = { ...metaV3, schemaVersion: 2, neutralRel: undefined };

describe("a nested provider's conflict", () => {
  it("is reported as live, not as already over", async () => {
    const { deps } = await world(metaV3);
    const [entry] = await listConflicts(deps);

    expect(entry?.superseded).toBe(false);
    expect(entry?.branches.filter((b) => b.onThisMachine)).toHaveLength(1);
    expect(entry?.branches.filter((b) => b.inSyncFolder)).toHaveLength(1);
  });

  it("can be resolved, and the kept bytes land on the other side", async () => {
    const { deps, remotePath } = await world(metaV3);
    const outcome = await resolveConflict(deps, CONFLICT_ID, "keep-local");

    expect(outcome).toMatchObject({ ok: true, action: "PUSH_OVERWRITE", neutralRel: NESTED_REL });
    expect(new Uint8Array(await fsp.readFile(remotePath))).toEqual(BRANCH_A);
  });

  it("keeps the other side's version just as well", async () => {
    const { deps, localPath } = await world(metaV3);
    const outcome = await resolveConflict(deps, CONFLICT_ID, "keep-remote");

    expect(outcome).toMatchObject({ ok: true, action: "PULL_OVERWRITE" });
    expect(new Uint8Array(await fsp.readFile(localPath))).toEqual(BRANCH_B);
  });

  it("was unresolvable before the path was recorded — and said so wrongly", async () => {
    // The regression this guards. Not "it fails", but *how* it failed: a false
    // all-clear, which is the one report a user acts on by walking away.
    const { deps } = await world(metaV2);
    const [entry] = await listConflicts(deps);

    expect(entry?.superseded).toBe(true);
    expect(await resolveConflict(deps, CONFLICT_ID, "keep-local")).toEqual({
      ok: false,
      reason: "kept-unreadable",
    });
  });
});

describe("a flat provider's conflict, written before schema 3", () => {
  it("still resolves, because rebuilding the path is correct for that shape", async () => {
    const root = makeRealTmpDir("conflict-shape-flat");
    roots.push(root);
    const replicaRoot = path.join(root, "replica");
    const localRoot = path.join(root, "local");
    const rel = `claude-code/${SID}.jsonl`;

    const dir = path.join(replicaRoot, ".quarantine", WS, "claude-code", CONFLICT_ID);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, "branch-aaaaaaaa.jsonl"), BRANCH_A);
    await fsp.writeFile(path.join(dir, "branch-bbbbbbbb.jsonl"), BRANCH_B);
    await fsp.writeFile(
      path.join(dir, "meta.json"),
      `${JSON.stringify({ ...metaV2, conflictId: CONFLICT_ID }, null, 2)}\n`,
    );
    const localPath = path.join(localRoot, `${SID}.jsonl`);
    const remotePath = path.join(replicaRoot, WS, ...rel.split("/"));
    for (const [target, bytes] of [
      [localPath, BRANCH_A],
      [remotePath, BRANCH_B],
    ] as const) {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, bytes);
    }

    const deps: ConflictCommandDeps = {
      fs: createNodeFsGateway({
        ids: { uuid: () => "id", token: () => "tok" },
        platform: process.platform,
        pid: process.pid,
        sleep: async () => undefined,
      }),
      joinPath: (...parts) => path.join(...parts),
      workspaceId: WS,
      replicaRoot,
      localPathFor: async (_provider, neutralRel) =>
        path.join(localRoot, neutralRel.slice(neutralRel.lastIndexOf("/") + 1)),
      mintWritePath: async (target) => ({ ok: true, value: target as SafeAbsolutePath }),
      backup: async () => ({ path: path.join(root, "backup.bak") }),
      hashBytes: hash,
      mayWriteRemote: () => true,
    };

    const [entry] = await listConflicts(deps);
    expect(entry?.superseded).toBe(false);
    expect(await resolveConflict(deps, CONFLICT_ID, "keep-local")).toMatchObject({ ok: true });
  });
});
