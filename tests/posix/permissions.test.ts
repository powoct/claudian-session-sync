/**
 * The cases that need real POSIX permission bits (testing.md §8.5, §12.4).
 *
 * These live outside `tests/m1/` on purpose. Node's `mode` on Windows only
 * carries the read-only bit — real access is decided by ACLs inherited from
 * the parent — so an assertion written in `chmod` terms there is either always
 * true or always false, and either way carries no information. The `no-skip`
 * gate binds `tests/m1/**` precisely so a blocker case cannot be quietly
 * turned off, which means a genuinely platform-conditional case has to live
 * somewhere else rather than be skipped in place.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { MachineId } from "../../src/domain/types";
import { sequentialIdGen } from "../../src/infra/clock";
import { createNodeFsGateway } from "../../src/infra/node-fs-gateway";
import { type PathGuardDeps, splitPathSegments } from "../../src/infra/path-guard";
import { readJson } from "../../src/infra/json-file";
import { createSyncDirStore } from "../../src/infra/sync-dir-store";
import { makeRealTmpDir, removeTree } from "../helpers/fs-cleanup";

const isWindows = process.platform === "win32";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) removeTree(dir);
});

function makeRoot(): string {
  const dir = makeRealTmpDir("aiss-posix-");
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

const MACHINE = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa" as MachineId;

describe.skipIf(isWindows)("unreadable is not the same as absent", () => {
  it("reports a file it may not read as unusable", async () => {
    // The distinction that matters: a directory we are not allowed to read is
    // emphatically not an empty one. Conflating them is how a permissions
    // problem becomes "the remote looks empty, push everything".
    const root = makeRoot();
    const target = path.join(root, "locked.json");
    await fsp.writeFile(target, "{}");
    await fsp.chmod(target, 0o000);

    try {
      expect((await readJson(fs, target)).status).toBe("unusable");
    } finally {
      await fsp.chmod(target, 0o600);
    }
  });
});

describe.skipIf(isWindows)("the write probe answers by trying", () => {
  it("reports failure on a directory it cannot write to", async () => {
    // Readiness treats "writable" as a precondition rather than an assumption
    // (§9.6.3), and the only honest way to know is to write something.
    const root = makeRoot();
    const store = createSyncDirStore({
      fs,
      guard,
      joinPath: (...parts) => path.join(...parts),
      syncDirRoot: root,
    });
    await fsp.chmod(root, 0o500);

    try {
      expect(await store.probeWritable(MACHINE)).toBe(false);
    } finally {
      await fsp.chmod(root, 0o700);
    }
  });
});
