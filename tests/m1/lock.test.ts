/**
 * testing.md §7.4 R-09 / R-10 — pass mutual exclusion.
 *
 * The lock is advisory and the tests say so. What they pin down is the part
 * that is not optional: a stale lock must be stealable, and stealing must
 * invalidate the previous holder's writes. A lock that cannot be stolen wedges
 * the plugin after any crash; one that can be stolen without an epoch lets two
 * passes write the same file believing they each hold it.
 */
import { describe, expect, it } from "vitest";
import {
  type LockFile,
  STALE_AFTER_MS,
  decideAcquire,
  heartbeat,
  isStale,
  mayWrite,
  parseLockFile,
} from "../../src/orchestration/lock";

const T0 = 1_700_000_000_000;
const MACHINE = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

const lock = (overrides: Partial<LockFile> = {}): LockFile => ({
  pid: 100,
  machineId: MACHINE,
  epoch: 1,
  acquiredAtMs: T0,
  heartbeatMs: T0,
  ...overrides,
});

const input = (overrides: Partial<Parameters<typeof decideAcquire>[0]> = {}) => ({
  existing: null,
  nowMs: T0,
  pid: 100,
  machineId: MACHINE,
  inProcessBusy: false,
  ...overrides,
});

describe("R-09: two passes in one instance", () => {
  it("refuses the second immediately rather than queueing it", () => {
    // Queueing would start the second pass from observations taken before the
    // first one wrote anything — it would plan against a world that no longer
    // exists.
    const outcome = decideAcquire(input({ inProcessBusy: true }));
    expect(outcome).toEqual({ ok: false, reason: "ALREADY_RUNNING" });
  });

  it("checks in-process state before touching the filesystem", () => {
    // Asserted by behaviour: busy wins even when the on-disk lock is free.
    const outcome = decideAcquire(input({ inProcessBusy: true, existing: null }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("ALREADY_RUNNING");
  });
});

describe("R-10: two instances competing", () => {
  it("grants the lock when nobody holds it", () => {
    const outcome = decideAcquire(input());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.lock.epoch).toBe(1);
  });

  it("refuses when another live instance holds it", () => {
    const outcome = decideAcquire(
      input({ pid: 200, existing: lock({ pid: 100, heartbeatMs: T0 }), nowMs: T0 + 1000 }),
    );
    expect(outcome).toMatchObject({ ok: false, reason: "LOCK_HELD" });
  });

  it("steals a lock whose holder stopped breathing", () => {
    // A crashed process leaves one behind. Refusing to sync until a human finds
    // and deletes a file is worse than occasionally overlapping.
    const outcome = decideAcquire(
      input({ pid: 200, existing: lock({ pid: 100 }), nowMs: T0 + STALE_AFTER_MS + 1 }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.stolenFrom?.pid).toBe(100);
  });

  it("bumps the epoch on every takeover", () => {
    const outcome = decideAcquire(
      input({ pid: 200, existing: lock({ epoch: 7 }), nowMs: T0 + STALE_AFTER_MS + 1 }),
    );
    if (!outcome.ok) return;
    expect(outcome.lock.epoch).toBe(8);
  });

  it("reclaims its own lock without treating itself as a competitor", () => {
    const outcome = decideAcquire(input({ existing: lock({ pid: 100 }), nowMs: T0 + 1000 }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Still bumped: a previous run of this pid may be mid-write.
    expect(outcome.lock.epoch).toBe(2);
  });
});

describe("stealing is only safe because writes re-check the epoch", () => {
  it("lets the current holder write", () => {
    const held = lock({ epoch: 5 });
    expect(mayWrite(held, held)).toBe(true);
  });

  it("stops a superseded holder from writing", () => {
    // The failure this prevents: we acquired the lock, another instance judged
    // it stale and took it, and now both are writing the same file. Comparing
    // pids would not catch it — the original holder's pid is still its own.
    const held = lock({ epoch: 5 });
    const stolen = lock({ pid: 200, epoch: 6 });
    expect(mayWrite(held, stolen)).toBe(false);
  });

  it("stops a write when the lock has vanished", () => {
    // An unreadable or deleted lock means we cannot prove we still hold it.
    expect(mayWrite(lock(), null)).toBe(false);
  });

  it("stops a write when the same pid re-acquired at a new epoch", () => {
    // Same process, later run — the earlier pass's in-flight writes are still
    // invalid.
    const held = lock({ epoch: 5 });
    expect(mayWrite(held, lock({ epoch: 6 }))).toBe(false);
  });
});

describe("staleness and heartbeats", () => {
  it("counts from the heartbeat, not from acquisition", () => {
    // A long pass is not an abandoned one.
    const long = lock({ acquiredAtMs: T0, heartbeatMs: T0 + 10 * STALE_AFTER_MS });
    expect(isStale(long, T0 + 10 * STALE_AFTER_MS + 1000)).toBe(false);
  });

  it("declares staleness once the heartbeat stops", () => {
    expect(isStale(lock(), T0 + STALE_AFTER_MS + 1)).toBe(true);
  });

  it("refreshes without changing identity", () => {
    const refreshed = heartbeat(lock({ epoch: 3 }), T0 + 5000);
    expect(refreshed.heartbeatMs).toBe(T0 + 5000);
    expect(refreshed.epoch).toBe(3);
    expect(refreshed.acquiredAtMs).toBe(T0);
  });
});

describe("a corrupt lock file never wedges the plugin", () => {
  it.each([
    ["not an object", "text"],
    ["null", null],
    ["an array", []],
    ["missing epoch", { pid: 1, machineId: MACHINE, acquiredAtMs: 1, heartbeatMs: 1 }],
    ["wrong types", { pid: "1", machineId: MACHINE, epoch: 1, acquiredAtMs: 1, heartbeatMs: 1 }],
  ])("reads %s as nobody holding it", (_label, raw) => {
    // An unreadable file is indistinguishable from a half-written one, and the
    // lock is advisory regardless — treating it as held forever is the only
    // outcome that cannot be recovered from.
    expect(parseLockFile(raw)).toBeNull();
  });

  it("parses a well-formed lock", () => {
    expect(parseLockFile({ ...lock() })).toEqual(lock());
  });

  it("acquires when the existing lock was unparseable", () => {
    const outcome = decideAcquire(input({ existing: parseLockFile("garbage") }));
    expect(outcome.ok).toBe(true);
  });
});

// ── end to end ─────────────────────────────────────────────────────────────

import { promises as fsp } from "node:fs";
import nodePath from "node:path";
import { afterEach } from "vitest";
import { World, WORKSPACE_ID, sha256 } from "../helpers/world";

const SID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const worlds: World[] = [];
afterEach(async () => {
  while (worlds.length) await worlds.pop()?.dispose();
});

describe("R-09 end to end: overlapping passes in one instance", () => {
  it("runs one pass's worth of work, not two", async () => {
    const w = World.create();
    worlds.push(w);
    const a = w.machine("A");
    await a.cli.session(SID).append(6);
    await a.pass({ withLock: true }); // observe

    // Both started before either finishes — the real shape of a timer firing
    // during a manual sync.
    const [first, second] = await Promise.all([
      a.pass({ withLock: true }),
      a.pass({ withLock: true }),
    ]);

    const aborted = [first, second].filter((r) => r.outcome === "aborted");
    expect(aborted, "exactly one pass must decline to run").toHaveLength(1);
    expect(aborted[0]?.abortReason).toBe("ALREADY_RUNNING");
    // And the declining pass did nothing at all, rather than queueing.
    expect(aborted[0]?.actions).toEqual([]);

    const replica = nodePath.join(a.replicaRoot, WORKSPACE_ID, "claude-code", `${SID}.jsonl`);
    const landed = new Uint8Array(await fsp.readFile(replica).catch(() => Buffer.alloc(0)));
    expect(sha256(landed)).toBe(await a.cli.session(SID).hash());
  });
});


// ── on disk ────────────────────────────────────────────────────────────────

import { sequentialIdGen } from "../../src/infra/clock";
import { createNodeFsGateway } from "../../src/infra/node-fs-gateway";
import { type PathGuardDeps, splitPathSegments } from "../../src/infra/path-guard";
import { createHomeStore } from "../../src/infra/home-store";
import { createFileLock } from "../../src/orchestration/lock-file";
import { makeRealTmpDir, removeTree } from "../helpers/fs-cleanup";

describe("R-10 on disk: two Obsidian windows, one lock file", () => {
  const homes: string[] = [];
  afterEach(() => {
    while (homes.length) removeTree(homes.pop() as string);
  });

  /** Two instances that differ only in pid, sharing one home directory. */
  function instances(nowMs: () => number) {
    const stateRoot = makeRealTmpDir("aiss-lock-");
    homes.push(stateRoot);
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
      joinPath: (...parts) => nodePath.join(...parts),
      dirnameOf: (target) => nodePath.dirname(target),
      splitPath: splitPathSegments,
    };
    const home = createHomeStore({ fs, guard, joinPath: (...p) => nodePath.join(...p), stateRoot });
    const make = (pid: number) => {
      let busy = false;
      return createFileLock({
        fs,
        home,
        workspaceId: "ws",
        machineId: MACHINE,
        pid,
        nowMs,
        inProcessBusy: () => busy,
        onAcquired: () => {
          busy = true;
        },
        onReleased: () => {
          busy = false;
        },
      });
    };
    return { first: make(101), second: make(202), stateRoot };
  }

  it("grants it to one of them and refuses the other", async () => {
    const { first, second } = instances(() => T0);

    expect(await first.acquire()).toEqual({ ok: true });
    expect(await second.acquire()).toMatchObject({ ok: false, reason: "LOCK_HELD" });
  });

  it("frees it on release", async () => {
    const { first, second } = instances(() => T0);
    await first.acquire();
    await first.release();
    expect(await second.acquire()).toEqual({ ok: true });
  });

  it("lets a stale lock be stolen, and stops the original from writing", async () => {
    // Both halves matter. Without stealing, one crash wedges the plugin until
    // a human finds and deletes a file. Without the epoch re-check, stealing
    // means two passes writing the same file believing they each hold it.
    let now = T0;
    const { first, second } = instances(() => now);

    await first.acquire();
    expect(await first.mayWrite()).toBe(true);

    now = T0 + STALE_AFTER_MS + 1;
    expect(await second.acquire()).toEqual({ ok: true });
    expect(await first.mayWrite(), "the original holder must notice").toBe(false);
    expect(await second.mayWrite()).toBe(true);
  });

  it("does not remove a lock that was taken from it", async () => {
    // Releasing the thief's lock would hand a third instance a free
    // acquisition while the thief is mid-write.
    let now = T0;
    const { first, second } = instances(() => now);
    await first.acquire();
    now = T0 + STALE_AFTER_MS + 1;
    await second.acquire();

    await first.release();

    expect(await second.mayWrite(), "the thief still holds it").toBe(true);
  });

  it("is not wedged by a corrupt lock file", async () => {
    const { first, stateRoot } = instances(() => T0);
    const lockPath = nodePath.join(stateRoot, "locks", "ws.lock");
    await fsp.mkdir(nodePath.dirname(lockPath), { recursive: true });
    await fsp.writeFile(lockPath, "{ this is not json");

    expect(await first.acquire()).toEqual({ ok: true });
  });
});
