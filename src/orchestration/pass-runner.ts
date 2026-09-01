/**
 * The composition root: everything a pass needs, assembled and taken down.
 *
 * `runPass` is deliberately ignorant of where its state lives — it is handed a
 * ledger, a cache, a backup hook and a lock. This is where those come from real
 * files, and where the preflight that decides whether a pass may run at all
 * happens (architecture §7.1 P0).
 *
 * The order below is the design and is not interchangeable:
 *
 *   roots → overlap → machine identity → binding → workspace identity
 *   → readiness → state load → runPass → commit
 *
 * Every step before `runPass` can abort with **zero writes on either side**,
 * and each is placed where it is because the step after it would otherwise act
 * on something unestablished. Checking readiness before knowing which directory
 * we mean, or writing before proving the four roots do not nest, is how a
 * misconfiguration becomes a sync between the wrong pair of directories.
 */
import { evaluateReadiness } from "../domain/readiness";
import type { NotReadyReason, ReadinessThresholds, RemoteRecord } from "../domain/readiness";
import type { MachineId, WorkspaceId } from "../domain/types";
import type { Clock, IdGen } from "../infra/clock";
import type { FsGateway } from "../infra/fs-gateway";
import type { HomeStore, WorkspaceBinding } from "../infra/home-store";
import { createBackupWriter } from "../infra/backup-writer";
import { type PathGuardDeps, findRootOverlaps, resolveUnderRoot } from "../infra/path-guard";
import {
  type SyncDirStore,
  SUPPORTED_FORMAT_VERSION,
  manifestIsWritable,
  manifestOrEmpty,
} from "../infra/sync-dir-store";
import type { ProviderAdapter } from "../providers/provider-adapter";
import { type PassReport, type Barrier } from "./pass-report";
import { type EngineDeps, type MintOutcome, runPass } from "./sync-engine";
import { type ScrubContext, createPassState, recordOutcomes } from "./state-adapters";

/** T6's per-pass sample size (§5.3.3): min(20, 2% of what we know about). */
const SCRUB_SAMPLE_MAX = 20;
const SCRUB_SAMPLE_FRACTION = 0.02;
const DEFAULT_SCRUB_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface PassRunnerDeps {
  /**
   * Run before discovery, inside the pass (ADR-69).
   *
   * Sharing a conversation record moves a file in the vault, which changes
   * what this same pass will admit — so it belongs before P1 rather than in a
   * separate call outside the lock, where it had a check-then-write window
   * against Claudian, the peer and the engine itself. Returns notices to fold
   * into the report.
   */
  readonly beforeDiscover?: () => Promise<readonly string[]>;
  readonly fs: FsGateway;
  readonly guard: PathGuardDeps;
  readonly clock: Clock;
  readonly ids: IdGen;
  readonly joinPath: (...parts: string[]) => string;
  readonly hashBytes: (bytes: Uint8Array) => string;

  readonly home: HomeStore;
  readonly syncDir: SyncDirStore;
  readonly binding: WorkspaceBinding;
  readonly machineId: MachineId;
  readonly workspaceId: WorkspaceId;

  /** Adapters plus the root each may write into, both already realpath'd. */
  readonly providers: readonly ProviderRuntime[];
  /** Realpath of the vault, for the four-root overlap check. */
  readonly vaultRoot: string;

  readonly settings: PassSettings;
  readonly lock?: EngineDeps["lock"];
  readonly barrier?: Barrier;
  readonly dryRun: boolean;
  /** True on the first pass after Obsidian started (scrub trigger T2). */
  readonly firstPassAfterStartup: boolean;
  readonly msSinceLastStartupScrub: number;
  /** True when the user asked for `Verify all files` (T7). */
  readonly verifyAll: boolean;
  readonly readiness?: ReadinessThresholds;
}

export interface ProviderRuntime {
  readonly adapter: ProviderAdapter;
  /** Realpath of the directory this adapter owns; writes are confined to it. */
  readonly root: string;
}

export interface PassSettings {
  readonly maxFileSizeBytes: number;
  readonly maxFilesPerPass: number;
  readonly localQuietMs: number;
  readonly remoteQuietMs: number;
  readonly clockSkewToleranceMs: number;
  readonly backupKeep: number;
  readonly scrubMaxAgeMs?: number;
}

export interface PassOutcome {
  readonly report: PassReport;
  readonly readiness: RemoteRecord;
  /** Set when the pass never reached the engine. */
  readonly preflight?: PreflightFailure;
}

