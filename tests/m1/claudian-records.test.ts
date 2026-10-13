/**
 * ADR-78's memory: what it remembers, what ends a hold, and what survives a
 * round trip through the disk.
 *
 * Forgetting is the dangerous part, and the first version forgot: a record
 * missing from the sync folder for two passes lost its witness along with its
 * hold, and the next device to push it — a peer that still had it, or simply
 * a move to a new sync folder — brought the deletion back (review, 2026-10-14,
 * reproduced twice). So nothing here forgets on its own any more, and the
 * tests pin that from the side that used to fail.
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
    expect(state.toFile().records[META]?.witnessedHash).toBe("sha256:b");
  });

  it("is not a change when nothing moved", () => {
    const state = createClaudianRecordsState({
      schemaVersion: STATE_SCHEMA_VERSION,
      records: { [META]: { witnessedHash: "sha256:a" } },
    });
    state.witness(META, "sha256:a");
    expect(state.changed()).toBe(false);
  });

  it("remembers a restore made for missing history only while the bytes are the same", () => {
    const state = createClaudianRecordsState(emptyClaudianRecords());
    state.witness(META, "sha256:r");
    state.markRestoredForMissingHistory(META, "sha256:r");
    expect(state.restoredForMissingHistory(META, "sha256:r")).toBe(true);
    state.witness(META, "sha256:r"); // the same bytes, converged again
    expect(state.restoredForMissingHistory(META, "sha256:r")).toBe(true);
    state.witness(META, "sha256:newer"); // anything newer is a record the rule has not seen
    expect(state.restoredForMissingHistory(META, "sha256:r")).toBe(false);
    expect(state.restoredForMissingHistory(META, "sha256:newer")).toBe(false);
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
  it("stops counting once it has nothing left to announce, so an idle hold rewrites nothing", () => {
    const file = (() => {
      const state = createClaudianRecordsState(emptyClaudianRecords());
      state.hold(META, hold(), "sha256:a");
      state.continueHold(META);
      return state.toFile();
    })();
    const later = createClaudianRecordsState(file);
    for (let i = 0; i < 5; i++) later.continueHold(META);
    expect(later.changed()).toBe(false);
  });

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

describe("what does not end a hold", () => {
  it("has no clock and no other way out than the two it names", () => {
    // Only witness() (the file is here again), release() (it reappeared) and
    // a bring-back end one. Nothing about time, or about the sync folder.
    const state = createClaudianRecordsState(emptyClaudianRecords());
    state.hold(META, hold(), "sha256:a");
    for (let i = 0; i < 1_000; i++) state.continueHold(META);
    expect(state.held(META)?.kind).toBe("deleted-here");
    expect(Object.keys(createClaudianRecordsState(state.toFile()).toFile().records)).toEqual([META]);
  });
});

describe("the store's identity", () => {
  it("says recreated only when it knew a different one", () => {
    const state = createClaudianRecordsState(emptyClaudianRecords());
    expect(state.observeStore(null)).toBe(false);
    expect(state.observeStore("101")).toBe(false); // first sight
    expect(state.observeStore("101")).toBe(false);
    expect(state.observeStore(null)).toBe(false); // the store is missing: not a recreation yet
    expect(state.observeStore("202")).toBe(true);
    expect(state.observeStore("202")).toBe(false);
    expect(createClaudianRecordsState(state.toFile()).observeStore("202")).toBe(false);
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

  it("tells absent, unusable, unreadable and newer apart", async () => {
    const home = homeAt();
    expect((await home.loadClaudianRecords(WS)).status).toBe("absent");

    const target = home.layout.claudianRecordsFile(WS);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, "{ torn");
    expect((await home.loadClaudianRecords(WS)).status).toBe("unusable");
    await fsp.writeFile(target, "");
    expect((await home.loadClaudianRecords(WS)).status).toBe("unusable");

    // A file that is there and cannot be read is not a file that is broken:
    // rebuilding over it would lose every hold the ledger no longer knows.
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      await fsp.writeFile(target, "{}");
      await fsp.chmod(target, 0o000);
      try {
        expect((await home.loadClaudianRecords(WS)).status).toBe("unreadable");
      } finally {
        await fsp.chmod(target, 0o600);
      }
    }

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
            hold: { kind: "from-the-future", sinceMs: 1, passes: 1, replicaSize: 1, replicaMtimeMs: 1 },
          },
          [TOMB]: { restoredForMissingHistory: "sha256:t" },
          "claude-code/x.jsonl": { witnessedHash: "sha256:x" },
          "../escape": { witnessedHash: "sha256:x" },
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
