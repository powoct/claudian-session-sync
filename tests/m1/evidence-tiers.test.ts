/**
 * architecture §5.3 at the engine level — what the manifest is allowed to do.
 *
 * The module tests (`manifest.test.ts`) pin the parsing rules. These pin the
 * only two things that matter about the cache in practice:
 *
 *  - it removes the steady-state reads, which is the entire reason it exists;
 *  - it cannot cause a write, however wrong or however hostile it is.
 *
 * The second is asserted the honest way: by forging the worst manifest the
 * rules permit and showing the damage is bounded to "a pass did nothing" —
 * not by pretending a bad manifest is detectable.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PassReport } from "../../src/orchestration/pass-report";
import { World, WORKSPACE_ID, sha256 } from "../helpers/world";

const SID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

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

async function settle(machine: { pass: () => Promise<PassReport> }) {
  await machine.pass();
  return machine.pass();
}

/** The E0 signature the engine will observe for a path, computed the same way. */
async function e0Of(target: string) {
  const st = await fsp.stat(target);
  const handle = await fsp.open(target, "r");
  try {
    const length = Math.min(st.size, 4096);
    const buffer = new Uint8Array(length);
    if (length > 0) await handle.read(buffer, 0, length, st.size - length);
    return {
      size: st.size,
      mtimeMs: st.mtimeMs,
      ctimeMs: st.ctimeMs,
      ino: st.ino,
      tailHash: sha256(buffer),
    };
  } finally {
    await handle.close();
  }
}

const readManifest = async (target: string) =>
  JSON.parse(await fsp.readFile(target, "utf8")) as {
    schemaVersion: number;
    entries: Record<string, Record<string, unknown>>;
  };

describe("E1: the steady state costs no reads", () => {
  it("answers an unchanged pair from two stats and a tail", async () => {
    const w = newWorld();
    const a = w.machine("A");

    await a.cli.session(SID).append(20);
    await settle(a); // pushes, then records what it read
    await a.pass(); // first pass that can hit the cache

    a.resetIo();
    const report = await a.pass();

    expect(report.actions.map((x) => x.action)).toEqual(["NOOP"]);
    expect(report.actions[0]?.evidence.level).toBe("E1/E1");
    // The claim, stated as I/O: not one byte of session content was read.
    expect(a.io.readFile, "a converged pass must not read file contents").toBe(0);
    expect(a.io.readTail, "but it still takes the cheap E0 evidence").toBeGreaterThan(0);
  });

  it("falls back to reading the moment either side moves", async () => {
    const w = newWorld();
    const a = w.machine("A");

    await a.cli.session(SID).append(20);
    await settle(a);
    await a.pass();

    await a.cli.session(SID).append(3);
    a.resetIo();
    await a.pass(); // observes the change
    const report = await a.pass();

    expect(a.io.readFile).toBeGreaterThan(0);
    expect(report.actions[0]?.evidence.level).toBe("E2/E2");
    expect(report.actions.map((x) => x.action)).toContain("PUSH_OVERWRITE");
  });
});

