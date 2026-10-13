/**
 * This machine's memory of Claudian's records, for one pass (ADR-78).
 *
 * Two facts per file, and the rules for changing them:
 *
 * - **Witnessed** — this machine converged on the file: read it equal on both
 *   sides, or wrote it. Set only at the point the ledger's converged base is
 *   set, from the same hash. It is what makes "missing here" mean "removed
 *   here" rather than "not here yet".
 * - **Held** — the file is missing here, the sync folder has it, and it is
 *   being kept off this machine. Created only by the planner's verdict, and
 *   ended by exactly three things: the user asking for it back, the file
 *   reappearing here, or the sync folder losing it too. No timer.
 *
 * Mutable and in-memory; the pass runner loads it before the pass and saves
 * it after, and a dry run never saves.
 */
import type { ClaudianRecordEntry, ClaudianRecordsFile, HeldRecordEntry } from "../infra/home-store";
import type { HoldKind } from "../domain/deleted-here";
import { claudianRecordOf } from "../domain/deleted-here";
import { STATE_SCHEMA_VERSION } from "../infra/state-store";

/** Passes a file may be missing from a complete, READY sync folder before it is forgotten. */
export const GONE_FROM_REPLICA_PASSES = 2;

/** Passes a new deleted-here hold must last before the user is told (ADR-78 H7). */
export const ANNOUNCE_AFTER_PASSES = 2;

export interface ClaudianRecordsState {
  /** This machine has converged on the file and remembers it. */
  witnessed(rel: string): boolean;
  /** The hash it converged on, or null. */
  witnessedHash(rel: string): string | null;
  /** Converged now. Ends any hold: the file is here again. */
  witness(rel: string, hash: string): void;

  held(rel: string): HeldRecordEntry | null;
  /** Starts a hold. `witnessedHash` covers a witness only the ledger knew. */
  hold(
    rel: string,
    hold: {
      readonly kind: HoldKind;
      readonly nowMs: number;
      readonly replicaSize: number;
      readonly replicaMtimeMs: number;
      readonly replicaDigest: string | null;
    },
    witnessedHash: string,
  ): void;
  /**
   * Counts one more pass of an existing hold. True exactly once: the pass in
   * which a deleted-here hold first deserves to be announced.
   */
  continueHold(rel: string): boolean;
  /**
   * Records what the sync folder's copy of a held file looks like now. True
   * when its digest moved off a previous, readable one — another device
   * changed the conversation after it was deleted here.
   */
  updateHeldReplica(rel: string, size: number, mtimeMs: number, digest: string | null): boolean;
  release(rel: string): void;
  requestRelease(rel: string): boolean;

  /**
   * Ages every entry against what the sync folder held this pass.
   *
   * `complete` false — the walk could not list the claudian subtree, or the
   * folder is not READY — leaves every count as it is: a listing that failed
   * says nothing about what is missing from it.
   */
  endPass(input: { readonly replicaRels: ReadonlySet<string>; readonly complete: boolean }): void;

  entries(): ReadonlyArray<readonly [string, ClaudianRecordEntry]>;
  toFile(): ClaudianRecordsFile;
  changed(): boolean;
}

export function emptyClaudianRecords(): ClaudianRecordsFile {
  return { schemaVersion: STATE_SCHEMA_VERSION, records: {} };
}

/**
 * The first file on a machine that has none, from the observation ledger.
 *
 * Every record this machine has converged on since the ledger last forgot it
 * is in there, with the hash. Without this, upgrading would treat every
 * record deleted before the upgrade's first pass as never seen — and restore
 * it, once more, which is the bug being fixed.
 *
 * `.inputs.json` is never witnessed: it is never held either (ADR-78).
 */
export function seedClaudianRecords(
  local: Readonly<Record<string, { readonly lastConvergedHash?: string | null }>>,
): ClaudianRecordsFile {
  const records: Record<string, ClaudianRecordEntry> = {};
  for (const [rel, entry] of Object.entries(local)) {
    const record = claudianRecordOf(rel);
    if (record === null || record.kind === "inputs") continue;
    if (typeof entry.lastConvergedHash !== "string" || entry.lastConvergedHash.length === 0) continue;
    records[rel] = { witnessedHash: entry.lastConvergedHash, goneFromReplicaPasses: 0 };
  }
  return { schemaVersion: STATE_SCHEMA_VERSION, records };
}

