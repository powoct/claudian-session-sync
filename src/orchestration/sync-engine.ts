/**
 * One pass, nine phases (architecture §7.1).
 *
 *   P0 preflight → P1 discover → P2 stability → P3 index → P4 plan
 *   → P5 guard → P6 apply → P7 reconcile → P8 commit
 *
 * The ordering is the design. The cheap stability gate runs *before* any bytes
 * are read, so an unstable file costs two stats rather than a 20 MB read; and
 * verification is pushed as close to the swap as the platform allows, because
 * neither POSIX nor Win32 offers rename-if-unchanged. What is left is
 * verify-then-swap with a residual window this project documents rather than
 * pretends away (§9.2.1 W1).
 *
 * Two rules hold throughout:
 *
 *  - **Every check failure cancels rather than continues.** An aborted action
 *    is replanned next pass from fresh observations; a continued one acts on
 *    facts that have already been contradicted.
 *  - **There is no catch-all.** Only known errno values are caught, so a
 *    CrashSignal injected by a test reaches the test instead of being absorbed
 *    as an I/O failure (testing.md §3 requirement 9).
 */
import {
  type Action,
  MALFORMED_TAIL_PASSES,
  type PlanInput,
  type SideFacts,
  plan,
  planOpaque,
  shrankBelowConvergedBase,
} from "../domain/planner";
import { comparePrefix, resolveNotLineAligned, tailState } from "../domain/merge-policy";
import { type E0Signature, judgeStability, signaturesEqual } from "../domain/stability";
import { buildConflictMeta, conflictId, quarantineLayout } from "../domain/conflict";
import { type CachedContentFacts, type ScrubTrigger, evidenceFor } from "../domain/manifest";
import type { LogicalId, PathViolation, SafeAbsolutePath } from "../domain/types";
import { MAX_DEPTH } from "../domain/path-safety";
import { classifyExternalArtifact, insertionBetween } from "../domain/external-artifacts";
import type { FsGateway } from "../infra/fs-gateway";
import { isDenylisted, isTransferArtifact } from "../infra/path-guard";
import type { Clock, IdGen } from "../infra/clock";
import type {
  ProviderAdapter,
  SessionFileRef,
  SessionGroup,
} from "../providers/provider-adapter";
import {
  type ActionEntry,
  type ActionResult,
  type Barrier,
  type DecisionEvidence,
  type PassReport,
  type UnknownFileEntry,
  type ViolationEntry,
  hashPrefix,
  idPrefix,
  isErrorResult,
  noopBarrier,
} from "./pass-report";

/** The four actions that put bytes on disk; everything else observes. */
/** Enough to act on; past it a list stops being a list (§9.1.6). */
const MAX_NAMED_REPLACEMENTS = 3;

const WRITE_ACTIONS = new Set<Action>(["PUSH_NEW", "PULL_NEW", "PUSH_OVERWRITE", "PULL_OVERWRITE"]);

/** Known errno values worth catching per file; anything else propagates. */
const CATCHABLE_IO = new Set(["ENOENT", "EACCES", "EPERM", "EBUSY", "EISDIR", "ENOTDIR", "EMFILE", "ENOSPC"]);

export interface SideObservation {
  readonly exists: boolean;
  readonly path: string;
  readonly stat: E0Signature | null;
}

export interface EngineDeps {
  readonly fs: FsGateway;
  readonly clock: Clock;
  readonly ids: IdGen;
  readonly adapters: readonly ProviderAdapter[];
  readonly barrier?: Barrier;

  /** Absolute root of this machine's view of the sync directory. */
  readonly replicaRoot: string;
  readonly workspaceId: string;
  readonly joinPath: (...parts: string[]) => string;

  readonly settings: EngineSettings;
  /** Preflight verdict; the pass is read-only or aborted unless this is ready. */
  readonly remoteReadiness: "ready" | "not-ready" | "unsupported-format";
  readonly dryRun: boolean;

  /** Ledger from the previous pass, keyed by neutralRel. Empty when lost. */
  readonly ledger: LedgerView;
  /**
   * Content facts remembered from earlier full reads (§5.3).
   *
   * Optional, and losing it costs I/O rather than correctness — which is the
   * whole design of the manifest. Absent, every stable file is read in full,
   * which is what this engine did before the cache existed.
   */
  readonly evidence?: EvidenceCache;
  /** Hash of bytes; injected because domain and infra must stay separable. */
  readonly hashBytes: (bytes: Uint8Array) => string;
  /**
   * Backup hook; returns the path written, or null when it could not be.
   *
   * `rotationDeferred` says the retention limit did not bind: a surplus copy
   * was kept because no survivor could be proven to contain it (§9.3.3). For
   * an append-only session that is rare; for a provider that rewrites whole
   * records it is *every* time, because an older whole-file version is never
   * a prefix of a newer one — so `backupKeep` silently stops bounding
   * anything and the area grows without limit. The flag is the only way the
   * user can learn that, which is why it travels rather than being dropped.
   */
  readonly backup: (
    input: BackupRequest,
  ) => Promise<{ readonly path: string | null; readonly rotationDeferred?: boolean }>;
  /**
   * Validates a write target through PathGuard.
   *
   * The engine never writes to a path an adapter handed it. An adapter is our
   * own code, but it is written to tolerate CLI layouts it has not seen, so a
   * structure change upstream can make it emit a traversal or a path outside
   * its root — testing.md §8.2's evil-adapter case. This is where that is
   * caught, and the branded return type is what makes skipping it impossible.
   */
  readonly mintWritePath: (target: string) => Promise<MintOutcome>;
  /** First 8 characters of this machine's id, for conflict metadata. */
  readonly machineIdPrefix: string;
  /**
   * Pass mutual exclusion (§7.4 R-09/R-10).
   *
   * Optional so unit-level callers need not provide one, but when present the
   * engine refuses to start a second pass rather than queueing it, and
   * re-checks before every write — a lock that can be stolen is only safe if
   * the previous holder notices.
   */
  readonly lock?: PassLock;
  /** Injected so the engine stays free of Date, per testing.md §3 req 4. */
  readonly nowIso: () => string;
}

export interface PassLock {
  /** Returns false when another pass holds it; the pass then does nothing. */
  acquire(): Promise<{ readonly ok: boolean; readonly reason?: string }>;
  /** Re-checked immediately before each write; false means we were superseded. */
  mayWrite(): Promise<boolean>;
  release(): Promise<void>;
}

export type MintOutcome =
  | { readonly ok: true; readonly value: SafeAbsolutePath }
  | { readonly ok: false; readonly violation: PathViolation; readonly detail?: string };

export interface BackupRequest {
  readonly sourcePath: string;
  readonly neutralRel: string;
  readonly logicalId: LogicalId;
  readonly remote: boolean;
  readonly action: Action;
}

export interface EngineSettings {
  readonly maxFileSizeBytes: number;
  readonly maxFilesPerPass: number;
  readonly localQuietMs: number;
  readonly remoteQuietMs: number;
  readonly clockSkewToleranceMs: number;
}

export interface LedgerEntryView {
  readonly sig: E0Signature;
  readonly firstSeenMs: number;
  readonly truncatedTailPasses: number;
  readonly remoteHadNonZeroSize: boolean;
}

export interface LedgerView {
  local(neutralRel: string): LedgerEntryView | null;
  remote(neutralRel: string): LedgerEntryView | null;
  record(neutralRel: string, side: "local" | "remote", entry: LedgerEntryView): void;
  /**
   * The opaque table's base (§7.2b #4a): hash of the content both sides held
   * at the last convergence this machine witnessed, or null. Only ever
   * consulted for `opaque-file` primaries, and only ever *set* from a hash of
   * bytes read in the pass that witnessed the convergence — it classifies
   * bytes read now, it never substitutes for reading them (ADR-48 vs ADR-12).
   */
  converged(neutralRel: string): string | null;
  /**
   * Size of the same converged bytes (§7.2b, OQ-14). Read by every table, not
   * just the opaque one: it answers "has this side dropped below what both
   * sides once held", which is the question a deliberate truncation raises and
   * the prefix relation cannot see.
   */
  convergedSize(neutralRel: string): number | null;
  recordConverged(neutralRel: string, hash: string, size: number): void;
}

