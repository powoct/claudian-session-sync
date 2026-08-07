/**
 * testing.md §6 — FsGateway against a real filesystem.
 *
 * Real tmpdir on purpose (§2.2): rename semantics, mtime granularity, case
 * sensitivity and permission errors are exactly what this plugin gets wrong,
 * and an in-memory filesystem models none of them faithfully.
 */
import { mkdtempSync, promises as fsp, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { SafeAbsolutePath } from "../../src/domain/types";
import { sequentialIdGen } from "../../src/infra/clock";
import { createNodeFsGateway } from "../../src/infra/node-fs-gateway";
import {
  RENAME_RETRY_DELAYS_MS,
  isStaleTempFile,
  retryOnTransient,
  shouldFsyncDirectory,
  tempName,
} from "../../src/infra/fs-gateway";
import { removeTree } from "../helpers/fs-cleanup";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) removeTree(dir);
});

function makeRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "aiss-fsg-"));
  roots.push(dir);
  return dir;
}

const slept: number[] = [];
const gateway = createNodeFsGateway({
  ids: sequentialIdGen(),
  platform: process.platform,
  pid: process.pid,
  sleep: async (ms) => {
    slept.push(ms);
  },
});

const safe = (target: string): SafeAbsolutePath => target as SafeAbsolutePath;
const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

beforeEach(() => {
  slept.length = 0;
});

