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
import { INITIAL_REMOTE_RECORD, LEGACY_BYTE_COUNT_BASIS } from "../domain/readiness";
import { type HoldKind, claudianRecordOf } from "../domain/deleted-here";

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
  /**
   * Which vault this binding is for (realpath'd), when it is known.
   *
   * Without it, "is this machine bound to this vault" is not a question the
   * state can answer — it could only ask "is this machine bound to anything",
   * and the answer was whichever binding sorted first. On a machine with two
   * vaults that picks the wrong one, and the identity check then reports the
   * vault as CHANGED and stops syncing (OQ-19, ADR-59).
   *
   * Optional because bindings written before this field exist; they are
   * stamped the first time their own vault is opened, which is what keeps the
   * migration to a single ordinary pass.
   */
  readonly vaultPath?: string;
  /**
   * Move this device's conversation records into the layer every device reads
   * (ADR-69). Machine-local, and deliberately not in `PortableSettings`:
   * `data.json` lives in the vault and travels with it, so a switch stored
   * there would turn itself on for the other machine and start moving *its*
   * records. Writing into another plugin's store is consent each machine
   * gives for itself.
   */
  readonly shareConversations?: boolean;
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
  /**
   * What `lastKnownCounts.bytes` measured (ADR-80). Absent in files written
   * before it, which measured basis 1 — and absent again after a downgrade
   * rewrites the file, which is why it is never assumed current.
   */
  readonly byteCountBasis?: number;
  readonly consecutiveStableProbes: number;
  readonly firstProbeMs: number | null;
  readonly notReadyReason: NotReadyReason | null;
}

/**
 * `shared-records.json` (ADR-71) — what this machine has published into
 * Claudian's shared layer, and what it is holding back.
 *
 * One entry per conversation whose record this machine moved. `publishedHash`
 * means exactly one thing: **bytes this machine itself wrote into the flat
 * layer**, or bytes it proved byte-identical on both sides. It is never seeded
 * from a record merely found there — that distinction is the whole safety
 * argument, because the hash is what authorises overwriting the shared copy.
 *
 * Machine-local and unsynced, like everything else here. Losing it costs
 * convergence, never bytes: every entry it forgets falls back to "hold and
 * report", which is the same answer the code gives a record it has never seen.
 */
export interface SharedRecordsFile {
  readonly schemaVersion: number;
  /**
   * The device key these entries were published from. A different one means a
   * reinstalled Claudian, whose records live in a different folder — the
   * entries describe conversations this installation never published.
   */
  readonly deviceKey: string;
  readonly records: Readonly<Record<string, SharedRecordEntry>>;
}

export interface SharedRecordEntry {
  /** sha256 of the bytes this machine last wrote into the flat layer. */
  readonly publishedHash: string;
  readonly publishedSize: number;
  /** Last pass that saw this conversation at all; drives GC. */
  readonly lastSeenMs: number;
}

/**
 * `claudian-records.json` (ADR-78) — which of Claudian's records this machine
 * has held, and which it is keeping off itself because they were removed here.
 *
 * Separate from the observation ledger on purpose. The ledger forgets a file
 * thirty days after it was last seen on this machine, and is rebuilt from
 * nothing whenever its owner or its sync folder changes — and a record the
 * user deleted is precisely a file this machine stops seeing. A memory of
 * deletions that expires is a conversation that comes back a month later.
 *
 * Keyed by neutral path (`claudian/<conv>.<kind>.json`). Holds hashes, sizes,
 * timestamps and booleans — no title, no text: the "changed since" check
 * compares a digest, never content.
 */
export interface ClaudianRecordsFile {
  readonly schemaVersion: number;
  /**
   * `.claudian/sessions` as last seen (its inode), or absent when unknown. A
   * different one means the store was recreated — a vault downloaded again,
   * the folder deleted — and its records missing all at once is not the user
   * deleting them.
   */
  readonly storeIdentity?: string;
  /**
   * Records found missing when the store was recreated whose judgement a pass
   * put off (their copy in the sync folder was still moving, say). Until a
   * pass judges them, their absence is still not a deletion.
   */
  readonly recreatedPending?: readonly string[];
  readonly records: Readonly<Record<string, ClaudianRecordEntry>>;
}

/**
 * Never forgotten, deliberately. A witness is what makes a record missing
 * here mean "removed here"; dropping one turns the record into "not here
 * yet", and the next time any device pushes it — a peer that still has it,
 * a move to a new sync folder — it comes back. One entry per record this
 * machine has ever held is a few hundred bytes each, which is the price.
 */