/**
 * The E1 cache (architecture §5.3), behind an interface because its two halves
 * live in different places with different trust levels.
 *
 * The remote side is backed by the sync directory's manifest, which any machine
 * and any sync tool can rewrite; the local side by this machine's observations
 * ledger, which nothing else touches. The engine deliberately cannot tell them
 * apart: both may authorise exactly one outcome, so a difference in trust would
 * change nothing about what it is allowed to do with either.
 */
export interface EvidenceCache {
  /** What was remembered about this side, or undefined. */
  lookup(neutralRel: string, side: "local" | "remote"): CachedContentFacts | undefined;
  /**
   * Non-null forces a full read this pass regardless of the cache (§5.3.3).
   *
   * The caller owns the bookkeeping (ages, sampling, budgets) because it owns
   * the file those live in; the engine only needs the verdict.
   */
  scrub(neutralRel: string): ScrubTrigger | null;
  /** Records an E2 result, so the next pass can answer from two stats. */
  record(neutralRel: string, side: "local" | "remote", facts: CachedContentFacts): void;
}

export async function runPass(deps: EngineDeps): Promise<PassReport> {
  const barrier = deps.barrier ?? noopBarrier;
  const startedAtMs = deps.clock.nowMs();
  const actions: ActionEntry[] = [];
  const violations: ViolationEntry[] = [];
  const unknownFiles: UnknownFileEntry[] = [];
  // Counted per (provider, name) rather than per session: twenty Grok sessions
  // all holding `signals.json` is one fact about the provider, not twenty
  // lines about sessions.
  const omissionCounts = new Map<string, number>();
  /** Providers whose backup retention did not bind this pass (§9.3.3). */
  const rotationDeferredFor = new Set<string>();
  /**
   * Whole-file records this pass replaced with the other machine's version.
   *
   * Counted, not listed. For a two-machine Claudian user this is the ordinary
   * steady state — every conversation turn rewrites a record — so a line per
   * file would be the noise ADR-48 rejected its alternative (a) for. But it is
   * also the path where a transport that leaves no readable copy can take this
   * machine's version without ADR-57's witness noticing (§9.4.3), and silence
   * there is the half of OQ-18 that no mechanism closes.
   */
  const replacedByPeer = new Map<string, number>();
  const historyReplaced: Array<{ logicalIdPrefix: string; backupPath: string | null }> = [];
  const notices: string[] = [];

  // ── P0 preflight ─────────────────────────────────────────────────────────
  // A pass that cannot establish where it is writing does not write. Aborting
  // here means zero changes on both sides, which is what makes "the sync
  // directory looks empty" survivable rather than catastrophic.
  const acquired = deps.lock ? await deps.lock.acquire() : { ok: true };
  if (!acquired.ok) {
    // Not queued: a second pass would plan against observations taken before
    // the first one wrote.
    return finish("aborted", acquired.reason ?? "lock-unavailable");
  }

  try {
    return await runPassBody();
  } finally {
    await deps.lock?.release();
  }

  async function runPassBody(): Promise<PassReport> {
  await barrier("P0:preflight-done", {});
  if (deps.remoteReadiness === "unsupported-format") {
    return finish("aborted", "format-version-unsupported");
  }

  // ── P1 discover ──────────────────────────────────────────────────────────
  const groups: Array<{ adapter: ProviderAdapter; group: SessionGroup }> = [];
  for (const adapter of deps.adapters) {
    const health = await adapter.healthCheck();
    if (!health.ok) {
      notices.push(`provider ${adapter.id} unavailable: ${health.reason ?? "unknown"}`);
      continue; // One provider failing must not stop the others.
    }
    for (const group of await adapter.listSessions()) groups.push({ adapter, group });
  }
  await barrier("P1:discover-done", {});

  // Remote-only sessions: present in the replica, absent locally.
  //
  // This is the one place a file the local CLI never wrote can become something
  // this plugin writes into the CLI's own directory, so it is where §8.2 layer
  // 1 has to hold: the adapter that owns the subtree decides whether the name
  // is a session at all, and anything it refuses is reported and left exactly
  // where it lies.
  const seen = new Set(groups.flatMap(({ group }) => group.files.map((f) => f.neutralRel)));
  // Keyed by provider and logical id, so a file only the replica has joins the
  // group it belongs to instead of forming a group of its own. That mattered
  // not at all while every provider's session was one file, and matters a lot
  // now: a session whose history is in the replica and whose commit point is
  // not is a session that must not be assembled on this machine (§6.6.1).
  const byLogicalId = new Map<string, { adapter: ProviderAdapter; group: SessionGroup }>();
  for (const held of groups) byLogicalId.set(`${held.adapter.id}\u0000${held.group.logicalId}`, held);

  // Kept rather than discarded after the discovery loop: OQ-18's witness needs
  // to know what else lives beside a replica file, and this walk already has it.
  const replicaSiblings = new Map<string, readonly string[]>();
  for (const { adapter, rel, siblings } of await listReplicaFiles(deps)) {
    replicaSiblings.set(rel.slice(0, rel.lastIndexOf("/")), siblings);
    if (seen.has(rel)) continue;
    const classified = adapter.classifyNeutral(rel);
    if (classified === null) {
      const name = rel.slice(rel.lastIndexOf("/") + 1);
      unknownFiles.push({
        providerId: adapter.id,
        neutralRel: rel,
        ...classifyExternalArtifact(name, siblings),
      });
      continue;
    }
    // Recognised, and deliberately not a member: this plugin wrote it into the
    // sync directory and it belongs nowhere else.
    if (classified.replicaOnly) continue;

    const file: SessionFileRef = {
      role: classified.role,
      absPath: "",
      neutralRel: rel,
      mode: classified.mode,
    };
    const key = `${adapter.id}\u0000${classified.logicalId}`;
    const existing = byLogicalId.get(key);
    if (existing) {
      // Same object as the one in `groups`, so the array sees this too.
      existing.group = { ...existing.group, files: [...existing.group.files, file] };
      continue;
    }
    const added = {
      adapter,
      group: { logicalId: classified.logicalId, files: [file], lastModifiedMs: 0 },
    };
    byLogicalId.set(key, added);
    groups.push(added);
  }

  let budget = deps.settings.maxFilesPerPass;

  for (const { adapter, group } of groups) {
    // `derived` stays refused: a derived file is rebuilt locally, never
    // copied, and REBUILD_LOCAL (§7.2b #5) has no implementation. Grok's
    // adapter simply does not list its derived members, so this only fires
    // for a provider that names one — but naming one and having it silently
    // ignored is the failure this branch exists to prevent.
    for (const file of group.files) {
      if (file.mode !== "derived") continue;
      notices.push(
        `${file.neutralRel}: this provider stores sessions in a form this version does not sync (${file.mode})`,
      );
      actions.push(
        entry(group, file.neutralRel, adapter.id, "DEFER", `unsupported-mode:${file.mode}`, "SKIPPED_POLICY"),
      );
    }

    // §6.6.1: the budget is spent per *group*, not per file. A group that does
    // not fit waits whole. Splitting one across passes would land the aux
    // members now and the primary minutes later — and for the window between
    // them the session is half-written, invisible in the CLI's list but still
    // reachable by `--resume <id>`, with the id arriving separately through
    // the vault's Claudian record. Whole-group deferral keeps that window at
    // the few milliseconds one pass needs.
    for (const name of group.unprovenOmissions ?? []) {
      const key = `${adapter.id}\u0000${name}`;
      omissionCounts.set(key, (omissionCounts.get(key) ?? 0) + 1);
    }

    const planned = orderedForCommit(group);

    // §9.1 / OQ-17: is this session being written *right now*? Asked of the
    // whole group, because its members go quiet out of step — measured, on
    // Grok: `chat_history.jsonl` held still for 23 seconds mid-turn while
    // `events.jsonl` advanced about ninety times, so the file a pass most
    // wants to copy looks settled exactly while the turn is in flight, and
    // what it copies is a version the finished turn does not extend.
    //
    // Checked before the budget so an active session costs a stat sweep and
    // nothing else. Providers whose session is one file declare no witnesses
    // and are unaffected.
    if (planned.length > 0 && (group.witnessPaths?.length ?? 0) > 0) {
      const activity = await observeGroupActivity(deps, group);
      const key = `${adapter.id}/${group.logicalId}`;
      const verdict = judgeStability({
        o2: activity,
        ledger: deps.ledger.local(key),
        nowMs: deps.clock.nowMs(),
        quietMs: deps.settings.localQuietMs,
        clockSkewToleranceMs: deps.settings.clockSkewToleranceMs,
      });
      deps.ledger.record(key, "local", {
        sig: activity,
        firstSeenMs: verdict.firstSeenMs,
        truncatedTailPasses: 0,
        remoteHadNonZeroSize: false,
      });
      if (!verdict.stable) {
        for (const file of planned) {
          actions.push(
            entry(group, file.neutralRel, adapter.id, "DEFER", "session-being-written", "SKIPPED_POLICY"),
          );
        }
        continue;
      }
    }

    // No commit point, no assembly. A group reaching here without a primary
    // can only have come from the replica, and only because the machine that
    // pushed it has not finished: landing its history alone would leave a
    // session directory the CLI does not list — and a Grok resume aimed at
    // that id was measured writing the user's next turn into a *different*
    // session (findings 2026-08-24). Waiting costs a pass; assembling costs
    // someone else's conversation.
    if (planned.length > 0 && !planned.some((file) => file.role === "primary")) {
      for (const file of planned) {
        actions.push(
          entry(group, file.neutralRel, adapter.id, "DEFER", "primary-not-in-replica", "SKIPPED_POLICY"),
        );
      }
      continue;
    }

    // …with a floor. A group larger than `maxFilesPerPass` would otherwise
    // defer for ever — the budget resets each pass and the group never
    // shrinks, so "wait for room" becomes "never sync this session". A group
    // that cannot fit an untouched budget is instead allowed to run alone: it
    // is the only work this pass does, which is the smallest departure from
    // the setting that still makes progress.
    if (planned.length > budget && budget < deps.settings.maxFilesPerPass) {
      for (const file of planned) {
        actions.push(entry(group, file.neutralRel, adapter.id, "DEFER", "budget-exhausted", "SKIPPED_BUDGET"));
      }
      continue;
    }
    budget -= planned.length;

    // Watched so a half-assembled group is said out loud rather than left in
    // the action rows to be noticed. See the notice below for why it matters.
    let auxLanded = false;
    let primaryPending = false;
    // §7.1 P5: "group 内任一 required 文件被拦下 → 整个 group DEFER". The engine
    // already stops a group for the budget, for a missing primary and for a
    // session being written; a member in conflict was the one way through.
    //
    // It matters most for exactly the case that found it. A rewind conflicts
    // the history and, in the same pass, `summary.json` reads as
    // `remote-at-converged-base` and pushes — so the group would land the
    // post-rewind record beside the pre-rewind history, a pairing neither
    // machine ever held. `orderedForCommit` puts the primary last, so a flag
    // raised by an aux member is enough to stop it; no two-phase machinery.
    let memberConflicted = false;

    for (const file of planned) {

      const localPath = await adapter.targetPathFor(file.neutralRel);
      const remotePath = deps.joinPath(deps.replicaRoot, deps.workspaceId, file.neutralRel);

      // ── P2 stability gate ────────────────────────────────────────────────
      // Before any bytes: one stat per side, compared with what the previous
      // pass recorded and with how long that has been true. An unstable file
      // never reaches P3, so it never costs a read.
      //
      // One stat, not two (ADR-63). The second observation and its
      // `changed-within-pass` verdict are gone: the delay that was meant to
      // separate them was never implemented, and implementing it would not
      // have earned it. A change that lands before this stat is in it, and the
      // ledger comparison catches it; a change that lands during the byte read
      // is caught by O2/O3 below.
      const localO2 = await observe(deps, localPath);
      const remoteO2 = await observe(deps, remotePath);
      await barrier("P2:o2-taken", { neutralRel: file.neutralRel });

      const nowMs = deps.clock.nowMs();
      const localStable = judgeSide(deps, localO2, deps.ledger.local(file.neutralRel), nowMs, "local");
      const remoteStable = judgeSide(deps, remoteO2, deps.ledger.remote(file.neutralRel), nowMs, "remote");

      // ── P3 index ─────────────────────────────────────────────────────────
      // What has to be read here is decided by the authorisation matrix
      // (§5.3.2), not by convenience. E1 — "both sides still match what we
      // remember, and we remember them agreeing" — is consulted for exactly
      // one question, "is there nothing to do?", and it answers by *not*
      // calling `plan()`. That is rule EV-1 as control flow: a remembered hash
      // has no route into a branch that writes, because the only branch it can
      // reach produces no writes at all.
      //
      // This is also the whole of the steady-state I/O saving: N unchanged
      // sessions cost two stats and a tail read each, not N full reads.
      const scrub = deps.evidence?.scrub(file.neutralRel) ?? null;
      const localE1 = cachedE1(deps, file.neutralRel, "local", localO2, localStable.stable, scrub);
      const remoteE1 = cachedE1(deps, file.neutralRel, "remote", remoteO2, remoteStable.stable, scrub);

      // Note what this branch does *not* carry: `conflictKnown`. Skipping
      // `plan()` skips its "this pair is already quarantined, do not pile up
      // another copy" case — and that is sound rather than an omission,
      // because the branch is only reachable when the two hashes are equal,
      // and equal content is not a disagreement to know about. A pair that was
      // in conflict and is now identical has already stopped being one: the
      // conflict id is derived from the two hashes, so the old one is simply
      // never computed again (U-21).
      if (
        deps.remoteReadiness === "ready" &&
        localE1 !== null &&
        remoteE1 !== null &&
        localE1.contentHash === remoteE1.contentHash
      ) {
        actions.push({
          ...entry(group, file.neutralRel, adapter.id, "NOOP", "e1-cache-hit", "APPLIED"),
          evidence: {
            level: "E1/E1",
            localLines: localE1.lineCount,
            remoteLines: remoteE1.lineCount,
            relation: "equal",
            stability: "stable / stable",
            localHashPrefix: hashPrefix(localE1.contentHash),
            remoteHashPrefix: hashPrefix(remoteE1.contentHash),
          },
        });
        // Stability accounting still runs: skipping it would reset the quiet
        // window every pass and make the file permanently un-actionable the
        // moment it does change.
        recordLedger(deps, file.neutralRel, "local", localO2, nowMs, null);
        recordLedger(deps, file.neutralRel, "remote", remoteO2, nowMs, null);
        continue;
      }

      // Bytes are read here and nowhere else, and the hash behind any decision
      // that writes comes from this read (E2). Nothing cached may substitute.
      const localBytes = localO2.exists && localStable.stable ? await readBytes(deps, localPath) : null;
      const remoteBytes = remoteO2.exists && remoteStable.stable ? await readBytes(deps, remotePath) : null;
      await barrier("P3:bytes-read", { neutralRel: file.neutralRel });

      // O3: the file must not have moved while we were reading it.
      const localO3 = localBytes ? await observe(deps, localPath) : localO2;
      const remoteO3 = remoteBytes ? await observe(deps, remotePath) : remoteO2;
      await barrier("P3:o3-taken", { neutralRel: file.neutralRel });
      const readStillValid =
        sameSignature(localO2.stat, localO3.stat) && sameSignature(remoteO2.stat, remoteO3.stat);

      // ── P4 plan ──────────────────────────────────────────────────────────
      const localFacts = facts(deps, localO2, localBytes, localStable.stable && readStillValid);
      const remoteFacts = facts(deps, remoteO2, remoteBytes, remoteStable.stable && readStillValid);
      const relation = relate(localBytes, remoteBytes);

      const input: PlanInput = {
        remote: deps.remoteReadiness,
        local: localFacts,
        remoteSide: remoteFacts,
        relation,
        conflictKnown: false,
        maxFileSizeBytes: deps.settings.maxFileSizeBytes,
        pullNewFastPath: false,
        hints: { remoteHadNonZeroSize: deps.ledger.remote(file.neutralRel)?.remoteHadNonZeroSize ?? false },
        history: {
          // Either side can be the one with the half-written record, so the
          // count that matters is the longer of the two streaks.
          truncatedTailPasses: Math.max(
            deps.ledger.local(file.neutralRel)?.truncatedTailPasses ?? 0,
            deps.ledger.remote(file.neutralRel)?.truncatedTailPasses ?? 0,
          ),
          // OQ-14. Compared against the *base*, never against each other:
          // this asks "did a side go backwards past what both once held", and
          // the answer may only ever refuse a fast-forward.
          localShrankBelowConverged: shrankBelowConvergedBase({
            sideSize: localFacts.size,
            otherSize: remoteFacts.size,
            convergedSize: deps.ledger.convergedSize(file.neutralRel),
          }),
          remoteShrankBelowConverged: shrankBelowConvergedBase({
            sideSize: remoteFacts.size,
            otherSize: localFacts.size,
            convergedSize: deps.ledger.convergedSize(file.neutralRel),
          }),
        },
      };
      let witness: WitnessOutcome = { found: false, copyRel: null, unreadable: null };
      if (file.mode === "opaque-file") {
        const base = deps.ledger.converged(file.neutralRel);
        // Entered only in the exact shape the witness can speak to, so the
        // extra reads are paid at most once per #4b event and never in steady
        // state. Deliberately not computed for #4a: the push is what set the
        // base, so after a discard the loser is here or in #4c — and the copy
        // reaches the machine that *won* as well, where testing it would make
        // every subsequent edit a conflict (the acceptance run's C4/G5).
        const shape =
          localFacts.exists && remoteFacts.exists &&
          base !== null &&
          localFacts.observedHash === base &&
          remoteFacts.observedHash !== base;
        if (shape) witness = await findDisplacedPush(deps, file.neutralRel, replicaSiblings, localFacts.observedHash);
      }

      const decision =
        file.mode === "opaque-file"
          ? planOpaque({
              remote: deps.remoteReadiness,
              local: localFacts,
              remoteSide: remoteFacts,
              conflictKnown: false,
              maxFileSizeBytes: deps.settings.maxFileSizeBytes,
              lastConvergedHash: deps.ledger.converged(file.neutralRel),
              displacedPushWitness: witness.found,
            })
          : plan(input);
      if (witness.unreadable !== null) {
        // Fail-open, and say so out loud. An unreadable candidate never stops
        // matching, and ADR-34 forbids deleting it, so failing closed would
        // freeze this record in permanent conflict — ADR-48's conflict
        // generator reached from the other side. Rare enough to be worth a
        // sentence, which tier-1 replacements below deliberately do not get.
        notices.push(
          `${file.neutralRel}: a file beside it in the sync folder could not be read (${witness.unreadable}), ` +
            "so it could not be checked before this machine's version was replaced — the previous " +
            "contents are in the backups folder",
        );
      }
      await barrier("P4:planned", { neutralRel: file.neutralRel });

      // U-11d. A truncated tail defers, and deferring is correct — but a file
      // that has been deferring for five passes is not waiting for a transfer
      // to finish, it is broken, and the difference is invisible from a report
      // that only ever says DEFER. So it stops being a quiet decision and
      // becomes something the user is told about.
      if (decision.flags.includes("malformedTail")) {
        notices.push(
          `${file.neutralRel}: the last record has been incomplete for ${MALFORMED_TAIL_PASSES}+ passes; ` +
            `nothing is being copied in either direction until it is whole`,
        );
      }
      await barrier("P5:guarded", { neutralRel: file.neutralRel });

      const evidence: DecisionEvidence = {
        level: `${byteLevel(localBytes)}/${byteLevel(remoteBytes)}`,
        localLines: localBytes ? countLines(localBytes) : null,
        remoteLines: remoteBytes ? countLines(remoteBytes) : null,
        relation,
        stability: `${localStable.stable ? "stable" : localStable.reason} / ${remoteStable.stable ? "stable" : remoteStable.reason}`,
        localHashPrefix: localFacts.observedHash ? hashPrefix(localFacts.observedHash) : null,
        remoteHashPrefix: remoteFacts.observedHash ? hashPrefix(remoteFacts.observedHash) : null,
      };

      // A conflict is only useful if both branches survive somewhere a user
      // can reach them. Quarantine is a copy — neither original is touched —
      // so a mistaken conflict costs a confusing report, not a lost branch.
      let quarantinedId: string | undefined;
      if (
        decision.action === "CONFLICT" &&
        !deps.dryRun &&
        localBytes &&
        remoteBytes &&
        localFacts.observedHash &&
        remoteFacts.observedHash
      ) {
        quarantinedId = await quarantineConflict(deps, {
          logicalId: group.logicalId,
          neutralRel: file.neutralRel,
          providerId: adapter.id,
          localBytes,
          remoteBytes,
          localHash: localFacts.observedHash,
          remoteHash: remoteFacts.observedHash,
          extension: extensionOf(file.neutralRel),
          reason: decision.reason,
          externalCopy: witness.copyRel,
        });
      }

      // §7.1 P5: a write may not land beside a member already in conflict.
      //
      // Narrower than "stop the group", deliberately. A second CONFLICT is
      // harmless — it writes nothing to either live file — and a fork of a
      // Grok session legitimately produces one per diverged member (acceptance
      // F-4), which the user has to see all of. What must not happen is a
      // *write*: with the history in conflict, pushing `summary.json` would
      // publish the post-rewind record beside the pre-rewind history, a pairing
      // neither machine ever held. `orderedForCommit` puts the primary last, so
      // an aux member's conflict is always seen before the commit point.
      if (memberConflicted && WRITE_ACTIONS.has(decision.action)) {
        actions.push(
          entry(group, file.neutralRel, adapter.id, "DEFER", "group-member-in-conflict", "SKIPPED_POLICY"),
        );
        recordLedger(deps, file.neutralRel, "local", localO2, nowMs, tailTruncated(localBytes));
        recordLedger(deps, file.neutralRel, "remote", remoteO2, nowMs, tailTruncated(remoteBytes));
        continue;
      }
      if (decision.action === "CONFLICT") memberConflicted = true;

      // ── P6 apply ─────────────────────────────────────────────────────────
      const applied = await applyAction(deps, barrier, {
        action: decision.action,
        group,
        mode: file.mode,
        neutralRel: file.neutralRel,
        onRotationDeferred: () => rotationDeferredFor.add(adapter.id),
        localPath,
        remotePath,
        localBytes,
        remoteBytes,
        localPre: localO3,
        remotePre: remoteO3,
      });

      actions.push({
        providerId: adapter.id,
        logicalIdPrefix: idPrefix(group.logicalId),
        neutralRel: file.neutralRel,
        action: decision.action,
        result: applied.result,
        reason: decision.reason,
        flags: decision.flags,
        conflictKnown: decision.conflictKnown,
        evidence,
        ...(applied.backupPath ? { backupPath: applied.backupPath } : {}),
        ...(applied.errorCode ? { errorCode: applied.errorCode } : {}),
        ...(applied.noReplaceUnavailable ? { noReplaceUnavailable: true } : {}),
        ...(quarantinedId ? { conflictId: quarantinedId } : {}),
      });

      // The dangerous state named directly, rather than inferred from a result
      // code: *this machine has no commit point for a session directory that
      // now exists*. Keying on FAILED_* would miss the quiet and far more
      // common way it happens — the aux members go quiet while the sync tool
      // is still writing the primary, so the primary comes back DEFERRED with
      // no error anywhere. Keying on "a planned write did not land" misses it
      // too, because a deferred file was never planned as a write.
      //
      // A primary that is already on this machine is deliberately excluded: a
      // stale one is the mixed-age case, which the CLI was measured to heal by
      // regenerating it. What cannot heal is its absence.
      // §9.1.6 mitigation 2, marked "M1 必做" and never implemented past the
      // opaque table: *every* landed PULL_OVERWRITE, whatever the merge mode.
      // The hazard it exists for has nothing to do with how the file merges —
      // it is that the local CLI may have this session open right now, and its
      // in-memory state has just gone stale under it. An append-only history
      // is if anything the likelier one to be open.
      //
      // Opaque records keep the counted per-provider line: they are rewritten
      // every turn, so naming each one is noise (ADR-48). A conversation
      // history is named, because it is the one the user might be typing into.
      if (decision.action === "PULL_OVERWRITE" && applied.result === "APPLIED") {
        if (file.mode === "opaque-file") {
          replacedByPeer.set(adapter.id, (replacedByPeer.get(adapter.id) ?? 0) + 1);
        } else {
          historyReplaced.push({
            logicalIdPrefix: idPrefix(group.logicalId),
            backupPath: applied.backupPath ?? null,
          });
        }
      }
      if (file.role !== "primary") {
        if (WRITE_ACTIONS.has(decision.action) && applied.result === "APPLIED") auxLanded = true;
      } else if (!localO2.exists && applied.result !== "APPLIED") {
        primaryPending = true;
      }

      if (applied.violation) {
        violations.push({
          rootSymbol: pullingAction(decision.action) ? "providerRoot" : "syncDir",
          relativePath: file.neutralRel,
          violation: applied.violation.violation,
          ...(applied.violation.detail ? { detail: applied.violation.detail } : {}),
        });
      }

      // The base moves only on convergence this pass witnessed with real bytes
      // (§7.2b, ADR-48): an observed-equal NOOP, or a landed write.
      // Deliberately not on the E1 branch above — a remembered hash may say
      // NOOP, it may not arm a future overwrite.
      //
      // Recorded for **every** mode, which is what §7.2b already specified
      // ("任一 `*_NEW`/`*_OVERWRITE` 落地（含 append-jsonl 表的）") and what the
      // `opaque-file` gate here quietly withheld. The opaque table is the only
      // one that reads the *hash*; the size is read by both, because a file
      // that has fallen below the last agreed point is a fork whatever its
      // merge mode (ADR-61).
      if (!deps.dryRun) {
        const convergedHash =
          decision.action === "NOOP" && decision.reason === "content-identical"
            ? localFacts.observedHash
            : applied.result === "APPLIED" &&
                (decision.action === "PUSH_NEW" || decision.action === "PUSH_OVERWRITE")
              ? localFacts.observedHash
              : applied.result === "APPLIED" &&
                  (decision.action === "PULL_NEW" || decision.action === "PULL_OVERWRITE")
                ? remoteFacts.observedHash
                : null;
        const convergedSize =
          decision.action === "NOOP" || decision.action === "PUSH_NEW" || decision.action === "PUSH_OVERWRITE"
            ? localFacts.size
            : remoteFacts.size;
        if (convergedHash) deps.ledger.recordConverged(file.neutralRel, convergedHash, convergedSize);
      }

      // P8's ledger write is unconditional, including for skipped and aborted
      // files — otherwise a deferred file would never accumulate the quiet
      // time it needs and would defer forever.
      //
      // A10: after a successful write the *post-write* snapshot is recorded,
      // not the one the decision was made against. We know exactly what we
      // just wrote, so treating it as a never-before-seen file on the next
      // pass would defer it for a full round for no reason — and would make a
      // converged pair take three passes to report NOOP instead of one.
      const wrote = applied.result === "APPLIED";
      const pulled = decision.action === "PULL_NEW" || decision.action === "PULL_OVERWRITE";
      const localPost = wrote && pulled ? await observe(deps, localPath) : localO2;
      const remotePost = wrote && !pulled ? await observe(deps, remotePath) : remoteO2;
      recordLedger(deps, file.neutralRel, "local", localPost, nowMs, tailTruncated(localBytes));
      recordLedger(deps, file.neutralRel, "remote", remotePost, nowMs, tailTruncated(remoteBytes));

      // Remember what was read, so the next pass can skip reading it.
      //
      // Only when the signature and the bytes provably describe the same
      // instant: for a read that is `readStillValid` (O2 == O3), and for a
      // write it is the bytes we just wrote against a stat taken immediately
      // after, accepted only if the size still matches. A pair recorded across
      // somebody else's append would make two divergent files look equal until
      // the next scrub — which is exactly the residual risk §5.3.3 exists for,
      // and there is no reason to feed it.
      const source = pulled ? remoteBytes : localBytes;
      recordEvidence(deps, file.neutralRel, "local", localPost, wrote && pulled ? source : readStillValid ? localBytes : null);
      recordEvidence(deps, file.neutralRel, "remote", remotePost, wrote && !pulled ? source : readStillValid ? remoteBytes : null);
    }

    // The one state ADR-30's "do not roll back" leaves behind that a user
    // could act on before the next pass repairs it. Rolling back would be a
    // fresh destructive write in an already-failing state, so this says what
    // happened instead: for a provider whose commit point is a separate file,
    // opening the session now is the thing not to do (findings 2026-08-24 —
    // a Grok resume aimed at a session with no summary.json was measured
    // appending the turn to a different conversation).
    if (auxLanded && primaryPending) {
      notices.push(
        `${group.logicalId}: part of this session was written but its main file was not — ` +
          "do not open it in the CLI until the next sync finishes it",
      );
    }
  }

  // Named, capped, and one line each: the point is that the user can tell
  // *which* conversation to quit and re-resume, which a count cannot say.
  for (const replaced of historyReplaced.slice(0, MAX_NAMED_REPLACEMENTS)) {
    notices.push(
      `session ${replaced.logicalIdPrefix}: this machine's history was replaced with the other ` +
        "machine's version — if you have it open in the CLI right now, quit and resume it again " +
        "before typing, or what you type next will not be saved" +
        (replaced.backupPath ? `; the previous contents are in ${replaced.backupPath}` : ""),
    );
  }
  if (historyReplaced.length > MAX_NAMED_REPLACEMENTS) {
    notices.push(
      `and ${historyReplaced.length - MAX_NAMED_REPLACEMENTS} more session(s) whose history was ` +
        "replaced the same way; the previous contents are in the backups folder",
    );
  }

  for (const [providerId, count] of replacedByPeer) {
    notices.push(
      `${providerId}: ${count} record(s) were replaced with the other machine's version; ` +
        "the previous contents are in the backups folder",
    );
  }
  await barrier("P7:reconciled", {});

  // Said once per pass rather than once per file: for a whole-file provider
  // every backup defers, and a notice per record would be noise instead of
  // news. What the user needs to know is that the number they set is not
  // bounding anything for that provider, and why.
  for (const providerId of rotationDeferredFor) {
    notices.push(
      `${providerId}: backups are being kept past the retention limit because none of the older ` +
        "versions can be reproduced from a newer one — this provider rewrites whole records, so " +
        "nothing is ever redundant. The folder will keep growing; prune it by hand if it matters.",
    );
  }

  await barrier("P8:before-commit", {});
  await barrier("P8:committed", {});

  const failed = actions.filter((a) => isErrorResult(a.result)).length;
  return finish(failed === 0 ? "ok" : actions.length === failed ? "failed" : "partial");
  }

  function finish(outcome: PassReport["outcome"], abortReason?: string): PassReport {
    return {
      startedAtMs,
      finishedAtMs: deps.clock.nowMs(),
      outcome,
      dryRun: deps.dryRun,
      ...(abortReason ? { abortReason } : {}),
      actions,
      violations,
      notices,
      unknownFiles,
      unprovenOmissions: [...omissionCounts]
        .map(([key, sessions]) => {
          const [providerId, name] = key.split("\u0000") as [string, string];
          return { providerId, name, sessions };
        })
        .sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name)),
    };
  }

  function entry(
    group: SessionGroup,
    neutralRel: string,
    providerId: string,
    action: Action,
    reason: string,
    result: ActionResult,
  ): ActionEntry {
    return {
      providerId,
      logicalIdPrefix: idPrefix(group.logicalId),
      neutralRel,
      action,
      result,
      reason,
      flags: [],
      conflictKnown: false,
      evidence: {
        level: "n/a",
        localLines: null,
        remoteLines: null,
        relation: "n/a",
        stability: "n/a",
        localHashPrefix: null,
        remoteHashPrefix: null,
      },
    };
  }
}

