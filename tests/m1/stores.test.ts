/**
 * testing.md §6 — the on-disk state façade, against a real filesystem.
 *
 * The parsing rules live in `state-store` / `manifest` and are tested there.
 * What is tested here is the part that only a filesystem can answer: which
 * disk conditions map to which degradation. Those are the ones that go wrong
 * quietly — a permissions error read as "the directory is empty", a zero-byte
 * file read as valid JSON, a probe file left behind that makes the next pass
 * think the sync directory has contents.
 */
import { mkdtempSync, promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { MachineId, SafeAbsolutePath, WorkspaceId } from "../../src/domain/types";
import { sequentialIdGen } from "../../src/infra/clock";
import { createNodeFsGateway } from "../../src/infra/node-fs-gateway";
import { type PathGuardDeps, splitPathSegments } from "../../src/infra/path-guard";
import { createJsonExclusive, readJson } from "../../src/infra/json-file";
import { createHomeStore, emptyBinding } from "../../src/infra/home-store";
import { createSyncDirStore, newRootFile } from "../../src/infra/sync-dir-store";
import { createBackupWriter } from "../../src/infra/backup-writer";
import { STATE_SCHEMA_VERSION, emptyObservations } from "../../src/infra/state-store";
import { removeTree } from "../helpers/fs-cleanup";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) removeTree(dir);
});

function makeRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "aiss-store-"));
  roots.push(dir);
  return dir;
}

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

const sha256 = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const WS = "3f1a9c2e-6b47-4d18-9a03-5e7c8d21b4f6" as WorkspaceId;
const MACHINE = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa" as MachineId;

const home = (stateRoot: string) =>
  createHomeStore({ fs, guard, joinPath: (...p) => path.join(...p), stateRoot });

const syncDir = (syncDirRoot: string) =>
  createSyncDirStore({ fs, guard, joinPath: (...p) => path.join(...p), syncDirRoot });

// ── json-file ──────────────────────────────────────────────────────────────

describe("reading a state file distinguishes three failures", () => {
  it("reports absent for a file that is not there", async () => {
    expect(await readJson(fs, path.join(makeRoot(), "nope.json"))).toEqual({ status: "absent" });
  });

  it("reports unusable for a zero-byte file", async () => {
    // What a crash between create and write leaves behind. It is neither
    // absent nor valid, and calling it either would take the caller's
    // "should I rebuild this?" decision away from them.
    const root = makeRoot();
    const target = path.join(root, "half.json");
    await fsp.writeFile(target, "");
    expect(await readJson(fs, target)).toEqual({ status: "unusable", reason: "empty" });
  });

  it("reports unusable for a truncated write", async () => {
    const root = makeRoot();
    const target = path.join(root, "cut.json");
    await fsp.writeFile(target, '{"schemaVersion": 1, "entr');
    expect(await readJson(fs, target)).toEqual({ status: "unusable", reason: "not-json" });
  });

  it.skipIf(process.platform === "win32")(
    "reports unusable, not absent, when it cannot be read",
    async () => {
      // The distinction that matters: a directory we are not allowed to read
      // is emphatically not an empty one. Conflating them is how a permissions
      // problem becomes "the remote looks empty, push everything".
      const root = makeRoot();
      const target = path.join(root, "locked.json");
      await fsp.writeFile(target, "{}");
      await fsp.chmod(target, 0o000);
      try {
        const load = await readJson(fs, target);
        expect(load.status).toBe("unusable");
      } finally {
        await fsp.chmod(target, 0o600);
      }
    },
  );

  it("refuses to replace when creating exclusively", async () => {
    const root = makeRoot();
    const target = path.join(root, "root.json");
    await fsp.writeFile(target, '{"first":true}');

    const outcome = await createJsonExclusive(
      fs,
      target as SafeAbsolutePath,
      { second: true },
      root as SafeAbsolutePath,
    );

    expect(outcome).toEqual({ ok: false, reason: "target-exists" });
    expect(JSON.parse(await fsp.readFile(target, "utf8"))).toEqual({ first: true });
  });
});

// ── home store ─────────────────────────────────────────────────────────────

