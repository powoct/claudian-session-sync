/**
 * Everything the plugin can do, with no Obsidian types anywhere in it.
 *
 * The UI asks this object questions and tells it to do things; it never
 * reaches past it. That boundary is what keeps the whole plugin runnable in a
 * plain Node test — and it is enforced, not merely intended: lint refuses an
 * `obsidian` import outside `src/ui/` and `src/main.ts` (architecture §4.1).
 *
 * The other rule this file exists to honour: **`onload()` reads nothing.** The
 * sync directory is typically a cloud-drive folder and Obsidian blocks while a
 * plugin loads, so construction is pure and every filesystem access happens in
 * `refresh()` or later, which the host calls once the layout is up
 * (testing.md §12.2c).
 */
import {
  type PortableSettings,
  DEFAULT_SETTINGS,
  parseSettings,
  serialiseSettings,
} from "../domain/settings";
import type { ConflictResolution } from "../domain/conflict";
import {
  type CompatWarnings,
  compatNotices,
  compatWarnings,
  isMarkerless,
  readsLegacySessionFolder,
} from "../domain/claudian-compat";
import { type HoldKind, claudianRecordOf } from "../domain/deleted-here";
import type { NotReadyReason, ReadinessObservation, ReadinessState } from "../domain/readiness";
import type { LogicalId, MachineId, WorkspaceId } from "../domain/types";
import type { Clock, IdGen } from "../infra/clock";
import type { FsGateway } from "../infra/fs-gateway";
import {
  type HomeStore,
  type ProviderBinding,
  type WorkspaceBinding,
  createHomeStore,
  emptyBinding,
} from "../infra/home-store";
import { createBackupWriter } from "../infra/backup-writer";
import { readClaudianVersion } from "../infra/claudian-version";
import type { PathGuardDeps } from "../infra/path-guard";
import { mintStatePath, probeCaseSensitivity, splitPathSegments } from "../infra/path-guard";
import { type MachineFile, STATE_SCHEMA_VERSION } from "../infra/state-store";
import { judgeIdentity } from "../infra/state-store";
import { createSyncDirStore, newRootFile } from "../infra/sync-dir-store";
import { CLAUDE_CODE, PROVIDERS, providerById } from "../providers/registry";
import { claudeCodeProjectDir } from "../providers/claude-code/adapter";
import { archivedPathsFor } from "../providers/provider-adapter";
import {
  type BackupEntry,
  type RestoreOutcome,
  countBackups,
  listBackups,
  restoreBackup,
} from "./restore-commands";
import { type ConflictEntry, listConflicts, resolveConflict } from "./conflict-commands";
import type { PassLock } from "./sync-engine";
import {
  DEVICE_KEY,
  type PublishOutcome,
  type ShareOutcome,
  type SharingHold,
  shareOwnConversations,
} from "./conversation-sharing";
import { createClaudianRecordsState } from "./claudian-records";
import { type HistoryNotHere, type HistoryNotHereResult, findHistoryNotHere } from "./resume-warning";
import { type SyncFolderAudit, auditSyncFolder } from "./sync-folder-audit";
import { type OrphanGroup, type RemoveOutcome, listOrphans, removeOrphan } from "./orphan-commands";
import type { ResolveOutcome } from "./conflict-commands";
import { createFileLock } from "./lock-file";
import type { ClaudianRecordsSummary, PassReport } from "./pass-report";
import {
  type PassOutcome,
  type ProviderRuntime,
  createWritePathMinter,
  runWorkspacePass,
} from "./pass-runner";
import {
  IDENTITY_MESSAGES,
  createWorkspaceIdentity,
  readWorkspaceIdentity,
} from "./workspace-identity";
import type { IdentityOutcome } from "./workspace-identity";

export interface RuntimeHost {
  readonly fs: FsGateway;
  readonly clock: Clock;
  readonly ids: IdGen;
  readonly joinPath: (...parts: string[]) => string;
  readonly dirnameOf: (target: string) => string;
  readonly hashBytes: (bytes: Uint8Array) => string;
  /**
   * This machine's Claudian installation key, when it can be read (ADR-67).
   *
   * Claudian derives it as `device-` + sha256 of a seed it keeps in
   * `localStorage`, and Obsidian gives every plugin the same renderer — so
   * this machine can compute its own key without any of it crossing a
   * machine boundary. Optional, and null whenever Claudian has not run here.
   */
  readonly claudianDeviceKey?: () => string | null;
  readonly platform: string;
  readonly hostname: string;
  readonly homedir: string;
  /** Realpath of the vault. Resolved by the caller, which owns the host API. */
  readonly vaultRoot: string;
  /**
   * Obsidian's config folder name (`app.vault.configDir`, normally `.obsidian`).
   *
   * Only used to read which Claudian is installed. Optional: without it the
   * version is unknown, and unknown means no compatibility warning at all.
   */
  readonly configDir?: string;
  readonly pid: number;
  /** Obsidian's `loadData` / `saveData`; the vault-side portable settings. */
  loadSettings(): Promise<unknown>;
  saveSettings(value: unknown): Promise<void>;
  /**
   * Shows a directory in the desktop file manager (§9.3.4).
   *
   * Injected rather than called, like every other outside effect: the runtime
   * stays runnable in a plain Node test, and the one file that knows about
   * Electron stays the one file that knows about Obsidian. Returns false when
   * the platform refused — the caller then says where the folder is instead of
   * claiming to have opened it.
   */
  openFolder(target: string): Promise<boolean>;
}

/**
 * Which of the plugin's mutually exclusive situations we are in.
 *
 * A flat list rather than nested booleans because the status bar and the
 * settings tab both need "what is going on" as a single answer, and every one
 * of these needs a different sentence and a different next step.
 */
export type RuntimePhase =
  | "loading"
  | "no-sync-dir"
  | "identity-required"
  | "identity-blocked"
  | "await-init"
  | "probing"
  | "not-ready"
  | "ready"
  | "syncing"
  | "error";

export interface RuntimeStatus {
  readonly phase: RuntimePhase;
  /** One line, for the status bar. */
  readonly short: string;
  /** A paragraph the settings tab can show, ending in what to do next. */
  readonly detail: string;
  readonly workspaceId: string | null;
  readonly syncDirPath: string | null;
  readonly readiness: ReadinessState;
  readonly notReadyReason: NotReadyReason | null;
  readonly lastPassAtMs: number | null;
  readonly lastSummary: string | null;
  readonly conflicts: number;
  readonly machineLabel: string | null;
}

const IDLE: RuntimeStatus = {
  phase: "loading",
  short: "Claudian Session Sync: starting",
  detail: "Reading local state.",
  workspaceId: null,
  syncDirPath: null,
  readiness: "UNCONFIGURED",
  notReadyReason: null,
  lastPassAtMs: null,
  lastSummary: null,
  conflicts: 0,
  machineLabel: null,
};

export class PluginRuntime {
  private settings: PortableSettings = DEFAULT_SETTINGS;
  private unknownSettings: Readonly<Record<string, unknown>> = {};
  private status: RuntimeStatus = IDLE;
  private machine: MachineFile | null = null;
  /**
   * The identity write the last `refresh` declined to make, as a sentence.
   *
   * Recomputed on every refresh rather than consumed, so it always describes
   * the current state: null the moment an identity is loaded or persisted.
   */
  private identityWithheld: string | null = null;
  /**
   * Claudian's manifest version as last read, or null when it could not be.
   *
   * Re-read before every pass as well as on refresh: Obsidian updates plugins
   * without a restart, and the warning it feeds is about the version running
   * now.
   */
  private claudianVersion: string | null = null;
  private binding: WorkspaceBinding | null = null;
  private identity: IdentityOutcome | null = null;
  private lastReport: PassReport | null = null;
  /**
   * Sessions known to be in conflict, surviving passes that cannot judge.
   *
   * A single pass report is the wrong source for the conflict count on its
   * own: a pass that DEFERs a divergent pair — a side still inside its quiet
   * window — emits no CONFLICT action, and counting only the report made the
   * status bar say "up to date" over a disagreement it had reported one pass
   * earlier (observed on the real-machine re-run, right after a resolution
   * failed). So the count is sticky: a CONFLICT adds the session, and only
   * first-hand evidence that the disagreement is over removes it — the pair
   * observed equal, an overwrite applied, or a resolution this runtime
   * performed itself. A DEFER changes nothing, which is the point.
   */
  private readonly conflicted = new Set<string>();
  private guard: PathGuardDeps | null = null;
  private home: HomeStore | null = null;
  private passInFlight = false;
  private startedAtMs: number;
  private firstPassDone = false;
  /** Last pass's forks, so the repair screen has something before it re-scans. */
  private sharingHolds: readonly SharingHold[] = [];
  /**
   * What real passes have had to say out loud (ADR-78 H7), until the host
   * shows it. A queue, not the last pass's: a pass started by a command —
   * bring-back, a restore, a resolution — has nobody waiting to show its
   * pop-up, and the hold it announced is already marked announced.
   */
  private announcements: string[] = [];
  /**
   * ADR-81's memory, in three parts, all in memory: a restart is when
   * Claudian reads its records again and reopens tabs, which is exactly when
   * the warning is worth repeating.
   *
   * `notHereKnown` is the last answer a real pass got — null until the first
   * one this run — and `notHereAsked` whether a real pass has asked at all,
   * answered or not. `warnedNotHere` is who the user has been shown a pop-up for;
   * a conversation leaves it when it is no longer at risk, so one that comes
   * back is news again. `pendingNotHere` is the pop-up the last real pass asks
   * for — replaced, not queued, so a pop-up a commanded pass asked for and
   * nobody showed is never shown after the transcript has landed.
   */
  private notHereKnown: ReadonlyMap<string, HistoryNotHere> | null = null;
  private notHereAsked = false;
  private warnedNotHere: ReadonlySet<string> = new Set();
  private pendingNotHere: readonly HistoryNotHere[] = [];
  private readonly listeners = new Set<(status: RuntimeStatus) => void>();