/**
 * The verified-overwrite protocol (§9.2.1), condensed to the checks that can be
 * made from a byte-level view.
 *
 * A dry run stops here: it has produced a decision and an explanation, which is
 * the whole point of dry-run mode, and touching anything would defeat it.
 */
async function applyAction(
  deps: EngineDeps,
  barrier: Barrier,
  ctx: {
    action: Action;
    group: SessionGroup;
    mode: SessionGroup["files"][number]["mode"];
    neutralRel: string;
    /** Called when retention could not bind; the pass says so once, at the end. */
    onRotationDeferred: () => void;
    localPath: string;
    remotePath: string;
    localBytes: Uint8Array | null;
    remoteBytes: Uint8Array | null;
    localPre: SideObservation;
    remotePre: SideObservation;
  },
): Promise<{
  result: ActionResult;
  backupPath?: string;
  errorCode?: string;
  violation?: { violation: PathViolation; detail?: string };
  noReplaceUnavailable?: boolean;
}> {
  const writes: Action[] = ["PUSH_NEW", "PULL_NEW", "PUSH_OVERWRITE", "PULL_OVERWRITE"];
  if (!writes.includes(ctx.action)) {
    return { result: ctx.action === "DEFER" ? "DEFERRED" : ctx.action.startsWith("SKIP") ? "SKIPPED_POLICY" : "APPLIED" };
  }
  if (deps.dryRun) return { result: "DEFERRED" };

  const pulling = ctx.action === "PULL_NEW" || ctx.action === "PULL_OVERWRITE";
  const sourceBytes = pulling ? ctx.remoteBytes : ctx.localBytes;
  const targetPath = pulling ? ctx.localPath : ctx.remotePath;
  const targetPre = pulling ? ctx.localPre : ctx.remotePre;
  if (!sourceBytes) return { result: "ABORTED_PRECONDITION" };

  // A truncated tail may never be a source: handing another machine half a
  // record makes it append to a line that was never finished. Lines exist
  // only in the append table's world — an opaque JSON blob routinely has no
  // trailing newline, and calling that "truncated" would DEFER it forever.
  if (ctx.mode === "append-jsonl" && tailState(sourceBytes) === "truncated") {
    return { result: "DEFERRED" };
  }

  let backupPath: string | undefined;
  const overwriting = ctx.action === "PUSH_OVERWRITE" || ctx.action === "PULL_OVERWRITE";

  await barrier("P6:before-backup", { neutralRel: ctx.neutralRel });
  if (overwriting) {
    // A6/O4. A failed backup cancels the overwrite — an overwrite without a way
    // back is exactly what invariant I1 forbids.
    const written = await deps.backup({
      sourcePath: targetPath,
      neutralRel: ctx.neutralRel,
      logicalId: ctx.group.logicalId,
      remote: !pulling,
      action: ctx.action,
    });
    if (written.path === null) return { result: "FAILED_BACKUP" };
    backupPath = written.path;
    if (written.rotationDeferred === true) ctx.onRotationDeferred();
  }
  await barrier("P6:after-backup", { neutralRel: ctx.neutralRel });

  // A8, the last look: the target must still be exactly what was planned
  // against. Anything else means somebody wrote while we were preparing.
  const targetNow = await observe(deps, targetPath);
  if (!sameSignature(targetPre.stat, targetNow.stat)) {
    return { result: "ABORTED_PRECONDITION", ...(backupPath ? { backupPath } : {}) };
  }

  // The lock may have been stolen while this pass prepared. Checking here
  // rather than only at acquisition is what makes stealing safe at all.
  if (deps.lock && !(await deps.lock.mayWrite())) {
    return { result: "ABORTED_PRECONDITION", ...(backupPath ? { backupPath } : {}) };
  }

  const minted = await deps.mintWritePath(targetPath);
  if (!minted.ok) {
    // Fail closed and loudly: a rejected write target means the adapter
    // produced something that does not belong under its root.
    return { result: "SKIPPED_POLICY", violation: minted, ...(backupPath ? { backupPath } : {}) };
  }

  await barrier("P6:before-rename", { neutralRel: ctx.neutralRel });
  let noReplaceUnavailable = false;
  try {
    if (overwriting) {
      await deps.fs.writeFileAtomic(minted.value, sourceBytes);
    } else {
      // A `*_NEW` action asserts the target does not exist, and A8 checked
      // that a few syscalls ago. What A8 cannot cover is the gap that follows:
      // the local CLI creating a session of the same name right then is not
      // exotic, it is what starting a conversation does. A replacing rename
      // would destroy it with no backup — `*_NEW` never takes one, because by
      // its own premise there is nothing to back up. So the "does not exist"
      // premise is enforced where there is no window behind it: the syscall.
      const outcome = await deps.fs.writeFileNoReplace(minted.value, sourceBytes);
      if (!outcome.ok) {
        // Losing this race is ordinary. Next pass sees two real files and
        // decides between them with bytes, which is the correct machinery for
        // the situation — this one is simply not it.
        return outcome.reason === "target-exists"
          ? { result: "ABORTED_PRECONDITION", ...(backupPath ? { backupPath } : {}) }
          : {
              result: "FAILED_IO",
              ...(outcome.code ? { errorCode: outcome.code } : {}),
              ...(backupPath ? { backupPath } : {}),
            };
      }
      noReplaceUnavailable = !outcome.noReplaceEnforced;
    }
  } catch (error) {
    const code = errnoOf(error);
    // No catch-all: an unknown failure propagates, which is what lets a
    // CrashSignal reach the test that injected it.
    if (!code || !CATCHABLE_IO.has(code)) throw error;
    return { result: "FAILED_IO", errorCode: code, ...(backupPath ? { backupPath } : {}) };
  }
  await barrier("P6:after-rename", { neutralRel: ctx.neutralRel });

  return {
    result: "APPLIED",
    ...(backupPath ? { backupPath } : {}),
    ...(noReplaceUnavailable ? { noReplaceUnavailable: true } : {}),
  };
}

