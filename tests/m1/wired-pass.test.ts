/**
 * testing.md §7.2 S-08 / S-16…S-20 — the scenarios that need real state files.
 *
 * Everything here is about what survives *between* passes. A harness with an
 * in-memory ledger can test what one pass decides; it cannot test that
 * deleting `observations.json` degrades the next pass to read-only, or that a
 * sync directory which has never been initialised receives nothing at all —
 * because in both cases the thing under test is the file.
 *
 * So these run through `runWorkspacePass`, the real composition root, with
 * every store on disk under the machine's own roots.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { World, WORKSPACE_ID, sha256 } from "../helpers/world";

const SID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

/** Distinct, well-formed session ids — the adapter's whitelist checks the shape. */
const sessionId = (index: number) =>
  `3f2504e0-4f89-41d3-9a0c-${String(index).padStart(12, "0")}`;

let world: World | null = null;
afterEach(async () => {
  await world?.dispose();
  world = null;
});

function newWorld(): World {
  world = World.create();
  return world;
}

const replicaFile = (machine: { replicaRoot: string }) =>
  path.join(machine.replicaRoot, WORKSPACE_ID, "claude-code", `${SID}.jsonl`);

const read = async (target: string) =>
  new Uint8Array(await fsp.readFile(target).catch(() => Buffer.alloc(0)));

const exists = async (target: string) =>
  fsp
    .stat(target)
    .then(() => true)
    .catch(() => false);

/** Everything currently under a directory, relative and sorted. */
async function tree(root: string, prefix = ""): Promise<string[]> {
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await tree(path.join(root, entry.name), rel)));
    else out.push(rel);
  }
  return out.sort();
}

describe("the wired pass carries a session between machines", () => {
  it("pushes, transports and lands, with state on disk throughout", async () => {
    const w = newWorld();
    const a = w.machine("A");
    const b = w.machine("B");

    await a.initialiseSyncDir();
    await a.cli.session(SID).append(8);
    const original = await a.cli.session(SID).hash();

    const push = await a.wiredSettle();
    expect(push.report.actions.map((x) => x.action)).toContain("PUSH_NEW");
    expect(sha256(await read(replicaFile(a)))).toBe(original);

    // The state files are real, and the next pass depends on them.
    expect(await exists(path.join(a.homeRoot, "state", WORKSPACE_ID, "observations.json"))).toBe(true);
    expect(await exists(path.join(a.homeRoot, "state", WORKSPACE_ID, "remote.json"))).toBe(true);
    expect(await exists(path.join(a.replicaRoot, ".aiss", "manifest.json"))).toBe(true);

    await w.flush("A", "B");
    const pull = await b.wiredSettle();
    expect(pull.report.actions.map((x) => x.action)).toContain("PULL_NEW");
    expect(await b.cli.session(SID).hash()).toBe(original);
  });

  it("reaches E1 across a restart, because the ledger is a file", async () => {
    // The point of putting the verified hash on disk: a converged workspace
    // costs almost no reads even after Obsidian has been closed and reopened.
    //
    // Fifty sessions, not one, because the T6 sample is `ceil(N × 2%)` — with
    // a single file that rounds to "verify it every pass", which is correct
    // and also unobservable. At fifty it is one file, and the other
    // forty-nine are the steady state this cache exists for.
    const w = newWorld();
    const a = w.machine("A");
    await a.initialiseSyncDir();
    for (let i = 0; i < 50; i++) {
      await a.cli.session(sessionId(i)).append(3);
    }
    await a.wiredSettle();
    await a.wiredPass();

    a.restart(); // forgets everything in memory; the files remain
    a.resetIo();
    const after = await a.wiredPass();

    const levels = after.report.actions.map((x) => x.evidence.level);
    expect(levels.filter((level) => level === "E1/E1").length).toBeGreaterThanOrEqual(48);
    expect(after.report.actions.every((x) => x.action === "NOOP")).toBe(true);
    // Two sides of at most one sampled file, and nothing else. Counted over
    // session files only: the pass also reads its own state through the same
    // gateway, and that is not what E1 is about.
    expect(a.sessionReads(), "a converged workspace re-reads only the sample").toHaveLength(2);
  }, 60_000);
});