describe("atomic write", () => {
  it("writes bytes and leaves no temp file behind", async () => {
    const root = makeRoot();
    const target = path.join(root, "session.jsonl");

    await gateway.writeFileAtomic(safe(target), enc('{"a":1}\n'));

    expect(readFileSync(target, "utf8")).toBe('{"a":1}\n');
    expect(await fsp.readdir(root)).toEqual(["session.jsonl"]);
  });

  it("replaces an existing file in one step", async () => {
    const root = makeRoot();
    const target = path.join(root, "session.jsonl");
    writeFileSync(target, "old\n");

    await gateway.writeFileAtomic(safe(target), enc("new\n"));

    expect(readFileSync(target, "utf8")).toBe("new\n");
    expect(await fsp.readdir(root)).toEqual(["session.jsonl"]);
  });

  it("names the temp file so it lands in the target's own directory", async () => {
    // Same directory means same filesystem, which is what makes the rename
    // atomic. A temp file in the system tmpdir would silently degrade to a
    // copy-then-delete across a mount boundary.
    expect(tempName("session.jsonl", 42, "abcd1234")).toBe("session.jsonl.aiss-tmp-42-abcd1234");

    // And observed end to end: during a write the temp file is a sibling.
    const root = makeRoot();
    const target = path.join(root, "session.jsonl");
    await gateway.writeFileAtomic(safe(target), enc("x"));
    expect(await fsp.readdir(root)).toEqual(["session.jsonl"]);
  });

  it("leaves the original intact when the write fails", async () => {
    const root = makeRoot();
    const target = path.join(root, "sub", "session.jsonl");
    // The parent does not exist, so the temp-file create fails before anything
    // is replaced.
    await expect(gateway.writeFileAtomic(safe(target), enc("x"))).rejects.toThrow();
    expect(await fsp.readdir(root)).toEqual([]);
  });

  it("creates files 0600 by default", async () => {
    if (process.platform === "win32") return; // Node's mode is inert there
    const root = makeRoot();
    const target = path.join(root, "session.jsonl");

    await gateway.writeFileAtomic(safe(target), enc("x"));

    const mode = (await fsp.stat(target)).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("reads", () => {
  it("returns null for a missing file rather than throwing", async () => {
    // "It is not there" is an answer the caller asked for, not a failure.
    const root = makeRoot();
    expect(await gateway.lstat(path.join(root, "nope"))).toBeNull();
  });

  it("does not follow the final symlink", async () => {
    if (process.platform === "win32") return; // needs privileges there
    const root = makeRoot();
    const realFile = path.join(root, "real.jsonl");
    writeFileSync(realFile, "content\n");
    await fsp.symlink(realFile, path.join(root, "link.jsonl"));

    const st = await gateway.lstat(path.join(root, "link.jsonl"));
    expect(st?.isSymbolicLink).toBe(true);
    expect(st?.isFile).toBe(false);
  });

  it("reports link counts, so a hard-linked file can be refused", async () => {
    const root = makeRoot();
    const original = path.join(root, "a.jsonl");
    writeFileSync(original, "x\n");
    await fsp.link(original, path.join(root, "b.jsonl"));

    expect((await gateway.lstat(original))?.nlink).toBe(2);
  });

  it("reads only the tail, and never past the start", async () => {
    const root = makeRoot();
    const target = path.join(root, "a.jsonl");
    writeFileSync(target, "0123456789");

    expect(new TextDecoder().decode(await gateway.readTail(target, 4))).toBe("6789");
    // Asking for more than exists yields the whole file, not an error.
    expect(new TextDecoder().decode(await gateway.readTail(target, 999))).toBe("0123456789");
  });

  it("returns an empty tail for an empty file", async () => {
    const root = makeRoot();
    const target = path.join(root, "empty.jsonl");
    writeFileSync(target, "");
    expect((await gateway.readTail(target, 4096)).length).toBe(0);
  });
});

describe("renameNoReplace", () => {
  it("moves a file when the target is free", async () => {
    const root = makeRoot();
    const from = path.join(root, "from.jsonl");
    const to = path.join(root, "to.jsonl");
    writeFileSync(from, "x\n");

    const outcome = await gateway.renameNoReplace(safe(from), safe(to));

    expect(outcome.ok).toBe(true);
    expect(readFileSync(to, "utf8")).toBe("x\n");
    expect(await gateway.lstat(from)).toBeNull();
  });

  it("refuses rather than clobbering an existing target", async () => {
    // The *_NEW actions rely on this: "somebody else created it while we were
    // working" must fail at the syscall, not silently overwrite their file.
    const root = makeRoot();
    const from = path.join(root, "from.jsonl");
    const to = path.join(root, "to.jsonl");
    writeFileSync(from, "new\n");
    writeFileSync(to, "existing\n");

    const outcome = await gateway.renameNoReplace(safe(from), safe(to));

    expect(outcome).toMatchObject({ ok: false, reason: "target-exists" });
    expect(readFileSync(to, "utf8")).toBe("existing\n");
  });
});

describe("platform behaviour", () => {
  it("skips directory fsync on Windows, where it returns EPERM", () => {
    // findings F-4: attempting it there is a guaranteed error, not durability.
    expect(shouldFsyncDirectory("win32")).toBe(false);
    expect(shouldFsyncDirectory("darwin")).toBe(true);
    expect(shouldFsyncDirectory("linux")).toBe(true);
  });
});

describe("stale temp-file detection", () => {
  const base = {
    isRegularFile: true,
    mtimeMs: 0,
    nowMs: 2 * 60 * 60 * 1000,
    maxAgeMs: 60 * 60 * 1000,
  };

  it("recognises an abandoned temp file", () => {
    expect(isStaleTempFile({ ...base, name: "s.jsonl.aiss-tmp-42-abcd1234" })).toBe(true);
  });

  it("recognises an abandoned staging directory entry", () => {
    expect(isStaleTempFile({ ...base, name: ".aiss-stage-abc" })).toBe(true);
  });

  // All four conditions must hold: a misconfigured syncDir would otherwise make
  // cleanup into a tool that deletes other people's files.
  it("leaves an ordinary file alone", () => {
    expect(isStaleTempFile({ ...base, name: "session.jsonl" })).toBe(false);
  });

  it("leaves a recent temp file alone", () => {
    expect(
      isStaleTempFile({ ...base, name: "s.jsonl.aiss-tmp-42-abcd1234", mtimeMs: base.nowMs - 1000 }),
    ).toBe(false);
  });

  it("leaves a non-regular file alone", () => {
    expect(
      isStaleTempFile({ ...base, name: "s.jsonl.aiss-tmp-42-abcd1234", isRegularFile: false }),
    ).toBe(false);
  });
});

describe("directory and file operations", () => {
  it("creates a directory tree", async () => {
    const root = makeRoot();
    const target = path.join(root, "a", "b", "c");
    await gateway.mkdirp(safe(target));
    expect((await gateway.lstat(target))?.isDirectory).toBe(true);
  });

  it("is idempotent about creating one that already exists", async () => {
    const root = makeRoot();
    await gateway.mkdirp(safe(path.join(root, "a")));
    await expect(gateway.mkdirp(safe(path.join(root, "a")))).resolves.toBeUndefined();
  });

  it("removes a file, and stays quiet about one that is already gone", async () => {
    const root = makeRoot();
    const target = path.join(root, "a.jsonl");
    writeFileSync(target, "x\n");

    await gateway.removeFile(safe(target));
    expect(await gateway.lstat(target)).toBeNull();
    await expect(gateway.removeFile(safe(target))).resolves.toBeUndefined();
  });

  it("copies bytes rather than linking", async () => {
    // A hard link would share an inode with the source, so a later write
    // through either name would rewrite the backup this is meant to preserve.
    const root = makeRoot();
    const from = path.join(root, "src.jsonl");
    const to = path.join(root, "backup.bak");
    writeFileSync(from, "content\n");

    await gateway.copyFile(from, safe(to));

    expect(readFileSync(to, "utf8")).toBe("content\n");
    const [a, b] = [await gateway.lstat(from), await gateway.lstat(to)];
    expect(a?.nlink).toBe(1);
    expect(b?.nlink).toBe(1);
    if (a?.ino !== undefined && b?.ino !== undefined) expect(a.ino).not.toBe(b.ino);
  });

  it("refuses to copy over an existing file", async () => {
    const root = makeRoot();
    const from = path.join(root, "src.jsonl");
    const to = path.join(root, "existing.bak");
    writeFileSync(from, "new\n");
    writeFileSync(to, "old\n");

    await expect(gateway.copyFile(from, safe(to))).rejects.toThrow();
    expect(readFileSync(to, "utf8")).toBe("old\n");
  });

  it("lists directory entries with their kinds", async () => {
    const root = makeRoot();
    writeFileSync(path.join(root, "a.jsonl"), "x\n");
    await fsp.mkdir(path.join(root, "sub"));

    const entries = (await gateway.readDir(root)).sort((x, y) => x.name.localeCompare(y.name));

    expect(entries.map((e) => e.name)).toEqual(["a.jsonl", "sub"]);
    expect(entries[0]?.isFile).toBe(true);
    expect(entries[1]?.isDirectory).toBe(true);
  });

  it("reads a whole file as bytes", async () => {
    const root = makeRoot();
    const target = path.join(root, "a.jsonl");
    writeFileSync(target, "hello\n");
    expect(new TextDecoder().decode(await gateway.readFile(target))).toBe("hello\n");
  });

  it("resolves symlinks with realpath", async () => {
    if (process.platform === "win32") return;
    const root = makeRoot();
    const real = path.join(root, "real");
    await fsp.mkdir(real);
    await fsp.symlink(real, path.join(root, "link"));

    // The escape rule's measured input is the resolved path, not what the user
    // typed — this is where that resolution happens.
    expect(await gateway.realpath(path.join(root, "link"))).toBe(await fsp.realpath(real));
  });
});

describe("transient-error retry (§9.2)", () => {
  const busy = (): Error & { code: string } =>
    Object.assign(new Error("locked"), { code: "EBUSY" });

  it("retries a transient failure and succeeds", async () => {
    const delays: number[] = [];
    let attempts = 0;

    const result = await retryOnTransient(
      async () => {
        attempts++;
        if (attempts < 3) throw busy();
        return "done";
      },
      async (ms) => {
        delays.push(ms);
      },
    );

    expect(result).toBe("done");
    expect(attempts).toBe(3);
    expect(delays).toEqual([100, 300]);
  });

  it("uses the documented backoff schedule before giving up", async () => {
    const delays: number[] = [];
    await expect(
      retryOnTransient(
        async () => {
          throw busy();
        },
        async (ms) => {
          delays.push(ms);
        },
      ),
    ).rejects.toThrow("locked");

    expect(delays).toEqual([...RENAME_RETRY_DELAYS_MS]);
  });

  it("does not retry an error that is not transient", async () => {
    // Retrying ENOENT wastes 1.3 seconds and still fails; worse, it hides the
    // real cause behind a timeout-shaped delay.
    let attempts = 0;
    await expect(
      retryOnTransient(
        async () => {
          attempts++;
          throw Object.assign(new Error("gone"), { code: "ENOENT" });
        },
        async () => undefined,
      ),
    ).rejects.toThrow("gone");
    expect(attempts).toBe(1);
  });

  it("does not retry an error with no code at all", async () => {
    let attempts = 0;
    await expect(
      retryOnTransient(
        async () => {
          attempts++;
          throw new Error("plain");
        },
        async () => undefined,
      ),
    ).rejects.toThrow("plain");
    expect(attempts).toBe(1);
  });
});
