import { rmSync } from "node:fs";

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