export type PreflightFailure =
  | { readonly kind: "root-overlap"; readonly detail: string }
  | { readonly kind: "root-not-canonical"; readonly detail: string }
  | { readonly kind: "not-ready"; readonly reason: NotReadyReason }
  | { readonly kind: "await-init" }
  | { readonly kind: "probing" };

/**
 * Runs one pass against real files, from preflight to commit.
 *
 * Returns a report even when nothing ran. "The pass did nothing and here is
 * why" is a result the status bar and the dry-run view both need; throwing
 * would make the caller invent that answer itself.
 */
export async function runWorkspacePass(deps: PassRunnerDeps): Promise<PassOutcome> {
  const nowMs = deps.clock.nowMs();
  const nowIso = new Date(nowMs).toISOString();

  // ── the roots must be canonical ──────────────────────────────────────────
  // Every containment check downstream compares against these strings, and
  // `resolveUnderRoot` refuses anything whose resolved parent falls outside
  // the root it was handed. Give it `/var/folders/...` on a Mac, where the
  // real path is `/private/var/folders/...`, and *every* write is rejected as
  // a symlink violation — technically correct, and completely unreadable as a
  // diagnosis. One check here turns that into one sentence.
  const nonCanonical = await findNonCanonicalRoots(deps);
  if (nonCanonical !== null) {
    return {
      report: abortedReport(nowMs, deps, `root-not-canonical: ${nonCanonical}`),
      readiness: await deps.home.loadRemote(deps.workspaceId, deps.binding.syncDirPath),
      preflight: { kind: "root-not-canonical", detail: nonCanonical },
    };
  }

  // ── four-root overlap (§9.7.5) ───────────────────────────────────────────
  // Before anything reads or writes: nested roots make every later guarantee
  // meaningless, because "inside the sync directory" and "inside the provider
  // directory" stop being different questions.
  const overlaps = findRootOverlaps(deps.guard, [
    { name: "vault", realPath: deps.vaultRoot },
    { name: "syncDir", realPath: deps.binding.syncDirPath },
    { name: "backupDir", realPath: deps.home.layout.backupsDir },
    ...deps.providers.map((p) => ({ name: `provider:${p.adapter.id}`, realPath: p.root })),
  ]).filter(
    // The one containment that is definitional rather than a misconfiguration
    // (ADR-48): the claudian provider's root IS inside the vault — its files
    // are the vault-side records everything else's admission reads. Every
    // other pair stays fatal, including this provider against the sync or
    // backup directory, and including any OTHER provider inside the vault:
    // this is an exemption for one measured fact, not a loosened rule.
    (o) => !(o.a === "vault" && o.b === "provider:claudian" && o.relation === "a-contains-b"),
  );
  if (overlaps.length > 0) {
    const detail = overlaps.map((o) => `${o.a} ${o.relation} ${o.b}`).join("; ");
    return {
      report: abortedReport(nowMs, deps, `root-overlap: ${detail}`),
      readiness: await deps.home.loadRemote(deps.workspaceId, deps.binding.syncDirPath),
      preflight: { kind: "root-overlap", detail },
    };
  }

  // ── state, loaded before readiness because NR-8 needs it ─────────────────
  // "This remote file used to have content" is a fact only the ledger holds,
  // and NR-8 is the question "and now it is empty?". Reading the ledger first
  // costs nothing — it is a local file and the pass needs it regardless.
  const fingerprint = deps.hashBytes(new TextEncoder().encode(deps.binding.syncDirPath));
  const loaded = await deps.home.loadObservations({
    workspaceId: deps.workspaceId,
    machineId: deps.machineId,
    syncDirFingerprint: fingerprint,
  });

  // ── readiness (§9.6) ─────────────────────────────────────────────────────
  const previous = await deps.home.loadRemote(deps.workspaceId, deps.binding.syncDirPath);
  const reachable = await deps.syncDir.reachable();
  const root = reachable ? await deps.syncDir.readRoot() : ({ status: "missing" } as const);
  const scan = reachable
    ? await deps.syncDir.scanWorkspace(deps.workspaceId)
    : { counts: { files: 0, bytes: 0 }, zeroByteRels: [] };
  const verdict = evaluateReadiness(
    previous,
    {
      reachable,
      root,
      syncDirEmpty: reachable ? await deps.syncDir.isEmpty() : false,
      workspaceSubtreeExists: reachable
        ? await deps.syncDir.workspaceSubtreeExists(deps.workspaceId)
        : false,
      counts: scan.counts,
      // NR-8: a file the ledger saw with bytes is now empty. That is the sync
      // tool doing something wrong — a placeholder, a rollback, an interrupted
      // transfer — and it is a whole-directory signal, not a per-file one.
      remoteRegression: scan.zeroByteRels.some(
        (rel) => loaded.file.remote[rel]?.remoteHadNonZeroSize === true,
      ),
      nowMs,
    },
    SUPPORTED_FORMAT_VERSION,
    deps.readiness,
  );

  // The write probe is only asked once `root.json` is there. Asking earlier
  // would create `.aiss/` in a directory the user has not initialised, and the
  // next pass would then read that as "not empty" and refuse to offer them the
  // one button that unblocks it.
  //
  // A dry run does not probe at all. The probe writes a file and deletes it,
  // which leaves no net change but is still a write — and ADR-27 makes dry-run
  // absolutely read-only precisely so that "the trees are byte-identical
  // afterwards" is a claim with no exceptions to remember. What it uses
  // instead is the last real pass's answer: writability was proved then, and a
  // dry run's job is to report what a real pass would do, not to re-prove it.
  const writable = deps.dryRun
    ? previous.state === "READY"
    : verdict.state === "READY" || verdict.state === "PROBING"
      ? await deps.syncDir.probeWritable(deps.machineId)
      : false;

  const record: RemoteRecord =
    verdict.state === "READY" && !writable
      ? { ...verdict.record, state: "PROBING" }
      : verdict.record;

  // Not persisted on a dry run either: advancing the readiness probe counter
  // is a change to what the *next* pass will decide, which is exactly the kind
  // of side effect "changes nothing" has to exclude.
  if (!deps.dryRun) {
    await deps.home.saveRemote(deps.workspaceId, record, {
      syncDirPath: deps.binding.syncDirPath,
      nowIso,
      initializedAt: root.status === "ok" ? nowIso : null,
    });
  }

  if (record.state === "UNCONFIGURED" || record.state === "AWAIT_INIT") {
    // AWAIT_INIT is read-only *including* the ledger: §7.2 S-16 says an
    // uninitialised sync directory receives nothing at all, not even `.aiss/`.
    return {
      report: abortedReport(nowMs, deps, record.state === "AWAIT_INIT" ? "await-init" : "unconfigured"),
      readiness: record,
      ...(record.state === "AWAIT_INIT" ? { preflight: { kind: "await-init" as const } } : {}),
    };
  }

  const remoteReadiness: EngineDeps["remoteReadiness"] =
    record.state === "READY"
      ? "ready"
      : record.notReadyReason === "NR-4-format-too-new"
        ? "unsupported-format"
        : "not-ready";

  // ── the manifest (§5.3) ──────────────────────────────────────────────────
  const manifestLoad = await deps.syncDir.loadManifest();
  const manifestWritable = manifestIsWritable(manifestLoad);

  const state = createPassState({
    observations: loaded.file,
    manifest: manifestOrEmpty(manifestLoad, nowIso),
    manifestWritable,
    workspaceId: deps.workspaceId,
    machineId: deps.machineId,
    nowMs,
    nowIso,
    scrub: scrubContext(deps, loaded.file.remote, manifestLoad.status !== "ok", previous, record),
  });

  // ── the pass ─────────────────────────────────────────────────────────────
  const backupWriter = createBackupWriter({
    fs: deps.fs,
    home: deps.home,
    joinPath: deps.joinPath,
    hashBytes: deps.hashBytes,
    nowMs: () => deps.clock.nowMs(),
    randomSuffix: () => deps.ids.token(4),
    keep: deps.settings.backupKeep,
  });

  const shareNotices = deps.beforeDiscover ? await deps.beforeDiscover() : [];

  const report = await runPass({
    fs: deps.fs,
    clock: deps.clock,
    ids: deps.ids,
    adapters: deps.providers.map((p) => p.adapter),
    ...(deps.barrier ? { barrier: deps.barrier } : {}),
    replicaRoot: deps.binding.syncDirPath,
    workspaceId: deps.workspaceId,
    joinPath: deps.joinPath,
    settings: deps.settings,
    remoteReadiness,
    dryRun: deps.dryRun,
    ledger: state.ledger,
    evidence: state.evidence,
    hashBytes: deps.hashBytes,
    backup: async (request) => {
      const outcome = await backupWriter.backup({
        sourcePath: request.sourcePath,
        workspaceId: deps.workspaceId,
        providerId: providerOf(request.neutralRel),
        logicalId: request.logicalId,
        remote: request.remote,
        action: request.action,
      });
      // The whole outcome, not just the path: `rotationDeferred` is how the
      // pass learns that retention did not bind (§9.3.3), and dropping it here
      // was why nothing could ever say so.
      return outcome;
    },
    mintWritePath: createWritePathMinter(writeRootsFor(deps)),
    machineIdPrefix: deps.machineId.slice(0, 8),
    ...(deps.lock ? { lock: deps.lock } : {}),
    nowIso: () => new Date(deps.clock.nowMs()).toISOString(),
  });

  // ── commit (§7.1 P8) ─────────────────────────────────────────────────────
  // Unconditional, including after a partial or failed pass: the observations
  // of files that were skipped are what let the next pass make progress on
  // them. A dry run writes nothing, which is the one promise it makes.
  if (!deps.dryRun) {
    const observations = recordOutcomes(
      state,
      report.actions.map((action) => ({
        neutralRel: action.neutralRel,
        action: action.action,
        result: action.result,
      })),
    );
    await deps.home.saveObservations(deps.workspaceId, observations, nowMs);

    const manifest = state.manifest();
    // Not rewritten when a newer client is demonstrably using this directory
    // (§5.3.4), and not written at all unless the remote is ready — a manifest
    // describing a half-hydrated directory is worse than none. Also not
    // written when nothing changed: the manifest is a *shared* file, and two
    // idle machines re-stamping it every timer pass is what the sync tool
    // turns into an endless stream of conflict copies. The exceptions are a
    // manifest that needs re-establishing (absent, or rebuilt from an
    // unusable one) or migrating — those are worth a write with no entries
    // changed.
    if (
      manifest !== null &&
      remoteReadiness === "ready" &&
      (state.manifestChanged() || manifestLoad.status !== "ok")
    ) {
      await deps.syncDir.saveManifest(manifest, nowIso);
    }

    // Re-scan when this pass added to the subtree, and record the new counts.
    //
    // The readiness scan runs before the pass, so without this the recorded
    // counts are always one pass behind whatever we ourselves just wrote —
    // and NR-5 ("the subtree vanished although we recorded files in it") would
    // be blind for exactly one pass after every push. That is one pass in
    // which an emptied sync directory reads as "nothing was ever here", which
    // is the reading the whole state machine exists to refuse. A directory
    // walk on the passes that actually wrote is a cheap price for closing it.
    if (report.actions.some((action) => action.result === "APPLIED" && pushes(action.action))) {
      const after = await deps.syncDir.scanWorkspace(deps.workspaceId);
      await deps.home.saveRemote(
        deps.workspaceId,
        { ...record, lastKnownCounts: maxCounts(record.lastKnownCounts, after.counts) },
        { syncDirPath: deps.binding.syncDirPath, nowIso, initializedAt: nowIso },
      );
    }
  }

  return {
    report:
      shareNotices.length > 0
        ? { ...report, notices: [...shareNotices, ...report.notices] }
        : report,
    readiness: record,
  };
}