export interface ClaudianRecordEntry {
  /** sha256 of the bytes this machine last converged on for this file. */
  readonly witnessedHash: string;
  /**
   * The bytes this machine landed because Claudian may have removed the
   * record by itself (ADR-78 ⑥). Cleared as soon as it converges on anything
   * else; while it matches, a second removal is the user's.
   */
  readonly restoredForMissingHistory?: string;
  readonly hold?: HeldRecordEntry;
}

export interface HeldRecordEntry {
  readonly kind: HoldKind;
  readonly sinceMs: number;
  /** Passes this hold has been applied in, including the first. */
  readonly passes: number;
  /** The user has been told about it (deleted-here only). */
  readonly announced: boolean;
  /** The sync folder's copy when last looked at, for "changed since". */
  readonly replicaSize: number;
  readonly replicaMtimeMs: number;
  /** `recordDigest` of that copy, or null when it could not be parsed. */
  readonly replicaDigest: string | null;
  /** The user asked for it back; the next pass lands it. */
  readonly releaseRequested: boolean;
}

/** Why `loadClaudianRecords` came back without a usable file. */
export type ClaudianRecordsLoad =
  | { readonly status: "loaded"; readonly file: ClaudianRecordsFile }
  | { readonly status: "absent" }
  /** Read, and not this format: empty, truncated, not JSON, not the shape. */
  | { readonly status: "unusable" }
  /**
   * Could not be read at all (EBUSY, EPERM, EACCES…). Not the same as
   * unusable: the file may be perfectly good, and rebuilding it from the
   * ledger would overwrite every hold older than the ledger's memory.
   */
  | { readonly status: "unreadable"; readonly reason: string }
  /** Written by a newer build of this plugin: not read, and never overwritten. */
  | { readonly status: "newer" };

const HOLD_KINDS: ReadonlySet<string> = new Set<HoldKind>([
  "deleted-here",
  "moved-to-device",
  "removed-by-tombstone",
  "tombstone-consumed",
]);

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
  sharedRecordsFile(workspaceId: string): string;
  claudianRecordsFile(workspaceId: string): string;
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
    sharedRecordsFile: (id) => join(root, "state", id, "shared-records.json"),
    claudianRecordsFile: (id) => join(root, "state", id, "claudian-records.json"),
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
  loadSharedRecords(workspaceId: WorkspaceId, deviceKey: string): Promise<SharedRecordsFile>;
  saveSharedRecords(workspaceId: WorkspaceId, file: SharedRecordsFile): Promise<void>;
  loadClaudianRecords(workspaceId: WorkspaceId): Promise<ClaudianRecordsLoad>;
  saveClaudianRecords(workspaceId: WorkspaceId, file: ClaudianRecordsFile): Promise<void>;
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
        byteCountBasis: parsed.byteCountBasis ?? LEGACY_BYTE_COUNT_BASIS,
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
        byteCountBasis: record.byteCountBasis,
        consecutiveStableProbes: record.consecutiveStableProbes,
        firstProbeMs: record.firstProbeMs,
        notReadyReason: record.notReadyReason,
      };
      await put(layout.remoteFile(workspaceId), layout.stateDir(workspaceId), file);
    },

    async loadSharedRecords(workspaceId, deviceKey) {
      const empty: SharedRecordsFile = {
        schemaVersion: STATE_SCHEMA_VERSION,
        deviceKey,
        records: {},
      };
      const load = await readJson(deps.fs, layout.sharedRecordsFile(workspaceId));
      if (load.status !== "loaded") return empty;
      const parsed = parseSharedRecords(load.raw);
      if (parsed === null) return empty;
      // Entries published from a different installation describe conversations
      // in a device folder this one does not own. Treating them as ours would
      // let a stale hash authorise overwriting a shared record.
      if (parsed.deviceKey !== deviceKey) return empty;
      return parsed;
    },

    async saveSharedRecords(workspaceId, file) {
      await put(layout.sharedRecordsFile(workspaceId), layout.stateDir(workspaceId), file);
    },

    async loadClaudianRecords(workspaceId) {
      const load = await readJson(deps.fs, layout.claudianRecordsFile(workspaceId));
      if (load.status === "absent") return { status: "absent" };
      if (load.status === "unusable") {
        return load.reason === "empty" || load.reason === "not-json"
          ? { status: "unusable" }
          : { status: "unreadable", reason: load.reason };
      }
      return parseClaudianRecords(load.raw);
    },

    async saveClaudianRecords(workspaceId, file) {
      await put(layout.claudianRecordsFile(workspaceId), layout.stateDir(workspaceId), file);
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
      ...(typeof c.vaultPath === "string" && c.vaultPath.length > 0
        ? { vaultPath: c.vaultPath }
        : {}),
      ...(c.shareConversations === true ? { shareConversations: true } : {}),
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

/**
 * Refuses far more than it repairs.
 *
 * A malformed entry is dropped rather than defaulted, because every default
 * that could be invented here — an empty hash, a zero size — would be a claim
 * about bytes in the vault that this machine never verified. Dropping one
 * costs a held-back record and a line in the report.
 */
function parseSharedRecords(raw: unknown): SharedRecordsFile | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const c = raw as Partial<SharedRecordsFile>;
  // A newer schema is never read and never rewritten: it is direct evidence of
  // a newer build of this plugin on this machine (§5.3).
  if (typeof c.schemaVersion !== "number" || c.schemaVersion > STATE_SCHEMA_VERSION) return null;
  if (typeof c.deviceKey !== "string") return null;
  if (typeof c.records !== "object" || c.records === null || Array.isArray(c.records)) return null;

  const records: Record<string, SharedRecordEntry> = {};
  for (const [id, value] of Object.entries(c.records)) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as Partial<SharedRecordEntry>;
    if (typeof entry.publishedHash !== "string" || entry.publishedHash.length === 0) continue;
    if (typeof entry.publishedSize !== "number" || !Number.isFinite(entry.publishedSize)) continue;
    if (typeof entry.lastSeenMs !== "number" || !Number.isFinite(entry.lastSeenMs)) continue;
    records[id] = {
      publishedHash: entry.publishedHash,
      publishedSize: entry.publishedSize,
      lastSeenMs: entry.lastSeenMs,
    };
  }
  return { schemaVersion: c.schemaVersion, deviceKey: c.deviceKey, records };
}