/**
 * Copies both branches into the deterministic quarantine directory.
 *
 * Idempotent by construction: the directory name is derived from the two
 * hashes, so a repeated pass over the same disagreement writes the same paths
 * and the exclusive create simply fails — which is why a conflict does not
 * accumulate copies and why nothing has to remember that it happened.
 */
async function quarantineConflict(
  deps: EngineDeps,
  input: {
    logicalId: LogicalId;
    neutralRel: string;
    providerId: string;
    localBytes: Uint8Array;
    remoteBytes: Uint8Array;
    localHash: string;
    remoteHash: string;
    extension: string;
    reason: string;
    externalCopy: string | null;
  },
): Promise<string | undefined> {
  const id = conflictId(
    { logicalId: input.logicalId, localHash: input.localHash, remoteHash: input.remoteHash },
    (value) => deps.hashBytes(new TextEncoder().encode(value)),
  );
  const layout = quarantineLayout({
    workspaceId: deps.workspaceId,
    providerId: input.providerId,
    conflictId: id,
    localHash: input.localHash,
    remoteHash: input.remoteHash,
    extension: input.extension,
  });

  const dir = deps.joinPath(deps.replicaRoot, ...layout.dir);
  const meta = buildConflictMeta({
    logicalId: input.logicalId,
    neutralRel: input.neutralRel,
    conflictId: id,
    localHash: input.localHash,
    remoteHash: input.remoteHash,
    localSize: input.localBytes.length,
    remoteSize: input.remoteBytes.length,
    localLineCount: countLines(input.localBytes),
    remoteLineCount: countLines(input.remoteBytes),
    machineIdPrefix: deps.machineIdPrefix,
    detectedAtIso: deps.nowIso(),
    reason: input.reason,
    externalCopy: input.externalCopy,
  });

  const bytesFor = (hash: string): Uint8Array =>
    hash === input.localHash ? input.localBytes : input.remoteBytes;
  const writes: Array<[string, Uint8Array]> = [
    ...layout.copies.map((copy): [string, Uint8Array] => [copy.name, bytesFor(copy.hash)]),
    [layout.meta, new TextEncoder().encode(`${JSON.stringify(meta, null, 2)}\n`)],
  ];

  // No-replace, and `target-exists` is success: the copy names are derived
  // from the content hashes, so an existing file already holds these bytes —
  // written by an earlier pass here or by the other machine. This is what
  // keeps the shared directory quiet: a re-detected conflict changes nothing
  // on disk, and the meta keeps its original `detectedAt` instead of being
  // stamped afresh every pass.
  for (const [name, bytes] of writes) {
    const minted = await deps.mintWritePath(deps.joinPath(dir, name));
    if (!minted.ok) return undefined;
    const written = await deps.fs
      .writeFileNoReplace(minted.value, bytes)
      .catch((error: unknown) => {
        const code = errnoOf(error);
        if (!code || !CATCHABLE_IO.has(code)) throw error;
        return { ok: false as const, reason: "io-error" as const, code };
      });
    if (!written.ok && written.reason !== "target-exists") {
      return undefined; // Reported as a conflict either way; the copies failed.
    }
  }
  return id;
}

