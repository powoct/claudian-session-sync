/**
 * The machine-local state directory (architecture §5.5) — store (b) of §5.6.
 *
 * `state-store.ts` decides what a loaded file *means*; this decides where it
 * lives and puts it there. The split matters because the parsing rules are the
 * interesting part and they should be testable without a filesystem, while the
 * layout is boring and needs a real one.
 *
 * Two properties hold for everything below:
 *
 *  - **Nothing here is ever synced, and nothing here can be rebuilt from what
 *    is.** Losing this directory means "reconfigure this machine", not "lost
 *    data" — which is exactly why the sync directory may never authorise
 *    anything (§5.6 rule 2).
 *  - **Every path is minted, none is cast.** These paths are constructed from
 *    the OS home directory rather than received from a sync folder, so there is
 *    no containment walk to do; what `mintStatePath` still checks is that no
 *    untrusted text was concatenated into one.
 */
import type { MachineId, Result, SafeAbsolutePath, WorkspaceId } from "../domain/types";
import type { FsGateway } from "./fs-gateway";
import { type PathGuardDeps, mintStatePath } from "./path-guard";
import { readJson, writeJson } from "./json-file";
import {
  type LoadOutcome,
  type MachineFile,
  type ObservationsFile,
  STATE_SCHEMA_VERSION,
  emptyObservations,
  gcObservations,
  parseMachineFile,
  parseObservations,
} from "./state-store";
import type { NotReadyReason, ReadinessState, RemoteRecord } from "../domain/readiness";
import { INITIAL_REMOTE_RECORD } from "../domain/readiness";

/** 0700: this directory holds absolute paths and a machine identity. */
const DIR_MODE = 0o700;

export interface HomeStoreDeps {
  readonly fs: FsGateway;
  readonly guard: PathGuardDeps;
  readonly joinPath: (...parts: string[]) => string;
  /** `<homedir>/.claudian-session-sync`, already realpath'd by the caller. */
  readonly stateRoot: string;
}

/**
 * Which machine-local settings a workspace is bound to (§5.5).
 *
 * The absolute `syncDirPath` is the reason this file exists at all: it is the
 * single most machine-specific value in the plugin, and putting it in the vault
 * would make Mac's path overwrite Windows's on the next vault sync.
 */
export interface WorkspaceBinding {
  readonly schemaVersion: number;
  readonly workspaceId: WorkspaceId;
  readonly syncDirPath: string;
  readonly providers: Readonly<Record<string, ProviderBinding>>;
  readonly createdAt: string;
}

export interface ProviderBinding {
  readonly enabled: boolean;
  /** Set when the user overrode the detected CLI storage root. */
  readonly rootOverride?: string;
  /**
   * Set once, the first time this provider is switched on (§6.1).
   *
   * Enabling a provider decides which of this machine's conversations start
   * travelling, and the answer is rarely "the one I just had": the r4
   * acceptance run turned Grok on and admitted fourteen historical sessions
   * across two machines — 56 files — with nothing shown first. So the first
   * enable runs a dry run before anything can be copied, and this flag is how
   * "first" is known across restarts.
   */
  readonly introducedAt?: string;
}

/** `remote.json` (§9.6.2) — this machine's view of one sync directory. */
export interface RemoteStateFile {
  readonly schemaVersion: number;
  readonly syncDirPath: string;
  readonly rootId: string | null;
  readonly state: ReadinessState;
  readonly initializedAt: string | null;
  readonly lastReadyPassAt: string | null;
  readonly lastKnownCounts: { readonly files: number; readonly bytes: number };
  readonly consecutiveStableProbes: number;
  readonly firstProbeMs: number | null;
  readonly notReadyReason: NotReadyReason | null;
}

export interface HomeLayout {
  readonly root: string;
  readonly machineFile: string;
  readonly workspacesDir: string;
  readonly locksDir: string;
  readonly backupsDir: string;
  readonly logsDir: string;
  workspaceFile(workspaceId: string): string;
  stateDir(workspaceId: string): string;
  observationsFile(workspaceId: string): string;
  remoteFile(workspaceId: string): string;
  lockFile(workspaceId: string): string;
}

export function homeLayout(deps: HomeStoreDeps): HomeLayout {
  const join = deps.joinPath;
  const root = deps.stateRoot;
  return {
    root,
    machineFile: join(root, "machine.json"),
    workspacesDir: join(root, "workspaces"),
    locksDir: join(root, "locks"),
    backupsDir: join(root, "backups"),
    logsDir: join(root, "logs"),
    workspaceFile: (id) => join(root, "workspaces", `${id}.json`),
    stateDir: (id) => join(root, "state", id),
    observationsFile: (id) => join(root, "state", id, "observations.json"),
    remoteFile: (id) => join(root, "state", id, "remote.json"),
    lockFile: (id) => join(root, "locks", `${id}.lock`),
  };
}

