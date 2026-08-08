import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Windows releases file handles lazily: an antivirus scanner or a child process
 * that exited milliseconds ago can still hold a directory open, and Node's
 * default `maxRetries: 0` turns that into an EBUSY/ENOTEMPTY that fails the
 * test rather than the flake it actually is.
 */
export const RM_OPTS = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const;

/**
 * Cleanup must never be the reason a suite goes red — a leftover temp directory
 * is noise, a false failure costs someone an investigation.
 */
export function removeTree(dir: string): void {
  try {
    rmSync(dir, RM_OPTS);
  } catch {
    // Best effort; the OS will reclaim the temp directory.
  }
}

/**
 * A temp directory, **realpath'd**.
 *
 * Every store in this plugin documents that its root must already be a
 * realpath, and `resolveUnderRoot` enforces it by refusing a path whose
 * resolved parent falls outside the root it was given. A raw `mkdtempSync`
 * breaks that on two of the three platforms and on neither of them obviously:
 * macOS hands back `/var/folders/...` for `/private/var/folders/...`, and
 * Windows hands back an 8.3 short name (`RUNNER~1` standing in for the real
 * directory name). Both then
 * fail as SYMLINK violations that look like a bug in the guard rather than in
 * the fixture — which is exactly how this cost a CI round once already.
 */
export function makeRealTmpDir(prefix: string): string {
  return realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)));
}