describe("S-16: an empty sync directory is never initialised for the user", () => {
  it("writes nothing at all — not even .aiss — until they say so", async () => {
    const w = newWorld();
    const a = w.machine("A");
    await a.cli.session(SID).append(5);

    // The one thing the machine constructor pre-creates is the workspace
    // subtree; an untouched directory is what this scenario is about.
    await fsp.rm(path.join(a.replicaRoot, WORKSPACE_ID), { recursive: true, force: true });

    const before = await tree(a.replicaRoot);
    const outcome = await a.wiredPass();
    const after = await tree(a.replicaRoot);

    expect(outcome.readiness.state).toBe("AWAIT_INIT");
    expect(outcome.preflight).toEqual({ kind: "await-init" });
    expect(after, "an uninitialised sync directory receives nothing").toEqual(before);
    expect(outcome.report.actions).toEqual([]);

    // And the user's own file is untouched.
    expect((await a.cli.session(SID).bytes()).length).toBeGreaterThan(0);
  });

  it("proceeds once the user initialises it", async () => {
    const w = newWorld();
    const a = w.machine("A");
    await fsp.rm(path.join(a.replicaRoot, WORKSPACE_ID), { recursive: true, force: true });
    await a.cli.session(SID).append(5);
    await a.wiredPass();

    await a.initialiseSyncDir();
    const outcome = await a.wiredSettle();

    expect(outcome.readiness.state).toBe("READY");
    expect(outcome.report.actions.map((x) => x.action)).toContain("PUSH_NEW");
  });
});

describe("S-08: the sync directory disappears", () => {
  it("fails the pass and changes nothing on this machine", async () => {
    const w = newWorld();
    const a = w.machine("A");
    await a.initialiseSyncDir();
    await a.cli.session(SID).append(6);
    await a.wiredSettle();
    const landed = await a.cli.session(SID).hash();

    // The drive is unmounted, the letter changed, the folder was renamed —
    // from here they are the same event (NR-9).
    await fsp.rename(a.replicaRoot, `${a.replicaRoot}-moved`);

    const outcome = await a.wiredPass();

    expect(outcome.readiness.state).toBe("NOT_READY");
    expect(outcome.readiness.notReadyReason).toBe("NR-9-sync-dir-unreachable");
    expect(await a.cli.session(SID).hash()).toBe(landed);
    for (const action of outcome.report.actions) {
      expect(["DEFER", "NOOP", "SKIP_REMOTE_NOT_READY"]).toContain(action.action);
    }
  });
});

describe("S-17 / S-18: the workspace subtree is emptied and comes back", () => {
  it("refuses to re-push into it, then recovers on its own", async () => {
    const w = newWorld();
    const a = w.machine("A");
    await a.initialiseSyncDir();
    await a.cli.session(SID).append(6);
    await a.wiredSettle();
    const pushed = sha256(await read(replicaFile(a)));

    // An external tool empties the subtree. Interpreting that as "the other
    // machine deleted everything" and re-pushing is the accident this state
    // machine exists to prevent — it would collide with whatever the other
    // machine actually has.
    await fsp.rm(path.join(a.replicaRoot, WORKSPACE_ID), { recursive: true, force: true });

    const notReady = await a.wiredPass();
    expect(notReady.readiness.state).toBe("NOT_READY");
    expect(notReady.readiness.notReadyReason).toBe("NR-5-workspace-subtree-missing");
    expect(notReady.report.actions.some((x) => x.action.startsWith("PUSH"))).toBe(false);
    expect(await exists(replicaFile(a))).toBe(false);

    // S-18: hydration finishes and the files come back.
    await fsp.mkdir(path.dirname(replicaFile(a)), { recursive: true });
    await fsp.writeFile(replicaFile(a), Buffer.from(await a.cli.session(SID).bytes()));

    const recovered = await a.wiredSettle();
    expect(recovered.readiness.state).toBe("READY");
    expect(sha256(await read(replicaFile(a)))).toBe(pushed);
  });
});

