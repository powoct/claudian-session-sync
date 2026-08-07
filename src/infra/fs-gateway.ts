/**
 * Every filesystem access in this plugin goes through here (architecture §4.1).
 *
 * Two reasons, both load-bearing:
 *
 *  - **The write methods only accept `SafeAbsolutePath`.** That branded type can
 *    only be produced by PathGuard, after realpath and containment checks, so
 *    "forgot to validate this path" is a compile error rather than a hole. Read
 *    methods take plain strings: reading is how validation itself is performed,
 *    and requiring a validated path to validate a path is circular.
 *  - **It can be decorated to record every call**, which is what the
 *    out-of-scope-IO assertion (invariant I4) and the dry-run no-write
 *    assertion are built on.
 */
import type { SafeAbsolutePath } from "../domain/types";

/** Just enough of `fs.Stats` for the decisions this plugin makes. */
export interface FileStat {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  /** Absent on some Windows filesystems; excluded from comparison when absent. */
  readonly ino: number | undefined;
  readonly nlink: number;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
}

export interface DirEntry {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
}

/** An error the gateway is willing to surface as a value rather than a throw. */
export interface FsError extends Error {
  readonly code?: string;
}

export interface FsGateway {
  // ── read side: plain strings, because validation is what reading is for ──

  /** `lstat`, never following the final symlink. Null on ENOENT. */
  lstat(path: string): Promise<FileStat | null>;
  /** Resolves symlinks. Throws on ENOENT — callers check existence first. */
  realpath(path: string): Promise<string>;
  readDir(path: string): Promise<DirEntry[]>;
  readFile(path: string): Promise<Uint8Array>;
  /** Last `min(size, n)` bytes, for the E0 tail hash without reading it all. */
  readTail(path: string, n: number): Promise<Uint8Array>;

  // ── write side: validated paths only ──

  /**
   * Writes atomically: exclusive temp file in the same directory, fsync, rename.
   *
   * Same directory means same filesystem, which is what makes the rename atomic.
   * A failure never degrades to "delete then write" — that leaves a window in
   * which a crash loses the file outright.
   */
  writeFileAtomic(path: SafeAbsolutePath, bytes: Uint8Array, options?: WriteOptions): Promise<void>;
  mkdirp(path: SafeAbsolutePath, mode?: number): Promise<void>;
  removeFile(path: SafeAbsolutePath): Promise<void>;
  /** Copies bytes, never links: a hard link would share an inode with the source. */
  copyFile(from: string, to: SafeAbsolutePath, mode?: number): Promise<void>;
  /** Renames without replacing an existing target, when the platform can. */
  renameNoReplace(from: SafeAbsolutePath, to: SafeAbsolutePath): Promise<RenameOutcome>;
}

export interface WriteOptions {
  /** Defaults to 0o600. Ignored on Windows, where Node's mode is inert. */
  readonly mode?: number;
  /** Defaults to true. */
  readonly fsync?: boolean;
}

export type RenameOutcome =
  | { readonly ok: true; readonly noReplaceEnforced: boolean }
  | { readonly ok: false; readonly reason: "target-exists" | "io-error"; readonly code?: string };

/** Windows retry schedule for EPERM/EBUSY (architecture §9.2). */
export const RENAME_RETRY_DELAYS_MS = [100, 300, 900] as const;

/** Errors worth retrying: another process has the file open, briefly. */
export const RETRYABLE_CODES = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]);

/**
 * Should a directory fsync be attempted on this platform?
 *
 * Measured (findings F-4): Windows returns EPERM for fsync on a directory
 * handle, so attempting it there produces a guaranteed error rather than a
 * durability guarantee.
 */
export function shouldFsyncDirectory(platform: string): boolean {
  return platform !== "win32";
}

/** `<name>.aiss-tmp-<pid>-<rand>`, alongside the target so the rename stays atomic. */
export function tempName(finalName: string, pid: number, token: string): string {
  return `${finalName}.aiss-tmp-${pid}-${token}`;
}

/**
 * Retries an operation on the transient errors Windows raises when another
 * process briefly holds a file open (architecture §9.2).
 *
 * Extracted and exported so the schedule can be tested directly: the failure
 * that matters is retrying something that is *not* transient, or giving up
 * before the last delay, and neither is reachable through a real filesystem on
 * a platform that does not produce EPERM on rename.
 *
 * Never falls back to a less safe operation. Exhausting the retries means the
 * error propagates — degrading to delete-then-write would turn a locked file
 * into a lost one.
 */
export async function retryOnTransient<T>(
  operation: () => Promise<T>,
  sleep: (ms: number) => Promise<void>,
  delays: readonly number[] = RENAME_RETRY_DELAYS_MS,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code: unknown }).code)
          : undefined;
      if (code === undefined || !RETRYABLE_CODES.has(code)) throw error;
      const delay = delays[attempt];
      if (delay === undefined) break;
      await sleep(delay);
    }
  }
  throw lastError;
}

/**
 * Is this a stale temp file left by an interrupted pass?
 *
 * All four conditions must hold before anything is deleted (§9.7.7). A
 * misconfigured sync directory would otherwise turn cleanup into a tool that
 * deletes somebody else's files.
 */
export function isStaleTempFile(input: {
  readonly name: string;
  readonly isRegularFile: boolean;
  readonly mtimeMs: number;
  readonly nowMs: number;
  readonly maxAgeMs: number;
}): boolean {
  const matchesPattern = /\.aiss-tmp-\d+-[0-9a-f]+$/.test(input.name) || /^\.aiss-stage-/.test(input.name);
  return (
    matchesPattern && input.isRegularFile && input.nowMs - input.mtimeMs > input.maxAgeMs
  );
}
