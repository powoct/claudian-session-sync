/**
 * The engine's two state views, over the files that actually hold them.
 *
 * `SyncEngine` asks for a `LedgerView` and an `EvidenceCache`; those are
 * synchronous, because a decision loop that awaits a lookup per file is a
 * decision loop with a race in it. So a pass loads both stores up front,
 * mutates them in memory, and writes them back at commit — which is also what
 * makes a crash mid-pass leave the previous pass's state intact (§7.1 P8).
 *
 * The two views are kept apart because their provenance is (review/2 §3.2):
 *
 *  - the **ledger** is what this machine watched happen — signatures, quiet
 *    windows, streaks. Nothing in it has crossed a network;
 *  - the **evidence cache** is content facts remembered from full reads, whose
 *    remote half lives in the sync directory and is written by other machines.
 *
 * They are both allowed to be wrong. The ledger being wrong costs a slow pass;
 * the cache being wrong costs a missed one. Neither can cost a write, and that
 * is the property the rest of the design rests on.
 */
import type { CachedContentFacts, Manifest, ManifestEntry } from "../domain/manifest";
import { isValidEntryKey, scrubTrigger } from "../domain/manifest";
import { signaturesEqual } from "../domain/stability";
import type { LedgerEntryRecord, ObservationsFile } from "../infra/state-store";
import type { EvidenceCache, LedgerEntryView, LedgerView } from "./sync-engine";

/** A ledger and manifest a pass can mutate, then hand back for commit. */
export interface PassState {
  readonly ledger: LedgerView;
  readonly evidence: EvidenceCache;
  /** The observations to write at P8, including this pass's changes. */
  observations(): ObservationsFile;
  /** The manifest to write at P8, or null when it must not be rewritten. */
  manifest(): Manifest | null;
  /**
   * Did this pass change any entry? A pass that verified files and found them
   * exactly as remembered has nothing to say, and saying it anyway — a fresh
   * `updatedAt`, bumped generations — is what made two idle machines rewrite
   * the shared manifest every few minutes and hand the sync tool a conflict
   * to manufacture copies from.
   */
  manifestChanged(): boolean;
}

export interface PassStateInput {
  readonly observations: ObservationsFile;
  readonly manifest: Manifest;
  /** False for a manifest from a newer schema: read as nothing, never rewritten. */
  readonly manifestWritable: boolean;
  readonly workspaceId: string;
  readonly machineId: string;
  readonly nowMs: number;
  readonly nowIso: string;
  readonly scrub: ScrubContext;
}

/**
 * The pass-level half of the scrub decision (§5.3.3).
 *
 * Per-file inputs — how long since this file was last read in full — come from
 * the ledger. These are the facts that are true of the whole pass, and they are
 * passed in rather than derived here because the caller is what knows whether
 * the plugin just started or the remote just became ready.
 */
export interface ScrubContext {
  readonly maxAgeMs: number;
  readonly firstPassAfterStartup: boolean;
  readonly msSinceLastStartupScrub: number;
  readonly manifestUnusable: boolean;
  readonly justBecameReady: boolean;
  readonly manuallyRequested: boolean;
  /** Files picked by this pass's random sample (T6). */
  readonly sampled: ReadonlySet<string>;
}

const EMPTY_ENTRY: Omit<LedgerEntryRecord, "sig" | "firstSeenMs" | "lastSeenMs"> = {
  lastFullVerifyMs: 0,
  verifiedSig: null,
  contentHash: "",
  verifiedLineCount: 0,
  remoteHadNonZeroSize: false,
  lastAction: "",
  lastResult: "",
  abortStreak: 0,
  skippedForBudgetPasses: 0,
  truncatedTailPasses: 0,
};