function extensionOf(neutralRel: string): string {
  const name = neutralRel.slice(neutralRel.lastIndexOf("/") + 1);
  const dot = name.indexOf(".");
  return dot === -1 ? "" : name.slice(dot);
}

// ── helpers ────────────────────────────────────────────────────────────────

async function observe(deps: EngineDeps, target: string): Promise<SideObservation> {
  const st = await deps.fs.lstat(target);
  if (st === null || !st.isFile) return { exists: false, path: target, stat: null };
  const tail = await deps.fs.readTail(target, 4096).catch(() => new Uint8Array(0));
  return {
    exists: true,
    path: target,
    stat: {
      size: st.size,
      mtimeMs: st.mtimeMs,
      ctimeMs: st.ctimeMs,
      ino: st.ino ?? 0,
      tailHash: deps.hashBytes(tail),
    },
  };
}

/**
 * E1 for one side, or null when the question has to be answered by reading.
 *
 * Null covers every reason not to trust the cache, and they are all cheap to
 * state: no cache, no file, a file that is still moving, a scrub that has come
 * due, or a signature that does not match the remembered one in all five
 * components (rule EV-2 — "the size is the same" is not a hit).
 */
function cachedE1(
  deps: EngineDeps,
  neutralRel: string,
  side: "local" | "remote",
  observation: SideObservation,
  stable: boolean,
  scrub: ScrubTrigger | null,
): { readonly contentHash: string; readonly lineCount: number } | null {
  if (scrub !== null) return null; // A scrub *is* the instruction to read it.
  if (!deps.evidence || !stable || !observation.exists || !observation.stat) return null;
  const evidence = evidenceFor(observation.stat, deps.evidence.lookup(neutralRel, side));
  return evidence.level === "E1" ? evidence : null;
}

