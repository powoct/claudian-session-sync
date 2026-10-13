/**
 * This machine's memory of Claudian's records, for one pass (ADR-78).
 *
 * Two facts per file, and the rules for changing them:
 *
 * - **Witnessed** — this machine converged on the file: read it equal on both
 *   sides, or wrote it. Set only at the point the ledger's converged base is
 *   set, from the same hash. It is what makes "missing here" mean "removed
 *   here" rather than "not here yet", and it is never forgotten (see
 *   `ClaudianRecordEntry`).
 * - **Held** — the file is missing here, the sync folder has it, and it is
 *   being kept off this machine. Created only by the planner's verdict, and
 *   ended by exactly two things: the user asking for it back, or the file
 *   reappearing here. No timer, and not the sync folder losing it either — a
 *   peer that still has the conversation pushes it again the moment the
 *   folder lacks it, and a hold that had lapsed by then would let it in.
 *
 * Mutable and in-memory; loaded and saved inside the pass lock, and a dry run
 * never saves.
 */
import type { ClaudianRecordEntry, ClaudianRecordsFile, HeldRecordEntry } from "../infra/home-store";
import type { HoldKind } from "../domain/deleted-here";
import { claudianRecordOf } from "../domain/deleted-here";
import { STATE_SCHEMA_VERSION } from "../infra/state-store";

/** Passes a new deleted-here hold must last before the user is told (ADR-78 H7). */
export const ANNOUNCE_AFTER_PASSES = 2;

export interface ClaudianRecordsState {
  /** This machine has converged on the file and remembers it. */
  witnessed(rel: string): boolean;
  /** Converged now. Ends any hold: the file is here again. */
  witness(rel: string, hash: string): void;
  /** Landed these bytes because Claudian may have removed the record itself. */
  markRestoredForMissingHistory(rel: string, hash: string): void;
  /** True when the file still holds exactly the bytes so landed. */
  restoredForMissingHistory(rel: string, currentHash: string): boolean;

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
   * which a deleted-here hold first deserves to be announced. Stops counting
   * after that, so a hold that changes nothing does not rewrite the file.
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
   * Notes the store's identity. True when it differs from a known previous
   * one: the store was recreated, and absences this pass are not deletions.
   */
  observeStore(identity: string | null): boolean;

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
    records[rel] = { witnessedHash: entry.lastConvergedHash };
  }
  return { schemaVersion: STATE_SCHEMA_VERSION, records };
}

export function createClaudianRecordsState(file: ClaudianRecordsFile): ClaudianRecordsState {
  const records = new Map<string, ClaudianRecordEntry>(Object.entries(file.records));
  let storeIdentity = file.storeIdentity ?? null;
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

    witness(rel, hash) {
      const record = claudianRecordOf(rel);
      if (record === null || record.kind === "inputs") return;
      const entry = records.get(rel);
      if (entry && entry.witnessedHash === hash && !entry.hold) return;
      // The restore-once mark survives only while the bytes are the ones it
      // was made for; anything newer is a record the rule has not seen.
      const keep = entry?.restoredForMissingHistory === hash ? { restoredForMissingHistory: hash } : {};
      set(rel, { witnessedHash: hash, ...keep });
    },

    markRestoredForMissingHistory(rel, hash) {
      const entry = records.get(rel);
      set(rel, { witnessedHash: entry?.witnessedHash ?? hash, restoredForMissingHistory: hash });
    },

    restoredForMissingHistory: (rel, currentHash) =>
      currentHash !== "" && records.get(rel)?.restoredForMissingHistory === currentHash,

    held: (rel) => records.get(rel)?.hold ?? null,

    hold(rel, hold, witnessedHash) {
      const entry = records.get(rel);
      set(rel, {
        ...(entry ?? {}),
        witnessedHash: entry?.witnessedHash ?? witnessedHash,
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
      if (!hold || hold.passes >= ANNOUNCE_AFTER_PASSES) return false;
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
      const { hold: _released, ...rest } = entry;
      set(rel, rest);
    },

    requestRelease(rel) {
      const hold = records.get(rel)?.hold;
      if (!hold) return false;
      if (!hold.releaseRequested) updateHold(rel, { releaseRequested: true });
      return true;
    },

    observeStore(identity) {
      if (identity === null) return false;
      const recreated = storeIdentity !== null && storeIdentity !== identity;
      if (storeIdentity !== identity) {
        storeIdentity = identity;
        dirty = true;
      }
      return recreated;
    },

    entries: () => [...records],

    toFile: () => ({
      schemaVersion: STATE_SCHEMA_VERSION,
      ...(storeIdentity !== null ? { storeIdentity } : {}),
      records: Object.fromEntries([...records].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    }),

    changed: () => dirty,
  };
}
