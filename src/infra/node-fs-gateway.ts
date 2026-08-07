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
      // Node exposes no RENAME_NOREPLACE, so the closest portable equivalent is
      // a link + unlink pair: link() fails with EEXIST if the target exists,
      // which is the atomic "do not replace" this needs.
      try {
        await fsp.link(from, to);
        await fsp.unlink(from);
        return { ok: true, noReplaceEnforced: true };
      } catch (error) {
        const code = codeOf(error);
        if (code === "EEXIST") return { ok: false, reason: "target-exists", code };
        // Filesystems without hard links (some FAT/exFAT, some network mounts)
        // fall back to a plain rename. The caller's A8 check is then the only
        // guard, which the report flags as `noReplaceUnavailable`.
        if (code === "EPERM" || code === "ENOSYS" || code === "EXDEV" || code === "EMLINK") {
          try {
            await renameWithRetry(deps, from, to);
            return { ok: true, noReplaceEnforced: false };
          } catch (fallbackError) {
            return ioError(codeOf(fallbackError));
          }
        }
        return ioError(code);
      }
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

  try {
    await renameWithRetry(deps, tmp, target);
  } catch (error) {
    await fsp.unlink(tmp).catch(() => undefined);
    throw error;
  }

  if (shouldFsync && shouldFsyncDirectory(deps.platform)) {
    // Durability of the directory entry itself. Windows returns EPERM for this
    // (findings F-4), so it is skipped there rather than failing every write.
    const dirHandle = await fsp.open(directory, "r").catch(() => null);
    if (dirHandle) {
      await dirHandle.sync().catch(() => undefined);
      await dirHandle.close();
    }
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