function recordEvidence(
  deps: EngineDeps,
  neutralRel: string,
  side: "local" | "remote",
  observation: SideObservation,
  bytes: Uint8Array | null,
): void {
  if (!deps.evidence || !bytes || !observation.stat) return;
  if (observation.stat.size !== bytes.length) return;
  deps.evidence.record(neutralRel, side, {
    e0: observation.stat,
    contentHash: deps.hashBytes(bytes),
    lineCount: countLines(bytes),
  });
}

/** Null when the side was not read: silence, not a claim that it is fine. */
function tailTruncated(bytes: Uint8Array | null): boolean | null {
  return bytes === null ? null : tailState(bytes) === "truncated";
}

/** What tier the report should show for a side: read this pass, or not read. */
function byteLevel(bytes: Uint8Array | null): string {
  return bytes ? "E2" : "E0";
}

function judgeSide(
  deps: EngineDeps,
  o2: SideObservation,
  ledger: LedgerEntryView | null,
  nowMs: number,
  side: "local" | "remote",
): { stable: boolean; reason?: string } {
  if (!o2.stat) return { stable: !o2.exists, reason: "absent" };
  const verdict = judgeStability({
    o2: o2.stat,
    ledger: ledger ? { sig: ledger.sig, firstSeenMs: ledger.firstSeenMs } : null,
    nowMs,
    quietMs: side === "local" ? deps.settings.localQuietMs : deps.settings.remoteQuietMs,
    clockSkewToleranceMs: deps.settings.clockSkewToleranceMs,
  });
  return verdict.stable ? { stable: true } : { stable: false, reason: verdict.reason ?? "unstable" };
}