export interface HomeStore {
  readonly layout: HomeLayout;
  loadMachine(): Promise<LoadOutcome<MachineFile>>;
  saveMachine(file: MachineFile): Promise<void>;
  loadBinding(workspaceId: WorkspaceId): Promise<LoadOutcome<WorkspaceBinding>>;
  saveBinding(binding: WorkspaceBinding): Promise<void>;
  listBoundWorkspaces(): Promise<string[]>;
  loadObservations(input: {
    readonly workspaceId: WorkspaceId;
    readonly machineId: MachineId;
    readonly syncDirFingerprint: string;
  }): Promise<{ readonly file: ObservationsFile; readonly outcome: LoadOutcome<ObservationsFile> }>;
  saveObservations(workspaceId: WorkspaceId, file: ObservationsFile, nowMs: number): Promise<void>;
  loadRemote(workspaceId: WorkspaceId, syncDirPath: string): Promise<RemoteRecord>;
  saveRemote(workspaceId: WorkspaceId, record: RemoteRecord, context: RemoteContext): Promise<void>;
  /** Mints a path under the state root; the only way to get a writable one. */
  mint(absoluteTarget: string): Result<SafeAbsolutePath>;
}

export interface RemoteContext {
  readonly syncDirPath: string;
  readonly nowIso: string;
  readonly initializedAt: string | null;
}

export function createHomeStore(deps: HomeStoreDeps): HomeStore {
  const layout = homeLayout(deps);
  const mint = (target: string) => mintStatePath(deps.guard, layout.root, target);

  /** Writes through the mint, or does nothing — never through a raw cast. */
  async function put(target: string, parent: string, value: unknown): Promise<void> {
    const file = mint(target);
    const dir = mint(parent);
    if (!file.ok || !dir.ok) return;
    await deps.fs.mkdirp(dir.value, DIR_MODE);
    await writeJson(deps.fs, file.value, value, dir.value);
  }

  return {
    layout,

    async loadMachine() {
      const load = await readJson(deps.fs, layout.machineFile);
      if (load.status === "absent") return { status: "absent" };
      if (load.status === "unusable") return { status: "unusable", reason: load.reason };
      return parseMachineFile(load.raw);
    },

    async saveMachine(file) {
      await put(layout.machineFile, layout.root, file);
    },

    async loadBinding(workspaceId) {
      const load = await readJson(deps.fs, layout.workspaceFile(workspaceId));
      if (load.status === "absent") return { status: "absent" };
      if (load.status === "unusable") return { status: "unusable", reason: load.reason };
      return parseBinding(load.raw, workspaceId);
    },

    async saveBinding(binding) {
      await put(layout.workspaceFile(binding.workspaceId), layout.workspacesDir, binding);
    },

    async listBoundWorkspaces() {
      const entries = await deps.fs.readDir(layout.workspacesDir).catch(() => []);
      return entries
        .filter((entry) => entry.isFile && entry.name.endsWith(".json"))
        .map((entry) => entry.name.slice(0, -".json".length))
        .sort();
    },

    async loadObservations(input) {
      const load = await readJson(deps.fs, layout.observationsFile(input.workspaceId));
      const empty = emptyObservations(input.machineId, input.syncDirFingerprint);
      if (load.status === "absent") return { file: empty, outcome: { status: "absent" } };
      if (load.status === "unusable") {
        return { file: empty, outcome: { status: "unusable", reason: load.reason } };
      }
      const parsed = parseObservations(load.raw, {
        machineId: input.machineId,
        syncDirFingerprint: input.syncDirFingerprint,
      });
      // The fail-safe of §5.5, made concrete: any doubt about the ledger and
      // the pass runs with an empty one, which means nothing is stable, which
      // means it degrades to observation for a round. Slow, never wrong.
      return { file: parsed.status === "loaded" ? parsed.value : empty, outcome: parsed };
    },

    async saveObservations(workspaceId, file, nowMs) {
      await put(
        layout.observationsFile(workspaceId),
        layout.stateDir(workspaceId),
        gcObservations(file, nowMs),
      );
    },

    async loadRemote(workspaceId, syncDirPath) {
      const load = await readJson(deps.fs, layout.remoteFile(workspaceId));
      if (load.status !== "loaded") return INITIAL_REMOTE_RECORD;
      const parsed = parseRemote(load.raw);
      if (parsed === null) return INITIAL_REMOTE_RECORD;
      // A record about a *different* directory says nothing about this one.
      // Starting over costs a probing round; trusting it could hand this
      // directory the READY state another one earned.
      if (parsed.syncDirPath !== syncDirPath) return INITIAL_REMOTE_RECORD;
      return {
        state: parsed.state,
        rootId: parsed.rootId,
        lastKnownCounts: parsed.lastKnownCounts,
        consecutiveStableProbes: parsed.consecutiveStableProbes,
        firstProbeMs: parsed.firstProbeMs,
        notReadyReason: parsed.notReadyReason,
      };
    },

    async saveRemote(workspaceId, record, context) {
      const file: RemoteStateFile = {
        schemaVersion: STATE_SCHEMA_VERSION,
        syncDirPath: context.syncDirPath,
        rootId: record.rootId,
        state: record.state,
        initializedAt: context.initializedAt,
        lastReadyPassAt: record.state === "READY" ? context.nowIso : null,
        lastKnownCounts: record.lastKnownCounts,
        consecutiveStableProbes: record.consecutiveStableProbes,
        firstProbeMs: record.firstProbeMs,
        notReadyReason: record.notReadyReason,
      };
      await put(layout.remoteFile(workspaceId), layout.stateDir(workspaceId), file);
    },

    mint,
  };
}

