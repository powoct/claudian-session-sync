/**
 * architecture §8.2 — the whitelist is a boundary on *both* sides.
 *
 * The local side has always had it: discovery is the adapter listing names it
 * recognises, so a foreign file in the CLI's directory is simply never seen.
 * The remote side had nothing. A replica is a directory an external sync tool
 * writes into, and those tools invent files — conflict copies, hostname
 * suffixes, numbered duplicates — that the plugin was pulling straight into the
 * CLI's own directory because "a file was there" was the whole test.
 *
 * These are the tests that would have caught it. They are written against the
 * wired pass rather than the classifier, because the classifier was correct all
 * along and unit-tested; what was missing was the call.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { World, WORKSPACE_ID } from "../helpers/world";

const SID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

let world: World | null = null;
afterEach(async () => {
  await world?.dispose();
  world = null;
});

async function plant(machine: { replicaRoot: string }, name: string): Promise<void> {
  const dir = path.join(machine.replicaRoot, WORKSPACE_ID, "claude-code");
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, name), '{"type":"user","uuid":"a"}\n');
}

describe("files in the replica that no adapter recognises", () => {
  it.each([
    ["a Syncthing conflict copy", `${SID}.sync-conflict-20260807-120000-ABCDEF.jsonl`],
    ["a Dropbox conflict copy", `${SID} (Air's conflicted copy 2026-08-07).jsonl`],
    ["a OneDrive hostname suffix", `${SID}-ct-mbp.jsonl`],
    ["a numbered duplicate", `${SID} (1).jsonl`],
    ["something unrelated", "notes.jsonl"],
  ])("is never written into the CLI's directory: %s", async (_label, name) => {
    world = World.create();
    const machine = world.machine("A");
    await machine.initialiseSyncDir();
    await plant(machine, name);

    // Two passes: the first observes, the second is the one that would act.
    await machine.wiredPass();
    const outcome = await machine.wiredPass();

    expect(await machine.cli.list()).toEqual([]);
    expect(outcome.report?.actions.map((a) => a.neutralRel)).not.toContain(`claude-code/${name}`);
  });

  it("leaves the file where it is — reporting is the whole response", async () => {
    world = World.create();
    const machine = world.machine("A");
    await machine.initialiseSyncDir();
    const name = `${SID}.sync-conflict-20260807-120000-ABCDEF.jsonl`;
    await plant(machine, name);
    const planted = path.join(machine.replicaRoot, WORKSPACE_ID, "claude-code", name);
    const before = await fsp.readFile(planted);

    await machine.wiredPass();
    await machine.wiredPass();

    // Moving it would produce a deletion at this path, which the user's sync
    // tool would then propagate to every other machine (§8.2).
    expect(await fsp.readFile(planted)).toEqual(before);
  });

  it("says which tool made it, so the report is actionable", async () => {
    world = World.create();
    const machine = world.machine("A");
    await machine.initialiseSyncDir();
    await plant(machine, `${SID}.jsonl`);
    await plant(machine, `${SID}.sync-conflict-20260807-120000-ABCDEF.jsonl`);

    const outcome = await machine.wiredPass();
    const unknown = outcome.report?.unknownFiles ?? [];

    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.kind).toBe("syncthing-conflict-copy");
    expect(unknown[0]?.copyOf).toBe(`${SID}.jsonl`);
    expect(unknown[0]?.providerId).toBe("claude-code");
  });

  it("still pulls the real session sitting next to the copies", async () => {
    world = World.create();
    const machine = world.machine("A");
    await machine.initialiseSyncDir();
    await plant(machine, `${SID}.jsonl`);
    await plant(machine, `${SID}.sync-conflict-20260807-120000-ABCDEF.jsonl`);

    await machine.wiredPass();
    await machine.wiredPass();

    expect(await machine.cli.list()).toEqual([`${SID}.jsonl`]);
  });

  it("does not pull our own aux file into the CLI's directory", async () => {
    // `<sid>.origin.json` is ours and lives only in the sync directory (§6.3).
    // It classifies as aux, not as unknown — so it is neither pulled nor
    // reported as something strange.
    world = World.create();
    const machine = world.machine("A");
    await machine.initialiseSyncDir();
    await plant(machine, `${SID}.origin.json`);

    await machine.wiredPass();
    const outcome = await machine.wiredPass();

    expect(await machine.cli.list()).toEqual([]);
    expect(outcome.report?.unknownFiles ?? []).toEqual([]);
  });
});