describe("the observations ledger", () => {
  it("round-trips through disk", async () => {
    const store = home(makeRoot());
    const file = emptyObservations(MACHINE, "sha256:fp");
    await store.saveObservations(WS, file, 1000);

    const loaded = await store.loadObservations({
      workspaceId: WS,
      machineId: MACHINE,
      syncDirFingerprint: "sha256:fp",
    });
    expect(loaded.outcome.status).toBe("loaded");
    expect(loaded.file.machineId).toBe(MACHINE);
  });

  it("voids the whole file when it describes a different sync directory", async () => {
    // Every firstSeenMs in it is then a statement about files this pass has
    // never seen, so keeping any of it would fabricate stability.
    const store = home(makeRoot());
    await store.saveObservations(WS, emptyObservations(MACHINE, "sha256:one"), 1000);

    const loaded = await store.loadObservations({
      workspaceId: WS,
      machineId: MACHINE,
      syncDirFingerprint: "sha256:two",
    });

    expect(loaded.outcome).toEqual({
      status: "unusable",
      reason: "sync-dir-fingerprint-mismatch",
    });
    expect(Object.keys(loaded.file.remote)).toEqual([]);
  });

  it("hands back an empty ledger rather than throwing on garbage", async () => {
    const root = makeRoot();
    const store = home(root);
    const target = path.join(root, "state", WS, "observations.json");
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, "not json at all");

    const loaded = await store.loadObservations({
      workspaceId: WS,
      machineId: MACHINE,
      syncDirFingerprint: "sha256:fp",
    });
    expect(loaded.outcome.status).toBe("unusable");
    expect(loaded.file.local).toEqual({});
  });
});

describe("the remote-state record", () => {
  it("is ignored when it describes another directory", async () => {
    // Otherwise a directory would inherit the READY state a different one
    // earned, which is the one state that permits writing.
    const store = home(makeRoot());
    await store.saveRemote(
      WS,
      {
        state: "READY",
        rootId: "root-a",
        lastKnownCounts: { files: 9, bytes: 900 },
        consecutiveStableProbes: 3,
        firstProbeMs: 5,
        notReadyReason: null,
      },
      { syncDirPath: "/somewhere/else", nowIso: "2026-08-08T00:00:00.000Z", initializedAt: null },
    );

    const record = await store.loadRemote(WS, "/here");
    expect(record.state).toBe("UNCONFIGURED");
    expect(record.lastKnownCounts).toEqual({ files: 0, bytes: 0 });
  });

  it("round-trips for the directory it belongs to", async () => {
    const store = home(makeRoot());
    await store.saveRemote(
      WS,
      {
        state: "READY",
        rootId: "root-a",
        lastKnownCounts: { files: 9, bytes: 900 },
        consecutiveStableProbes: 3,
        firstProbeMs: 5,
        notReadyReason: null,
      },
      { syncDirPath: "/here", nowIso: "2026-08-08T00:00:00.000Z", initializedAt: null },
    );

    expect(await store.loadRemote(WS, "/here")).toMatchObject({
      state: "READY",
      rootId: "root-a",
      lastKnownCounts: { files: 9, bytes: 900 },
    });
  });
});

describe("workspace bindings", () => {
  it("round-trips and lists", async () => {
    const store = home(makeRoot());
    const binding = emptyBinding({ workspaceId: WS, syncDirPath: "/sync", createdAt: "now" });
    await store.saveBinding(binding);

    expect(await store.listBoundWorkspaces()).toEqual([WS]);
    expect(await store.loadBinding(WS)).toEqual({ status: "loaded", value: binding });
  });

  it("rejects a binding whose id does not match its filename", async () => {
    // The filename is how the binding is found; a mismatch means one of the
    // two is a copy of the other's, and guessing which would bind a workspace
    // to another machine's sync directory.
    const root = makeRoot();
    const store = home(root);
    const target = path.join(root, "workspaces", `${WS}.json`);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(
      target,
      JSON.stringify({ schemaVersion: 1, workspaceId: "someone-else", syncDirPath: "/x" }),
    );

    expect(await store.loadBinding(WS)).toEqual({
      status: "unusable",
      reason: "workspace-id-mismatch",
    });
  });

  it("treats a provider with no explicit enable as disabled", async () => {
    const root = makeRoot();
    const store = home(root);
    const target = path.join(root, "workspaces", `${WS}.json`);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(
      target,
      JSON.stringify({
        schemaVersion: STATE_SCHEMA_VERSION,
        workspaceId: WS,
        syncDirPath: "/sync",
        providers: { "claude-code": {}, codex: { enabled: "yes" } },
      }),
    );

    const load = await store.loadBinding(WS);
    expect(load.status).toBe("loaded");
    if (load.status !== "loaded") return;
    // A malformed record failing to say "disabled" is not consent.
    expect(load.value.providers["claude-code"]?.enabled).toBe(false);
    expect(load.value.providers["codex"]?.enabled).toBe(false);
  });
});

// ── sync directory ─────────────────────────────────────────────────────────