export function emptyBinding(input: {
  readonly workspaceId: WorkspaceId;
  readonly syncDirPath: string;
  readonly createdAt: string;
}): WorkspaceBinding {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    workspaceId: input.workspaceId,
    syncDirPath: input.syncDirPath,
    providers: {},
    createdAt: input.createdAt,
  };
}

function parseBinding(raw: unknown, expected: WorkspaceId): LoadOutcome<WorkspaceBinding> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { status: "unusable", reason: "not-an-object" };
  }
  const c = raw as Partial<WorkspaceBinding>;
  if (typeof c.schemaVersion !== "number") return { status: "unusable", reason: "missing-schema-version" };
  if (c.schemaVersion > STATE_SCHEMA_VERSION) return { status: "unusable", reason: "newer-schema" };
  if (c.workspaceId !== expected) return { status: "unusable", reason: "workspace-id-mismatch" };
  if (typeof c.syncDirPath !== "string" || c.syncDirPath.length === 0) {
    return { status: "unusable", reason: "missing-sync-dir" };
  }

  return {
    status: "loaded",
    value: {
      schemaVersion: c.schemaVersion,
      workspaceId: expected,
      syncDirPath: c.syncDirPath,
      providers: parseProviders(c.providers),
      createdAt: typeof c.createdAt === "string" ? c.createdAt : "",
    },
  };
}

function parseProviders(raw: unknown): Record<string, ProviderBinding> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, ProviderBinding> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const v = value as Partial<ProviderBinding>;
    // Absent means disabled. A provider is enabled by the user saying so, not
    // by a malformed record failing to say otherwise.
    const override = typeof v.rootOverride === "string" ? v.rootOverride : undefined;
    const introduced = typeof v.introducedAt === "string" ? v.introducedAt : undefined;
    out[id] = {
      enabled: v.enabled === true,
      ...(override === undefined ? {} : { rootOverride: override }),
      ...(introduced === undefined ? {} : { introducedAt: introduced }),
    };
  }
  return out;
}

function parseRemote(raw: unknown): RemoteStateFile | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const c = raw as Partial<RemoteStateFile>;
  if (typeof c.schemaVersion !== "number" || c.schemaVersion > STATE_SCHEMA_VERSION) return null;
  if (typeof c.syncDirPath !== "string") return null;
  if (typeof c.state !== "string") return null;

  const counts = c.lastKnownCounts;
  return {
    schemaVersion: c.schemaVersion,
    syncDirPath: c.syncDirPath,
    rootId: typeof c.rootId === "string" ? c.rootId : null,
    state: c.state,
    initializedAt: typeof c.initializedAt === "string" ? c.initializedAt : null,
    lastReadyPassAt: typeof c.lastReadyPassAt === "string" ? c.lastReadyPassAt : null,
    lastKnownCounts: {
      files: typeof counts?.files === "number" ? counts.files : 0,
      bytes: typeof counts?.bytes === "number" ? counts.bytes : 0,
    },
    consecutiveStableProbes:
      typeof c.consecutiveStableProbes === "number" ? c.consecutiveStableProbes : 0,
    firstProbeMs: typeof c.firstProbeMs === "number" ? c.firstProbeMs : null,
    notReadyReason: typeof c.notReadyReason === "string" ? c.notReadyReason : null,
  };
}
