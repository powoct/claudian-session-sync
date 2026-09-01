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

describe("Claudian 2.2.5: records under devices/ (2026-09-01)", () => {
  const DEVICE = `device-${"a1b2c3d4".repeat(8)}`;
  const OTHER_DEVICE = `device-${"f9e8d7c6".repeat(8)}`;

  it("admits a conversation whose record moved into a device directory", async () => {
    world = World.create();
    const machine = world.machine("A");
    await machine.initialiseSyncDir();
    await machine.cli.session(SID).append(3);
    machine.cli.scopeToDevice(SID, DEVICE);

    await machine.pass();
    const report = await machine.pass();
    expect(report.actions.filter((a) => a.result === "APPLIED").map((a) => a.neutralRel)).toEqual([
      `claude-code/${SID}.jsonl`,
    ]);
  });

  it("ignores a directory that is not a device key", async () => {
    // §8.2's fail-closed rule reaches in here too: the walk is two levels and
    // the name must match upstream's own `device-` + 64 hex, so a folder the
    // user dropped into the store is not a place records are read from.
    world = World.create();
    const machine = world.machine("A");
    await machine.initialiseSyncDir();
    await machine.cli.session(SID).append(3);
    machine.cli.scopeToDevice(SID, "notes-backup");

    await machine.pass();
    const report = await machine.pass();
    expect(report.actions.filter((a) => a.result === "APPLIED")).toEqual([]);
  });

  it("pairs a tombstone within its own layer, not across them", async () => {
    // Upstream's rule, read off `selectSessionMetadataCandidate`: a device
    // deletion is tested against the device layer and an unscoped deletion
    // against the flat one. Pairing across layers would let one machine's
    // delete hide a conversation another machine still holds — and this plugin
    // does not propagate deletions at all (ADR-10).
    world = World.create();
    const machine = world.machine("A");
    await machine.initialiseSyncDir();
    await machine.cli.session(SID).append(3);
    machine.cli.scopeToDevice(SID, DEVICE);
    machine.cli.tombstone(SID, { device: OTHER_DEVICE }); // another device's delete

    await machine.pass();
    const report = await machine.pass();
    expect(
      report.actions.filter((a) => a.result === "APPLIED").map((a) => a.neutralRel),
      "another device's tombstone ended admission",
    ).toEqual([`claude-code/${SID}.jsonl`]);
  });

  it("does not let a top-level tombstone bury a device-scoped record", async () => {
    // `selectSessionMetadataCandidate` returns the device record whenever it
    // exists and its *own* layer has no deletion — `unscopedDeleted` is only
    // ever consulted for the flat and legacy paths. So a conversation deleted
    // back when it lived at the top level, then recreated under a device, is
    // live upstream, and admission must agree or the session silently stops
    // syncing again for a different reason.
    world = World.create();
    const machine = world.machine("A");
    await machine.initialiseSyncDir();
    await machine.cli.session(SID).append(3);
    machine.cli.tombstone(SID); // top level
    machine.cli.scopeToDevice(SID, DEVICE); // record moves, tombstone does not

    await machine.pass();
    const report = await machine.pass();
    expect(
      report.actions.filter((a) => a.result === "APPLIED").map((a) => a.neutralRel),
      "a top-level tombstone suppressed a device record",
    ).toEqual([`claude-code/${SID}.jsonl`]);
  });

  it("stops admitting when the tombstone is in the same device directory", async () => {
    world = World.create();
    const machine = world.machine("A");
    await machine.initialiseSyncDir();
    await machine.cli.session(SID).append(3);
    machine.cli.scopeToDevice(SID, DEVICE);
    machine.cli.tombstone(SID, { device: DEVICE });

    await machine.pass();
    const report = await machine.pass();
    expect(report.actions.filter((a) => a.result === "APPLIED")).toEqual([]);
  });
});

describe("tombstones are matched by name, never parsed", () => {
  it("a torn half-written tombstone still ends admission", async () => {
    // Claudian rewrites these files wholesale, so catching one mid-write is a
    // real state, not a hypothesis. Termination must not depend on the
    // marker's *content* being readable — the marker existing is the fact.
    world = World.create();
    const machine = world.machine("A");
    await machine.initialiseSyncDir();
    await machine.cli.session(SID).append(3);
    await fsp.writeFile(
      path.join(machine.vaultPath, ".claudian", "sessions", `conv-fake-${SID}.deleted.json`),
      "{", // torn: not valid JSON
    );

    await machine.pass();
    const report = await machine.pass();

    expect(report.actions.filter((a) => a.result === "APPLIED")).toEqual([]);
    const replica = path.join(machine.replicaRoot, WORKSPACE_ID, "claude-code");
    expect(await fsp.readdir(replica).catch(() => [])).toEqual([]);
  });
});
