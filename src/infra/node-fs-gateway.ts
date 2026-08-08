/**
 * The real FsGateway, on Node.
 *
 * Everything interesting here is about failure: which errors are values, which
 * are retried, and which must never be "handled" by falling back to something
 * less safe. The recurring rule is that a write never degrades — if the atomic
 * path cannot be taken, the operation fails and is reported, because the
 * alternative (delete then write) turns a transient error into a lost file.
 */
import { constants as fsConstants, promises as fsp, realpath as realpathCallback } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";
import type { SafeAbsolutePath } from "../domain/types";
import type { IdGen } from "./clock";
import {
  type DirEntry,
  type FileStat,
  type FsGateway,
  retryOnTransient,
  type RenameOutcome,
  type WriteOptions,
  type WriteOutcome,
  shouldFsyncDirectory,
  tempName,
} from "./fs-gateway";

const DEFAULT_FILE_MODE = 0o600;
const DEFAULT_DIR_MODE = 0o700;

export interface NodeFsGatewayDeps {
  readonly ids: IdGen;
  readonly platform: string;
  readonly pid: number;
  /** Injected so retry tests do not actually wait 1.3 seconds. */
  readonly sleep: (ms: number) => Promise<void>;
}

export function createNodeFsGateway(deps: NodeFsGatewayDeps): FsGateway {
  return {
    async lstat(target) {
      try {
        const st = await fsp.lstat(target, { bigint: false });
        return toFileStat(st);
      } catch (error) {
        // ENOENT is an answer, not a failure: "it is not there" is exactly what
        // the caller asked. Everything else is a real problem and propagates.
        if (codeOf(error) === "ENOENT") return null;
        throw error;
      }
    },

    async realpath(target) {
      // `.native` matters: the escape rule's measured input is the OS's own
      // resolution, including the drive-letter casing Windows normalises to.
      // The promises API has no native variant, so the callback one is wrapped.
      return realpathNative(target);
    },

    async readDir(target) {
      const entries = await fsp.readdir(target, { withFileTypes: true });
      return entries.map(
        (entry): DirEntry => ({
          name: entry.name,
          isFile: entry.isFile(),
          isDirectory: entry.isDirectory(),
          isSymbolicLink: entry.isSymbolicLink(),
        }),
      );
    },

    async readFile(target) {
      return new Uint8Array(await fsp.readFile(target));
    },

    async readTail(target, n) {
      // Opened once and stat'd through the descriptor, so the size used for the
      // offset belongs to the same file the bytes come from.
      const handle = await fsp.open(target, "r");
      try {
        const { size } = await handle.stat();
        const length = Math.min(size, n);
        if (length <= 0) return new Uint8Array(0);
        const buffer = new Uint8Array(length);
        await handle.read(buffer, 0, length, size - length);
        return buffer;
      } finally {
        await handle.close();
      }
    },

    async writeFileAtomic(target, bytes, options) {
      await writeAtomic(deps, target, bytes, options);
    },

    async writeFileNoReplace(target, bytes, options) {
      return writeNoReplace(deps, target, bytes, options);
    },

    async mkdirp(target, mode = DEFAULT_DIR_MODE) {
      await fsp.mkdir(target, { recursive: true, mode });
    },

    async removeFile(target) {
      try {
        await fsp.unlink(target);
      } catch (error) {
        if (codeOf(error) !== "ENOENT") throw error;
      }
    },

    async copyFile(from, to, mode = DEFAULT_FILE_MODE) {
      // COPYFILE_EXCL: refuse rather than clobber. The caller picked a name it
      // believes is free, and being wrong about that is worth knowing.
      await fsp.copyFile(from, to, fsConstants.COPYFILE_EXCL);
      if (shouldApplyMode(deps.platform)) await fsp.chmod(to, mode);
    },

    async renameNoReplace(from, to) {
      return linkOrRename(deps, from, to);
    },
  };
}

/** `exactOptionalPropertyTypes` forbids an explicit `code: undefined`. */
function ioError(code: string | undefined): RenameOutcome {
  return code === undefined
    ? { ok: false, reason: "io-error" }
    : { ok: false, reason: "io-error", code };
}

const realpathNative = promisify(realpathCallback.native) as (target: string) => Promise<string>;

async function writeAtomic(
  deps: NodeFsGatewayDeps,
  target: SafeAbsolutePath,
  bytes: Uint8Array,
  options: WriteOptions | undefined,
): Promise<void> {
  const tmp = await stageTemp(deps, target, bytes, options);
  try {
    await renameWithRetry(deps, tmp, target);
  } catch (error) {
    await fsp.unlink(tmp).catch(() => undefined);
    throw error;
  }
  await fsyncDirectoryOf(deps, target, options);
}

/**
 * The same staged write, committed with a rename that will not replace.
 *
 * Splitting the commit out rather than adding a flag inside `writeAtomic`
 * keeps the two failure shapes apart: this one has an outcome that is neither
 * success nor error — "somebody else got there first" — and folding that into
 * a throw would push the caller towards a catch-all.
 *
 * The temp file is removed on every non-success path. Leaving it behind would
 * be harmless (the stale-temp sweeper collects it) but it would also mean a
 * losing race leaks a file per pass for as long as the race persists.
 */
