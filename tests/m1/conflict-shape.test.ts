/**
 * architecture §8.1 — a conflict directory has to say which file it is about.
 *
 * Schema 2 stored only the logical id, and both commands rebuilt the path as
 * `<provider>/<logicalId><ext>`. That is right for exactly one provider shape.
 * For a provider whose file name merely *contains* the id and whose layout is
 * nested — Codex — the rebuilt path points at nothing, and the failure is
 * worse than an error: both live branches read as absent, so the entry is
 * reported as needing no decision, and the dialog tells the user so
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

    expect(entry?.standing).toBe("in-dispute");
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

  it("was unresolvable before the path was recorded — and now says it cannot see them", async () => {
    // The regression this guards. Not "it fails", but *how* it failed: a false
    // all-clear, which is the one report a user acts on by walking away. Both
    // live files are sitting there forked; only the rebuilt path is wrong. It
    // now reads `unreadable`, whose sentence sends the user to look, rather
    // than sharing one verdict with "both sides moved past this pair".
    const { deps } = await world(metaV2);
    const [entry] = await listConflicts(deps);

    expect(entry?.standing).toBe("unreadable");
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
    expect(entry?.standing).toBe("in-dispute");
    expect(await resolveConflict(deps, CONFLICT_ID, "keep-local")).toMatchObject({ ok: true });
  });
});

/**
 * The 2026-09-09 conflict storm: a resolved conflict never left the list.
 *
 * A resolution *converges* the two sides, and the surviving bytes are by
 * definition one of the archived branches — so the old predicate ("no branch is
 * on either side") saw a branch on both sides and reported a live fork. On the
 * reporting machine 47 directories had converged byte-for-byte and every one
 * still offered buttons that would rewrite identical bytes.
 */
describe("a conflict whose two sides now agree", () => {
  const settledWorld = async () => {
    const built = await world(metaV3);
    // What a completed resolution looks like on disk: both sides hold BRANCH_A.
    await fsp.writeFile(built.remotePath, BRANCH_A);
    return built;
  };

  it("is settled, and names the version both sides hold", async () => {
    const { deps } = await settledWorld();
    const [entry] = await listConflicts(deps);

    expect(entry?.standing).toBe("settled");
    const both = entry?.branches.filter((b) => b.onThisMachine && b.inSyncFolder);
    expect(both, "one branch is on both sides").toHaveLength(1);
  });

  it("still lists, so the other version stays reachable", async () => {
    // Flagged, never filtered: the copies are deliberately never deleted, and
    // "Show me both" is the only route to them.
    const { deps } = await settledWorld();
    expect(await listConflicts(deps)).toHaveLength(1);
    expect(await resolveConflict(deps, CONFLICT_ID, "reveal")).toMatchObject({
      ok: true,
      action: "REVEAL",
    });
  });

  it("refuses the keep buttons instead of rewriting identical bytes", async () => {
    // The panel greys these, but the palette commands act on the same list and
    // read no flag at all — so the refusal has to live in the action.
    const { deps, localPath, remotePath } = await settledWorld();
    for (const choice of ["keep-local", "keep-remote"] as const) {
      expect(await resolveConflict(deps, CONFLICT_ID, choice)).toEqual({
        ok: false,
        reason: "sides-agree",
      });
    }
    expect(new Uint8Array(await fsp.readFile(localPath))).toEqual(BRANCH_A);
    expect(new Uint8Array(await fsp.readFile(remotePath))).toEqual(BRANCH_A);
  });

  it("flips back if the other machine pushes its version again", async () => {
    // Nothing is stored, and that is the point: a marker in the directory
    // would suppress a genuine recurrence under the same conflictId.
    const { deps, remotePath } = await settledWorld();
    expect((await listConflicts(deps))[0]?.standing).toBe("settled");

    await fsp.writeFile(remotePath, BRANCH_B);
    expect((await listConflicts(deps))[0]?.standing).toBe("in-dispute");
  });

  it("is not confused by a file the OS drops in the directory", async () => {
    // Finder writes `.DS_Store` here precisely when someone clicks "Show me
    // both", so it arrives on the entries a user is looking at.
    const { deps } = await settledWorld();
    const [before] = await listConflicts(deps);
    await fsp.writeFile(
      path.join(before?.directory as string, ".DS_Store"),
      enc("not a session version"),
    );

    const [after] = await listConflicts(deps);
    expect(after?.standing).toBe("settled");
    expect(after?.branches).toHaveLength(3);
  });
});

describe("two sides that cannot be read are not two sides that agree", () => {
  it("does not call a pair of empty reads a convergence", async () => {
    // A cloud client dehydrating both files makes them read as zero bytes, and
    // `hash(empty) === hash(empty)` is a real, equal, non-null hash. Going
    // through the branch flags is what rules it out: neither empty file
    // matches an archived version.
    const { deps, localPath, remotePath } = await world(metaV3);
    for (const target of [localPath, remotePath]) await fsp.writeFile(target, enc(""));

    expect((await listConflicts(deps))[0]?.standing).toBe("moved-on");
  });

  it("says it cannot see them, not that they moved on", async () => {
    const { deps, localPath, remotePath } = await world(metaV3);
    for (const target of [localPath, remotePath]) await fsp.rm(target);

    expect((await listConflicts(deps))[0]?.standing).toBe("unreadable");
  });

  it("calls it moved-on only when both sides were actually read", async () => {
    const { deps, localPath, remotePath } = await world(metaV3);
    await fsp.writeFile(localPath, enc("a third thing\n"));
    await fsp.writeFile(remotePath, enc("a fourth thing\n"));

    expect((await listConflicts(deps))[0]?.standing).toBe("moved-on");
  });
});