describe("root.json", () => {
  it("reads missing, corrupt and ok apart", async () => {
    const root = makeRoot();
    const store = syncDir(root);
    expect(await store.readRoot()).toEqual({ status: "missing" });

    await fsp.mkdir(path.join(root, ".aiss"), { recursive: true });
    await fsp.writeFile(path.join(root, ".aiss", "root.json"), '{"magic":"something-else"}');
    expect(await store.readRoot()).toEqual({ status: "corrupt" });

    await fsp.writeFile(
      path.join(root, ".aiss", "root.json"),
      JSON.stringify(
        newRootFile({
          rootId: "r1",
          nowIso: "now",
          machineId: MACHINE,
          label: "MBP",
          platform: "darwin",
        }),
      ),
    );
    expect(await store.readRoot()).toEqual({ status: "ok", rootId: "r1", formatVersion: 1 });
  });

  it("can only be created once", async () => {
    // Two machines initialising the same directory at the same moment must not
    // both succeed: the rootId is the anchor everything else is compared to.
    const store = syncDir(makeRoot());
    const file = (id: string) =>
      newRootFile({ rootId: id, nowIso: "now", machineId: MACHINE, label: "x", platform: "linux" });

    expect(await store.initialise(file("first"))).toEqual({ ok: true });
    expect(await store.initialise(file("second"))).toMatchObject({ ok: false });
    expect(await store.readRoot()).toMatchObject({ rootId: "first" });
  });
});

describe("is the sync directory empty?", () => {
  it("ignores OS metadata, so a folder made in Finder still counts as empty", async () => {
    // `.DS_Store` appears the moment a folder is opened. Calling that "not
    // empty" would turn every fresh sync directory on macOS into NR-1 and
    // hide the one button that unblocks the user.
    const root = makeRoot();
    await fsp.writeFile(path.join(root, ".DS_Store"), "junk");
    await fsp.writeFile(path.join(root, ".dropbox.cache"), "junk");
    expect(await syncDir(root).isEmpty()).toBe(true);
  });

  it("ignores an .aiss left behind by our own write probe", async () => {
    const root = makeRoot();
    await fsp.mkdir(path.join(root, ".aiss"), { recursive: true });
    expect(await syncDir(root).isEmpty()).toBe(true);
  });

  it("does not call a directory with real content empty", async () => {
    const root = makeRoot();
    await fsp.mkdir(path.join(root, WS), { recursive: true });
    expect(await syncDir(root).isEmpty()).toBe(false);
  });

  it("does not call an unreadable directory empty", async () => {
    expect(await syncDir(path.join(makeRoot(), "not-there")).isEmpty()).toBe(false);
  });
});

describe("the write probe", () => {
  it("proves writability and leaves nothing behind", async () => {
    const root = makeRoot();
    expect(await syncDir(root).probeWritable(MACHINE)).toBe(true);
    expect(await fsp.readdir(path.join(root, ".aiss"))).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("reports failure on a read-only directory", async () => {
    const root = makeRoot();
    await fsp.chmod(root, 0o500);
    try {
      expect(await syncDir(root).probeWritable(MACHINE)).toBe(false);
    } finally {
      await fsp.chmod(root, 0o700);
    }
  });
});

describe("the workspace scan", () => {
  it("counts files and bytes, and names the empty ones", async () => {
    const root = makeRoot();
    const dir = path.join(root, WS, "claude-code");
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, "a.jsonl"), "12345");
    await fsp.writeFile(path.join(dir, "b.jsonl"), "");
    // Sync-tool droppings must not move the numbers, or the shrink detector
    // fires on the tool's own breathing.
    await fsp.writeFile(path.join(dir, "c.jsonl.partial"), "1234567890");

    const scan = await syncDir(root).scanWorkspace(WS);

    expect(scan.counts).toEqual({ files: 2, bytes: 5 });
    expect(scan.zeroByteRels).toEqual(["claude-code/b.jsonl"]);
  });
});

// ── backups ────────────────────────────────────────────────────────────────

function writer(stateRoot: string, keep: number) {
  const store = home(stateRoot);
  return {
    store,
    backup: createBackupWriter({
      fs,
      home: store,
      joinPath: (...p) => path.join(...p),
      hashBytes: sha256,
      nowMs: (() => {
        let t = 1_700_000_000_000;
        return () => (t += 1000);
      })(),
      randomSuffix: () => "abcd",
      keep,
    }),
  };
}

const backupDir = (stateRoot: string, remote = false) =>
  path.join(stateRoot, "backups", WS, "claude-code", ...(remote ? ["remote"] : []));

