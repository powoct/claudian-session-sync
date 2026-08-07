/**
 * testing.md §8.3 / §8.4 — containment, links and the denylist, on a real
 * filesystem.
 *
 * These are the tests that decide whether a hostile or merely odd file in the
 * sync directory can reach outside the roots the user configured. Every case
 * asserts fail-closed: rejected with a named violation, never "handled".
 */
import { mkdtempSync, promises as fsp, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { SafeAbsolutePath } from "../../src/domain/types";
import { sequentialIdGen } from "../../src/infra/clock";
import { createNodeFsGateway } from "../../src/infra/node-fs-gateway";
import {
  type PathGuardDeps,
  containsPath,
  splitPathSegments,
  findRootOverlaps,
  isDenylisted,
  isTransferArtifact,
  probeCaseSensitivity,
  resolveUnderRoot,
} from "../../src/infra/path-guard";
import { removeTree } from "../helpers/fs-cleanup";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) removeTree(dir);
});

function makeRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "aiss-pg-"));
  roots.push(dir);
  // resolveUnderRoot's parameter is named realRoot because it must be one.
  // macOS hands out /var/folders/... which is a symlink to /private/var/...,
  // and Windows can hand out an 8.3 short name — in both cases the guard would
  // correctly refuse every path under it as having escaped its root.
  return realpathSync.native(dir);
}

const fs = createNodeFsGateway({
  ids: sequentialIdGen(),
  platform: process.platform,
  pid: process.pid,
  sleep: async () => undefined,
});

const deps: PathGuardDeps = {
  fs,
  platform: process.platform,
  caseSensitive: true,
  joinPath: (...parts) => path.join(...parts),
  dirnameOf: (target) => path.dirname(target),
  splitPath: splitPathSegments,
};

const isPosix = process.platform !== "win32";

describe("resolveUnderRoot — acceptance", () => {
  it("resolves an ordinary nested path", async () => {
    const root = makeRoot();
    await fsp.mkdir(path.join(root, "ws", "claude-code"), { recursive: true });
    writeFileSync(path.join(root, "ws", "claude-code", "a.jsonl"), "x\n");

    const result = await resolveUnderRoot(deps, root, "ws/claude-code/a.jsonl", {
      requireRegularFile: true,
    });

    expect(result.ok).toBe(true);
  });

  it("resolves a path that does not exist yet, which is what a new write needs", async () => {
    const root = makeRoot();
    const result = await resolveUnderRoot(deps, root, "ws/claude-code/new.jsonl");
    expect(result.ok).toBe(true);
  });
});

describe("resolveUnderRoot — the root must already be a realpath", () => {
  it("refuses everything under a root that has not been resolved", async () => {
    // Not a quirk to work around: on macOS /var/folders is a symlink to
    // /private/var/folders, so a caller passing the unresolved path is asking
    // about a different directory than the one the walk lands in. Failing
    // closed is right — but it fails for every file, so it is worth having a
    // test that names the cause.
    const real = makeRoot();
    const unresolved = path.join(tmpdir(), path.basename(real));
    if (unresolved === real) return; // no symlinked tmpdir on this platform

    await fsp.mkdir(path.join(real, "ws"), { recursive: true });
    writeFileSync(path.join(real, "ws", "a.jsonl"), "x\n");

    const result = await resolveUnderRoot(deps, unresolved, "ws/a.jsonl");
    expect(result).toMatchObject({ ok: false, violation: "SYMLINK" });
  });
});

describe("resolveUnderRoot — traversal and links (SEC-01..SEC-05)", () => {
  it("rejects a traversal before touching the filesystem", async () => {
    const root = makeRoot();
    const result = await resolveUnderRoot(deps, root, "../../etc/passwd");
    expect(result).toMatchObject({ ok: false, violation: "TRAVERSAL" });
  });

  it("SEC-01: rejects a session file that is a symlink to a credential file", async () => {
    if (!isPosix) return;
    const root = makeRoot();
    const secret = path.join(root, "secret.json");
    writeFileSync(secret, "sk-TESTSENTINEL-0000\n");
    await fsp.mkdir(path.join(root, "ws"), { recursive: true });
    await fsp.symlink(secret, path.join(root, "ws", "a.jsonl"));

    const result = await resolveUnderRoot(deps, root, "ws/a.jsonl", { requireRegularFile: true });

    // Refused without dereferencing: the bytes are never read, so they cannot
    // reach a report, a log or the sync directory.
    expect(result).toMatchObject({ ok: false, violation: "SYMLINK" });
  });

  it("SEC-03: rejects an intermediate directory that is a symlink", async () => {
    if (!isPosix) return;
    const root = makeRoot();
    const outside = makeRoot();
    await fsp.symlink(outside, path.join(root, "ws"));

    const result = await resolveUnderRoot(deps, root, "ws/claude-code/a.jsonl");

    // Not "follow it and check we are still inside": that check can be defeated
    // by repointing the link between the check and the write.
    expect(result).toMatchObject({ ok: false, violation: "SYMLINK" });
  });

  it("SEC-05: rejects a hard-linked file on the read side", async () => {
    const root = makeRoot();
    const secret = path.join(root, "id_ed25519_copy");
    writeFileSync(secret, "PRIVATE KEY\n");
    await fsp.mkdir(path.join(root, "ws"), { recursive: true });
    await fsp.link(secret, path.join(root, "ws", "a.jsonl"));

    const result = await resolveUnderRoot(deps, root, "ws/a.jsonl", {
      requireRegularFile: true,
      rejectHardLinks: true,
    });

    expect(result).toMatchObject({ ok: false, violation: "HARDLINK_SUSPECT" });
  });

  it("rejects a directory where a regular file was required", async () => {
    const root = makeRoot();
    await fsp.mkdir(path.join(root, "ws", "a.jsonl"), { recursive: true });

    const result = await resolveUnderRoot(deps, root, "ws/a.jsonl", { requireRegularFile: true });

    expect(result).toMatchObject({ ok: false, violation: "NOT_REGULAR_FILE" });
  });
});