describe("EV-1: no manifest can authorise a write", () => {
  it("bounds the worst forged manifest to a pass that does nothing", async () => {
    // The strongest lie the rules allow: an entry whose E0 matches the remote
    // file exactly (so it is an E1 hit) but whose contentHash is the *local*
    // file's, claiming two divergent files are identical.
    const w = newWorld();
    const a = w.machine("A");
    const b = w.machine("B");

    await a.cli.session(SID).append(6);
    await settle(a);
    await w.flush("A", "B");
    await settle(b);

    // An external tool swaps B's replica copy for *same-size divergent*
    // content — the shape of U-18, and the one the manifest is dangerous
    // about. One byte inside the last record, so nothing about the size or the
    // line structure gives it away.
    const swapped = new Uint8Array(await fsp.readFile(replicaFile(b)));
    swapped[swapped.length - 5] = 0x41; // the space in `"line 5"` becomes `A`
    await fsp.writeFile(replicaFile(b), swapped);
    await b.pass(); // the remote is unstable this pass, so it is only observed

    const localHash = await b.cli.session(SID).hash();
    const remoteHash = sha256(await read(replicaFile(b)));
    expect(localHash, "the two sides must really differ").not.toBe(remoteHash);

    const manifest = await readManifest(b.manifestPath);
    const key = `${WORKSPACE_ID}/claude-code/${SID}.jsonl`;
    manifest.entries[key] = {
      ...manifest.entries[key],
      contentHash: localHash, // the lie
      e0: await e0Of(replicaFile(b)), // with a true signature behind it
    };
    await fsp.writeFile(b.manifestPath, JSON.stringify(manifest, null, 2));
    // The local half of the cache has to agree too, or there is no E1 pair.
    // It does, honestly: b just read its own file.

    const report = await b.pass();

    // The lie lands — and this is the honest part: a forged E1 pair produces a
    // NOOP. What it cannot produce is a write. Both files are untouched, so
    // the cost is a missed sync that the next scrub repairs, not a lost branch.
    expect(report.actions.map((x) => x.action)).toEqual(["NOOP"]);
    expect(await b.cli.session(SID).hash()).toBe(localHash);
    expect(sha256(await read(replicaFile(b)))).toBe(remoteHash);

    // And the repair is not hypothetical. Losing the manifest forces T4 — a
    // full read of everything — which finds the disagreement it was hiding on
    // the very next pass.
    await fsp.rm(b.manifestPath);
    const truth = await b.pass();
    expect(truth.actions.map((x) => x.action)).toEqual(["CONFLICT"]);
    expect(truth.actions[0]?.evidence.level).toBe("E2/E2");
  });

  it("ignores an entry that claims a file the replica does not have", async () => {
    // S-06b, in its sharpest form: the manifest arrives before the session and
    // says the remote already holds exactly what we hold. Believing it would
    // silently skip the push and lose the session on the other machine.
    const w = newWorld();
    const a = w.machine("A");

    await a.cli.session(SID).append(8);
    await a.pass();
    const localHash = await a.cli.session(SID).hash();

    await fsp.mkdir(path.dirname(a.manifestPath), { recursive: true });
    await fsp.writeFile(
      a.manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        updatedAt: "2026-08-08T00:00:00.000Z",
        entries: {
          [`${WORKSPACE_ID}/claude-code/${SID}.jsonl`]: {
            provider: "claude-code",
            workspaceId: WORKSPACE_ID,
            logicalId: SID,
            mode: "append-jsonl",
            size: 1,
            lineCount: 8,
            contentHash: localHash,
            e0: { size: 1, mtimeMs: 1, ctimeMs: 1, ino: 1, tailHash: localHash },
            lastWriter: "B",
            updatedAt: "2026-08-08T00:00:00.000Z",
            generation: 1,
          },
        },
      }),
    );

    const report = await a.pass();

    expect(report.actions.map((x) => x.action)).toContain("PUSH_NEW");
    expect(sha256(await read(replicaFile(a)))).toBe(localHash);
  });
});

describe("S-07: the manifest can be deleted at any time", () => {
  it("rebuilds it and reaches a byte-identical result", async () => {
    const w = newWorld();
    const a = w.machine("A");
    const b = w.machine("B");

    await a.cli.session(SID).append(12);
    await settle(a);
    await w.flush("A", "B");
    await settle(b);
    await b.cli.session(SID).append(4);
    await settle(b);
    await w.flush("B", "A");
    await settle(a);

    const before = await w.snapshot();
    expect(await fsp.stat(a.manifestPath)).toBeTruthy();

    await fsp.rm(a.manifestPath);
    await a.pass();
    const report = await a.pass();
    const after = await w.snapshot();

    // Same files, same bytes — the cache was carrying nothing the filesystem
    // could not say for itself.
    expect([...after.live.keys()].sort()).toEqual([...before.live.keys()].sort());
    for (const [key, version] of after.live) {
      expect(version.hash, key).toBe(before.live.get(key)?.hash);
    }
    expect(report.actions.map((x) => x.action)).toEqual(["NOOP"]);
    // Rebuilt, not left missing: otherwise every later pass pays for it.
    expect((await readManifest(a.manifestPath)).entries).toHaveProperty(
      `${WORKSPACE_ID}/claude-code/${SID}.jsonl`,
    );
  });
});

describe("X-03: a manifest from a newer plugin version", () => {
  it("moves files normally and does not touch the manifest's bytes", async () => {
    const w = newWorld();
    const a = w.machine("A");

    await a.cli.session(SID).append(9);
    const expected = await a.cli.session(SID).hash();

    // Direct evidence that a newer client is using this directory. Rebuilding
    // it would destroy whatever that client recorded (§5.3.4).
    const future = `${JSON.stringify({ schemaVersion: 99, updatedAt: "x", entries: {} }, null, 2)}\n`;
    await fsp.mkdir(path.dirname(a.manifestPath), { recursive: true });
    await fsp.writeFile(a.manifestPath, future);

    await settle(a);

    expect(sha256(await read(replicaFile(a)))).toBe(expected);
    expect(await fsp.readFile(a.manifestPath, "utf8")).toBe(future);
  });
});