  constructor(private readonly host: RuntimeHost) {
    // Construction is pure on purpose: no read here can be worth blocking
    // Obsidian's startup for.
    this.startedAtMs = host.clock.nowMs();
  }

  currentStatus(): RuntimeStatus {
    return this.status;
  }

  currentSettings(): PortableSettings {
    return this.settings;
  }

  lastPassReport(): PassReport | null {
    return this.lastReport;
  }

  /**
   * The pop-up the last pass asked for, handed over once.
   *
   * Separate from the report because the report is read when someone opens
   * it, and these are the passes where someone should: a conversation was
   * kept off this device, or brought back without being asked for.
   */
  takeAnnouncement(): string | null {
    const parts = [...this.announcements];
    if (this.pendingNotHere.length > 0) {
      parts.push(announceHistoryNotHere(this.pendingNotHere));
      this.warnedNotHere = new Set([...this.warnedNotHere, ...this.pendingNotHere.map((entry) => entry.conversationId)]);
      this.pendingNotHere = [];
    }
    this.announcements = [];
    if (parts.length === 0) return null;
    return `Claudian Session Sync: ${parts.join(" ")} Details in the sync report.`;
  }

  onChange(listener: (status: RuntimeStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Reads state and recomputes the status. Safe to call repeatedly.
   *
   * `persistIdentity: false` is how a dry run gets its machine identity without
   * writing one (§7.6). It is a parameter rather than a setting because
   * `dryRun` is decided per pass, and this is the only write `refresh` makes.
   */
  async refresh(options: { readonly persistIdentity?: boolean } = {}): Promise<RuntimeStatus> {
    const settings = parseSettings(await this.host.loadSettings());
    this.settings = settings.settings;
    this.unknownSettings = settings.unknown;

    const home = await this.homeStore();
    const identity = await this.loadOrCreateMachine(home, options.persistIdentity ?? true);
    this.machine = identity.machine;
    this.identityWithheld = identity.withheld;
    await this.detectClaudian();

    // The vault answers "which workspace is this" (§5.2.3); this machine's
    // binding answers "and where does it sync to". Both, or nothing happens.
    // Read once with no bound id so the vault's own claim is available: with a
    // bound id supplied, a mismatch returns CHANGED and withholds the file,
    // which is the very thing that made the selection below impossible.
    const vaultClaimsId = (await readWorkspaceIdentity(await this.identityDeps(), null)).file?.workspaceId ?? null;
    const bound = await this.boundWorkspaceId(home, vaultClaimsId);
    this.identity = await readWorkspaceIdentity(await this.identityDeps(), bound);
    const workspaceId = this.identity.file?.workspaceId ?? bound;
    this.binding = workspaceId ? await this.loadBinding(home, workspaceId) : null;

    return this.publish(await this.computeStatus());
  }

  /**
   * Runs one pass.
   *
   * Returns the status rather than the report so a caller that only wants to
   * update a status bar does not have to interpret one; `lastPassReport()` is
   * there for the caller that does.
   */
  async syncNow(options: { dryRun?: boolean; verifyAll?: boolean } = {}): Promise<RuntimeStatus> {
    const prepared = await this.prepare({ dryRun: options.dryRun ?? false });
    if (!prepared.ok) return this.publish(prepared.status);
    if (this.passInFlight) return this.status;
    await this.detectClaudian();
    // After the version is read, because whether a `.deleted.json` may be
    // published depends on it.
    const claudianRecords = this.claudianRecordsProbes(prepared.deps.providers);

    this.publish({ ...this.status, phase: "syncing", short: "Claudian Session Sync: syncing…" });
    try {
      const outcome = await runWorkspacePass({
        ...prepared.deps,
        // Inside the pass, so it holds the same lock every other write here
        // does (ADR-69; the review found the first version running outside it,
        // with a check-then-write window against the peer, Claudian and the
        // engine itself). A dry run moves nothing.
        ...(this.binding?.shareConversations === true && !(options.dryRun ?? false)
          ? { beforeDiscover: (lock?: PassLock) => this.shareConversations(lock) }
          : {}),
        ...(claudianRecords ? { claudianRecords } : {}),
        dryRun: options.dryRun ?? false,
        verifyAll: options.verifyAll ?? false,
        firstPassAfterStartup: !this.firstPassDone,
        msSinceLastStartupScrub: this.host.clock.nowMs() - this.startedAtMs,
      });
      this.firstPassDone = true;
      // Folded in the way `pass-runner` folds its ledger notice: decided
      // before the pass began, from a step the report would otherwise have no
      // word for. A dry run that silently declines to write its own identity
      // file is a dry run whose report is not the whole story.
      //
      // The compatibility warnings go first and go every pass: the report is
      // where a user looks when something came back that should not have, and
      // the answer has to be there on the day they look, not only on the day
      // it was first noticed.
      const leading = [
        ...compatNotices(this.compatInput()),
        ...(this.identityWithheld ? [this.identityWithheld] : []),
      ];
      // After the pass, so a transcript it just brought is not warned about.
      // Not after a pass that never got the lock: another is moving files
      // right now, and what this would see is the middle of it.
      const trailing = lockAborted(outcome.report)
        ? []
        : this.foldHistoryNotHere(
            await this.historyNotHere(prepared.deps.providers),
            outcome.report,
            options.dryRun ?? false,
          );
      this.lastReport =
        leading.length > 0 || trailing.length > 0
          ? { ...outcome.report, notices: [...leading, ...outcome.report.notices, ...trailing] }
          : outcome.report;
      const announcement = options.dryRun ? null : announce(outcome.report.claudianRecords);
      if (announcement !== null) this.announcements.push(announcement);
      for (const action of outcome.report.actions) {
        if (action.action === "CONFLICT") this.conflicted.add(action.neutralRel);
        else if (
          action.result === "APPLIED" &&
          (action.action === "NOOP" || action.action.endsWith("_OVERWRITE"))
        ) {
          // A NOOP here always means "observed equal" — the engine wires
          // `conflictKnown: false` into every plan, so the planner's
          // conflict-already-known NOOP is unreachable. If that wiring ever
          // changes, this delete must learn to check `action.conflictKnown`,
          // or a still-divergent pair would clear itself off the count.
          this.conflicted.delete(action.neutralRel);
        }
      }
      // The set is in-memory on purpose: after a restart the very next pass
      // re-judges every divergent pair (conflict identity is content-derived),
      // so nothing is lost but one observation round's worth of count.
      return this.publish(await this.computeStatus(outcome));
    } catch (error) {
      // A pass that throws is a bug, not an ordinary outcome — every expected
      // failure is a value. Surfacing it as an error state rather than
      // swallowing it is the difference between a user seeing "something is
      // wrong" and seeing a plugin that quietly stopped syncing.
      return this.publish({
        ...this.status,
        phase: "error",
        short: "Claudian Session Sync: failed",
        detail: `The last pass ended unexpectedly: ${describe(error)}`,
      });
    }
  }

  /** The user's explicit "yes, this is a new sync directory" (§9.6.3). */
  async initialiseSyncDir(): Promise<{ readonly ok: boolean; readonly reason?: string }> {
    const binding = this.binding;
    const machine = this.machine;
    if (!binding || !machine) return { ok: false, reason: "not-configured" };

    const store = createSyncDirStore({
      fs: this.host.fs,
      guard: await this.pathGuard(),
      joinPath: this.host.joinPath,
      syncDirRoot: binding.syncDirPath,
    });
    const outcome = await store.initialise(
      newRootFile({
        rootId: this.host.ids.uuid(),
        nowIso: this.nowIso(),
        machineId: machine.machineId,
        label: machine.machineLabel,
        platform: this.host.platform,
      }),
    );
    // A pass, not just a refresh. The readiness record is only recomputed by a
    // pass, so without this the panel would still be showing "this folder is
    // empty, initialise it" straight after the user did — and the obvious
    // response to that is to press it again.
    await this.syncNow();
    return outcome;
  }

  /** The user's explicit "create the workspace identity" (§5.2.3, ADR-20). */
  async createIdentity(label: string): Promise<{ readonly ok: boolean; readonly reason?: string }> {
    const created = await createWorkspaceIdentity(await this.identityDeps(), {
      workspaceId: this.host.ids.uuid() as WorkspaceId,
      label,
      nowIso: this.nowIso(),
    });
    await this.refresh();
    return created.ok ? { ok: true } : { ok: false, reason: created.reason };
  }

  async updateSettings(patch: Partial<PortableSettings>): Promise<void> {
    const merged = parseSettings({ ...this.settings, ...patch });
    this.settings = merged.settings;
    await this.host.saveSettings(serialiseSettings(this.settings, this.unknownSettings));
    this.publish(await this.computeStatus());
  }

  async setSyncDir(syncDirPath: string): Promise<void> {
    const workspaceId = this.identity?.file?.workspaceId;
    if (!workspaceId) return;
    const home = await this.homeStore();
    const previous = this.binding;
    await home.saveBinding({
      ...(previous ?? emptyBinding({ workspaceId, syncDirPath, createdAt: this.nowIso() })),
      workspaceId,
      syncDirPath,
      // Stamped where the binding is first written. Redundant with the heal
      // in `boundWorkspaceId` — which stamps any binding whose id the open
      // vault claims — and kept anyway, because a field that is correct from
      // the moment of creation needs no migration reasoning to trust.
      vaultPath: this.host.vaultRoot,
    });
    await this.refresh();
  }

  /**
   * Turns a provider on or off, or points it at a different storage root.
   *
   * Returns `firstEnable` when this switched a provider on for the first time
   * — in which case a dry run has already been performed and its report is
   * waiting. §6.1 keeps that gate as long-term behaviour, and not because the
   * Tier might be unproven: enabling a provider decides which of this
   * machine's existing conversations begin travelling to another one, and
   * "we found the CLI's folder" is not consent to copy what is in it. The r4
   * acceptance run is the measurement — turning Grok on admitted fourteen
   * historical sessions across two machines, 56 files, with nothing shown
   * first, because this gate was documented and never built.
   *
   * The dry run happens *after* the binding is written, which is safe for the
   * reason ADR-27 exists: a dry run writes nothing at all. What the user gets
   * is the scope, before any pass can act on it.
   */
  /**
   * `rootOverride: null` clears it; omitting the key leaves it alone.
   *
   * The distinction is the whole point. A patch that merely omits the field
   * cannot express "remove this", so emptying the storage-folder box left the
   * old value on disk and the user had no way back except editing the binding
   * by hand — which is exactly what the 2026-09-04 re-check operator had to do
   * after a stray keystroke put `5` in Grok's path.
   */
  async setProvider(
    providerId: string,
    patch: Partial<Omit<ProviderBinding, "rootOverride">> & {
      readonly rootOverride?: string | null;
    },
  ): Promise<{ readonly firstEnable: boolean }> {
    const binding = this.binding;
    if (!binding) return { firstEnable: false };
    const previous = binding.providers[providerId] ?? { enabled: false };
    const firstEnable = patch.enabled === true && previous.introducedAt === undefined;
    const { rootOverride, ...rest } = patch;
    const next: ProviderBinding = {
      ...previous,
      ...rest,
      ...(firstEnable ? { introducedAt: this.nowIso() } : {}),
    };
    if (rootOverride === null) delete (next as { rootOverride?: string }).rootOverride;
    else if (rootOverride !== undefined) {
      (next as { rootOverride?: string }).rootOverride = rootOverride;
    }
    const home = await this.homeStore();
    await home.saveBinding({
      ...binding,
      providers: { ...binding.providers, [providerId]: next },
    });
    await this.refresh();
    if (firstEnable) await this.syncNow({ dryRun: true });
    return { firstEnable };
  }

  providerEnabled(providerId: string): boolean {
    return this.binding?.providers[providerId]?.enabled === true;
  }

  providerRootOverride(providerId: string): string | null {
    return this.binding?.providers[providerId]?.rootOverride ?? null;
  }

  /** Default storage root for a provider on this machine, before any override. */
  defaultProviderRoot(providerId: string): string | null {
    const descriptor = providerById(providerId);
    return descriptor
      ? descriptor.defaultRoot(
          { homedir: this.host.homedir, vaultRealPath: this.host.vaultRoot },
          this.host.joinPath,
        )
      : null;
  }

  async conflicts(): Promise<ConflictEntry[]> {
    const deps = await this.conflictDeps();
    return deps ? listConflicts(deps) : [];
  }

  /**
   * The backup root for this workspace, or null before there is one.
   *
   * §9.3.4's first requirement is that a user can *find* the backups; the
   * command and the settings button both need somewhere to point.
   */
  async backupsDir(): Promise<string | null> {
    const workspaceId = this.identity?.file?.workspaceId;
    if (!workspaceId) return null;
    const home = await this.homeStore();
    return this.host.joinPath(home.layout.backupsDir, workspaceId);
  }

  /**
   * Opens a folder, and says whether it worked.
   *
   * The path is reported either way by the caller. "Show me the folder" that
   * silently does nothing is the same class of lie as a resolution that
   * silently does nothing (R2-1) — smaller, but the same shape.
   */
  async reveal(target: string): Promise<boolean> {
    return this.host.openFolder(target).catch(() => false);
  }

  async backups(): Promise<BackupEntry[]> {
    const deps = await this.conflictDeps();
    if (!deps) return [];
    const load = await (await this.homeStore()).loadClaudianRecords(deps.workspaceId as WorkspaceId);
    const heldHere = new Set(
      load.status === "loaded"
        ? Object.entries(load.file.records)
            .filter(([, entry]) => entry.hold !== undefined)
            .map(([rel]) => rel)
        : [],
    );
    return listBackups({ ...deps, heldHere });
  }

  /** Everything the folder holds, so the dialog can say what it left out. */
  async backupCount(): Promise<number> {
    const deps = await this.conflictDeps();
    return deps ? countBackups(deps) : 0;
  }

  /** Sessions this machine holds without their commit point (§6.6). */
  async orphans(): Promise<OrphanGroup[]> {
    const deps = await this.conflictDeps();
    return deps ? listOrphans({ ...deps, nowMs: () => this.host.clock.nowMs() }) : [];
  }

  /**
   * Deletes one half-copied session, after keeping a copy of it.
   *
   * Takes the same lock a pass does (ADR-50): this writes into the CLI's own
   * directory, and it is the one command whose purpose is to destroy bytes, so
   * doing it while a pass is mid-apply is the last thing anyone wants. It does
   * not need the sync folder to be ready — nothing here touches it.
   */
  async removeOrphan(
    providerId: string,
    logicalId: string,
    expected: ReadonlyArray<{ readonly neutralRel: string; readonly sizeBytes: number }>,
  ): Promise<RemoveOutcome> {
    const deps = await this.conflictDeps();
    if (!deps) return { ok: false, reason: "not-listed" };
    return this.withWriteGate<RemoveOutcome>({ ok: false, reason: "sync-in-progress" }, () =>
      removeOrphan(
        { ...deps, nowMs: () => this.host.clock.nowMs() },
        providerId,
        logicalId,
        expected,
      ),
    );
  }

  async restore(
    backupPath: string,
    expectedHashPrefix: string,
    expectedLiveHashPrefix: string | null,
  ): Promise<RestoreOutcome> {
    const deps = await this.conflictDeps();
    if (!deps) return { ok: false, reason: "unknown-backup" };
    const outcome = await this.withWriteGate<RestoreOutcome>(
      { ok: false, reason: "sync-in-progress" },
      (mayWriteRemote) =>
        restoreBackup(
          { ...deps, mayWriteRemote },
          backupPath,
          expectedHashPrefix,
          expectedLiveHashPrefix,
        ),
    );
    // A pass afterwards, exactly as resolution does: a restore changes what
    // one side holds, and the report — including the CONFLICT a divergent
    // restore is *meant* to raise — is how the user sees what it did.
    if (outcome.ok) await this.syncNow();
    return outcome;
  }

  async resolve(conflictId: string, resolution: ConflictResolution): Promise<ResolveOutcome> {
    const deps = await this.conflictDeps();
    if (!deps) return { ok: false, reason: "unknown-conflict" };
    const outcome = await this.withWriteGate<ResolveOutcome>(
      { ok: false, reason: "sync-in-progress" },
      (mayWriteRemote) => resolveConflict({ ...deps, mayWriteRemote }, conflictId, resolution),
    );
    if (outcome.ok && outcome.action !== "REVEAL") {
      // First-hand knowledge: this runtime just settled that session, so it
      // leaves the sticky set now — the pass below may only DEFER it (the
      // file was written milliseconds ago and is inside its quiet window),
      // and a DEFER deliberately clears nothing.
      this.conflicted.delete(outcome.neutralRel);
      // A pass, not just a status refresh: it is what records the
      // now-agreeing pair and pushes the settled version onward.
      await this.syncNow();
    }
    return outcome;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private publish(status: RuntimeStatus): RuntimeStatus {
    this.status = status;
    for (const listener of this.listeners) listener(status);
    return status;
  }

  private nowIso(): string {
    return new Date(this.host.clock.nowMs()).toISOString();
  }

  private get stateRoot(): string {
    return this.host.joinPath(this.host.homedir, ".claudian-session-sync");
  }

  private async pathGuard(): Promise<PathGuardDeps> {
    if (this.guard) return this.guard;
    // Probed, never inferred from the platform (§9.7.4): macOS can be
    // formatted case-sensitive and a Linux mount can be the opposite, and a
    // wrong answer makes the four-root overlap check a formality.
    const base: PathGuardDeps = {
      fs: this.host.fs,
      platform: this.host.platform,
      caseSensitive: true,
      joinPath: this.host.joinPath,
      dirnameOf: this.host.dirnameOf,
      splitPath: splitPathSegments,
    };
    // Bootstrapping: the probe needs somewhere to write, and `PathGuardDeps`
    // needs the probe's answer. Minted through the same guard as everything
    // else — the state root trivially contains itself, so the provisional
    // `caseSensitive` above cannot change the outcome.
    const probeDir = mintStatePath(base, this.stateRoot, this.stateRoot);
    if (!probeDir.ok) return base;
    await this.host.fs.mkdirp(probeDir.value, 0o700).catch(() => undefined);
    const caseSensitive = await probeCaseSensitivity(
      this.host.fs,
      probeDir.value,
      this.host.joinPath,
      this.host.ids.token(4),
    ).catch(() => this.host.platform === "linux");

    this.guard = { ...base, caseSensitive };
    return this.guard;
  }

  private async homeStore(): Promise<HomeStore> {
    if (this.home) return this.home;
    this.home = createHomeStore({
      fs: this.host.fs,
      guard: await this.pathGuard(),
      joinPath: this.host.joinPath,
      stateRoot: this.stateRoot,
    });
    return this.home;
  }

  private async identityDeps() {
    return {
      fs: this.host.fs,
      guard: await this.pathGuard(),
      joinPath: this.host.joinPath,
      vaultRoot: this.host.vaultRoot,
    };
  }

  /**
   * Loads this machine's identity, creating or renaming it as needed (§10.3).
   *
   * A rename is silent by design: `machineId` never takes part in a decision,
   * so the entire cost of giving way is one line in an audit list — and a
   * dialog asking the user to adjudicate a hostname change is a dialog nobody
   * can answer.
   *
   * `persist: false` makes it **absolutely read-only**, which is what §7.6
   * promises of a dry run: the state directory is one of the five trees a dry
   * run may not touch, and this was the only write left in it. The identity is
   * still produced, in memory, because a pass needs one — and a provisional id
   * changes nothing it decides (§10.3). What it does change is the observation
   * ledger, which a real pass would invalidate in exactly the same way when
   * the identity file is missing (ADR-74), so the dry run's report stays a
   * true account of what the real pass would do.
   *
   * The withheld write is returned rather than logged, so the caller can put
   * it in the report instead of leaving the user to notice the difference.
   */
  private async loadOrCreateMachine(
    home: HomeStore,
    persist: boolean,
  ): Promise<{ machine: MachineFile | null; withheld: string | null }> {
    const identity = {
      hostname: this.host.hostname,
      platform: this.host.platform as MachineFile["identity"]["platform"],
      homedir: this.host.homedir,
    };
    const load = await home.loadMachine();
    if (load.status !== "loaded") {
      const created: MachineFile = {
        schemaVersion: STATE_SCHEMA_VERSION,
        machineId: this.host.ids.uuid() as MachineId,
        machineLabel: this.host.hostname,
        createdAt: this.nowIso(),
        identity,
        superseded: [],
      };
      if (!persist) {
        return {
          machine: created,
          withheld:
            "dry run: this machine has no identity file yet, and none was created. A real pass " +
            "creates one; until then this pass has no memory of earlier passes to compare with, " +
            "so everything below reads as first sight.",
        };
      }
      await home.saveMachine(created);
      return { machine: created, withheld: null };
    }

    const verdict = judgeIdentity(load.value.identity, identity);
    if (verdict === "same") return { machine: load.value, withheld: null };
    if (verdict === "foreign-platform") {
      // A state directory under a different OS is a copy, not a rename: the
      // paths recorded in it do not describe this machine. Fail closed (ADR-21)
      // — `prepare()` aborts the pass on a missing machine file, so refusing
      // here is a refusal to sync rather than a refusal to load.
      return { machine: null, withheld: null };
    }
    // A rename is a rename. The id is minted once and never re-minted, so the
    // observation ledger — and with it ADR-61's shrink-guard base — survives
    // every hostname change. Only the label and the recorded fingerprint move.
    const renamed: MachineFile = {
      ...load.value,
      machineLabel: this.host.hostname,
      identity,
    };
    if (!persist) {
      return {
        machine: renamed,
        withheld:
          "dry run: this machine has been renamed since it last synced, and the recorded name " +
          "was left as it was. A real pass updates it; the machine id is unchanged either way, " +
          "so nothing this pass decided depended on it.",
      };
    }
    await home.saveMachine(renamed);
    return { machine: renamed, withheld: null };
  }

  /**
   * Which workspace this machine is bound to **for the vault that is open**.
   *
   * It used to be "whichever sorted first", which is only ever right on a
   * machine with one vault. With two, the panel showed the other workspace's
   * configuration, the folder field was disabled, and the identity check
   * declared the open vault CHANGED and stopped syncing — a fail-closed guard
   * (ADR-21) firing on a configuration that is not an anomaly at all. It
   * blocked a real acceptance run until the operator moved a binding aside
   * (OQ-19, ADR-59).
   *
   * The order matters, and the last branch is the one that keeps the guard:
   *
   *  1. a binding that names this vault — unambiguous, and how it works once
   *     every binding has been stamped;
   *  2. a binding whose id equals what this vault claims — the same answer by
   *     a different route, used to stamp legacy bindings on first sight;
   *  3. otherwise, if any binding predates the field, fall back to the old
   *     behaviour. That deliberately keeps failing closed: an unstamped
   *     binding might be this vault's, so "no binding claims this vault"
   *     cannot yet be read as "this vault is new";
   *  4. all bindings stamped and none claims this vault ⇒ genuinely a vault
   *     this machine has not bound yet. Null, so the settings pane offers to
   *     create an identity instead of reporting an anomaly.
   */
  private async boundWorkspaceId(home: HomeStore, vaultClaimsId: WorkspaceId | null): Promise<WorkspaceId | null> {
    const ids = await home.listBoundWorkspaces();
    if (ids.length === 0) return null;

    const loaded = await Promise.all(ids.map((id) => home.loadBinding(id as WorkspaceId)));
    const known: WorkspaceBinding[] = [];
    for (const outcome of loaded) if (outcome.status === "loaded") known.push(outcome.value);

    const claimsThisVault = known.find((b) => b.vaultPath === this.host.vaultRoot);
    if (claimsThisVault) return claimsThisVault.workspaceId;

    if (vaultClaimsId !== null) {
      const byId = known.find((b) => b.workspaceId === vaultClaimsId);
      if (byId) {
        if (byId.vaultPath === undefined) {
          await home.saveBinding({ ...byId, vaultPath: this.host.vaultRoot });
        }
        return byId.workspaceId;
      }
    }

    const anyUnstamped = known.some((b) => b.vaultPath === undefined);
    return anyUnstamped ? ((ids[0] as WorkspaceId | undefined) ?? null) : null;
  }

  private async loadBinding(home: HomeStore, workspaceId: WorkspaceId): Promise<WorkspaceBinding | null> {
    const load = await home.loadBinding(workspaceId);
    return load.status === "loaded" ? load.value : null;
  }

  /** Assembles the pass, or explains why it cannot be assembled. */
  private async prepare(options: { readonly dryRun: boolean }): Promise<
    { ok: true; deps: PassRunnerArgs } | { ok: false; status: RuntimeStatus }
  > {
    if (!this.machine || !this.identity) {
      // The one path on which a pass can reach `loadOrCreateMachine`, and so
      // the one place the dry-run promise could be broken by it: a first run,
      // or any run whose identity file has gone missing.
      const status = await this.refresh({ persistIdentity: !options.dryRun });
      if (!this.machine || !this.identity) return { ok: false, status };
    }
    if (this.identity.status !== "ok" || !this.identity.file) {
      return { ok: false, status: await this.computeStatus() };
    }
    const binding = this.binding;
    if (!binding || binding.syncDirPath.length === 0) {
      return { ok: false, status: await this.computeStatus() };
    }

    const home = await this.homeStore();
    const guard = await this.pathGuard();
    const providers = await this.providerRuntimes(binding);
    const machine = this.machine;

    return {
      ok: true,
      deps: {
        fs: this.host.fs,
        guard,
        clock: this.host.clock,
        ids: this.host.ids,
        joinPath: this.host.joinPath,
        hashBytes: this.host.hashBytes,
        home,
        syncDir: createSyncDirStore({
          fs: this.host.fs,
          guard,
          joinPath: this.host.joinPath,
          syncDirRoot: binding.syncDirPath,
        }),
        binding,
        machineId: machine.machineId,
        workspaceId: this.identity.file.workspaceId,
        providers,
        vaultRoot: this.host.vaultRoot,
        settings: {
          maxFileSizeBytes: this.settings.maxFileSizeMB * 1024 * 1024,
          maxFilesPerPass: this.settings.maxFilesPerPass,
          localQuietMs: this.settings.localQuietMs,
          remoteQuietMs: this.settings.remoteQuietMs,
          clockSkewToleranceMs: this.settings.clockSkewToleranceMs,
          backupKeep: this.settings.backupKeep,
          scrubMaxAgeMs: this.settings.scrubMaxAgeHours * 60 * 60 * 1000,
        },
        lock: createFileLock({
          fs: this.host.fs,
          home,
          workspaceId: this.identity.file.workspaceId,
          machineId: machine.machineId,
          pid: this.host.pid,
          nowMs: () => this.host.clock.nowMs(),
          inProcessBusy: () => this.passInFlight,
          onAcquired: () => {
            this.passInFlight = true;
          },
          onReleased: () => {
            this.passInFlight = false;
          },
        }),
      },
    };
  }

  /**
   * An adapter per provider switched on here — or, for the read-only audit,
   * per provider at all: the sync folder holds whatever any device pushed.
   * The audit asks a switched-off provider's adapter about the sync folder
   * only, never about this machine's folder for it.
   */
  private async providerRuntimes(
    binding: WorkspaceBinding,
    options: { readonly includeDisabled?: boolean } = {},
  ): Promise<ProviderRuntime[]> {
    const runtimes: ProviderRuntime[] = [];
    for (const descriptor of PROVIDERS) {
      const configured = binding.providers[descriptor.id];
      if (!configured?.enabled && !options.includeDisabled) continue;
      const root =
        configured?.rootOverride ??
        descriptor.defaultRoot(
          { homedir: this.host.homedir, vaultRealPath: this.host.vaultRoot },
          this.host.joinPath,
        );
      // Realpath'd here because every containment check downstream compares
      // against this string, and preflight refuses a root that is not its own
      // realpath rather than failing one write at a time.
      const real = await this.host.fs.realpath(root).catch(() => root);
      runtimes.push({
        adapter: descriptor.create({
          providerRoot: real,
          configuredRoot: root,
          vaultRealPath: this.host.vaultRoot,
          joinPath: this.host.joinPath,
          dirnameOf: this.host.dirnameOf,
          listDir: async (dir) =>
            (await this.host.fs.readDir(dir).catch(() => [])).map((entry) => ({
              name: entry.name,
              isFile: entry.isFile,
            })),
          statFile: async (target) => {
            const st = await this.host.fs.lstat(target);
            return st ? { mtimeMs: st.mtimeMs } : null;
          },
          readTextFile: async (target) => {
            const bytes = await this.host.fs.readFile(target).catch(() => null);
            return bytes === null ? null : new TextDecoder().decode(bytes);
          },
        }),
        root: real,
      });
    }
    return runtimes;
  }

  /**
   * The two gates a pass passes and a click, until now, did not.
   *
   * A resolution and a restore are writes into the same files a pass writes,
   * so they need the same two answers a pass gets — and both were being taken
   * on trust:
   *
   * **The lock.** `runWorkspacePass` acquires one (§9.4), which is what keeps
   * a second Obsidian window, or a second machine sharing the sync folder,
   * from applying to the same file at the same time. A click held nothing, so
   * the one operation a user watches happen was the one operation running
   * unprotected.
   *
   * **Readiness.** `status.readiness` is only recomputed *by a pass* — so a
   * sync folder unmounted since the last one still reads READY, and a write
   * into it would build a tree in a mount point that is not there (NR-9), or
   * into a directory that was recreated with a different rootId (NR-2). The
   * two facts those rules turn on are cheap to re-observe, so they are, at
   * the moment of the click rather than whenever the last pass happened.
   */
  private async withWriteGate<T>(
    busy: T,
    body: (mayWriteRemote: () => boolean, lock: PassLock | undefined) => Promise<T>,
  ): Promise<T> {
    // Never a dry run: everything behind this gate is a write the user asked
    // for by name, and one of them is "put this version back".
    const prepared = await this.prepare({ dryRun: false });
    if (!prepared.ok) return busy;
    const lock = prepared.deps.lock;
    const acquired = await lock?.acquire();
    if (acquired && !acquired.ok) return busy;

    try {
      const fresh = await this.probeRemoteWritable(prepared.deps);
      // `mayWrite()` as well as the fresh probe: the lock can be taken over by
      // another instance mid-operation, and the command re-asks immediately
      // before it writes for the same reason the engine does.
      return await body(() => fresh, lock);
    } finally {
      await lock?.release();
    }
  }

  /**
   * Is the sync folder writable *right now* — the NR-1/NR-2/NR-9 subset.
   *
   * Deliberately not the whole readiness evaluation: that one counts every
   * file in the workspace subtree to judge hydration, which is a per-pass
   * cost and answers a question about trends. What a click needs is narrower
   * and strictly more conservative — the directory is there, and it is still
   * the same one we recorded — so a false "not ready" costs a refusal with a
   * reason, never a write into the wrong place.
   */
  private async probeRemoteWritable(deps: {
    syncDir: { reachable(): Promise<boolean>; readRoot(): Promise<ReadinessObservation["root"]> };
  }): Promise<boolean> {
    if (this.status.readiness !== "READY") return false;
    if (!(await deps.syncDir.reachable().catch(() => false))) return false;
    const root = await deps.syncDir.readRoot().catch(() => ({ status: "missing" }) as const);
    if (root.status !== "ok") return false;
    // The rootId this machine recorded for this folder. A folder that was
    // deleted and recreated by the sync tool comes back with a different one,
    // which is NR-2 — the case the marker file exists to make detectable.
    const binding = this.binding;
    const workspaceId = this.identity?.file?.workspaceId;
    if (!binding || !workspaceId) return false;
    const recorded = await (await this.homeStore())
      .loadRemote(workspaceId, binding.syncDirPath)
      .catch(() => null);
    return recorded?.rootId == null || recorded.rootId === root.rootId;
  }

  /**
   * The questions ADR-78 asks of this machine's disk, or null when the
   * `claudian` provider is off.
   *
   * The Claude project folder is the one this plugin's own Claude Code
   * provider writes into — the same path its pulls land at, which the engine
   * relies on to recognise a transcript it pulled this very pass. With that
   * provider off there is no probe at all: no transcript from another device
   * can arrive, so a record restored "for its history" would be restored for
   * ever. Where this folder and the one Claudian checks differ
   * (`CLAUDE_CONFIG_DIR`, an override), the answer can be wrong either way —
   * see ADR-78's residual risks.
   */
  private claudianRecordsProbes(
    providers: readonly ProviderRuntime[],
  ): PassRunnerArgs["claudianRecords"] | null {
    const claudian = providers.find((p) => p.adapter.id === "claudian");
    if (!claudian) return null;
    const claudeCode = providers.find((p) => p.adapter.id === CLAUDE_CODE.id);
    const { fs, joinPath, vaultRoot } = this.host;
    const syncDir = this.binding?.syncDirPath;
    const workspaceId = this.identity?.file?.workspaceId;

    return {
      markerless: isMarkerless(this.claudianVersion),
      claudeTranscriptPath:
        claudeCode && syncDir && workspaceId
          ? async (sessionId) => {
              // No projects folder is Claudian's "unknown" as well: it does not
              // delete a conversation it cannot look for.
              if ((await fs.lstat(claudeCode.root).catch(() => null)) === null) return null;
              const dir = claudeCodeProjectDir({ providerRoot: claudeCode.root, vaultRealPath: vaultRoot, joinPath });
              return {
                local: joinPath(dir, `${sessionId}.jsonl`),
                // The Claude Code provider's own name for it in the sync folder.
                replica: joinPath(syncDir, workspaceId, CLAUDE_CODE.id, `${sessionId}.jsonl`),
              };
            }
          : null,
      // Every device's folder, not only this one's: another device assigning a
      // conversation to itself moves the shared record into its folder, and
      // that is still a move, not a delete.
      movedToDevice: async (conversationId) => {
        const devices = joinPath(claudian.root, "devices");
        for (const entry of await fs.readDir(devices).catch(() => [])) {
          if (entry.isFile || !DEVICE_KEY.test(entry.name)) continue;
          const found = await fs.lstat(joinPath(devices, entry.name, `${conversationId}.meta.json`)).catch(() => null);
          if (found !== null) return true;
        }
        return false;
      },
      // The inode, where the filesystem has one: a recreated folder gets a new
      // one, a folder whose files were deleted keeps its own.
      storeIdentity: async () => {
        const st = await fs.lstat(claudian.root).catch(() => null);
        return st === null || !st.isDirectory || !st.ino ? null : String(st.ino);
      },
    };
  }

  /**
   * Claude conversations listed here whose history is in the sync folder and
   * not on this machine yet (ADR-81, H10): "off" when there is no asking,
   * null when the answer is unknown.
   *
   * The transcript is looked for where this plugin's own Claude Code provider
   * puts it, so with that provider off there is nothing to say: no transcript
   * is on its way, and "wait for the next sync" would be a promise nobody
   * keeps. The records are Claudian's, read from the vault whether or not the
   * records provider is on — they usually travel with the vault.
   */
  private async historyNotHere(providers: readonly ProviderRuntime[]): Promise<HistoryNotHereResult | null | "off"> {
    const claudeCode = providers.find((p) => p.adapter.id === CLAUDE_CODE.id);
    const syncDir = this.binding?.syncDirPath;
    const workspaceId = this.identity?.file?.workspaceId;
    if (!claudeCode || !syncDir || !workspaceId) return "off";
    const { fs, joinPath, vaultRoot } = this.host;
    return findHistoryNotHere({
      fs,
      joinPath,
      storeDir: joinPath(vaultRoot, ".claudian", "sessions"),
      deviceKey: this.host.claudianDeviceKey?.() ?? null,
      projectDir: claudeCodeProjectDir({ providerRoot: claudeCode.root, vaultRealPath: vaultRoot, joinPath }),
      replicaDir: joinPath(syncDir, workspaceId, CLAUDE_CODE.id),
      maxRecordBytes: this.settings.maxFileSizeMB * 1024 * 1024,
    }).catch(() => null);
  }

  /**
   * One pass's H10 answer folded into what this runtime knows; returns the
   * report lines for it. A dry run gets the lines and changes nothing.
   *
   * The pop-up is for the conversations Claudian is listing, and Claudian
   * 2.3.20 reads its records from disk when it starts and not again: a record
   * that arrives with the vault later is not in its list until the next
   * launch, so it cannot be sent in. Every new shared conversation arrives
   * that way — record first, transcript a pass or two later — and a pop-up for
   * each would be one the user learns to dismiss. So a conversation is
   * announced by the first real pass this run (Claudian has just read every
   * record on disk), or once it has been at risk for two answers running;
   * the report names every one, every pass. A pass whose answer is unknown
   * changes nothing it remembers, and says so.
   */
  private foldHistoryNotHere(result: HistoryNotHereResult | null | "off", report: PassReport, dryRun: boolean): string[] {
    if (result === "off") {
      if (!dryRun) {
        this.notHereKnown = null;
        this.notHereAsked = false;
        this.warnedNotHere = new Set();
        this.pendingNotHere = [];
      }
      return [];
    }
    const known = this.notHereKnown;
    const firstAsked = !this.notHereAsked;
    if (!dryRun) this.notHereAsked = true;
    if (result === null) {
      return known !== null && known.size > 0
        ? [
            "History not here yet: this pass could not check (a folder did not answer); the last check named " +
              `${known.size} Claude conversation(s).`,
          ]
        : [];
    }
    const current = new Map(result.entries.map((entry) => [entry.conversationId, entry]));
    // A record caught mid-write is not a conversation that stopped being at risk.
    for (const conversationId of result.unsure) {
      const before = known?.get(conversationId);
      if (before) current.set(conversationId, before);
    }
    const entries = [...current.values()].sort(newestFirst);
    if (!dryRun) {
      const warned = new Set([...this.warnedNotHere].filter((id) => current.has(id)));
      this.pendingNotHere = entries.filter(
        (entry) => !warned.has(entry.conversationId) && (firstAsked || known?.has(entry.conversationId) === true),
      );
      this.warnedNotHere = warned;
      this.notHereKnown = current;
    }
    return describeHistoryNotHere(entries, report);
  }

  /**
   * Records this device is keeping off itself, for the bring-back screen.
   *
   * Read-only. Titles are read from the sync folder's copy now, for display,
   * and never stored or reported. Not listed: tombstones, because bringing one
   * back would only delete its conversation again at Claudian's next launch;
   * and records the sync folder no longer has, because there is nothing to
   * bring back — their holds stay, in case a device pushes them again.
   */
  async heldRecords(): Promise<readonly HeldRecordView[]> {
    const binding = this.binding;
    const workspaceId = this.identity?.file?.workspaceId;
    if (!binding || !workspaceId) return [];
    const load = await (await this.homeStore()).loadClaudianRecords(workspaceId);
    if (load.status !== "loaded") return [];
    const views: HeldRecordView[] = [];
    for (const [rel, entry] of Object.entries(load.file.records)) {
      const record = claudianRecordOf(rel);
      const hold = entry.hold;
      if (!record || !hold || hold.kind === "tombstone-consumed") continue;
      const copy = await this.replicaCopy(binding.syncDirPath, workspaceId, rel);
      if (copy === null) continue;
      views.push({
        neutralRel: rel,
        conversationId: record.conversationId,
        kind: hold.kind,
        sinceMs: hold.sinceMs,
        releaseRequested: hold.releaseRequested,
        title: copy.title,
      });
    }
    return views.sort((a, b) => b.sinceMs - a.sinceMs);
  }

  /**
   * Asks the next pass to land these records again (ADR-78 H5).
   *
   * Under the write gate: a pass loads and saves the memory while it holds
   * the same lock, so the request can neither land in the middle of a pass
   * nor be saved over by one. Then a pass, so the user sees the result
   * rather than a promise. The pass lands each with the same no-replace
   * create a new record gets — it cannot overwrite anything.
   */
  async bringBack(rels: readonly string[]): Promise<BringBackOutcome> {
    const workspaceId = this.identity?.file?.workspaceId;
    if (!workspaceId) return { ok: false, reason: "unavailable" };
    // Only a pass with the provider on reads the request, so marking it now
    // would be a promise kept at some unannounced later date.
    if (!this.providerEnabled("claudian")) return { ok: false, reason: "provider-off" };
    const marked = await this.withWriteGate<BringBackOutcome | null>(
      { ok: false, reason: "sync-in-progress" },
      async () => {
        const home = await this.homeStore();
        const load = await home.loadClaudianRecords(workspaceId);
        if (load.status !== "loaded") return { ok: false, reason: "unavailable" };
        const state = createClaudianRecordsState(load.file);
        let count = 0;
        for (const rel of rels) if (state.requestRelease(rel)) count += 1;
        if (count === 0) return { ok: false, reason: "unavailable" };
        await home.saveClaudianRecords(workspaceId, state.toFile());
        return null;
      },
    );
    if (marked !== null) return marked;
    await this.syncNow();
    return { ok: true };
  }

  /** The sync folder's copy, with its title when it can be read; null when there is none. */
  private async replicaCopy(
    syncDirPath: string,
    workspaceId: string,
    rel: string,
  ): Promise<{ readonly title: string | null } | null> {
    const target = this.host.joinPath(syncDirPath, workspaceId, ...rel.split("/"));
    const stat = await this.host.fs.lstat(target).catch(() => null);
    if (stat === null || !stat.isFile) return null;
    if (stat.size > this.settings.maxFileSizeMB * 1024 * 1024) return { title: null };
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(await this.host.fs.readFile(target)));
      const title = (parsed as { title?: unknown } | null)?.title;
      return { title: typeof title === "string" && title.length > 0 ? title : null };
    } catch {
      return { title: null };
    }
  }

  /**
   * What the sync folder holds that this vault no longer lists (ADR-81, H8).
   *
   * Read-only: nothing here writes to the sync folder, the vault or a CLI's
   * folder, and it takes no lock — a pass running alongside can only make a
   * count one file stale. Titles are read for the screen and kept nowhere.
   */
  async auditSyncFolder(): Promise<AuditOutcome> {
    const binding = this.binding;
    const workspaceId = this.identity?.file?.workspaceId;
    if (!binding || !workspaceId || binding.syncDirPath.length === 0) return { ok: false, reason: "not-set-up" };
    const { fs, joinPath } = this.host;
    // The sync folder, not this workspace's folder inside it: that one does
    // not exist until something has been pushed, and then it holds nothing.
    const folder = await fs.lstat(binding.syncDirPath).catch(() => null);
    if (folder === null || !folder.isDirectory) return { ok: false, reason: "unreachable" };
    const replicaRoot = joinPath(binding.syncDirPath, workspaceId);
    const load = await (await this.homeStore()).loadClaudianRecords(workspaceId).catch(() => null);
    const file = load?.status === "loaded" ? load.file : null;
    const providers = await this.providerRuntimes(binding, { includeDisabled: true });
    await this.detectClaudian();
    return {
      ok: true,
      audit: await auditSyncFolder({
        fs,
        joinPath,
        replicaRoot,
        vaultRealPath: this.host.vaultRoot,
        providers: providers.map((p) => ({ adapter: p.adapter, enabled: this.providerEnabled(p.adapter.id) })),
        deletedHere: {
          status:
            load === null || (load.status !== "loaded" && load.status !== "absent")
              ? "unreadable"
              : this.providerEnabled("claudian")
                ? "tracked"
                : "records-provider-off",
          file,
        },
        legacyStillListed: readsLegacySessionFolder(this.claudianVersion),
        maxRecordBytes: this.settings.maxFileSizeMB * 1024 * 1024,
      }),
    };
  }

  /** Is this machine moving its conversation records into the shared layer? */
  sharesConversations(): boolean {
    return this.binding?.shareConversations === true;
  }

  /**
   * What the installed Claudian breaks in the features switched on here.
   *
   * From the last version read, so the settings pane can render it without
   * touching the disk; refresh and every pass keep it current.
   */
  compatibilityWarnings(): CompatWarnings {
    return compatWarnings(this.compatInput());
  }

  private compatInput() {
    return {
      claudianVersion: this.claudianVersion,
      sharing: this.sharesConversations(),
    };
  }

  private async detectClaudian(): Promise<void> {
    const configDir = this.host.configDir;
    this.claudianVersion =
      configDir === undefined || configDir.length === 0
        ? null
        : await readClaudianVersion({
            fs: this.host.fs,
            joinPath: this.host.joinPath,
            pluginsDir: this.host.joinPath(this.host.vaultRoot, configDir, "plugins"),
          });
  }

  /** Machine-local consent, so it never travels with the vault (ADR-69). */
  async setShareConversations(value: boolean): Promise<void> {
    const binding = this.binding;
    if (!binding) return;
    const next = { ...binding, shareConversations: value };
    const home = await this.homeStore();
    await home.saveBinding(next);
    this.binding = next;
    // The pane redraws from what this leaves behind, and the warning under
    // this switch is meant for the moment it is flipped. `setProvider` gets
    // the same through its refresh; this one has to ask.
    await this.detectClaudian();
  }

  /**
   * Runs the reconciliation and turns its outcome into report lines.
   *
   * `lock` is the pass's own, so every write here is re-checked against it —
   * this runs inside `runPass`, which is where the two comments that used to
   * claim it always said it was.
   */
  private async shareConversations(lock?: PassLock): Promise<readonly string[]> {
    const holds = await this.runSharing(
      lock ? { lock, inspectOnly: false } : { inspectOnly: false },
    );
    if (holds === null) return [];
    this.sharingHolds = holds.holds;
    const notices: string[] = [];
    const { outcome } = holds;

    if (outcome.moved + outcome.completed > 0) {
      notices.push(
        `${outcome.moved + outcome.completed} conversation record(s) moved to the shared ` +
          "layer, so your other devices list them. Moving them back is not something this " +
          "switch can undo.",
      );
    }
    if (outcome.folded > 0) {
      notices.push(
        `${outcome.folded} shared conversation record(s) caught up with this device's newer ` +
          "version. The version each replaced is in your backups.",
      );
    }
    if (outcome.retired > 0) {
      notices.push(
        `${outcome.retired} conversation record(s) are now maintained by another device, so ` +
          "this device's stale copy was withdrawn (a copy is in your backups).",
      );
    }
    if (outcome.tombstoned > 0) {
      notices.push(
        `${outcome.tombstoned} conversation(s) you deleted were still listed in the shared ` +
          "layer, and the deletion has now been carried across.",
      );
    }
    for (const held of outcome.heldBack.slice(0, 3)) {
      notices.push(`not shared — ${held}`);
    }
    if (outcome.heldBack.length > 3) {
      notices.push(`…and ${outcome.heldBack.length - 3} more left where they are`);
    }
    if (outcome.holds.length > 0) {
      notices.push(
        `${outcome.holds.length} conversation record(s) on this device are not being shared, ` +
          "because the copy in the shared layer differs from this device's, or was removed. Run " +
          '"Repair shared conversation records" to see them and choose.',
      );
    }
    return notices;
  }

  /**
   * The reconciliation itself, shared by the pass and the repair screen.
   *
   * Failures are swallowed and the outcome is reported rather than acted on:
   * this is a convenience laid on top of another plugin's store, and it must
   * never be the reason a sync pass does not run.
   */
  private async runSharing(options: {
    /** Required: see `ShareDeps.inspectOnly`. Forgetting it is a consent bug. */
    readonly inspectOnly: boolean;
    readonly lock?: PassLock;
    readonly forced?: ReadonlySet<string>;
    readonly only?: ReadonlySet<string>;
  }): Promise<{ outcome: ShareOutcome; holds: readonly SharingHold[] } | null> {
    const { lock, forced, only, inspectOnly } = options;
    const workspaceId = this.identity?.file?.workspaceId;
    const deviceKey = this.host.claudianDeviceKey?.() ?? null;
    if (!workspaceId || deviceKey === null) return null;
    try {
      const home = await this.homeStore();
      const backupWriter = createBackupWriter({
        fs: this.host.fs,
        home,
        joinPath: this.host.joinPath,
        hashBytes: this.host.hashBytes,
        nowMs: () => this.host.clock.nowMs(),
        randomSuffix: () => this.host.ids.token(4),
        keep: this.settings.backupKeep,
      });
      const published = await home.loadSharedRecords(workspaceId, deviceKey);
      const outcome = await shareOwnConversations({
        fs: this.host.fs,
        guard: await this.pathGuard(),
        joinPath: this.host.joinPath,
        hashBytes: (bytes: Uint8Array) => this.host.hashBytes(bytes),
        vaultRealPath: this.host.vaultRoot,
        deviceKey,
        nowMs: this.host.clock.nowMs(),
        published,
        // `<id>.meta` matches the claudian provider's own logical-id shape, so
        // these land in the directory its restore path already looks in
        // (a bare `<id>` would put them somewhere nothing relates to it).
        backup: async (input) => {
          const kept = await backupWriter.backup({
            sourcePath: input.sourcePath,
            workspaceId,
            providerId: "claudian",
            logicalId: `${input.conversationId}.meta` as LogicalId,
            remote: false,
            action: input.action,
          });
          return kept.path;
        },
        mayWrite: () => (lock ? lock.mayWrite() : Promise.resolve(true)),
        ...(forced ? { forced } : {}),
        ...(only ? { only } : {}),
        inspectOnly,
      });
      if (outcome.published !== null) {
        await home.saveSharedRecords(workspaceId, outcome.published);
      }
      return { outcome, holds: outcome.holds };
    } catch {
      return null;
    }
  }

  /**
   * The forks a person has to decide, for the repair screen.
   *
   * Read-only, and that is load-bearing rather than tidy. The sharing switch is
   * machine-local consent; opening a screen is not consent. This used to run
   * the full reconciliation, so a user with the switch off who opened the
   * screen to look had every record on this device published by the act of
   * looking (2026-09-04 acceptance, deviation 4).
   */
  async sharingConflicts(): Promise<readonly SharingHold[]> {
    const run = await this.runSharing({ inspectOnly: true });
    return run === null ? this.sharingHolds : run.holds;
  }

  /**
   * Publishes this device's version of one conversation, on the user's say-so.
   *
   * One id at a time and never in bulk: each of these is an independent fork,
   * and one decision does not carry to the next. The shared version it replaces
   * is backed up first, and a backup that fails cancels the write.
   */
  async publishSharedRecord(conversationId: string): Promise<PublishOutcome> {
    // `only`, so the click acts on the conversation the user was shown and no
    // other. Under the same lock every other click-path write takes: this is a
    // destructive write outside a pass, and a pass may be applying right now.
    //
    // The outcome is three-way rather than a boolean because two of the three
    // read identically to a user and lead to different next moves: "a pass is
    // running, try in a moment" is not "it did not apply". The re-check's
    // reviewer flagged that both landed on one sentence, and said not to trust
    // the dialog — a screen a careful reader is told to disbelieve is a bug.
    const one = new Set([conversationId]);
    return this.withWriteGate<PublishOutcome>({ ok: false, reason: "sync-in-progress" }, async (_, lock) => {
      // The gate's lock goes in, so every write the click makes is re-checked
      // against it, exactly as a pass's are.
      const run = await this.runSharing({ forced: one, only: one, inspectOnly: false, ...(lock ? { lock } : {}) });
      if (run === null) return { ok: false, reason: "unavailable" };
      // Counted at the write, not at the device copy's removal afterwards. A
      // record another device removed from the shared layer is put back by
      // the original move, which replaces nothing.
      const { created, replaced } = run.outcome.sharedWrites;
      if (replaced > 0) return { ok: true, replaced: true };
      if (created > 0) return { ok: true, replaced: false };
      return { ok: false, reason: "changed-again" };
    });
  }

  private async conflictDeps() {
    const binding = this.binding;
    const workspaceId = this.identity?.file?.workspaceId;
    if (!binding || !workspaceId) return null;

    const home = await this.homeStore();
    const providers = await this.providerRuntimes(binding);
    const backupWriter = createBackupWriter({
      fs: this.host.fs,
      home,
      joinPath: this.host.joinPath,
      hashBytes: this.host.hashBytes,
      nowMs: () => this.host.clock.nowMs(),
      randomSuffix: () => this.host.ids.token(4),
      keep: this.settings.backupKeep,
    });

    return {
      fs: this.host.fs,
      joinPath: this.host.joinPath,
      workspaceId,
      replicaRoot: binding.syncDirPath,
      localPathFor: async (providerId: string, neutralRel: string) => {
        const runtime = providers.find((p) => p.adapter.id === providerId);
        return runtime ? runtime.adapter.targetPathFor(neutralRel) : null;
      },
      archivedPathsFor: (providerId: string, neutralRel: string) => {
        const provider = providers.find((p) => p.adapter.id === providerId);
        return provider ? archivedPathsFor(provider.adapter, neutralRel) : [];
      },
      // The same validator the pass writes through: a resolution is an
      // overwrite of a session file and gets the same containment walk.
      mintWritePath: createWritePathMinter({
        guard: await this.pathGuard(),
        roots: [binding.syncDirPath, ...providers.map((p) => p.root), home.layout.backupsDir],
      }),
      backup: (request: Parameters<typeof backupWriter.backup>[0]) => backupWriter.backup(request),
      hashBytes: this.host.hashBytes,
      mayWriteRemote: () => this.status.readiness === "READY",
      // Restore needs two things conflict resolution does not: the adapters
      // themselves (to find where a backed-up basename belongs now) and the
      // backup root to read from.
      providers,
      backupsDir: home.layout.backupsDir,
    };
  }

  private async computeStatus(outcome?: PassOutcome): Promise<RuntimeStatus> {
    const workspaceId = this.identity?.file?.workspaceId ?? null;
    const syncDirPath = this.binding?.syncDirPath ?? null;
    const machineLabel = this.machine?.machineLabel ?? null;
    // Active conflicts are what passes have *judged* to be in conflict and
    // not yet seen settled — not the number of quarantine directories
    // (which survive resolution on purpose), and not the last report alone
    // (which says nothing about a divergent pair it DEFERred). The sticky
    // set above is maintained on exactly those rules.
    const conflicts = this.lastReport ? this.conflicted.size : this.status.conflicts;
    const base = {
      workspaceId,
      syncDirPath,
      lastPassAtMs: this.lastReport?.finishedAtMs ?? this.status.lastPassAtMs,
      lastSummary: this.lastReport ? summarise(this.lastReport) : this.status.lastSummary,
      conflicts,
      machineLabel,
    };

    if (this.identity && this.identity.status !== "ok") {
      return {
        ...base,
        phase: "identity-blocked",
        readiness: "UNCONFIGURED",
        notReadyReason: null,
        short: "Claudian Session Sync: workspace identity problem",
        detail: IDENTITY_MESSAGES[this.identity.status],
      };
    }
    if (!workspaceId) {
      return {
        ...base,
        phase: "identity-required",
        readiness: "UNCONFIGURED",
        notReadyReason: null,
        short: "Claudian Session Sync: not set up",
        detail:
          "This vault has no workspace identity yet. Create one here on the first machine, " +
          "then wait for your vault sync to carry it to the others — creating a second one " +
          "would split this workspace in two.",
      };
    }
    if (!syncDirPath) {
      return {
        ...base,
        phase: "no-sync-dir",
        readiness: "UNCONFIGURED",
        notReadyReason: null,
        short: "Claudian Session Sync: no sync folder",
        detail:
          "Choose the folder your sync tool keeps in step across machines — a Dropbox, " +
          "iCloud or Syncthing directory. It must not be inside the vault.",
      };
    }

    const readiness =
      outcome?.readiness ??
      (await (await this.homeStore()).loadRemote(workspaceId, syncDirPath));

    if (outcome?.preflight?.kind === "root-overlap" || outcome?.preflight?.kind === "root-not-canonical") {
      return {
        ...base,
        phase: "error",
        readiness: readiness.state,
        notReadyReason: readiness.notReadyReason,
        short: "Claudian Session Sync: folder configuration problem",
        detail:
          outcome.preflight.kind === "root-overlap"
            ? `Two of the configured folders contain one another (${outcome.preflight.detail}). ` +
              "Nothing is synced until they are separate — nested roots make every later " +
              "safety check meaningless."
            : `${outcome.preflight.detail}. Point the setting at the folder's real location ` +
              "rather than a link to it.",
      };
    }

    const phase: RuntimePhase =
      readiness.state === "READY"
        ? "ready"
        : readiness.state === "AWAIT_INIT"
          ? "await-init"
          : readiness.state === "NOT_READY"
            ? "not-ready"
            : "probing";

    return {
      ...base,
      phase,
      readiness: readiness.state,
      notReadyReason: readiness.notReadyReason,
      short: shortFor(phase, base.lastSummary, conflicts),
      detail: detailFor(phase, readiness.notReadyReason, syncDirPath),
    };
  }
}

/** What one line of status bar says. */
function shortFor(phase: RuntimePhase, summary: string | null, conflicts: number): string {
  const suffix = conflicts > 0 ? ` · ${conflicts} conflict${conflicts === 1 ? "" : "s"}` : "";
  if (phase === "ready") return `Claudian Session Sync: ${summary ?? "idle"}${suffix}`;
  if (phase === "await-init") return "Claudian Session Sync: folder needs initialising";
  if (phase === "not-ready") return `Claudian Session Sync: paused${suffix}`;
  return `Claudian Session Sync: checking folder${suffix}`;
}

function detailFor(
  phase: RuntimePhase,
  reason: NotReadyReason | null,
  syncDirPath: string,
): string {
  if (phase === "await-init") {
    return (
      `The sync folder is empty. If it is brand new, choose "Initialise this sync folder". ` +
      `If you expect another machine's data to be there, wait for your sync tool to finish — ` +
      `nothing will be written to ${syncDirPath} before you say so.`
    );
  }
  if (phase === "not-ready") return NOT_READY_MESSAGES[reason ?? "NR-1-root-missing"];
  if (phase === "probing") {
    return "Watching the sync folder settle. Syncing starts once its contents stop changing.";
  }
  return "Syncing normally.";
}

/**
 * What each NR trigger means in words the user can act on.
 *
 * Written out rather than generated because every one of them is a refusal to
 * sync, and a refusal whose explanation is a code reads as a malfunction.
 */
const NOT_READY_MESSAGES: Record<NotReadyReason, string> = {
  "NR-1-root-missing":
    "The sync folder has contents but no marker file. It may have been recreated or restored " +
    "from a backup. Nothing is pushed until you confirm this is the right folder.",
  "NR-2-root-id-mismatch":
    "This is not the sync folder this vault was set up with. Check the path before continuing — " +
    "syncing into the wrong folder is not something this plugin can undo.",
  "NR-3-root-corrupt":
    "The sync folder's marker file could not be read. It is left untouched, in case it is a " +
    "transfer still in progress.",
  "NR-4-format-too-new":
    "The sync folder was written by a newer version of this plugin. This machine is read-only " +
    "until it is updated, so it cannot write a layout the newer one would misread.",
  "NR-5-workspace-subtree-missing":
    "This workspace's folder has disappeared from the sync directory. It is not being " +
    "re-created: an empty folder and a folder that has not downloaded yet look identical, and " +
    "guessing wrong would overwrite the other machine's history.",
  "NR-6-file-count-dropped":
    "The sync folder is holding fewer files than before. Usually this is a download still in " +
    "progress; syncing resumes on its own once the count stops falling.",
  "NR-7-byte-count-dropped":
    "The sync folder is holding fewer bytes than before. Usually a download still in progress; " +
    "syncing resumes on its own once the bytes are back. Claudian's conversation records are " +
    "not counted, so their shrinking cannot cause this.",
  "NR-8-remote-regression":
    "A file in the sync folder that had content is now empty. That is a sync-tool problem, not " +
    "a change anyone made, so nothing is copied over it.",
  "NR-9-sync-dir-unreachable":
    "The sync folder cannot be reached — an unmounted drive, a changed drive letter, or a " +
    "folder that moved. Syncing resumes when it comes back.",
};

/**
 * Changes and failures only — conflicts are deliberately not here. The status
 * line appends the conflict count itself, and a CONFLICT action's result is
 * "APPLIED" (the quarantine copies were applied), so counting it as a change
 * *and* letting the suffix report it produced "1 change, 1 conflict · 1
 * conflict" on a single conflicted session during the M1 acceptance run.
 */
function summarise(report: PassReport): string {
  if (report.outcome === "aborted") return `did nothing (${report.abortReason ?? "aborted"})`;
  const applied = report.actions.filter(
    (a) => a.result === "APPLIED" && a.action !== "NOOP" && a.action !== "CONFLICT",
  ).length;
  const failed = report.actions.filter((a) => a.result.startsWith("FAILED")).length;

  // "0 changes" is the steady state, which is to say: the normal one. Saying
  // it as a count reads like a report of failure every five minutes.
  if (applied === 0 && failed === 0) return "up to date";

  const parts = applied > 0 ? [`${applied} change${applied === 1 ? "" : "s"}`] : [];
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.join(", ");
}

/** One record the bring-back screen lists. */
export interface HeldRecordView {
  readonly neutralRel: string;
  readonly conversationId: string;
  readonly kind: Exclude<HoldKind, "tombstone-consumed">;
  readonly sinceMs: number;
  readonly releaseRequested: boolean;
  /** From the sync folder's copy, read for this screen only. */
  readonly title: string | null;
}

export type AuditOutcome =
  | { readonly ok: true; readonly audit: SyncFolderAudit }
  | { readonly ok: false; readonly reason: "not-set-up" | "unreachable" };

export type BringBackOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "sync-in-progress" | "unavailable" | "provider-off" };