describe("denylist (§9.7.6)", () => {
  it.each([
    ".credentials.json",
    "auth.json",
    ".env",
    ".env.local",
    "id_rsa",
    "known_hosts",
    "config.toml",
    "server.pem",
    "vault.kdbx",
    "state_5.sqlite",
    "logs_2.sqlite-wal",
    "index.db",
    ".ssh",
  ])("refuses %s", (name) => {
    expect(isDenylisted(name)).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(isDenylisted("AUTH.JSON")).toBe(true);
    expect(isDenylisted("ID_RSA")).toBe(true);
  });

  it("leaves ordinary session files alone", () => {
    expect(isDenylisted("3f2504e0-4f89-41d3-9a0c-0305e82c3301.jsonl")).toBe(false);
    expect(isDenylisted("session.jsonl")).toBe(false);
  });

  it("refuses a denylisted name even nested inside a valid path", async () => {
    const root = makeRoot();
    const result = await resolveUnderRoot(deps, root, "ws/.ssh/id_rsa");
    expect(result).toMatchObject({ ok: false, violation: "DENYLISTED" });
  });

  it("recognises an external sync tool's leftovers", () => {
    expect(isTransferArtifact("a.jsonl.crdownload")).toBe(true);
    expect(isTransferArtifact(".stfolder")).toBe(true);
    expect(isTransferArtifact("~syncthing~a.jsonl.tmp")).toBe(true);
    expect(isTransferArtifact("a.jsonl")).toBe(false);
  });
});

describe("four-root overlap (§9.7.5)", () => {
  const roots4 = (over: Partial<Record<string, string>> = {}) => [
    { name: "vault", realPath: over.vault ?? "/home/testuser/vault" },
    { name: "syncDir", realPath: over.syncDir ?? "/home/testuser/Dropbox/aiss" },
    { name: "backupDir", realPath: over.backupDir ?? "/home/testuser/.ai-session-sync/backups" },
    { name: "providerRoot", realPath: over.providerRoot ?? "/home/testuser/.claude/projects" },
  ];

  it("passes on a sane configuration", () => {
    expect(findRootOverlaps(deps, roots4())).toEqual([]);
  });

  it("catches syncDir inside the vault", () => {
    // Would push every conversation into the vault and make Obsidian index it.
    const overlaps = findRootOverlaps(deps, roots4({ syncDir: "/home/testuser/vault/sync" }));
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]).toMatchObject({ a: "vault", b: "syncDir", relation: "a-contains-b" });
  });

  it("catches syncDir set to the home directory", () => {
    // Every other root becomes a subtree: the plugin would sync its own backups
    // and somebody's credentials.
    const overlaps = findRootOverlaps(deps, roots4({ syncDir: "/home/testuser" }));
    expect(overlaps.length).toBeGreaterThanOrEqual(3);
  });

  it("catches backupDir inside syncDir", () => {
    // The backups would live in the same tree they exist to survive.
    const overlaps = findRootOverlaps(
      deps,
      roots4({ backupDir: "/home/testuser/Dropbox/aiss/backups" }),
    );
    expect(overlaps).toHaveLength(1);
  });

  it("catches two roots that are the same directory", () => {
    const overlaps = findRootOverlaps(deps, roots4({ syncDir: "/home/testuser/vault" }));
    expect(overlaps[0]?.relation).toBe("same");
  });

  it("does not mistake a sibling prefix for containment", () => {
    // /home/testuser/vault-backup is not inside /home/testuser/vault, however
    // much startsWith would like it to be.
    expect(findRootOverlaps(deps, roots4({ syncDir: "/home/testuser/vault-backup" }))).toEqual([]);
  });

  it("honours the case-sensitivity probe", () => {
    const insensitive = { ...deps, caseSensitive: false };
    const args = roots4({ syncDir: "/home/testuser/VAULT/sync" });
    expect(findRootOverlaps(deps, args)).toEqual([]);
    expect(findRootOverlaps(insensitive, args)).toHaveLength(1);
  });
});

describe("containsPath", () => {
  it("treats a directory as containing itself", () => {
    expect(containsPath(deps, "/a/b", "/a/b")).toBe(true);
  });

  it("does not treat a parent as contained by its child", () => {
    expect(containsPath(deps, "/a/b/c", "/a/b")).toBe(false);
  });
});

describe("case-sensitivity probe", () => {
  it("reports what the filesystem actually does", async () => {
    const root = makeRoot();
    const sensitive = await probeCaseSensitivity(
      fs,
      root as SafeAbsolutePath,
      (...parts) => path.join(...parts),
      "abc123",
    );

    // Not asserted against the platform — that is the whole point. It is
    // asserted to be a definite answer, and to leave nothing behind.
    expect(typeof sensitive).toBe("boolean");
    expect(await fsp.readdir(root)).toEqual([]);
  });
});