export function createPassState(input: PassStateInput): PassState {
  const local = new Map(Object.entries(input.observations.local));
  const remote = new Map(Object.entries(input.observations.remote));
  const entries: Record<string, ManifestEntry> = { ...input.manifest.entries };
  let manifestDirty = false;
  const key = (rel: string) => `${input.workspaceId}/${rel}`;

  const sideMap = (side: "local" | "remote") => (side === "local" ? local : remote);

  const toView = (record: LedgerEntryRecord): LedgerEntryView => ({
    sig: record.sig,
    firstSeenMs: record.firstSeenMs,
    truncatedTailPasses: record.truncatedTailPasses,
    remoteHadNonZeroSize: record.remoteHadNonZeroSize,
  });

  const ledger: LedgerView = {
    local(rel) {
      const record = local.get(rel);
      return record ? toView(record) : null;
    },
    remote(rel) {
      const record = remote.get(rel);
      return record ? toView(record) : null;
    },
    record(rel, side, entry) {
      const map = sideMap(side);
      const previous = map.get(rel);
      map.set(rel, {
        ...(previous ?? EMPTY_ENTRY),
        sig: entry.sig,
        firstSeenMs: entry.firstSeenMs,
        lastSeenMs: input.nowMs,
        truncatedTailPasses: entry.truncatedTailPasses,
        remoteHadNonZeroSize: entry.remoteHadNonZeroSize,
      });
    },
  };

  const evidence: EvidenceCache = {
    lookup(rel, side) {
      if (side === "remote") {
        const entryKey = key(rel);
        // A key that does not parse as `<workspaceId>/<provider>/<path>` is
        // somebody else's or malformed; either way it does not describe this
        // file (§5.3.4 M-06).
        if (!isValidEntryKey(entryKey, input.workspaceId)) return undefined;
        return entries[entryKey];
      }
      const record = local.get(rel);
      if (!record || record.verifiedSig === null || record.contentHash === "") return undefined;
      return {
        e0: record.verifiedSig,
        contentHash: record.contentHash,
        lineCount: record.verifiedLineCount,
      };
    },

    scrub(rel) {
      const record = remote.get(rel) ?? local.get(rel);
      return scrubTrigger({
        nowMs: input.nowMs,
        lastFullVerifyMs: record?.lastFullVerifyMs ?? 0,
        maxAgeMs: input.scrub.maxAgeMs,
        firstPassAfterStartup: input.scrub.firstPassAfterStartup,
        msSinceLastStartupScrub: input.scrub.msSinceLastStartupScrub,
        // A file whose last outcome was unsettled gets read again (T3): the
        // states listed there are the ones where the cache is most likely to
        // be describing a file that moved under it.
        lastResultWasUnsettled: isUnsettled(record),
        manifestUnusable: input.scrub.manifestUnusable,
        justBecameReady: input.scrub.justBecameReady,
        manuallyRequested: input.scrub.manuallyRequested,
        sampled: input.scrub.sampled.has(rel),
      });
    },

    record(rel, side, facts) {
      recordVerified(sideMap(side), rel, facts, input.nowMs);
      if (side !== "remote" || !input.manifestWritable) return;
      const previous = entries[key(rel)];
      // Re-verifying an unchanged file is not news. Rewriting the entry
      // anyway would bump `generation` and stamp `updatedAt` on every scrub
      // of every quiet file — churn in a *shared* file. The signature check
      // is exact (all five stat components), so a file another machine wrote
      // — different inode, different timestamps — still refreshes the entry,
      // which is what that machine's E1 tier needs.
      if (
        previous &&
        previous.size === facts.e0.size &&
        previous.lineCount === facts.lineCount &&
        previous.contentHash === facts.contentHash &&
        signaturesEqual(previous.e0, facts.e0)
      ) {
        return;
      }
      manifestDirty = true;
      entries[key(rel)] = {
        provider: providerOf(rel),
        workspaceId: input.workspaceId,
        logicalId: logicalIdOf(rel),
        mode: "append-jsonl",
        size: facts.e0.size,
        lineCount: facts.lineCount,
        contentHash: facts.contentHash,
        e0: facts.e0,
        lastWriter: input.machineId,
        updatedAt: input.nowIso,
        generation: (previous?.generation ?? 0) + 1,
        // Whatever a newer version put here survives our rewrite (M-05).
        ...(previous?.unknown ? { unknown: previous.unknown } : {}),
      };
    },
  };

  return {
    ledger,
    evidence,
    observations: () => ({
      ...input.observations,
      local: Object.fromEntries(local),
      remote: Object.fromEntries(remote),
    }),
    manifest: () => (input.manifestWritable ? { ...input.manifest, entries } : null),
    manifestChanged: () => manifestDirty,
  };
}

/**
 * Records the hash *and* the signature it was computed against, together.
 *
 * Together is the whole point. `sig` moves on every observation, including
 * passes that watched a file change without reading it; pairing that with a
 * hash from an older read is precisely the mismatch E1 must never make.
 */
function recordVerified(
  map: Map<string, LedgerEntryRecord>,
  rel: string,
  facts: CachedContentFacts,
  nowMs: number,
): void {
  const previous = map.get(rel);
  map.set(rel, {
    ...(previous ?? EMPTY_ENTRY),
    sig: facts.e0,
    firstSeenMs: previous?.firstSeenMs ?? nowMs,
    lastSeenMs: nowMs,
    lastFullVerifyMs: nowMs,
    verifiedSig: facts.e0,
    contentHash: facts.contentHash,
    verifiedLineCount: facts.lineCount,
  });
}

const UNSETTLED = new Set(["CONFLICT", "DEFERRED", "FAILED_IO", "ABORTED_PRECONDITION"]);

function isUnsettled(record: LedgerEntryRecord | undefined): boolean {
  if (!record) return false;
  return UNSETTLED.has(record.lastAction) || UNSETTLED.has(record.lastResult);
}

/** `<provider>/<file>` — the neutral relative path's first segment. */
function providerOf(rel: string): string {
  const at = rel.indexOf("/");
  return at === -1 ? "" : rel.slice(0, at);
}

function logicalIdOf(rel: string): string {
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  const dot = name.indexOf(".");
  return dot === -1 ? name : name.slice(0, dot);
}

/**
 * Records what happened to a file, for the next pass's T3 decision.
 *
 * Separate from the engine's own ledger writes because the engine reports
 * outcomes and the ledger stores them: threading an action result through
 * `LedgerEntryView` would put a reporting concern into the type the stability
 * judgement reads from.
 */
export function recordOutcomes(
  state: PassState,
  outcomes: ReadonlyArray<{
    readonly neutralRel: string;
    readonly action: string;
    readonly result: string;
  }>,
): ObservationsFile {
  const file = state.observations();
  const apply = (side: Readonly<Record<string, LedgerEntryRecord>>) => {
    const out: Record<string, LedgerEntryRecord> = { ...side };
    for (const outcome of outcomes) {
      const record = out[outcome.neutralRel];
      if (!record) continue;
      out[outcome.neutralRel] = {
        ...record,
        lastAction: outcome.action,
        lastResult: outcome.result,
        abortStreak:
          outcome.result === "ABORTED_PRECONDITION" ? record.abortStreak + 1 : 0,
        skippedForBudgetPasses:
          outcome.result === "SKIPPED_BUDGET" ? record.skippedForBudgetPasses + 1 : 0,
      };
    }
    return out;
  };
  return { ...file, local: apply(file.local), remote: apply(file.remote) };
}