/** The pop-up text for a pass's ADR-78 news, or null when it has none. */
function announce(summary: ClaudianRecordsSummary | undefined): string | null {
  if (!summary) return null;
  const parts: string[] = [];
  if (summary.newlyHeld > 0) {
    parts.push(
      `${summary.newlyHeld} conversation(s) you deleted on this device are being kept off it — ` +
        "your other devices still have them.",
    );
  }
  if (summary.changedSinceDeleted > 0) {
    parts.push(
      `${summary.changedSinceDeleted} conversation(s) deleted here were changed on another device since.`,
    );
  }
  if (summary.restoredHistoryMissing > 0) {
    parts.push(
      `${summary.restoredHistoryMissing} conversation(s) whose history had not reached this device yet ` +
        "were restored — Claudian may have removed them by itself.",
    );
  }
  return parts.length === 0 ? null : parts.join(" ");
}

/** Report lines named per conversation; the rest are counted. */
const NOT_HERE_LISTED = 20;
/** Titles a pop-up names; the rest are counted. */
const NOT_HERE_TITLED = 3;
const TITLE_CHARS = 60;

/** The aborts that mean another pass holds the lock right now. */
function lockAborted(report: PassReport): boolean {
  return report.outcome === "aborted" && ["ALREADY_RUNNING", "LOCK_HELD", "lock-unavailable"].includes(report.abortReason ?? "");
}