/**
 * Drops what it cannot vouch for, entry by entry.
 *
 * An entry that does not parse is lost, which can only ever release a hold —
 * the record comes back once, and deleting it again holds it again. The one
 * thing that is never guessed is a hold's kind: an unknown one would be a
 * hold this version cannot explain to the user.
 */
function parseClaudianRecords(raw: unknown): ClaudianRecordsLoad {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { status: "unusable" };
  const c = raw as Partial<ClaudianRecordsFile>;
  if (typeof c.schemaVersion !== "number") return { status: "unusable" };
  if (c.schemaVersion > STATE_SCHEMA_VERSION) return { status: "newer" };
  if (typeof c.records !== "object" || c.records === null || Array.isArray(c.records)) {
    return { status: "unusable" };
  }

  const records: Record<string, ClaudianRecordEntry> = {};
  for (const [rel, value] of Object.entries(c.records)) {
    if (claudianRecordOf(rel) === null) continue;
    if (typeof value !== "object" || value === null) continue;
    const entry = value as Partial<ClaudianRecordEntry>;
    if (typeof entry.witnessedHash !== "string") continue;
    const hold = parseHold(entry.hold);
    records[rel] = {
      witnessedHash: entry.witnessedHash,
      ...(typeof entry.restoredForMissingHistory === "string"
        ? { restoredForMissingHistory: entry.restoredForMissingHistory }
        : {}),
      ...(hold ? { hold } : {}),
    };
  }
  return {
    status: "loaded",
    file: {
      schemaVersion: c.schemaVersion,
      ...(typeof c.storeIdentity === "string" ? { storeIdentity: c.storeIdentity } : {}),
      ...(Array.isArray(c.recreatedPending)
        ? {
            recreatedPending: c.recreatedPending.filter(
              (rel): rel is string => typeof rel === "string" && claudianRecordOf(rel) !== null,
            ),
          }
        : {}),
      records,
    },
  };
}

function parseHold(raw: unknown): HeldRecordEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const h = raw as Partial<HeldRecordEntry>;
  if (typeof h.kind !== "string" || !HOLD_KINDS.has(h.kind)) return null;
  const sinceMs = finite(h.sinceMs);
  const passes = finite(h.passes);
  const size = finite(h.replicaSize);
  const mtime = finite(h.replicaMtimeMs);
  if (sinceMs === null || passes === null || size === null || mtime === null) return null;
  return {
    kind: h.kind,
    sinceMs,
    passes,
    announced: h.announced === true,
    replicaSize: size,
    replicaMtimeMs: mtime,
    replicaDigest: typeof h.replicaDigest === "string" ? h.replicaDigest : null,
    releaseRequested: h.releaseRequested === true,
  };
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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
    ...(typeof c.byteCountBasis === "number" ? { byteCountBasis: c.byteCountBasis } : {}),
    consecutiveStableProbes:
      typeof c.consecutiveStableProbes === "number" ? c.consecutiveStableProbes : 0,
    firstProbeMs: typeof c.firstProbeMs === "number" ? c.firstProbeMs : null,
    notReadyReason: typeof c.notReadyReason === "string" ? c.notReadyReason : null,
  };
}