describe("S-19: the sync directory is not the one we know", () => {
  it("stops and does not recover by itself", async () => {
    const w = newWorld();
    const a = w.machine("A");
    await a.initialiseSyncDir("root-original");
    await a.cli.session(SID).append(6);
    await a.wiredSettle();

    // A different rootId means a different directory: recreated, restored from
    // a backup, or the user pointed the setting somewhere else. Any of those
    // needs a person, so this one never self-clears.
    const rootPath = path.join(a.replicaRoot, ".aiss", "root.json");
    const rootFile = JSON.parse(await fsp.readFile(rootPath, "utf8")) as Record<string, unknown>;
    await fsp.writeFile(rootPath, JSON.stringify({ ...rootFile, rootId: "root-somewhere-else" }));

    const first = await a.wiredPass();
    expect(first.readiness.notReadyReason).toBe("NR-2-root-id-mismatch");

    const second = await a.wiredPass();
    expect(second.readiness.state, "no amount of waiting fixes this").toBe("NOT_READY");
    expect(second.readiness.notReadyReason).toBe("NR-2-root-id-mismatch");
  });
});

describe("S-20: the observations ledger is lost", () => {
  it("degrades to a read-only pass, then recovers", async () => {
    const w = newWorld();
    const a = w.machine("A");
    await a.initialiseSyncDir();
    await a.cli.session(SID).append(6);
    await a.wiredSettle();
    await w.flush("A", "B");

    const b = w.machine("B");
    await b.wiredSettle(); // pulls A's version

    // Local content that has not been pushed yet, so the recovery pass has
    // something to do and "did nothing" cannot pass for "recovered".
    await b.cli.session(SID).append(3);

    const observations = path.join(b.homeRoot, "state", WORKSPACE_ID, "observations.json");
    expect(await exists(observations)).toBe(true);
    await fsp.rm(observations);
    b.restart();

    const before = await w.snapshot();
    const degraded = await b.wiredPass();
    const after = await w.snapshot();

    // Nothing is stable without a ledger, so every action that needs
    // stability defers. The cost of losing this file is one slow pass.
    for (const action of degraded.report.actions) {
      expect(["DEFER", "NOOP"], JSON.stringify(action)).toContain(action.action);
    }
    expect([...after.live.keys()].sort()).toEqual([...before.live.keys()].sort());
    for (const [key, version] of after.live) {
      expect(version.hash, key).toBe(before.live.get(key)?.hash);
    }

    // Rebuilt during that pass, which is the precondition for recovering.
    expect(await exists(observations)).toBe(true);
    const recovered = await b.wiredPass();
    expect(recovered.report.actions.map((x) => x.action)).toContain("PUSH_OVERWRITE");
  });
});

describe("the four roots may not nest", () => {
  it("refuses to run at all when the sync directory is inside the vault", async () => {
    const w = newWorld();
    const a = w.machine("A");
    await a.initialiseSyncDir();
    await a.cli.session(SID).append(4);

    // A sync directory inside the vault pushes every conversation into
    // Obsidian's index — and, worse, makes "inside the sync directory" and
    // "inside the vault" stop being different questions.
    const inside = path.join(a.vaultPath, "nested-sync");
    await fsp.mkdir(inside, { recursive: true });

    const before = await tree(a.replicaRoot);
    const outcome = await a.wiredPass({ binding: { syncDirPath: inside } });
    const after = await tree(a.replicaRoot);

    expect(outcome.preflight?.kind).toBe("root-overlap");
    expect(outcome.report.outcome).toBe("aborted");
    expect(outcome.report.abortReason).toContain("root-overlap");
    expect(after).toEqual(before);
    expect(await tree(inside), "and nothing was written into the bad root either").toEqual([]);
  });
});
