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
import type { NotReadyReason, ReadinessState } from "../domain/readiness";
import type { MachineId, WorkspaceId } from "../domain/types";
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
import type { PathGuardDeps } from "../infra/path-guard";
import { mintStatePath, probeCaseSensitivity, splitPathSegments } from "../infra/path-guard";
import { type MachineFile, STATE_SCHEMA_VERSION } from "../infra/state-store";
import { detectIdentityDrift, rotateMachineId } from "../infra/state-store";
import { createSyncDirStore, newRootFile } from "../infra/sync-dir-store";
import { PROVIDERS, providerById } from "../providers/registry";
import {
  type BackupEntry,
  type RestoreOutcome,
  listBackups,
  restoreBackup,
} from "./restore-commands";
import { type ConflictEntry, listConflicts, resolveConflict } from "./conflict-commands";
import type { ResolveOutcome } from "./conflict-commands";
import { createFileLock } from "./lock-file";
import type { PassReport } from "./pass-report";
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
  readonly platform: string;
  readonly hostname: string;
  readonly homedir: string;
  /** Realpath of the vault. Resolved by the caller, which owns the host API. */
  readonly vaultRoot: string;
  readonly pid: number;
  /** Obsidian's `loadData` / `saveData`; the vault-side portable settings. */
  loadSettings(): Promise<unknown>;
  saveSettings(value: unknown): Promise<void>;
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

  onChange(listener: (status: RuntimeStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Reads state and recomputes the status. Safe to call repeatedly. */
  async refresh(): Promise<RuntimeStatus> {
    const settings = parseSettings(await this.host.loadSettings());
    this.settings = settings.settings;
    this.unknownSettings = settings.unknown;

    const home = await this.homeStore();
    this.machine = await this.loadOrCreateMachine(home);

    // The vault answers "which workspace is this" (§5.2.3); this machine's
    // binding answers "and where does it sync to". Both, or nothing happens.
    const bound = await this.boundWorkspaceId(home);
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
    const prepared = await this.prepare();
    if (!prepared.ok) return this.publish(prepared.status);
    if (this.passInFlight) return this.status;

    this.publish({ ...this.status, phase: "syncing", short: "Claudian Session Sync: syncing…" });
    try {
      const outcome = await runWorkspacePass({
        ...prepared.deps,
        dryRun: options.dryRun ?? false,
        verifyAll: options.verifyAll ?? false,
        firstPassAfterStartup: !this.firstPassDone,
        msSinceLastStartupScrub: this.host.clock.nowMs() - this.startedAtMs,
      });
      this.firstPassDone = true;
      this.lastReport = outcome.report;
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
    });
    await this.refresh();
  }

  async setProvider(providerId: string, patch: Partial<ProviderBinding>): Promise<void> {
    const binding = this.binding;
    if (!binding) return;
    const previous = binding.providers[providerId] ?? { enabled: false };
    const home = await this.homeStore();
    await home.saveBinding({
      ...binding,
      providers: { ...binding.providers, [providerId]: { ...previous, ...patch } },
    });
    await this.refresh();
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

  async backups(): Promise<BackupEntry[]> {
    const deps = await this.conflictDeps();
    return deps ? listBackups(deps) : [];
  }

  async restore(
    backupPath: string,
    expectedHashPrefix: string,
    expectedLiveHashPrefix: string | null,
  ): Promise<RestoreOutcome> {
    const deps = await this.conflictDeps();
    if (!deps) return { ok: false, reason: "unknown-backup" };
    const outcome = await restoreBackup(
      deps,
      backupPath,
      expectedHashPrefix,
      expectedLiveHashPrefix,
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
    const outcome = await resolveConflict(deps, conflictId, resolution);
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
   * Loads this machine's identity, creating or rotating it as needed (§10.3).
   *
   * Rotation is silent by design: `machineId` never takes part in a decision,
   * so the entire cost of giving way is one line in an audit list — and a
   * dialog asking the user to adjudicate a hostname change is a dialog nobody
   * can answer.
   */
  private async loadOrCreateMachine(home: HomeStore): Promise<MachineFile> {
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
      await home.saveMachine(created);
      return created;
    }

    const drift = detectIdentityDrift(load.value.identity, identity);
    if (drift === null) return load.value;
    const rotated = rotateMachineId(
      load.value,
      { machineId: this.host.ids.uuid() as MachineId, identity, nowIso: this.nowIso() },
      drift,
    );
    await home.saveMachine(rotated);
    return rotated;
  }

  private async boundWorkspaceId(home: HomeStore): Promise<WorkspaceId | null> {
    const bound = await home.listBoundWorkspaces();
    return (bound[0] as WorkspaceId | undefined) ?? null;
  }

  private async loadBinding(home: HomeStore, workspaceId: WorkspaceId): Promise<WorkspaceBinding | null> {
    const load = await home.loadBinding(workspaceId);
    return load.status === "loaded" ? load.value : null;
  }

  /** Assembles the pass, or explains why it cannot be assembled. */
  private async prepare(): Promise<
    { ok: true; deps: PassRunnerArgs } | { ok: false; status: RuntimeStatus }
  > {
    if (!this.machine || !this.identity) {
      const status = await this.refresh();
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
          probeDelayMs: this.settings.probeDelayMs,
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

  private async providerRuntimes(binding: WorkspaceBinding): Promise<ProviderRuntime[]> {
    const runtimes: ProviderRuntime[] = [];
    for (const descriptor of PROVIDERS) {
      const configured = binding.providers[descriptor.id];
      if (!configured?.enabled) continue;
      const root =
        configured.rootOverride ??
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
          vaultRealPath: this.host.vaultRoot,
          joinPath: this.host.joinPath,
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
    "The sync folder is holding fewer bytes than before. Usually a download in progress; " +
    "syncing resumes on its own.",
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type PassRunnerArgs = Omit<
  Parameters<typeof runWorkspacePass>[0],
  "dryRun" | "verifyAll" | "firstPassAfterStartup" | "msSinceLastStartupScrub"
>;
