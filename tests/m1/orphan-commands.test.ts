/**
 * Half-copied sessions, and the four conditions that keep this from deleting a
 * real one (architecture §6.6).
 *
 * The command exists because §6.6 chose not to roll back a group whose primary
 * failed to land. Its whole difficulty is that a leftover and a session the CLI
 * is creating right now look identical: a directory with some members and no
 * commit point. So the tests that matter here are the refusals.
 */
import { promises as fsp } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeHarness } from "../helpers/runtime-harness";

const SID = "01a02f27-c1aa-7aa1-9580-e4188952ef3b";
const LONG_AGO = 30 * 60 * 1000;

const machines: RuntimeHarness[] = [];
afterEach(async () => {
  while (machines.length) await machines.pop()?.dispose();
});

async function withGrok(): Promise<RuntimeHarness> {
  const machine = await RuntimeHarness.create();
  machines.push(machine);
  await machine.configure();
  await machine.runtime.setProvider("grok", { enabled: true });
  await machine.runtime.refresh();
  return machine;
}

/** A session whose commit point never arrived, last touched long enough ago. */
async function halfCopied(machine: RuntimeHarness, sessionId = SID): Promise<void> {
  await machine.writeGrokSession(sessionId, { turns: 2 });
  await fsp.rm(machine.grokPath(sessionId, "summary.json"));
  // Aged against the runtime's own clock, not the wall clock: the harness
  // injects a fixed one that starts years earlier, so `Date.now()` here would
  // make the file look like it was written in the future.
  const old = new Date(machine.nowMs() - LONG_AGO);
  for (const name of ["chat_history.jsonl", "updates.jsonl"]) {
    await fsp.utimes(machine.grokPath(sessionId, name), old, old).catch(() => undefined);
  }
}

describe("finding a session that arrived without its commit point", () => {
  it("lists it, with what it would delete", async () => {
    const machine = await withGrok();
    await halfCopied(machine);

    const groups = await machine.runtime.orphans();

    expect(groups).toHaveLength(1);
    expect(groups[0]?.logicalId).toBe(SID);
    expect(groups[0]?.files.map((f) => f.neutralRel).sort()).toEqual([
      `grok/${SID}/chat_history.jsonl`,
      `grok/${SID}/updates.jsonl`,
    ]);
    expect(groups[0]?.totalBytes).toBeGreaterThan(0);
  }, 30_000);

  it("says nothing about a complete session", async () => {
    const machine = await withGrok();
    await machine.writeGrokSession(SID, { turns: 2 });

    expect(await machine.runtime.orphans()).toEqual([]);
  }, 30_000);

  it("leaves alone a session the CLI is still creating", async () => {
    // The refusal that matters most. A session being written has exactly the
    // shape of a leftover — members, no commit point — and deleting it would
    // destroy a conversation as it was being had.
    const machine = await withGrok();
    await machine.writeGrokSession(SID, { turns: 2 });
    await fsp.rm(machine.grokPath(SID, "summary.json"));

    expect(await machine.runtime.orphans()).toEqual([]);
  }, 30_000);

  it("leaves alone a session the next sync will finish", async () => {
    // The sync folder still has the commit point, so this is not a leftover —
    // it is a job half done, and the next pass completes it. Offering to
    // delete it would race a repair that is already going to happen.
    const machine = await withGrok();
    await machine.writeGrokSession(SID, { turns: 2 });
    await machine.settle();
    await halfCopied(machine);

    expect(await machine.runtime.orphans()).toEqual([]);
  }, 60_000);
});

describe("clearing one", () => {
  it("keeps a copy before deleting, and the files are gone", async () => {
    const machine = await withGrok();
    await halfCopied(machine);
    const listed = (await machine.runtime.orphans())[0];

    const outcome = await machine.runtime.removeOrphan(
      "grok",
      SID,
      (listed?.files ?? []).map((f) => ({ neutralRel: f.neutralRel, sizeBytes: f.sizeBytes })),
    );

    expect(outcome).toMatchObject({ ok: true, removed: 2, backedUp: 2 });
    await expect(fsp.stat(machine.grokPath(SID, "chat_history.jsonl"))).rejects.toThrow();
    // I1: this is the one command whose purpose is to destroy bytes, so the
    // bytes have to still be reachable afterwards.
    const backups = await machine.runtime.backups();
    expect(backups.some((b) => b.originalName === "chat_history.jsonl")).toBe(true);
    expect(await machine.runtime.orphans()).toEqual([]);
  }, 30_000);

  it("refuses when the files changed since the list was drawn", async () => {
    // Between drawing the row and pressing the button, the CLI may have
    // carried on writing the very session this is about to remove.
    const machine = await withGrok();
    await halfCopied(machine);
    const listed = (await machine.runtime.orphans())[0];
    // Grown, but still looking old — which is what a sync tool that preserves
    // timestamps produces, and the case where "it has not been touched for a
    // while" is not enough on its own.
    const target = machine.grokPath(SID, "chat_history.jsonl");
    await fsp.appendFile(target, '{"type":"user"}\n');
    const old = new Date(machine.nowMs() - LONG_AGO);
    await fsp.utimes(target, old, old);

    const outcome = await machine.runtime.removeOrphan(
      "grok",
      SID,
      (listed?.files ?? []).map((f) => ({ neutralRel: f.neutralRel, sizeBytes: f.sizeBytes })),
    );

    expect(outcome).toEqual({ ok: false, reason: "changed-since-listed" });
    await expect(fsp.stat(machine.grokPath(SID, "chat_history.jsonl"))).resolves.toBeTruthy();
  }, 30_000);

  it("refuses a session it is not currently listing", async () => {
    const machine = await withGrok();
    await machine.writeGrokSession(SID, { turns: 2 });

    const outcome = await machine.runtime.removeOrphan("grok", SID, []);

    expect(outcome).toEqual({ ok: false, reason: "not-listed" });
  }, 30_000);
});

describe("I1 on the one command whose purpose is deletion", () => {
  it("deletes nothing when a copy cannot be kept", async () => {
    // Every overwrite in this plugin backs up first and cancels if it cannot
    // (§9.3). Deletion is the same promise with nothing left over afterwards,
    // so a failed copy has to stop it — otherwise this is the single place
    // where bytes leave without a way back.
    const machine = await RuntimeHarness.create({
      failWrite: (target) => target.includes("backups"),
    });
    machines.push(machine);
    await machine.configure();
    await machine.runtime.setProvider("grok", { enabled: true });
    await machine.runtime.refresh();
    await halfCopied(machine);
    const listed = (await machine.runtime.orphans())[0];

    const outcome = await machine.runtime.removeOrphan(
      "grok",
      SID,
      (listed?.files ?? []).map((f) => ({ neutralRel: f.neutralRel, sizeBytes: f.sizeBytes })),
    );

    expect(outcome).toEqual({ ok: false, reason: "backup-failed" });
    // Both still there: it stops at the first failure, and it stops before
    // deleting anything rather than partway through.
    await expect(fsp.stat(machine.grokPath(SID, "chat_history.jsonl"))).resolves.toBeTruthy();
    await expect(fsp.stat(machine.grokPath(SID, "updates.jsonl"))).resolves.toBeTruthy();
  }, 30_000);
});