export function createClaudianRecordsState(file: ClaudianRecordsFile): ClaudianRecordsState {
  const records = new Map<string, ClaudianRecordEntry>(Object.entries(file.records));
  let dirty = false;

  const set = (rel: string, entry: ClaudianRecordEntry) => {
    records.set(rel, entry);
    dirty = true;
  };
  const updateHold = (rel: string, patch: Partial<HeldRecordEntry>) => {
    const entry = records.get(rel);
    if (!entry?.hold) return;
    set(rel, { ...entry, hold: { ...entry.hold, ...patch } });
  };

  return {
    witnessed: (rel) => records.has(rel),
    witnessedHash: (rel) => records.get(rel)?.witnessedHash ?? null,

    witness(rel, hash) {
      const record = claudianRecordOf(rel);
      if (record === null || record.kind === "inputs") return;
      const entry = records.get(rel);
      if (entry && entry.witnessedHash === hash && entry.goneFromReplicaPasses === 0 && !entry.hold) return;
      set(rel, { witnessedHash: hash, goneFromReplicaPasses: 0 });
    },

    held: (rel) => records.get(rel)?.hold ?? null,

    hold(rel, hold, witnessedHash) {
      const entry = records.get(rel);
      set(rel, {
        witnessedHash: entry?.witnessedHash ?? witnessedHash,
        goneFromReplicaPasses: 0,
        hold: {
          kind: hold.kind,
          sinceMs: hold.nowMs,
          passes: 1,
          announced: false,
          replicaSize: hold.replicaSize,
          replicaMtimeMs: hold.replicaMtimeMs,
          replicaDigest: hold.replicaDigest,
          releaseRequested: false,
        },
      });
    },

    continueHold(rel) {
      const hold = records.get(rel)?.hold;
      if (!hold) return false;
      const passes = hold.passes + 1;
      const announce = hold.kind === "deleted-here" && !hold.announced && passes >= ANNOUNCE_AFTER_PASSES;
      updateHold(rel, { passes, ...(announce ? { announced: true } : {}) });
      return announce;
    },

    updateHeldReplica(rel, size, mtimeMs, digest) {
      const hold = records.get(rel)?.hold;
      if (!hold) return false;
      // An unreadable copy keeps the last readable digest, so the next
      // readable one is still compared against something the user saw.
      const nextDigest = digest ?? hold.replicaDigest;
      const moved = digest !== null && hold.replicaDigest !== null && digest !== hold.replicaDigest;
      updateHold(rel, { replicaSize: size, replicaMtimeMs: mtimeMs, replicaDigest: nextDigest });
      return moved;
    },

    release(rel) {
      const entry = records.get(rel);
      if (!entry?.hold) return;
      set(rel, { witnessedHash: entry.witnessedHash, goneFromReplicaPasses: entry.goneFromReplicaPasses });
    },

    requestRelease(rel) {
      const hold = records.get(rel)?.hold;
      if (!hold) return false;
      if (!hold.releaseRequested) updateHold(rel, { releaseRequested: true });
      return true;
    },

    endPass({ replicaRels, complete }) {
      if (!complete) return;
      for (const [rel, entry] of [...records]) {
        if (replicaRels.has(rel)) {
          if (entry.goneFromReplicaPasses !== 0) set(rel, { ...entry, goneFromReplicaPasses: 0 });
          continue;
        }
        const gone = entry.goneFromReplicaPasses + 1;
        if (gone >= GONE_FROM_REPLICA_PASSES) {
          records.delete(rel);
          dirty = true;
        } else {
          set(rel, { ...entry, goneFromReplicaPasses: gone });
        }
      }
    },

    entries: () => [...records],

    toFile: () => ({
      schemaVersion: STATE_SCHEMA_VERSION,
      records: Object.fromEntries([...records].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    }),

    changed: () => dirty,
  };
}
