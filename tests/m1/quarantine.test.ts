/**
 * testing.md §5.2.6 / §1.2 — quarantine at the engine level.
 *
 * A conflict is only useful if both branches end up somewhere a user can reach
 * them. These tests check the copies actually land, that the originals are
 * untouched (I1-b), and that repeating the pass does not pile up duplicates —
 * which is the property that makes storing conflict state unnecessary.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { World, WORKSPACE_ID, sha256 } from "../helpers/world";
import { assertInventoryPreserved, assertRecoverable } from "../helpers/invariants";
import type { PassReport } from "../../src/orchestration/pass-report";

const SID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

let world: World | null = null;
afterEach(async () => {
  await world?.dispose();
  world = null;
});

function newWorld(): World {
  world = World.create();
  return world;
}

async function settle(machine: { pass: () => Promise<PassReport> }): Promise<PassReport> {
  await machine.pass();
  return machine.pass();
}

const replicaFile = (m: { replicaRoot: string }) =>
  path.join(m.replicaRoot, WORKSPACE_ID, "claude-code", `${SID}.jsonl`);

const quarantineRoot = (m: { replicaRoot: string }) =>
  path.join(m.replicaRoot, ".quarantine", WORKSPACE_ID, "claude-code");

const read = async (p: string) => new Uint8Array(await fsp.readFile(p).catch(() => Buffer.alloc(0)));

/** Builds a genuine fork: shared history, then each side goes its own way. */
async function forkedWorld() {
  const w = newWorld();
  const a = w.machine("A");
  const b = w.machine("B");

  await a.cli.session(SID).append(5);
  await settle(a);
  await w.flush("A", "B");
  await settle(b);

  await a.cli.session(SID).appendRaw('{"uuid":"a1","branch":"A"}\n');
  await b.cli.session(SID).appendRaw('{"uuid":"b1","branch":"B"}\n');
  await settle(b);
  await w.flush("B", "A");

  return { w, a, b };
}

describe("a conflict preserves both branches", () => {
  it("writes both copies and a metadata file", async () => {
    const { a } = await forkedWorld();

    const localBefore = await a.cli.session(SID).hash();
    const remoteBefore = sha256(await read(replicaFile(a)));

    const report = await settle(a);
    expect(report.actions[0]?.action).toBe("CONFLICT");

    const conflictId = report.actions[0]?.conflictId;
    expect(conflictId, "a conflict must record where the copies went").toBeTruthy();

    const dir = path.join(quarantineRoot(a), conflictId as string);
    const entries = (await fsp.readdir(dir)).sort();
    expect(entries).toHaveLength(3);
    // Copies are named by content hash, never by side: the directory is
    // shared, and "local"/"remote" swap meaning between the two machines.
    expect(entries.filter((n) => /^branch-[0-9a-f]{8}\.jsonl$/.test(n))).toHaveLength(2);
    expect(entries).toContain("meta.json");

    // The copies are byte-identical to the originals — quarantining is not
    // allowed to transform anything (§1.2: "quarantine is not an I1 exception").
    const copies = entries.filter((n) => n !== "meta.json");
    const hashes = await Promise.all(copies.map(async (n) => sha256(await read(path.join(dir, n)))));
    expect(hashes.sort()).toEqual([localBefore, remoteBefore].sort());
  });

  it("leaves both originals exactly where they were (I1-b)", async () => {
    const { w: forked, a } = await forkedWorld();
    const w = forked;

    const localBefore = await a.cli.session(SID).hash();
    const remoteBefore = sha256(await read(replicaFile(a)));
    const before = await w.snapshot();

    await settle(a);
    const after = await w.snapshot();

    // Quarantine is a copy, not a move. A mistaken conflict must cost a
    // confusing report, never a vanished conversation.
    expect(await a.cli.session(SID).hash()).toBe(localBefore);
    expect(sha256(await read(replicaFile(a)))).toBe(remoteBefore);
    assertRecoverable(before, after);
    assertInventoryPreserved(before, after);
  });

  it("writes metadata a user can compare without exposing content", async () => {
    const { a } = await forkedWorld();
    const report = await settle(a);
    const dir = path.join(quarantineRoot(a), report.actions[0]?.conflictId as string);

    const meta = JSON.parse(await fsp.readFile(path.join(dir, "meta.json"), "utf8"));
    expect(meta.branches).toHaveLength(2);
    for (const branch of meta.branches) {
      expect(branch.lineCount).toBeGreaterThan(0);
      expect(branch.hashPrefix).toHaveLength(8);
    }
    // No side labels — the file is shared, and sides swap between machines.
    expect(JSON.stringify(meta)).not.toMatch(/"local|"remote/);
    // Nothing that could carry a line of the conversation.
    for (const key of ["content", "bytes", "lines", "sample", "text"]) {
      expect(meta).not.toHaveProperty(key);
    }
  });
});