/** Just enough to know which roots exist and how to compare paths. */
export interface WriteRoots {
  readonly guard: PathGuardDeps;
  readonly roots: readonly string[];
}

/**
 * Turns an absolute target into a validated path, or refuses it.
 *
 * This is the evil-adapter defence of §8.2 at its narrowest point. An adapter
 * is our code, but it is written to tolerate CLI layouts it has never seen, so
 * a structure change upstream can make it emit a path outside its own root.
 * The target is matched back to a known root and re-resolved through the
 * per-level symlink walk — a path belonging to no root cannot be written at
 * all, because there is no way to obtain the branded type for it.
 *
 * Exported because conflict resolution writes session files too, and a second
 * "simpler" validator would be a second place for a traversal to land.
 */
export function createWritePathMinter(input: WriteRoots): (target: string) => Promise<MintOutcome> {
  return async (target: string) => {
    for (const root of input.roots) {
      const rel = relativeUnder(input.guard, root, target);
      if (rel === null) continue;
      const resolved = await resolveUnderRoot(input.guard, root, rel);
      return resolved.ok
        ? { ok: true, value: resolved.value }
        : {
            ok: false,
            violation: resolved.violation,
            ...(resolved.detail ? { detail: resolved.detail } : {}),
          };
    }
    return { ok: false, violation: "ROOT_OVERLAP", detail: "target belongs to no configured root" };
  };
}