async function readBytes(deps: EngineDeps, target: string): Promise<Uint8Array | null> {
  try {
    return await deps.fs.readFile(target);
  } catch (error) {
    const code = errnoOf(error);
    if (!code || !CATCHABLE_IO.has(code)) throw error;
    return null;
  }
}

function facts(
  deps: EngineDeps,
  observation: SideObservation,
  bytes: Uint8Array | null,
  stable: boolean,
): SideFacts {
  return {
    exists: observation.exists,
    size: observation.stat?.size ?? 0,
    observedHash: bytes ? deps.hashBytes(bytes) : "",
    stable,
    tail: bytes ? tailState(bytes) : "lf-terminated",
    isPlaceholder: false,
  };
}

/** Byte comparison, and the one place `not-line-aligned` is resolved (§7.4.1). */
function relate(localBytes: Uint8Array | null, remoteBytes: Uint8Array | null): PlanInput["relation"] {
  if (!localBytes || !remoteBytes) return "n/a";
  if (localBytes.length === remoteBytes.length) {
    return indexOfDifference(localBytes, remoteBytes) === -1 ? "equal" : "divergent";
  }
  const localShorter = localBytes.length < remoteBytes.length;
  const [short, long] = localShorter ? [localBytes, remoteBytes] : [remoteBytes, localBytes];
  const verdict = comparePrefix(short, long);

  if (verdict.verdict === "not-line-aligned") {
    if (resolveNotLineAligned(short) !== "prefix") return "divergent";
  } else if (verdict.verdict !== "prefix") {
    return "divergent";
  }
  return localShorter ? "r-extends-l" : "l-extends-r";
}