describe("backup before overwrite", () => {
  it("copies the version about to be destroyed", async () => {
    const stateRoot = makeRoot();
    const source = path.join(makeRoot(), "s.jsonl");
    await fsp.writeFile(source, "one\ntwo\n");

    const outcome = await writer(stateRoot, 3).backup.backup({
      sourcePath: source,
      workspaceId: WS,
      providerId: "claude-code",
      logicalId: "s" as never,
      remote: false,
      action: "PULL_OVERWRITE",
    });

    expect(outcome.path).not.toBeNull();
    expect(await fsp.readFile(outcome.path as string, "utf8")).toBe("one\ntwo\n");
  });

  it("puts a remote version in its own subtree", async () => {
    // The only route back for a version PUSH_OVERWRITE removes from the sync
    // directory: it may have come from another machine and will vanish there.
    const stateRoot = makeRoot();
    const source = path.join(makeRoot(), "s.jsonl");
    await fsp.writeFile(source, "remote\n");

    const outcome = await writer(stateRoot, 3).backup.backup({
      sourcePath: source,
      workspaceId: WS,
      providerId: "claude-code",
      logicalId: "s" as never,
      remote: true,
      action: "PUSH_OVERWRITE",
    });

    expect(outcome.path).toContain(path.join("claude-code", "remote"));
  });

  it("returns null when there is nothing to copy, which cancels the overwrite", async () => {
    const outcome = await writer(makeRoot(), 3).backup.backup({
      sourcePath: path.join(makeRoot(), "gone.jsonl"),
      workspaceId: WS,
      providerId: "claude-code",
      logicalId: "s" as never,
      remote: false,
      action: "PULL_OVERWRITE",
    });
    expect(outcome).toMatchObject({ path: null, reason: "source-unreadable" });
  });

  it("records one index line per backup, without content", async () => {
    const stateRoot = makeRoot();
    const source = path.join(makeRoot(), "s.jsonl");
    await fsp.writeFile(source, '{"secret":"AISS-SENTINEL-1"}\n');
    const w = writer(stateRoot, 3);
    await w.backup.backup({
      sourcePath: source,
      workspaceId: WS,
      providerId: "claude-code",
      logicalId: "s" as never,
      remote: false,
      action: "PULL_OVERWRITE",
    });

    const index = await fsp.readFile(path.join(backupDir(stateRoot), "index.jsonl"), "utf8");
    expect(index.trim().split("\n")).toHaveLength(1);
    expect(index).not.toContain("AISS-SENTINEL-1");
    expect(index).toContain('"lineCount":1');
  });
});

describe("rotation is governed by I1 (§9.3.3)", () => {
  it("drops surplus versions the newest one still contains", async () => {
    const stateRoot = makeRoot();
    const source = path.join(makeRoot(), "s.jsonl");
    const w = writer(stateRoot, 2);

    // Four strictly growing versions, as an append-only session produces.
    for (const lines of ["a\n", "a\nb\n", "a\nb\nc\n", "a\nb\nc\nd\n"]) {
      await fsp.writeFile(source, lines);
      await w.backup.backup({
        sourcePath: source,
        workspaceId: WS,
        providerId: "claude-code",
        logicalId: "s" as never,
        remote: false,
        action: "PULL_OVERWRITE",
      });
    }

    const kept = (await fsp.readdir(backupDir(stateRoot))).filter((n) => n.endsWith(".bak"));
    expect(kept).toHaveLength(2);
  });

  it("keeps a surplus version that no survivor can reproduce", async () => {
    // The counterintuitive half: `keep = 1` is itself a data-loss path unless
    // rotation checks. This branch exists nowhere else, so it stays.
    const stateRoot = makeRoot();
    const source = path.join(makeRoot(), "s.jsonl");
    const w = writer(stateRoot, 1);

    await fsp.writeFile(source, "branch-one\n");
    await w.backup.backup({
      sourcePath: source,
      workspaceId: WS,
      providerId: "claude-code",
      logicalId: "s" as never,
      remote: false,
      action: "PULL_OVERWRITE",
    });

    await fsp.writeFile(source, "branch-two\n");
    const second = await w.backup.backup({
      sourcePath: source,
      workspaceId: WS,
      providerId: "claude-code",
      logicalId: "s" as never,
      remote: false,
      action: "PULL_OVERWRITE",
    });

    const kept = (await fsp.readdir(backupDir(stateRoot))).filter((n) => n.endsWith(".bak"));
    expect(kept, "the divergent branch survives keep=1").toHaveLength(2);
    expect(second.rotationDeferred).toBe(true);
  });
});