async function writeNoReplace(
  deps: NodeFsGatewayDeps,
  target: SafeAbsolutePath,
  bytes: Uint8Array,
  options: WriteOptions | undefined,
): Promise<WriteOutcome> {
  const tmp = await stageTemp(deps, target, bytes, options);
  const outcome = await linkOrRename(deps, tmp, target);
  if (!outcome.ok) {
    await fsp.unlink(tmp).catch(() => undefined);
    return outcome;
  }
  await fsyncDirectoryOf(deps, target, options);
  return outcome;
}

/**
 * Writes the bytes to an exclusive temp file beside the target and returns it.
 *
 * Beside, because same directory means same filesystem, which is what makes
 * the commit a rename rather than a copy.
 */
async function stageTemp(
  deps: NodeFsGatewayDeps,
  target: SafeAbsolutePath,
  bytes: Uint8Array,
  options: WriteOptions | undefined,
): Promise<string> {
  const mode = options?.mode ?? DEFAULT_FILE_MODE;
  const shouldFsync = options?.fsync ?? true;
  const directory = path.dirname(target);
  const tmp = path.join(directory, tempName(path.basename(target), deps.pid, deps.ids.token(4)));

  // "wx" — exclusive create. If the name is somehow taken, that is a collision
  // worth failing on, not one to write through.
  const handle = await fsp.open(tmp, "wx", mode);
  try {
    await handle.write(bytes);
    if (shouldFsync) await handle.sync();
  } catch (error) {
    await handle.close();
    await fsp.unlink(tmp).catch(() => undefined);
    throw error;
  }
  await handle.close();
  return tmp;
}

async function fsyncDirectoryOf(
  deps: NodeFsGatewayDeps,
  target: string,
  options: WriteOptions | undefined,
): Promise<void> {
  if ((options?.fsync ?? true) === false) return;
  if (!shouldFsyncDirectory(deps.platform)) return;
  // Durability of the directory entry itself. Windows returns EPERM for this
  // (findings F-4), so it is skipped there rather than failing every write.
  const dirHandle = await fsp.open(path.dirname(target), "r").catch(() => null);
  if (!dirHandle) return;
  await dirHandle.sync().catch(() => undefined);
  await dirHandle.close();
}

/**
 * Moves `from` onto `to` without replacing an existing `to`.
 *
 * Node exposes no `RENAME_NOREPLACE`, so the closest portable equivalent is a
 * link + unlink pair: `link()` fails with EEXIST if the target exists, which
 * is the atomic "do not replace" this needs.
 */
async function linkOrRename(
  deps: NodeFsGatewayDeps,
  from: string,
  to: string,
): Promise<RenameOutcome> {
  try {
    await fsp.link(from, to);
    await fsp.unlink(from);
    return { ok: true, noReplaceEnforced: true };
  } catch (error) {
    const code = codeOf(error);
    if (code === "EEXIST") return { ok: false, reason: "target-exists", code };
    // Filesystems without hard links (some FAT/exFAT, some network mounts)
    // fall back to a plain rename, which *does* replace. A non-atomic
    // existence check first is not a guarantee, but the alternative on those
    // filesystems is no check at all — and this is the branch where a `*_NEW`
    // write could otherwise land on a file that appeared since the last look.
    // `noReplaceEnforced: false` tells the caller the difference.
    if (code === "EPERM" || code === "ENOSYS" || code === "EXDEV" || code === "EMLINK") {
      if ((await fsp.lstat(to).catch(() => null)) !== null) {
        return { ok: false, reason: "target-exists" };
      }
      try {
        await renameWithRetry(deps, from, to);
        return { ok: true, noReplaceEnforced: false };
      } catch (fallbackError) {
        return ioError(codeOf(fallbackError));
      }
    }
    return ioError(code);
  }
}

/** Rename with the shared transient-error backoff. Never unlink-then-rename. */
async function renameWithRetry(deps: NodeFsGatewayDeps, from: string, to: string): Promise<void> {
  await retryOnTransient(() => fsp.rename(from, to), deps.sleep);
}

function toFileStat(st: {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
  nlink: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): FileStat {
  return {
    size: st.size,
    mtimeMs: st.mtimeMs,
    ctimeMs: st.ctimeMs,
    // Windows reports 0 for inodes it cannot supply; treat that as absent
    // rather than as a real value that would compare equal across files.
    ino: st.ino === 0 ? undefined : st.ino,
    nlink: st.nlink,
    isFile: st.isFile(),
    isDirectory: st.isDirectory(),
    isSymbolicLink: st.isSymbolicLink(),
  };
}

/** Node's mode is inert on Windows; setting it there promises something false. */
function shouldApplyMode(platform: string): boolean {
  return platform !== "win32";
}

function codeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}
