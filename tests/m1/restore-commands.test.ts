/**
 * architecture §9.3 — the read half of I1.
 *
 * The write half was always right: every overwrite backs up first, rotation
 * only deletes what a survivor can reproduce byte for byte. What was missing
 * was any way to exercise the guarantee, so these tests are about the promise
 * being *usable*: the version is found, it is put back, and putting it back is
 * itself reversible.
 *
 * Driven through the full runtime, because two of the properties are not
 * local to the command — that a restore is followed by a real pass, and that
 * restoring an older version of an append-only session produces the revert the
 * dialog said it would rather than a surprise.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeHarness } from "../helpers/runtime-harness";

const SID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

const machines: RuntimeHarness[] = [];
afterEach(async () => {
  while (machines.length) await machines.pop()?.dispose();
});

/**
 * Two machines that have overwritten each other once, which is the only way a
 * backup comes into existence at all.
 */
async function withBackups() {
  const a = await RuntimeHarness.create();
  machines.push(a);
  await a.appendSession(SID, 4);
  await a.configure();
  await a.settle();

  const b = await RuntimeHarness.createPeer(a);
  machines.push(b);
  await b.settle(); // b pulls A's version

  await b.appendSession(SID, 3); // b continues the conversation
  await b.settle(); // and pushes, backing up the replica's older version

  await a.settle(); // a pulls it, backing up its own older version
  return { a, b };
}

describe("listing what was kept", () => {
  it("finds the version an overwrite destroyed, with enough to identify it", async () => {
    const { a } = await withBackups();

    const backups = await a.runtime.backups();

    expect(backups.length).toBeGreaterThan(0);
    const entry = backups[0];
    expect(entry?.providerId).toBe("claude-code");
    expect(entry?.originalName).toBe(`${SID}.jsonl`);
    expect(entry?.lineCount).toBeGreaterThan(0);
    expect(entry?.hashPrefix).toMatch(/^[0-9a-f]{8}$/);
    // §11.1: a prefix, never a whole hash, and never a line of the session.
    expect(entry?.hashPrefix.length).toBe(8);
    expect(JSON.stringify(backups)).not.toContain("written on");
  });

  it("says what restoring would lead to, before anything is clicked", async () => {
    const { a } = await withBackups();

    const backups = await a.runtime.backups();

    // A's own backup is the version it held before pulling B's longer one —
    // a strict prefix of what is there now, so restoring reverts and the next
    // sync undoes it. Saying that up front is the point.
    const local = backups.find((entry) => !entry.remote);
    expect(local?.liveRelation).toBe("differs");
    // Predicted against the sync folder — the side the next pass compares
    // with — which holds the longer version A just pulled.
    expect(local?.outcome).toBe("will-be-undone");
    expect(local?.neutralRel).toBe(`claude-code/${SID}.jsonl`);
  });

  it("survives an unreadable index — recovery never depends on it", async () => {
    const { a } = await withBackups();
    const before = await a.runtime.backups();
    expect(before.length).toBeGreaterThan(0);

    // The index is written best-effort (backup-writer.ts), so a restore that
    // needed it would be a restore a lost line could block.
    const dir = path.join(a.homedir, ".claudian-session-sync", "backups");
    for (const index of await findIndexes(dir)) await fsp.writeFile(index, "{ broken\n");

    const after = await a.runtime.backups();
    expect(after.map((entry) => entry.path).sort()).toEqual(
      before.map((entry) => entry.path).sort(),
    );
    expect(after.every((entry) => entry.action === "")).toBe(true);
  });
});

