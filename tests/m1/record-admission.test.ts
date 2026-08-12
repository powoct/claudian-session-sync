/**
 * ADR-47 — admission is by the vault's Claudian conversation records, for
 * every provider.
 *
 * The split under test: *admission* decides what may enter the sync folder,
 * and comes from the records; *membership* decides what keeps converging once
 * there, and is the engine's replica walk (pinned in multi-provider.test.ts).
 * These tests cover the admission half for the provider that changed — Claude
 * Code, whose project directory used to be the whole rule.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { World, WORKSPACE_ID } from "../helpers/world";

const SID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const TERMINAL = "9a1b2c3d-4e5f-4a1b-8c2d-3e4f5a6b7c8d";

let world: World | null = null;
afterEach(async () => {
  await world?.dispose();
  world = null;
});

describe("admission by Claudian record (claude-code)", () => {
  it("pushes a recorded session and leaves a bare-terminal one alone", async () => {
    world = World.create();
    const machine = world.machine("A");
    await machine.initialiseSyncDir();
    await machine.cli.session(SID).append(3); // via Claudian: record planted
    await machine.cli.terminalSession(TERMINAL).append(3); // bare `claude` run

    await machine.pass();
    const report = await machine.pass();

    const applied = report.actions.filter((a) => a.result === "APPLIED").map((a) => a.neutralRel);
    expect(applied).toEqual([`claude-code/${SID}.jsonl`]);
    const replica = path.join(machine.replicaRoot, WORKSPACE_ID, "claude-code");
    expect((await fsp.readdir(replica)).sort()).toEqual([`${SID}.jsonl`]);
  });

  it("stops admitting a conversation Claudian has tombstoned", async () => {
    // Deletion in Claudian is a marker file next to a meta file that stays
    // (markDeleted writes, removes nothing) — so ignoring tombstones would
    // keep syncing every conversation the user ever deleted. Only admission
    // ends here: nothing is removed from the sync folder, because a removal
    // there is deletion propagation, which has no design yet (ADR-10).
    world = World.create();
    const machine = world.machine("A");
    await machine.initialiseSyncDir();
    await machine.cli.session(SID).append(3);
    machine.cli.tombstone(SID);

    await machine.pass();
    const report = await machine.pass();

    expect(report.actions.filter((a) => a.result === "APPLIED")).toEqual([]);
    const replica = path.join(machine.replicaRoot, WORKSPACE_ID, "claude-code");
    expect(await fsp.readdir(replica).catch(() => [])).toEqual([]);
  });

  it("keeps converging a tombstoned session that is already in the sync folder", async () => {
    // Tombstoning after the session synced must not strand the other machine:
    // membership is replica presence, so the copy keeps converging — it just
    // can never be admitted again from scratch.
    world = world ?? World.create();
    const w = world;
    const a = w.machine("A");
    const b = w.machine("B");
    await a.initialiseSyncDir();
    await b.initialiseSyncDir();
    await a.cli.session(SID).append(3);
    await a.pass();
    await a.pass(); // pushed
    await w.flush("A", "B");
    await b.pass();
    await b.pass(); // landed on B

    a.cli.tombstone(SID);
    await b.cli.session(SID).append(2); // B extends (B has its own record)
    await b.pass();
    await b.pass(); // B pushes the extension
    await w.flush("B", "A");
    await a.pass();
    const report = await a.pass(); // A pulls it despite the tombstone

    const pulled = report.actions.find((x) => x.neutralRel === `claude-code/${SID}.jsonl`);
    expect(pulled?.action).toBe("PULL_OVERWRITE");
    expect(pulled?.result).toBe("APPLIED");
  });
});