/** Every root this plugin is allowed to write into, for one workspace. */
export function writeRootsFor(deps: PassRunnerDeps): WriteRoots {
  return {
    guard: deps.guard,
    roots: [
      deps.binding.syncDirPath,
      ...deps.providers.map((p) => p.root),
      deps.home.layout.backupsDir,
    ],
  };
}

/** POSIX-separated remainder of `target` under `root`, or null if outside. */
function relativeUnder(guard: PathGuardDeps, root: string, target: string): string | null {
  const rootParts = guard.splitPath(root);
  const targetParts = guard.splitPath(target);
  if (targetParts.length <= rootParts.length) return null;

  const same = (a: string, b: string) =>
    guard.caseSensitive ? a === b : a.toLowerCase() === b.toLowerCase();
  for (const [index, part] of rootParts.entries()) {
    if (!same(part, targetParts[index] ?? "")) return null;
  }
  return targetParts.slice(rootParts.length).join("/");
}

function scrubContext(
  deps: PassRunnerDeps,
  remoteEntries: Readonly<Record<string, unknown>>,
  manifestUnusable: boolean,
  previous: RemoteRecord,
  current: RemoteRecord,
): ScrubContext {
  return {
    maxAgeMs: deps.settings.scrubMaxAgeMs ?? DEFAULT_SCRUB_MAX_AGE_MS,
    firstPassAfterStartup: deps.firstPassAfterStartup,
    msSinceLastStartupScrub: deps.msSinceLastStartupScrub,
    manifestUnusable,
    // T5: coming back from NOT_READY means the directory may have been
    // something else in the meantime, so nothing remembered about it counts.
    justBecameReady: previous.state !== "READY" && current.state === "READY",
    manuallyRequested: deps.verifyAll,
    sampled: sampleForScrub(deps, Object.keys(remoteEntries)),
  };
}