function newestFirst(a: HistoryNotHere, b: HistoryNotHere): number {
  return (
    b.lastActivityMs - a.lastActivityMs ||
    (a.conversationId < b.conversationId ? 1 : a.conversationId > b.conversationId ? -1 : 0)
  );
}

/**
 * One report line per conversation whose history is not here yet (ADR-81),
 * newest first, with what this pass did about the transcript — "deferred,
 * still settling" and "skipped, too large" are different waits, and only the
 * report can say which. Ids only: the report never carries a title.
 */
function describeHistoryNotHere(entries: readonly HistoryNotHere[], report: PassReport): string[] {
  const lines = entries.slice(0, NOT_HERE_LISTED).map((entry) => {
    const rel = `${CLAUDE_CODE.id}/${entry.sessionId}.jsonl`;
    const action = report.actions.find((a) => a.neutralRel === rel);
    const thisPass = action ? ` This pass: ${action.action} (${action.reason}).` : "";
    return (
      `History not here yet: Claude conversation ${entry.conversationId}${entry.shared ? " (shared)" : ""} ` +
      `resumes ${rel}, which the sync folder has and this device's Claude folder does not. Don't send ` +
      "in it here until it arrives — Claudian deletes or resets a conversation whose history it cannot " +
      `find${entry.shared ? ", and this one is shared: the change would reach your other devices with the vault" : ""}.` +
      thisPass
    );
  });
  const rest = entries.length - NOT_HERE_LISTED;
  if (rest > 0) lines.push(`History not here yet: ${rest} more Claude conversation(s) like the above, less recent.`);
  return lines;
}

/**
 * The pop-up, naming conversations the way Claudian lists them — by title.
 * Read for this text alone and kept nowhere else: the report has ids.
 */
function announceHistoryNotHere(entries: readonly HistoryNotHere[]): string {
  const named = entries.slice(0, NOT_HERE_TITLED).map((entry) => {
    if (entry.title === null) return "(untitled)";
    const title = entry.title.replace(/\s+/g, " ").trim();
    return `"${title.length > TITLE_CHARS ? `${title.slice(0, TITLE_CHARS - 1)}…` : title}"`;
  });
  const rest = entries.length - named.length;
  return (
    `History has not reached this device yet for ${entries.length} Claude conversation(s): ` +
    `${named.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}. Don't send in them until it has — Claudian ` +
    "deletes or resets a conversation whose history it cannot find" +
    (entries.some((entry) => entry.shared)
      ? ", and for a shared one that change reaches your other devices with the vault."
      : ".")
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type PassRunnerArgs = Omit<
  Parameters<typeof runWorkspacePass>[0],
  "dryRun" | "verifyAll" | "firstPassAfterStartup" | "msSinceLastStartupScrub"
>;
