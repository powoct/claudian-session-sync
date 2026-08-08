/**
 * testing.md §7.2 S-04c — getting out of a conflict.
 *
 * Detection without resolution would leave the plugin able to notice a problem
 * and unable to end it, so all three ways out ship in M1. What every case here
 * checks, whichever way the user goes, is the same thing: **the branch they
 * did not choose is still reachable.** A conflict resolution that destroyed
 * the loser would be a worse outcome than the conflict.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeHarness, sha256 } from "../helpers/runtime-harness";

const SID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

const machines: RuntimeHarness[] = [];
afterEach(async () => {
  while (machines.length) await machines.pop()?.dispose();
});

const read = async (target: string) =>
  new Uint8Array(await fsp.readFile(target).catch(() => Buffer.alloc(0)));

/**
 * Two machines that have forked the same session.
 *
 * Both sides append, so neither contains the other — the shape the whole
 * prefix-safe merge rule exists to refuse to resolve on its own.
 */
async function forked() {
  const a = await RuntimeHarness.create();
  machines.push(a);
  await a.appendSession(SID, 6);
  await a.configure();
  await a.settle();

  const b = await RuntimeHarness.createPeer(a);
  machines.push(b);
  await b.settle(); // pulls A's version

  await a.appendRaw(SID, '{"uuid":"a1","type":"user","text":"written on A"}\n');
  await a.settle(); // A's extension reaches the sync folder

  // Different bytes, deliberately. Appending the *same* line on both sides
  // leaves them in a prefix relationship, which is a fork that resolves
  // itself — and a fixture that never produces the conflict it claims to.
  await b.appendRaw(SID, '{"uuid":"b1","type":"user","text":"written on B"}\n');
  const status = await b.settle();

  const workspaceId = status.workspaceId as string;
  return { a, b, workspaceId };
}

describe("a fork becomes a conflict, and the conflict can be ended", () => {
  it("lists both branches with enough to tell them apart", async () => {
    const { b } = await forked();

    const conflicts = await b.runtime.conflicts();

    expect(conflicts).toHaveLength(1);
    const only = conflicts[0];
    expect(only?.logicalIdPrefix).toBe(SID.slice(0, 8));
    // Counts and hash prefixes only — never a line of either conversation.
    expect(only?.meta.localLineCount).toBeGreaterThan(0);
    expect(only?.meta.remoteLineCount).toBeGreaterThan(0);
    expect(JSON.stringify(only?.meta)).not.toContain('"text"');
  });

  it("keeps this machine's version, and the other stays reachable", async () => {
    const { b, workspaceId } = await forked();
    const conflicts = await b.runtime.conflicts();
    const only = conflicts[0];
    const mine = sha256(await read(b.sessionPath(SID)));
    const theirs = sha256(await read(b.replicaPath(workspaceId, SID)));
    expect(mine).not.toBe(theirs);

    const outcome = await b.runtime.resolve(only?.conflictId as string, "keep-local");

    expect(outcome).toMatchObject({ ok: true, action: "PUSH_OVERWRITE" });
    expect(sha256(await read(b.replicaPath(workspaceId, SID)))).toBe(mine);
    // The abandoned branch: still in quarantine, and now also in the backup
    // area, because overwriting it was an overwrite like any other.
    expect(await fsp.readdir(only?.directory as string)).toHaveLength(3);
    if (outcome.ok && outcome.action !== "REVEAL") {
      expect(sha256(await read(outcome.backupPath as string))).toBe(theirs);
    }
  });

  it("keeps the other machine's version, and this one stays reachable", async () => {
    const { b, workspaceId } = await forked();
    const only = (await b.runtime.conflicts())[0];
    const mine = sha256(await read(b.sessionPath(SID)));
    const theirs = sha256(await read(b.replicaPath(workspaceId, SID)));

    const outcome = await b.runtime.resolve(only?.conflictId as string, "keep-remote");

    expect(outcome).toMatchObject({ ok: true, action: "PULL_OVERWRITE" });
    expect(sha256(await read(b.sessionPath(SID)))).toBe(theirs);
    if (outcome.ok && outcome.action !== "REVEAL") {
      expect(sha256(await read(outcome.backupPath as string))).toBe(mine);
    }
  });

  it("shows both without writing anything", async () => {
    // The third option is not padding: two buttons force a guess, and the
    // honest answer to "which of these do I want" is often "let me look".
    const { b, workspaceId } = await forked();
    const only = (await b.runtime.conflicts())[0];
    const before = [
      sha256(await read(b.sessionPath(SID))),
      sha256(await read(b.replicaPath(workspaceId, SID))),
    ];

    const outcome = await b.runtime.resolve(only?.conflictId as string, "reveal");

    expect(outcome).toMatchObject({ ok: true, action: "REVEAL" });
    if (outcome.ok && outcome.action === "REVEAL") {
      expect(await fsp.readdir(outcome.directory)).toContain("meta.json");
    }
    expect([
      sha256(await read(b.sessionPath(SID))),
      sha256(await read(b.replicaPath(workspaceId, SID))),
    ]).toEqual(before);
  });

  it("converges after a resolution instead of conflicting again", async () => {
    const { b, workspaceId } = await forked();
    const only = (await b.runtime.conflicts())[0];
    await b.runtime.resolve(only?.conflictId as string, "keep-local");

    const after = await b.settle();

    expect(after.readiness).toBe("READY");
    expect(sha256(await read(b.replicaPath(workspaceId, SID)))).toBe(
      sha256(await read(b.sessionPath(SID))),
    );
    for (const action of b.runtime.lastPassReport()?.actions ?? []) {
      expect(action.action, JSON.stringify(action)).not.toBe("CONFLICT");
    }
  });
});

describe("a resolution refuses when it is no longer the same disagreement", () => {
  it("declines once the chosen branch has moved on", async () => {
    // The dialog froze a pair of versions; the session did not. Resolving
    // against a version the user never saw is not what they asked for.
    const { b } = await forked();
    const only = (await b.runtime.conflicts())[0];

    await b.appendSession(SID, 1);
    const outcome = await b.runtime.resolve(only?.conflictId as string, "keep-local");

    expect(outcome).toEqual({ ok: false, reason: "branch-moved" });
  });

  it("declines an id that is not there", async () => {
    const { b } = await forked();
    expect(await b.runtime.resolve("deadbeefdeadbeef", "keep-local")).toEqual({
      ok: false,
      reason: "unknown-conflict",
    });
  });

  it("declines to push into a sync folder that is not ready", async () => {
    // Keeping *this* machine's version writes into the sync folder, and that
    // is the one direction a half-hydrated or unrecognised folder makes
    // dangerous. Keeping the other machine's version writes locally and stays
    // available, because nothing about the folder's state makes a local write
    // less safe.
    const { b } = await forked();
    const only = (await b.runtime.conflicts())[0];

    const rootPath = path.join(b.syncDir, ".aiss", "root.json");
    const rootFile = JSON.parse(await fsp.readFile(rootPath, "utf8")) as Record<string, unknown>;
    await fsp.writeFile(rootPath, JSON.stringify({ ...rootFile, rootId: "somewhere-else" }));
    const status = await b.runtime.syncNow();
    expect(status.notReadyReason).toBe("NR-2-root-id-mismatch");

    expect(await b.runtime.resolve(only?.conflictId as string, "keep-local")).toEqual({
      ok: false,
      reason: "remote-not-ready",
    });
    expect((await b.runtime.resolve(only?.conflictId as string, "keep-remote")).ok).toBe(true);
  });
});
