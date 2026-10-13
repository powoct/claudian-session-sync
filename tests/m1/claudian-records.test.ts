/**
 * ADR-78's memory: what it remembers, when it forgets, and what survives a
 * round trip through the disk.
 *
 * The forgetting rules are the dangerous part. Forgetting a hold early brings
 * a deleted conversation back; never forgetting anything grows a file without
 * bound. So each rule is pinned from both sides, including the one that must
 * not fire: a listing that failed is not evidence that a file is gone.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { WorkspaceId } from "../../src/domain/types";
import { sequentialIdGen } from "../../src/infra/clock";
import { createHomeStore } from "../../src/infra/home-store";
import { createNodeFsGateway } from "../../src/infra/node-fs-gateway";
import { type PathGuardDeps, splitPathSegments } from "../../src/infra/path-guard";
import { STATE_SCHEMA_VERSION } from "../../src/infra/state-store";
import {
  createClaudianRecordsState,
  emptyClaudianRecords,
  seedClaudianRecords,
} from "../../src/orchestration/claudian-records";
import { makeRealTmpDir, removeTree } from "../helpers/fs-cleanup";

const CONV = "conv-1786422687897-15ktes7p9";
const META = `claudian/${CONV}.meta.json`;
const TOMB = `claudian/${CONV}.deleted.json`;
const INPUTS = `claudian/${CONV}.inputs.json`;

const hold = (kind: "deleted-here" | "moved-to-device" = "deleted-here") => ({
  kind,
  nowMs: 1_000,
  replicaSize: 10,
  replicaMtimeMs: 5,
  replicaDigest: "d1",
});

describe("witnessing", () => {
  it("remembers a convergence and never an inputs sidecar", () => {
    const state = createClaudianRecordsState(emptyClaudianRecords());
    state.witness(META, "sha256:a");
    state.witness(TOMB, "sha256:t");
    state.witness(INPUTS, "sha256:i");
    expect(state.witnessed(META)).toBe(true);
    expect(state.witnessed(TOMB)).toBe(true);
    expect(state.witnessed(INPUTS)).toBe(false);
  });

  it("ends a hold — converging means the file is here again", () => {
    const state = createClaudianRecordsState(emptyClaudianRecords());
    state.hold(META, hold(), "sha256:a");
    state.witness(META, "sha256:b");
    expect(state.held(META)).toBeNull();
    expect(state.witnessedHash(META)).toBe("sha256:b");
  });

  it("is not a change when nothing moved", () => {
    const state = createClaudianRecordsState({
      schemaVersion: STATE_SCHEMA_VERSION,
      records: { [META]: { witnessedHash: "sha256:a", goneFromReplicaPasses: 0 } },
    });
    state.witness(META, "sha256:a");
    expect(state.changed()).toBe(false);
  });

  it("is seeded from the ledger's converged hashes, records and tombstones only", () => {
    const seeded = seedClaudianRecords({
      [META]: { lastConvergedHash: "sha256:a" },
      [TOMB]: { lastConvergedHash: "sha256:t" },
      [INPUTS]: { lastConvergedHash: "sha256:i" },
      [`claude-code/${"1".repeat(8)}-1111-4111-8111-111111111111.jsonl`]: { lastConvergedHash: "sha256:c" },
      [`claudian/conv-1-a.meta.json`]: { lastConvergedHash: null },
    });
    expect(Object.keys(seeded.records).sort()).toEqual([TOMB, META].sort());
  });
});

describe("a hold", () => {
  it("is announced exactly once, on its second pass, and only for a deletion", () => {
    const state = createClaudianRecordsState(emptyClaudianRecords());
    state.hold(META, hold(), "sha256:a");
    expect(state.continueHold(META)).toBe(true);
    expect(state.continueHold(META)).toBe(false);
    expect(state.continueHold(META)).toBe(false);

    state.hold(TOMB, { ...hold(), kind: "tombstone-consumed" } as never, "sha256:t");
    expect(state.continueHold(TOMB)).toBe(false);
    const moved = createClaudianRecordsState(emptyClaudianRecords());
    moved.hold(META, hold("moved-to-device"), "sha256:a");
    expect(moved.continueHold(META)).toBe(false);
  });

  it("reports a change only when a readable digest moved off a readable one", () => {
    const state = createClaudianRecordsState(emptyClaudianRecords());
    state.hold(META, hold(), "sha256:a");
    expect(state.updateHeldReplica(META, 11, 6, "d1")).toBe(false); // bytes moved, meaning did not
    expect(state.updateHeldReplica(META, 12, 7, null)).toBe(false); // unreadable now
    expect(state.held(META)?.replicaDigest).toBe("d1"); // …and the last readable one is kept
    expect(state.updateHeldReplica(META, 13, 8, "d2")).toBe(true);
    expect(state.held(META)?.replicaSize).toBe(13);
  });

  it("takes a bring-back request only for something held", () => {
    const state = createClaudianRecordsState(emptyClaudianRecords());
    expect(state.requestRelease(META)).toBe(false);
    state.hold(META, hold(), "sha256:a");
    expect(state.requestRelease(META)).toBe(true);
    expect(state.held(META)?.releaseRequested).toBe(true);
  });

  it("released, keeps the witness", () => {
    const state = createClaudianRecordsState(emptyClaudianRecords());
    state.hold(META, hold(), "sha256:a");
    state.release(META);
    expect(state.held(META)).toBeNull();
    expect(state.witnessed(META)).toBe(true);
  });
});

describe("forgetting", () => {
  const withHold = () => {
    const state = createClaudianRecordsState(emptyClaudianRecords());
    state.hold(META, hold(), "sha256:a");
    return state;
  };

  it("drops an entry the sync folder has lacked for two complete passes", () => {
    const state = withHold();
    state.endPass({ replicaRels: new Set(), complete: true });
    expect(state.held(META)).not.toBeNull();
    state.endPass({ replicaRels: new Set(), complete: true });
    expect(state.witnessed(META)).toBe(false);
  });

  it("counts nothing on a pass that could not list the folder", () => {
    const state = withHold();
    for (let i = 0; i < 5; i++) state.endPass({ replicaRels: new Set(), complete: false });
    expect(state.held(META)).not.toBeNull();
  });

  it("starts the count again when the file is seen", () => {
    const state = withHold();
    state.endPass({ replicaRels: new Set(), complete: true });
    state.endPass({ replicaRels: new Set([META]), complete: true });
    state.endPass({ replicaRels: new Set(), complete: true });
    expect(state.held(META)).not.toBeNull();
  });

  it("has no clock: a hold seen in the folder lasts however long", () => {
    const state = withHold();
    for (let i = 0; i < 1_000; i++) state.endPass({ replicaRels: new Set([META]), complete: true });
    expect(state.held(META)?.kind).toBe("deleted-here");
  });
});

describe("on disk", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const dir of roots) removeTree(dir);
  });
  const fs = createNodeFsGateway({
    ids: sequentialIdGen(),
    platform: process.platform,
    pid: process.pid,
    sleep: async () => undefined,
  });
  const guard: PathGuardDeps = {
    fs,
    platform: process.platform,
    caseSensitive: process.platform === "linux",
    joinPath: (...parts) => path.join(...parts),
    dirnameOf: (target) => path.dirname(target),
    splitPath: splitPathSegments,
  };
  const WS = "3f1a9c2e-6b47-4d18-9a03-5e7c8d21b4f6" as WorkspaceId;
  const homeAt = () => {
    const root = makeRealTmpDir("aiss-claudian-records-");
    roots.push(root);
    return createHomeStore({ fs, guard, joinPath: (...p) => path.join(...p), stateRoot: root });
  };

  it("round-trips a hold exactly", async () => {
    const home = homeAt();
    const state = createClaudianRecordsState(emptyClaudianRecords());
    state.witness(TOMB, "sha256:t");
    state.hold(META, hold(), "sha256:a");
    state.requestRelease(META);
    await home.saveClaudianRecords(WS, state.toFile());

    const load = await home.loadClaudianRecords(WS);
    expect(load.status).toBe("loaded");
    if (load.status === "loaded") expect(load.file).toEqual(state.toFile());
  });

  it("tells absent, unreadable and newer apart", async () => {
    const home = homeAt();
    expect((await home.loadClaudianRecords(WS)).status).toBe("absent");

    const target = home.layout.claudianRecordsFile(WS);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, "{ torn");
    expect((await home.loadClaudianRecords(WS)).status).toBe("unusable");

    await fsp.writeFile(target, JSON.stringify({ schemaVersion: STATE_SCHEMA_VERSION + 1, records: {} }));
    expect((await home.loadClaudianRecords(WS)).status).toBe("newer");
  });

  it("drops entries it cannot vouch for, and a hold whose kind it does not know", async () => {
    const home = homeAt();
    const target = home.layout.claudianRecordsFile(WS);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(
      target,
      JSON.stringify({
        schemaVersion: STATE_SCHEMA_VERSION,
        records: {
          [META]: {
            witnessedHash: "sha256:a",
            goneFromReplicaPasses: 0,
            hold: { kind: "from-the-future", sinceMs: 1, passes: 1, replicaSize: 1, replicaMtimeMs: 1 },
          },
          [TOMB]: { goneFromReplicaPasses: 0 },
          "claude-code/x.jsonl": { witnessedHash: "sha256:x", goneFromReplicaPasses: 0 },
          "../escape": { witnessedHash: "sha256:x", goneFromReplicaPasses: 0 },
        },
      }),
    );
    const load = await home.loadClaudianRecords(WS);
    expect(load.status).toBe("loaded");
    if (load.status !== "loaded") return;
    expect(Object.keys(load.file.records)).toEqual([META]);
    expect(load.file.records[META]?.hold).toBeUndefined();
  });
});