/**
 * T6, the random sample.
 *
 * Its value is that it does not depend on a clock — which matters because a
 * broken clock is one of the conditions T1 is meant to catch, and T1 reads a
 * clock. Selection is by hashing each key with a per-pass token, so it is
 * uniform, reproducible from that token when a test needs it, and needs no
 * `Math.random` (banned outright below the infra layer).
 */
function sampleForScrub(deps: PassRunnerDeps, keys: readonly string[]): ReadonlySet<string> {
  if (keys.length === 0) return new Set();
  const size = Math.min(SCRUB_SAMPLE_MAX, Math.ceil(keys.length * SCRUB_SAMPLE_FRACTION));
  const token = deps.ids.token(8);
  const ranked = [...keys].sort((a, b) =>
    deps.hashBytes(new TextEncoder().encode(token + a)) <
    deps.hashBytes(new TextEncoder().encode(token + b))
      ? -1
      : 1,
  );
  return new Set(ranked.slice(0, size));
}

function abortedReport(nowMs: number, deps: PassRunnerDeps, reason: string): PassReport {
  return {
    startedAtMs: nowMs,
    finishedAtMs: deps.clock.nowMs(),
    outcome: "aborted",
    dryRun: deps.dryRun,
    abortReason: reason,
    actions: [],
    violations: [],
    unknownFiles: [],
    unprovenOmissions: [],
    notices: [],
  };
}

/**
 * Returns a description of the first root that is not its own realpath.
 *
 * Only roots that exist are checked: a sync directory the user has typed but
 * not created yet is the readiness state machine's problem, not this one's,
 * and reporting it here would mask the message that actually helps.
 */
async function findNonCanonicalRoots(deps: PassRunnerDeps): Promise<string | null> {
  const roots: Array<[string, string]> = [
    ["vault", deps.vaultRoot],
    ["syncDir", deps.binding.syncDirPath],
    ...deps.providers.map((p): [string, string] => [`provider:${p.adapter.id}`, p.root]),
  ];
  for (const [name, target] of roots) {
    const real = await deps.fs.realpath(target).catch(() => null);
    if (real === null || samePath(deps, real, target)) continue;
    return `${name} is not a canonical path`;
  }
  return null;
}

function samePath(deps: PassRunnerDeps, a: string, b: string): boolean {
  const [left, right] = deps.guard.caseSensitive ? [a, b] : [a.toLowerCase(), b.toLowerCase()];
  return deps.guard.splitPath(left).join("/") === deps.guard.splitPath(right).join("/");
}

function pushes(action: string): boolean {
  return action === "PUSH_NEW" || action === "PUSH_OVERWRITE";
}

/**
 * The high-water mark, never lowered here.
 *
 * `evaluateReadiness` already keeps counts monotone while things are healthy;
 * repeating the rule at the commit point matters because a scan taken straight
 * after a write can race the sync tool moving a file out from under it, and
 * writing a *smaller* number would arm the shrink detector against our own
 * measurement noise.
 */
function maxCounts(a: RemoteRecord["lastKnownCounts"], b: RemoteRecord["lastKnownCounts"]) {
  return { files: Math.max(a.files, b.files), bytes: Math.max(a.bytes, b.bytes) };
}

function providerOf(neutralRel: string): string {
  const at = neutralRel.indexOf("/");
  return at === -1 ? "" : neutralRel.slice(0, at);
}
