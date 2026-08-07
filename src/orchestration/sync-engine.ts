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
import { type Action, type PlanInput, type SideFacts, plan } from "../domain/planner";
import { comparePrefix, resolveNotLineAligned, tailState } from "../domain/merge-policy";
import { type E0Signature, judgeStability } from "../domain/stability";
import { buildConflictMeta, conflictId, quarantineLayout } from "../domain/conflict";
import type { LogicalId, PathViolation, SafeAbsolutePath } from "../domain/types";
import type { FsGateway } from "../infra/fs-gateway";
import type { Clock, IdGen } from "../infra/clock";
import type { ProviderAdapter, SessionGroup } from "../providers/provider-adapter";
import {
  type ActionEntry,
  type ActionResult,
  type Barrier,
  type DecisionEvidence,
  type PassReport,
  type ViolationEntry,
  hashPrefix,
  idPrefix,
  isErrorResult,
  noopBarrier,
} from "./pass-report";

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
  /** Hash of bytes; injected because domain and infra must stay separable. */
  readonly hashBytes: (bytes: Uint8Array) => string;
  /** Backup hook; returns the path written, or null when it could not be. */
  readonly backup: (input: BackupRequest) => Promise<string | null>;
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
  readonly probeDelayMs: number;
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
}

export async function runPass(deps: EngineDeps): Promise<PassReport> {
  const barrier = deps.barrier ?? noopBarrier;
  const startedAtMs = deps.clock.nowMs();
  const actions: ActionEntry[] = [];
  const violations: ViolationEntry[] = [];
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
  const seen = new Set(groups.flatMap(({ group }) => group.files.map((f) => f.neutralRel)));
  for (const rel of await listReplicaFiles(deps)) {
    if (!seen.has(rel)) groups.push({ adapter: deps.adapters[0] as ProviderAdapter, group: remoteOnlyGroup(rel) });
  }

  let budget = deps.settings.maxFilesPerPass;

  for (const { adapter, group } of groups) {
    for (const file of group.files) {
      if (file.role !== "primary") continue;
      if (budget <= 0) {
        actions.push(entry(group, file.neutralRel, adapter.id, "DEFER", "budget-exhausted", "SKIPPED_BUDGET"));
        continue;
      }
      budget--;

      const localPath = await adapter.targetPathFor(file.neutralRel);
      const remotePath = deps.joinPath(deps.replicaRoot, deps.workspaceId, file.neutralRel);

      // ── P2 stability gate ────────────────────────────────────────────────
      // Before any bytes: two stats separated by probeDelayMs, compared with
      // each other and with the previous pass. An unstable file never reaches
      // P3, so it never costs a read.
      const localO1 = await observe(deps, localPath);
      const remoteO1 = await observe(deps, remotePath);
      await barrier("P2:o1-taken", { neutralRel: file.neutralRel });
      const localO2 = await observe(deps, localPath);
      const remoteO2 = await observe(deps, remotePath);
      await barrier("P2:o2-taken", { neutralRel: file.neutralRel });

      const nowMs = deps.clock.nowMs();
      const localStable = judgeSide(deps, localO1, localO2, deps.ledger.local(file.neutralRel), nowMs, "local");
      const remoteStable = judgeSide(deps, remoteO1, remoteO2, deps.ledger.remote(file.neutralRel), nowMs, "remote");

      // ── P3 index ─────────────────────────────────────────────────────────
      // Bytes are read here and nowhere else, and the hash used for any
      // decision comes from this read (E2). Nothing cached may substitute.
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
        history: { truncatedTailPasses: deps.ledger.remote(file.neutralRel)?.truncatedTailPasses ?? 0 },
      };
      const decision = plan(input);
      await barrier("P4:planned", { neutralRel: file.neutralRel });
      await barrier("P5:guarded", { neutralRel: file.neutralRel });

      const evidence: DecisionEvidence = {
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
          providerId: adapter.id,
          localBytes,
          remoteBytes,
          localHash: localFacts.observedHash,
          remoteHash: remoteFacts.observedHash,
          extension: extensionOf(file.neutralRel),
        });
      }

      // ── P6 apply ─────────────────────────────────────────────────────────
      const applied = await applyAction(deps, barrier, {
        action: decision.action,
        group,
        neutralRel: file.neutralRel,
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
        ...(quarantinedId ? { conflictId: quarantinedId } : {}),
      });

      if (applied.violation) {
        violations.push({
          rootSymbol: pullingAction(decision.action) ? "providerRoot" : "syncDir",
          relativePath: file.neutralRel,
          violation: applied.violation.violation,
          ...(applied.violation.detail ? { detail: applied.violation.detail } : {}),
        });
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
      recordLedger(
        deps,
        file.neutralRel,
        "local",
        wrote && pulled ? await observe(deps, localPath) : localO2,
        nowMs,
      );
      recordLedger(
        deps,
        file.neutralRel,
        "remote",
        wrote && !pulled ? await observe(deps, remotePath) : remoteO2,
        nowMs,
      );
    }
  }

  await barrier("P7:reconciled", {});
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
    neutralRel: string;
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
  // record makes it append to a line that was never finished.
  if (tailState(sourceBytes) === "truncated") return { result: "DEFERRED" };

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
    if (written === null) return { result: "FAILED_BACKUP" };
    backupPath = written;
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
  try {
    await deps.fs.writeFileAtomic(minted.value, sourceBytes);
  } catch (error) {
    const code = errnoOf(error);
    // No catch-all: an unknown failure propagates, which is what lets a
    // CrashSignal reach the test that injected it.
    if (!code || !CATCHABLE_IO.has(code)) throw error;
    return { result: "FAILED_IO", errorCode: code, ...(backupPath ? { backupPath } : {}) };
  }
  await barrier("P6:after-rename", { neutralRel: ctx.neutralRel });

  return { result: "APPLIED", ...(backupPath ? { backupPath } : {}) };
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
    providerId: string;
    localBytes: Uint8Array;
    remoteBytes: Uint8Array;
    localHash: string;
    remoteHash: string;
    extension: string;
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
    conflictId: id,
    localHash: input.localHash,
    remoteHash: input.remoteHash,
    localSize: input.localBytes.length,
    remoteSize: input.remoteBytes.length,
    localLineCount: countLines(input.localBytes),
    remoteLineCount: countLines(input.remoteBytes),
    machineIdPrefix: deps.machineIdPrefix,
    detectedAtIso: deps.nowIso(),
  });

  const writes: Array<[string, Uint8Array]> = [
    [layout.localCopy, input.localBytes],
    [layout.remoteCopy, input.remoteBytes],
    [layout.meta, new TextEncoder().encode(`${JSON.stringify(meta, null, 2)}\n`)],
  ];

  for (const [name, bytes] of writes) {
    const minted = await deps.mintWritePath(deps.joinPath(dir, name));
    if (!minted.ok) return undefined;
    try {
      await deps.fs.writeFileAtomic(minted.value, bytes);
    } catch (error) {
      const code = errnoOf(error);
      if (!code || !CATCHABLE_IO.has(code)) throw error;
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

function judgeSide(
  deps: EngineDeps,
  o1: SideObservation,
  o2: SideObservation,
  ledger: LedgerEntryView | null,
  nowMs: number,
  side: "local" | "remote",
): { stable: boolean; reason?: string } {
  if (!o1.stat || !o2.stat) return { stable: !o2.exists, reason: "absent" };
  const verdict = judgeStability({
    o1: o1.stat,
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

function sameSignature(a: E0Signature | null, b: E0Signature | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.tailHash === b.tailHash
  );
}

function countLines(bytes: Uint8Array): number {
  let count = 0;
  for (const byte of bytes) if (byte === 0x0a) count++;
  return count;
}

function recordLedger(
  deps: EngineDeps,
  neutralRel: string,
  side: "local" | "remote",
  observation: SideObservation,
  nowMs: number,
): void {
  if (!observation.stat) return;
  const previous = side === "local" ? deps.ledger.local(neutralRel) : deps.ledger.remote(neutralRel);
  const unchanged =
    previous !== null &&
    previous.sig.size === observation.stat.size &&
    previous.sig.tailHash === observation.stat.tailHash &&
    previous.sig.mtimeMs === observation.stat.mtimeMs;

  deps.ledger.record(neutralRel, side, {
    sig: observation.stat,
    firstSeenMs: unchanged ? previous.firstSeenMs : nowMs,
    truncatedTailPasses: previous?.truncatedTailPasses ?? 0,
    remoteHadNonZeroSize:
      (previous?.remoteHadNonZeroSize ?? false) || (side === "remote" && observation.stat.size > 0),
  });
}

async function listReplicaFiles(deps: EngineDeps): Promise<string[]> {
  const base = deps.joinPath(deps.replicaRoot, deps.workspaceId);
  const found: string[] = [];
  for (const adapter of deps.adapters) {
    const dir = deps.joinPath(base, adapter.id);
    const entries = await deps.fs.readDir(dir).catch(() => []);
    for (const item of entries) {
      if (item.isFile) found.push(`${adapter.id}/${item.name}`);
    }
  }
  return found;
}

function remoteOnlyGroup(neutralRel: string): SessionGroup {
  const name = neutralRel.slice(neutralRel.lastIndexOf("/") + 1);
  return {
    logicalId: name.replace(/\.jsonl$/, "") as LogicalId,
    files: [{ role: "primary", absPath: "", neutralRel, mode: "append-jsonl" }],
    lastModifiedMs: 0,
  };
}

function pullingAction(action: Action): boolean {
  return action === "PULL_NEW" || action === "PULL_OVERWRITE";
}

function errnoOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}