function indexOfDifference(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

/**
 * The O3/O5 recheck of §9.1.4: is this still the same file, byte for byte?
 *
 * Delegates to `signaturesEqual` rather than comparing fields here, so the
 * engine cannot drift from the ledger's notion of sameness. `ino` is the part
 * that matters and the part a hand-rolled comparison forgets: it is the only
 * signal that the path was replaced by a *different* file — a rename-over or a
 * delete-and-recreate can leave size, both timestamps and the tail identical.
 */
function sameSignature(a: E0Signature | null, b: E0Signature | null): boolean {
  if (a === null || b === null) return a === b;
  return signaturesEqual(a, b);
}

function countLines(bytes: Uint8Array): number {
  let count = 0;
  for (const byte of bytes) if (byte === 0x0a) count++;
  return count;
}

/**
 * @param truncated Whether this side's last record was incomplete, or null when
 * the side was not read and there is nothing to say. A null keeps the streak as
 * it stands: an unread side is not evidence the file recovered.
 */
function recordLedger(
  deps: EngineDeps,
  neutralRel: string,
  side: "local" | "remote",
  observation: SideObservation,
  nowMs: number,
  truncated: boolean | null,
): void {
  if (!observation.stat) return;
  const previous = side === "local" ? deps.ledger.local(neutralRel) : deps.ledger.remote(neutralRel);
  // `signaturesEqual`, not a subset of it (OQ-21). This used to compare size,
  // tailHash and mtime — three of the five components the stability gate
  // compares — so a replacement that kept the content and the timestamp, which
  // is exactly the shape of an atomic rename, was *changed* to one and
  // *unchanged* to the other. The ledger then kept the old first-sighting and
  // the next pass credited the file with a quiet window it never waited out.
  // Two definitions of "the same file" in one module is a bug whichever one is
  // right.
  const unchanged = previous !== null && signaturesEqual(previous.sig, observation.stat);

  // The same clamp §9.1.2 applies, for the same reason and now in the place
  // that persists. `judgeStability` restarts a first-sighting that sits in the
  // future — "a bounded wait, not a permanent defer" — but its verdict was
  // recomputed here rather than used, so the future value was written straight
  // back and the correction never survived the pass that made it.
  const carried = unchanged ? previous.firstSeenMs : nowMs;
  const streak = previous?.truncatedTailPasses ?? 0;
  deps.ledger.record(neutralRel, side, {
    sig: observation.stat,
    firstSeenMs: carried > nowMs + deps.settings.clockSkewToleranceMs ? nowMs : carried,
    // Consecutive, so a single good pass clears it — the flag is about a file
    // that stays broken, not one that was caught mid-write once.
    truncatedTailPasses: truncated === null ? streak : truncated ? streak + 1 : 0,
    remoteHadNonZeroSize:
      (previous?.remoteHadNonZeroSize ?? false) || (side === "remote" && observation.stat.size > 0),
  });
}

/**
 * Every file in the replica, with the adapter whose subtree it was found in.
 *
 * Two things this deliberately does not do. It does not flatten: a provider
 * whose layout is nested (Codex shards by date) has files the previous
 * one-level listing could not see at all, and "invisible" for a pull means a
 * session that simply never arrives. And it does not decide what a file *is* —
 * that is `classifyNeutral`'s job, one caller up, where a rejection can be
 * reported instead of silently dropped.
 *
 * Transfer leftovers are skipped rather than reported: `.part`/`.tmp` files
 * appear and vanish between passes by design, and a report that lists them
 * every pass trains the user to stop reading it (§8.2's ignore list).
 */
async function listReplicaFiles(
  deps: EngineDeps,
): Promise<Array<{ adapter: ProviderAdapter; rel: string; siblings: readonly string[] }>> {
  const base = deps.joinPath(deps.replicaRoot, deps.workspaceId);
  const found: Array<{ adapter: ProviderAdapter; rel: string; siblings: readonly string[] }> = [];

  for (const adapter of deps.adapters) {
    await walk(adapter, deps.joinPath(base, adapter.id), adapter.id, 1);
  }
  return found;

  async function walk(
    adapter: ProviderAdapter,
    dir: string,
    rel: string,
    depth: number,
  ): Promise<void> {
    const entries = await deps.fs.readDir(dir).catch(() => []);
    const siblings = entries.filter((item) => item.isFile).map((item) => item.name);
    for (const item of entries) {
      if (isTransferArtifact(item.name) || isDenylisted(item.name)) continue;
      const childRel = `${rel}/${item.name}`;
      if (item.isFile) {
        found.push({ adapter, rel: childRel, siblings });
        continue;
      }
      // One below MAX_DEPTH, because the workspace id is a segment too and a
      // path this walk cannot hand to `parseNeutralRel` is a path we should not
      // have collected in the first place.
      if (depth + 1 < MAX_DEPTH) await walk(adapter, deps.joinPath(dir, item.name), childRel, depth + 1);
    }
  }
}

function pullingAction(action: Action): boolean {
  return action === "PULL_NEW" || action === "PULL_OVERWRITE";
}

function errnoOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/**
 * The order a group's files are written in: primary last (§6.6, §6.6.1).
 *
 * G1 says the primary is the group's only visibility switch, so as long as it
 * lands after everything else, a session that is being created is invisible to
 * the CLI until it is complete. That is the whole of the atomicity Grok's
 * measurement showed is needed — a torn *update* self-heals, a torn *creation*
 * would not, and this ordering is what prevents the second.
 *
 * `derived` members are already excluded: they are refused above, and no
 * adapter lists them.
 */
function orderedForCommit(group: SessionGroup): SessionFileRef[] {
  const syncable = group.files.filter((file) => file.mode !== "derived");
  return [
    ...syncable.filter((file) => file.role !== "primary"),
    ...syncable.filter((file) => file.role === "primary"),
  ];
}

interface WitnessOutcome {
  /** A sibling in the replica holds exactly this machine's current bytes. */
  readonly found: boolean;
  /** Where that sibling is, so the conflict can name it. */
  readonly copyRel: string | null;
  /** A candidate existed and could not be read; the errno, or null. */
  readonly unreadable: string | null;
}

/**
 * Looks for this machine's own bytes set aside under another name (OQ-18).
 *
 * The question this answers is the one `planOpaque` cannot: inside #4b the
 * local side still holds the converged base, and a remote that has moved off
 * it is produced *identically* by a peer editing after receiving our version
 * and by the sync tool discarding our push. The two executions leave the same
 * bytes and the same observation history, so no function of them is right in
 * both (ADR-57). What differs is what the transport left in the folder: when
 * it had to choose, it renamed the loser aside, and if those bytes are ours
 * then ours is what was discarded.
 *
 * Candidates come from the *insertion relation*, not from
 * `classifyExternalArtifact`'s confidence ladder — the only artifact ever seen
 * in the field lands on that ladder's medium rung, and a `high`-only gate
 * would have missed the exact case this exists for. The classifier stays an
 * explainer; the bytes are the boundary.
 */
async function findDisplacedPush(
  deps: EngineDeps,
  neutralRel: string,
  siblingsByDir: Map<string, readonly string[]>,
  localHash: string | null,
): Promise<WitnessOutcome> {
  if (localHash === null) return { found: false, copyRel: null, unreadable: null };
  const cut = neutralRel.lastIndexOf("/");
  const dirRel = neutralRel.slice(0, cut);
  const bareName = neutralRel.slice(cut + 1);
  const siblings = siblingsByDir.get(dirRel) ?? [];

  const candidates = siblings
    .filter(
      (name) =>
        name !== bareName &&
        insertionBetween(bareName, name) !== null &&
        !isTransferArtifact(name) &&
        !isDenylisted(name),
    )
    .sort()
    // Capped: a folder full of copies is a folder to tell the user about, not
    // one to read exhaustively on every #4b.
    .slice(0, 4);

  let unreadable: string | null = null;
  for (const name of candidates) {
    const path = deps.joinPath(deps.replicaRoot, deps.workspaceId, dirRel, name);
    const stat = await deps.fs.lstat(path);
    if (stat === null || !stat.isFile) continue;
    if (stat.size === 0 || stat.size > deps.settings.maxFileSizeBytes) continue;
    const bytes = await readBytes(deps, path);
    if (bytes === null) {
      unreadable ??= "unreadable";
      continue;
    }
    if (deps.hashBytes(bytes) === localHash) return { found: true, copyRel: `${dirRel}/${name}`, unreadable: null };
  }
  return { found: false, copyRel: null, unreadable };
}

/**
 * One signature for a whole session's liveness (§9.1, OQ-17).
 *
 * `lstat` only — no tail read. A session that is being written changes size
 * every fraction of a second (Grok's `events.jsonl` grew by hundreds of bytes
 * roughly ten times a second in the measurement), so size and the two
 * timestamps decide it, and reading a tail from a dozen files per session per
 * pass would buy nothing. The per-file check keeps its tail hash: this is the
 * belt, that is the braces.
 *
 * Composed rather than compared pairwise so `judgeStability` can be reused
 * unchanged: any member appearing, vanishing, growing or being replaced moves
 * the composite, and the quiet window then measures how long the *session* has
 * been still rather than how long one of its files has.
 */
async function observeGroupActivity(deps: EngineDeps, group: SessionGroup): Promise<E0Signature> {
  const parts: string[] = [];
  let size = 0;
  let mtimeMs = 0;
  let ctimeMs = 0;
  for (const path of [...(group.witnessPaths ?? [])].sort()) {
    const st = await deps.fs.lstat(path);
    if (st === null || !st.isFile) continue;
    size += st.size;
    mtimeMs = Math.max(mtimeMs, st.mtimeMs);
    ctimeMs = Math.max(ctimeMs, st.ctimeMs);
    parts.push(`${path}:${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino ?? 0}`);
  }
  return {
    size,
    mtimeMs,
    ctimeMs,
    // Not a real inode: the composite has no single file behind it. Held
    // constant so `signaturesEqual` is decided by the parts digest below.
    ino: 0,
    tailHash: deps.hashBytes(new TextEncoder().encode(parts.join("\n"))),
  };
}