describe("putting a version back", () => {
  it("writes it, and keeps what was there as a backup of its own", async () => {
    const { a } = await withBackups();
    const backups = await a.runtime.backups();
    const entry = backups.find((candidate) => !candidate.remote);
    const live = a.sessionPath(SID);
    const beforeRestore = await fsp.readFile(live);

    const outcome = await a.runtime.restore(entry?.path as string, entry?.hashPrefix as string, entry?.liveHashPrefix ?? null);

    expect(outcome).toMatchObject({ ok: true, neutralRel: `claude-code/${SID}.jsonl` });
    // The restore is itself reversible: what it destroyed is now listed too.
    const afterList = await a.runtime.backups();
    const hashes = afterList.map((candidate) => candidate.hashPrefix);
    expect(hashes).toContain(entry?.hashPrefix);
    expect(afterList.length).toBeGreaterThan(backups.length);
    expect(beforeRestore.length).toBeGreaterThan(0);
  }, 30_000);

  it("refuses when the backup is no longer the version the row described", async () => {
    // The row was drawn at some earlier moment; agreeing to it must mean
    // agreeing to those bytes, not to whatever is at that path now.
    const { a } = await withBackups();
    const entry = (await a.runtime.backups())[0];

    const outcome = await a.runtime.restore(entry?.path as string, "deadbeef", entry?.liveHashPrefix ?? null);

    expect(outcome).toEqual({ ok: false, reason: "backup-changed" });
  });

  it("refuses an unknown path rather than writing to it", async () => {
    const { a } = await withBackups();

    const outcome = await a.runtime.restore(
      path.join(a.homedir, "not-a-backup.bak"),
      "deadbeef",
      null,
    );

    expect(outcome).toEqual({ ok: false, reason: "unknown-backup" });
  });

  it("runs a pass afterwards, so the report says what the sync then did", async () => {
    const { a } = await withBackups();
    const entry = (await a.runtime.backups()).find((candidate) => !candidate.remote);

    await a.runtime.restore(entry?.path as string, entry?.hashPrefix as string, entry?.liveHashPrefix ?? null);

    const report = a.runtime.lastPassReport();
    expect(report).not.toBeNull();
    expect(report?.actions.some((x) => x.neutralRel === `claude-code/${SID}.jsonl`)).toBe(true);
  }, 30_000);
});

async function findIndexes(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fsp.readdir(root, { withFileTypes: true }).catch(() => [])) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...(await findIndexes(child)));
    else if (entry.name === "index.jsonl") found.push(child);
  }
  return found;
}

describe("the ways a restore could destroy something (design review, 2026-08-16)", () => {
  it("survives its own rotation — the clicked version is not rotated away", async () => {
    // The scenario needs the retention limit to actually bite: `backupKeep`
    // defaults to 3, so three local backups plus the one the restore takes is
    // four, and rotation drops the oldest — which for an append-only session
    // is a byte prefix of the new one and therefore "reproducible". I1's
    // letter survives; the row the user pressed does not, and a restore that
    // then failed would leave them with neither.
    const { a, b } = await withBackups(); // one local backup on A
    for (let round = 0; round < 2; round++) {
      await b.appendSession(SID, 2);
      await b.settle();
      await a.settle(); // each pull overwrites A and backs up what it held
    }

    const locals = (await a.runtime.backups()).filter((candidate) => !candidate.remote);
    expect(locals.length, "the retention limit must be reached for this to test anything").toBe(3);
    const oldest = locals[locals.length - 1];

    const outcome = await a.runtime.restore(
      oldest?.path as string,
      oldest?.hashPrefix as string,
      oldest?.liveHashPrefix ?? null,
    );

    expect(outcome.ok).toBe(true);
    await expect(fsp.stat(oldest?.path as string)).resolves.toBeTruthy();
  }, 60_000);

  it("refuses when the session changed after the list was drawn", async () => {
    // Verified overwrite, as §9.2 demands of every other overwrite: the row
    // promised a change *from* specific live bytes. A CLI appending between
    // the listing and the click means those appends exist in no backup and in
    // no restored version — the one way this command could lose bytes.
    const { a } = await withBackups();
    const entry = (await a.runtime.backups()).find((candidate) => !candidate.remote);
    await a.appendRaw(SID, '{"uuid":"late","type":"user"}\n');

    const outcome = await a.runtime.restore(entry?.path as string, entry?.hashPrefix as string, entry?.liveHashPrefix ?? null);

    expect(outcome).toEqual({ ok: false, reason: "target-changed" });
  }, 30_000);

  it("puts a session back that is gone, instead of failing on a backup it cannot take", async () => {
    // The row that said "nothing is there, so this puts it back" could never
    // succeed: backing up a file that does not exist returns null, which the
    // overwrite path reads as "no backup, no write".
    const { a } = await withBackups();
    // Gone *before* the list is drawn, which is what the user would see: the
    // row reads "nothing is there now" and carries no live hash.
    await fsp.rm(a.sessionPath(SID));
    const entry = (await a.runtime.backups()).find((candidate) => !candidate.remote);
    expect(entry?.liveRelation).toBe("absent");

    const outcome = await a.runtime.restore(entry?.path as string, entry?.hashPrefix as string, entry?.liveHashPrefix ?? null);

    expect(outcome).toMatchObject({ ok: true, created: true, backupPath: null });
    expect((await fsp.stat(a.sessionPath(SID))).size).toBe(entry?.sizeBytes);
  }, 30_000);
});
