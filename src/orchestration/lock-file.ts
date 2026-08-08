/**
 * The `PassLock` of §7.4 R-09/R-10, on a real file.
 *
 * `lock.ts` decides; this puts the decision on disk. The split is worth it
 * because the interesting rules — a stale lock must be stealable, and stealing
 * must invalidate the previous holder's writes — are pure and exhaustively
 * testable, while the part that needs a filesystem is short.
 *
 * The lock is advisory and stays advisory. What it buys is that two Obsidian
 * windows on the same vault do not routinely trip over each other; what it
 * cannot buy is mutual exclusion against a process that ignores it. The write
 * path is safe without it — verified overwrite plus backup-before-overwrite are
 * the real guarantees — so this may fail open, and does.
 */
import type { FsGateway } from "../infra/fs-gateway";
import type { HomeStore } from "../infra/home-store";
import { readJson, writeJson } from "../infra/json-file";
import {
  type LockFile,
  STALE_AFTER_MS,
  decideAcquire,
  heartbeat,
  mayWrite as mayWriteAgainst,
  parseLockFile,
} from "./lock";
import type { PassLock } from "./sync-engine";

export interface LockFileDeps {
  readonly fs: FsGateway;
  readonly home: HomeStore;
  readonly workspaceId: string;
  readonly machineId: string;
  readonly pid: number;
  readonly nowMs: () => number;
  /** True when this instance already has a pass in flight (§7.4 R-09). */
  readonly inProcessBusy: () => boolean;
  readonly onAcquired: () => void;
  readonly onReleased: () => void;
}

/**
 * Refresh the heartbeat once a third of the stale window has passed.
 *
 * There is no timer: `mayWrite` runs immediately before every write, which is
 * where a long pass naturally checks in. A pass that spends more than
 * `STALE_AFTER_MS` reading without writing can still be judged stale by another
 * instance — and that is handled rather than prevented, because the takeover
 * bumps the epoch and this pass's next `mayWrite` returns false. It loses a
 * pass; it does not collide.
 */
const HEARTBEAT_AFTER_MS = STALE_AFTER_MS / 3;

export function createFileLock(deps: LockFileDeps): PassLock {
  const path = deps.home.layout.lockFile(deps.workspaceId);
  let held: LockFile | null = null;
  let lastBeatMs = 0;

  /**
   * Reads the lock, keeping "there is no file" apart from "the file says
   * nothing usable".
   *
   * Both mean nobody holds a claim we can verify — but only the first permits
   * an exclusive create. Collapsing them makes a corrupt lock permanent: the
   * exclusive write fails against the very file we decided to ignore, the
   * acquisition reports LOCK_HELD, and the plugin never syncs again until a
   * human finds and deletes it. Which is precisely the outcome `parseLockFile`
   * treating garbage as "unheld" exists to avoid.
   */
  async function read(): Promise<
    { kind: "absent" } | { kind: "corrupt" } | { kind: "held"; lock: LockFile }
  > {
    const load = await readJson(deps.fs, path);
    if (load.status === "absent") return { kind: "absent" };
    if (load.status === "unusable") return { kind: "corrupt" };
    const lock = parseLockFile(load.raw);
    return lock === null ? { kind: "corrupt" } : { kind: "held", lock };
  }

  async function currentLock(): Promise<LockFile | null> {
    const state = await read();
    return state.kind === "held" ? state.lock : null;
  }

  async function put(lock: LockFile, exclusive: boolean): Promise<boolean> {
    const file = deps.home.mint(path);
    const dir = deps.home.mint(deps.home.layout.locksDir);
    if (!file.ok || !dir.ok) return false;
    await deps.fs.mkdirp(dir.value);
    if (!exclusive) {
      await writeJson(deps.fs, file.value, lock, dir.value);
      return true;
    }
    // Nobody held it a moment ago, so creating exclusively is what makes "we
    // both read an empty lock" resolve to one winner instead of two.
    const bytes = new TextEncoder().encode(`${JSON.stringify(lock, null, 2)}\n`);
    const outcome = await deps.fs.writeFileNoReplace(file.value, bytes);
    return outcome.ok;
  }

  return {
    async acquire() {
      if (deps.inProcessBusy()) return { ok: false, reason: "ALREADY_RUNNING" };

      const existing = await read();
      const outcome = decideAcquire({
        existing: existing.kind === "held" ? existing.lock : null,
        nowMs: deps.nowMs(),
        pid: deps.pid,
        machineId: deps.machineId,
        inProcessBusy: false,
      });
      if (!outcome.ok) return { ok: false, reason: outcome.reason };

      // Exclusive only when there was genuinely no file. Overwriting a corrupt
      // one is safe for the same reason stealing a stale one is: the epoch
      // re-check before every write is what makes any takeover recoverable.
      const written = await put(outcome.lock, existing.kind === "absent");
      if (!written) return { ok: false, reason: "LOCK_HELD" };

      held = outcome.lock;
      lastBeatMs = deps.nowMs();
      deps.onAcquired();
      return { ok: true };
    },

    async mayWrite() {
      if (held === null) return false;
      if (!mayWriteAgainst(held, await currentLock())) return false;

      const now = deps.nowMs();
      if (now - lastBeatMs >= HEARTBEAT_AFTER_MS) {
        const refreshed = heartbeat(held, now);
        if (await put(refreshed, false)) {
          held = refreshed;
          lastBeatMs = now;
        }
      }
      return true;
    },

    async release() {
      const mine = held;
      held = null;
      deps.onReleased();
      if (mine === null) return;

      // Only remove a lock that is still ours. Deleting one that was stolen
      // would hand a third instance a free acquisition while the thief is
      // mid-write.
      if (!mayWriteAgainst(mine, await currentLock())) return;
      const file = deps.home.mint(path);
      if (file.ok) await deps.fs.removeFile(file.value).catch(() => undefined);
    },
  };
}