describe("S-04 / U-13 / U-20: a known conflict does not accumulate copies", () => {
  it("produces the same directory on every repeat, with nothing remembered", async () => {
    const { a } = await forkedWorld();

    const first = await settle(a);
    const dir = path.join(quarantineRoot(a), first.actions[0]?.conflictId as string);
    const dirBefore = (await fsp.readdir(quarantineRoot(a))).sort();
    const filesBefore = await fsp.readdir(dir);
    const metaBefore = await read(path.join(dir, "meta.json"));

    // Repeat the pass several times, with the clock moving — a re-stamped
    // `detectedAt` must show up as changed bytes, not hide behind a frozen
    // clock. The id is derived from the two hashes, so the same disagreement
    // lands on the same paths — the exclusive create fails, nothing is added.
    for (let i = 0; i < 3; i++) {
      a.advanceClock(60_000);
      await a.pass();
    }

    expect((await fsp.readdir(quarantineRoot(a))).sort()).toEqual(dirBefore);
    expect((await fsp.readdir(dir)).sort()).toEqual([...filesBefore].sort());
    // Byte-stable, not merely name-stable: a re-detected conflict must not
    // re-stamp `detectedAt` — the shared directory stays quiet (acceptance
    // defect D-2: the meta was rewritten, same size, every pass).
    expect(sha256(await read(path.join(dir, "meta.json")))).toBe(sha256(metaBefore));
  });

  it("survives losing every trace of local state", async () => {
    const { a } = await forkedWorld();
    const first = await settle(a);
    const dirBefore = (await fsp.readdir(quarantineRoot(a))).sort();

    // U-20: throw away the ledger entirely, as an Obsidian restart would.
    a.restart();
    await settle(a);

    // Same two files, same id, same directory — nothing had to remember that
    // this conflict existed.
    expect((await fsp.readdir(quarantineRoot(a))).sort()).toEqual(dirBefore);
    expect(dirBefore).toContain(first.actions[0]?.conflictId as string);
  });

  it("S-04b: behaves identically with the manifest deleted", async () => {
    // The conflict identity is derived from the two hashes, so it cannot
    // depend on the cache. Deleting the manifest is the cheapest way to prove
    // that rather than assert it — if any part of the identity came from
    // there, the next pass would land on a different directory.
    const { a } = await forkedWorld();
    const first = await settle(a);
    const dirBefore = (await fsp.readdir(quarantineRoot(a))).sort();

    await fsp.rm(a.manifestPath, { force: true });
    for (let i = 0; i < 3; i++) await a.pass();

    expect((await fsp.readdir(quarantineRoot(a))).sort()).toEqual(dirBefore);
    expect(dirBefore).toContain(first.actions[0]?.conflictId as string);
  });
});

describe("U-21: fixing the content clears the conflict by itself", () => {
  it("resumes ordinary handling once one side contains the other", async () => {
    const { a } = await forkedWorld();
    await settle(a);

    // The user resolves it by hand: local adopts the remote branch and adds to
    // it, so local now strictly extends remote.
    const remoteBytes = await read(replicaFile(a));
    await fsp.writeFile(a.cli.session(SID).filePath, remoteBytes);
    await a.cli.session(SID).appendRaw('{"uuid":"merged","branch":"resolved"}\n');

    const report = await settle(a);

    // The old conflictId is simply never computed again. No state had to be
    // cleared, and nothing had to notice the user's edit.
    expect(report.actions[0]?.action).toBe("PUSH_OVERWRITE");
    expect(report.actions[0]?.conflictId).toBeUndefined();
  });
});

describe("dry run never quarantines", () => {
  it("reports the conflict and writes nothing", async () => {
    const { w, a } = await forkedWorld();

    const before = await w.snapshot();
    await a.pass({ dryRun: true });
    const report = await a.pass({ dryRun: true });
    const after = await w.snapshot();

    expect(report.actions[0]?.action).toBe("CONFLICT");
    expect(report.actions[0]?.conflictId).toBeUndefined();
    expect([...after.live.keys()].sort()).toEqual([...before.live.keys()].sort());
    expect([...after.archive.keys()].sort()).toEqual([...before.archive.keys()].sort());
  });
});
