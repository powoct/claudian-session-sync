/**
 * The dual-replica L2 world (testing.md §7.1).
 *
 * Four real tmpdir subtrees:
 *
 *   A.local <-> A.replica <--[transport]--> B.replica <-> B.local
 *
 * Both replicas are separate directories on purpose. A shared sync folder would
 * make `flush()` meaningless — the file is already on the other side, so
 * delay, reordering and truncation cannot be expressed at all, and those are
 * precisely the behaviours an external sync tool exhibits. Everything except
 * the transport is a real filesystem, so rename semantics, mtime granularity
 * and case sensitivity stay honest.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, promises as fsp, writeFileSync } from "node:fs";
import path from "node:path";
import type { LogicalId, SafeAbsolutePath } from "../../src/domain/types";
import {
  type CachedContentFacts,
  type Manifest,
  type ManifestEntry,
  type ScrubTrigger,
  emptyManifest,
  parseManifest,
  serialiseManifest,
} from "../../src/domain/manifest";
import type { FsGateway } from "../../src/infra/fs-gateway";
import { fixedClock, sequentialIdGen } from "../../src/infra/clock";
import { createNodeFsGateway } from "../../src/infra/node-fs-gateway";
import { type PathGuardDeps, splitPathSegments } from "../../src/infra/path-guard";
import { type WorkspaceBinding, createHomeStore } from "../../src/infra/home-store";
import { createSyncDirStore, newRootFile } from "../../src/infra/sync-dir-store";
import { type PassOutcome, runWorkspacePass } from "../../src/orchestration/pass-runner";
import { createFileLock } from "../../src/orchestration/lock-file";
import { STATE_SCHEMA_VERSION } from "../../src/infra/state-store";
import { createClaudeCodeAdapter } from "../../src/providers/claude-code/adapter";
import type { ProviderAdapter } from "../../src/providers/provider-adapter";
import {
  type EngineDeps,
  type EvidenceCache,
  type LedgerEntryView,
  type LedgerView,
  type MintOutcome,
  runPass,
} from "../../src/orchestration/sync-engine";
import {
  type Barrier,
  CrashSignal,
  type HookPoint,
  type PassReport,
  isCrashSignal,
} from "../../src/orchestration/pass-report";
import { makeRealTmpDir, removeTree } from "./fs-cleanup";

import { DEFAULT_READINESS, type ReadinessThresholds } from "../../src/domain/readiness";

export type MachineName = "A" | "B";

export interface WiredPassOptions {
  readonly dryRun?: boolean;
  /** Overrides part of the workspace binding, e.g. to point at a bad syncDir. */
  readonly binding?: Partial<WorkspaceBinding>;
  readonly barrier?: Barrier;
  readonly withLock?: boolean;
  readonly backupKeep?: number;
  readonly firstPassAfterStartup?: boolean;
  readonly verifyAll?: boolean;
  readonly readiness?: ReadinessThresholds;
}

export const WORKSPACE_ID = "3f1a9c2e-6b47-4d18-9a03-5e7c8d21b4f6";

export const sha256 = (bytes: Uint8Array): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** Deliberately small: property tests read whole files to check invariants. */
export const MAX_SYNTHETIC_FILE_BYTES = 256 * 1024;

export interface TransportOptions {
  /** Bytes to keep, simulating a partially transferred file. */
  readonly truncateBytes?: number;
  /** Drop this delivery entirely. */
  readonly drop?: boolean;
  /** Land a zero-byte placeholder instead of the content. */
  readonly zeroByte?: boolean;
  /** Preserve the source mtime (many sync tools do), or stamp it now. */
  readonly mtime?: "preserve" | "rewrite-now" | "future";
}

interface Version {
  readonly hash: string;
  readonly size: number;
  read(): Uint8Array;
}

export interface WorldSnapshot {
  /** Files the CLI and the plugin can both see. */
  readonly live: Map<string, Version>;
  /** Backups (including remote/) and quarantine copies. */
  readonly archive: Map<string, Version>;
}

export class World {
  private readonly root: string;
  private readonly machines = new Map<MachineName, Machine>();
  private clockMs = 1_700_000_000_000;

  private constructor(root: string) {
    this.root = root;
  }

  static create(): World {
    // Realpath'd: the stores require it, and macOS `/var` -> `/private/var`
    // plus Windows 8.3 short names make a raw tmpdir fail containment on two
    // platforms out of three.
    return new World(makeRealTmpDir("aiss-world-"));
  }

  machine(name: MachineName): Machine {
    const existing = this.machines.get(name);
    if (existing) return existing;
    const created = new Machine(name, path.join(this.root, name), () => this.clockMs);
    this.machines.set(name, created);
    return created;
  }

  advanceClockAll(ms: number): void {
    this.clockMs += ms;
    for (const machine of this.machines.values()) machine.setClock(this.clockMs);
  }

  /**
   * Moves what one machine has written into the other's replica.
   *
   * This is where an external sync tool's behaviour is modelled: what arrives,
   * when, in what state. Nothing is delivered until this is called.
   */
  async flush(from: MachineName, to: MachineName, options: TransportOptions = {}): Promise<void> {
    if (options.drop) return;
    const source = this.machine(from).replicaRoot;
    const target = this.machine(to).replicaRoot;
    await copyTree(source, target, options, this.clockMs);
  }

  async snapshot(): Promise<WorldSnapshot> {
    const live = new Map<string, Version>();
    const archive = new Map<string, Version>();

    for (const [name, machine] of this.machines) {
      await collect(machine.localRoot, `${name}:local`, live);
      await collect(machine.replicaRoot, `${name}:replica`, live);
      // The archive must include backups/remote/ — it is the only route back
      // for a remote version destroyed by PUSH_OVERWRITE (testing.md §1.1).
      await collect(machine.backupRoot, `${name}:backup`, archive);
      await collect(machine.quarantineRoot, `${name}:quarantine`, archive);
    }
    return { live, archive };
  }

  async dispose(): Promise<void> {
    removeTree(this.root);
  }
}

export class Machine {
  readonly localRoot: string;
  readonly replicaRoot: string;
  /** `<homedir>/.claudian-session-sync` for this machine (§5.5), a real directory. */
  readonly homeRoot: string;
  readonly backupRoot: string;
  readonly quarantineRoot: string;
  readonly vaultPath: string;
  readonly cli: FakeCli;

  private clock = fixedClock(1_700_000_000_000);
  private readonly ledger = new MemoryLedger();
  private readonly projectDir: string;
  /**
   * Stands in for the local half of `observations.json` (§5.5).
   *
   * In memory rather than on disk because the point of the split is *where the
   * store lives*: this one is never synced, so `flush()` must not carry it and
   * deleting the manifest must not touch it.
   */
  private readonly localEvidence = new Map<string, CachedContentFacts>();
  /**
   * Counts the reads a pass performs, which is how E1 is observable at all.
   *
   * `readPaths` matters once the real stores are in play: a wired pass reads
   * `observations.json`, `root.json` and the manifest through the same
   * gateway, so a bare count cannot tell "we re-read every session" from "we
   * loaded our own state".
   */
  readonly io = { readFile: 0, readTail: 0, lstat: 0, readPaths: [] as string[] };

  constructor(
    readonly name: MachineName,
    root: string,
    now: () => number,
  ) {
    this.localRoot = path.join(root, "local");
    this.replicaRoot = path.join(root, "replica");
    this.homeRoot = path.join(root, "home", ".claudian-session-sync");
    // Inside the home root, as §5.5 puts it — so the wired path and the
    // in-memory one write to the same place and `snapshot()` sees both.
    this.backupRoot = path.join(this.homeRoot, "backups");
    this.quarantineRoot = path.join(root, "quarantine");
    this.vaultPath = path.join(root, "vault");
    this.clock = fixedClock(now());

    // The escape rule is exercised for real: the project directory name is
    // derived from this machine's vault path, so A and B genuinely differ.
    this.projectDir = path.join(this.localRoot, escapeForTest(this.vaultPath));
    for (const dir of [
      this.projectDir,
      this.replicaRoot,
      this.homeRoot,
      this.backupRoot,
      this.quarantineRoot,
      this.vaultPath,
    ]) {
      mkdirSync(dir, { recursive: true });
    }
    mkdirSync(path.join(this.replicaRoot, WORKSPACE_ID, "claude-code"), { recursive: true });
    this.cli = new FakeCli(this.projectDir, path.join(this.vaultPath, ".claudian", "sessions"));
  }

  setClock(ms: number): void {
    this.clock.set(ms);
  }

  advanceClock(ms: number): void {
    this.clock.advance(ms);
  }

  /** Forgets in-process state, as an Obsidian restart would. */
  restart(): void {
    this.ledger.clear();
    this.localEvidence.clear();
  }

  resetIo(): void {
    this.io.readFile = 0;
    this.io.readTail = 0;
    this.io.lstat = 0;
    this.io.readPaths.length = 0;
  }

  /** Full reads of session files only, excluding this plugin's own state. */
  sessionReads(): string[] {
    return this.io.readPaths.filter((target) => target.endsWith(".jsonl"));
  }

  /** Where this machine's replica keeps the manifest (architecture §5.3). */
  get manifestPath(): string {
    return path.join(this.replicaRoot, ".aiss", `manifest-${WORKSPACE_ID}.json`);
  }

  /** Shared across passes on this machine, so R-09 is testable end to end. */
  private passInFlight = false;
  private lockEpoch = 0;

  async pass(
    options: {
      dryRun?: boolean;
      barrier?: Barrier;
      withLock?: boolean;
      /** Registered alongside the Claude Code adapter, for multi-provider tests. */
      extraAdapters?: readonly ProviderAdapter[];
    } = {},
  ): Promise<PassReport> {
    // Load, run, write back — the real shape of a pass, and the reason this is
    // here rather than in a mock: S-07 deletes the file between passes, so the
    // manifest has to be genuinely read from and written to disk for that test
    // to be testing anything.
    const cache = await this.loadEvidence();
    const deps = { ...this.engineDeps(options), evidence: cache };

    let report: PassReport;
    if (!options.withLock) {
      report = await runPass(deps);
    } else {
      let heldEpoch = 0;
      report = await runPass({
        ...deps,
        lock: {
          acquire: async () => {
            if (this.passInFlight) return { ok: false, reason: "ALREADY_RUNNING" };
            this.passInFlight = true;
            heldEpoch = ++this.lockEpoch;
            return { ok: true };
          },
          mayWrite: async () => heldEpoch === this.lockEpoch,
          release: async () => {
            this.passInFlight = false;
          },
        },
      });
    }

    if (!options.dryRun) await cache.persist();
    return report;
  }

  /**
   * Builds the pass's E1 cache from the two stores it actually has.
   *
   * Remote entries come from the manifest in the sync directory — untrusted,
   * transported by `flush()`, deletable. Local entries come from this
   * machine's own memory. A manifest that is missing or unreadable forces a
   * full-read pass (trigger T4), which is what makes losing it cost I/O rather
   * than correctness.
   */
  private async loadEvidence(): Promise<EvidenceCache & { persist(): Promise<void> }> {
    const raw = await fsp
      .readFile(this.manifestPath, "utf8")
      .then((text) => JSON.parse(text) as unknown)
      .catch(() => undefined);
    const load = parseManifest(raw);
    const manifest: Manifest =
      load.status === "ok" || load.status === "migrate"
        ? load.manifest
        : emptyManifest(new Date(this.clock.nowMs()).toISOString());
    const writable = load.status !== "unusable";
    const forceFullRead = load.status !== "ok" && load.status !== "migrate";

    const entries: Record<string, ManifestEntry> = { ...manifest.entries };
    const key = (rel: string) => `${WORKSPACE_ID}/${rel}`;

    // Arrow properties, not shorthand methods: `this` has to stay the machine.
    return {
      lookup: (rel, side) =>
        side === "remote" ? entries[key(rel)] : this.localEvidence.get(rel),
      scrub: (): ScrubTrigger | null => (forceFullRead ? "T4-manifest" : null),
      record: (rel, side, facts) => {
        if (side === "local") {
          this.localEvidence.set(rel, facts);
          return;
        }
        const previous = entries[key(rel)];
        entries[key(rel)] = {
          provider: rel.slice(0, rel.indexOf("/")),
          workspaceId: WORKSPACE_ID,
          logicalId: rel.slice(rel.lastIndexOf("/") + 1).replace(/\.jsonl$/, ""),
          mode: "append-jsonl",
          size: facts.e0.size,
          lineCount: facts.lineCount,
          contentHash: facts.contentHash,
          e0: facts.e0,
          lastWriter: this.name,
          updatedAt: new Date(this.clock.nowMs()).toISOString(),
          generation: (previous?.generation ?? 0) + 1,
          ...(previous?.unknown ? { unknown: previous.unknown } : {}),
        };
      },
      persist: async () => {
        // A manifest from a newer schema is never rewritten (§5.3.4): a newer
        // client is demonstrably using this directory.
        if (!writable) return;
        const serialised = serialiseManifest(
          { ...manifest, entries },
          new Date(this.clock.nowMs()).toISOString(),
        );
        await fsp.mkdir(path.dirname(this.manifestPath), { recursive: true });
        await fsp.writeFile(this.manifestPath, `${JSON.stringify(serialised, null, 2)}\n`);
      },
    };
  }

  /**
   * Runs a pass through the real composition root (§7.1 P0–P8).
   *
   * The difference from `pass()` is where the state comes from: everything —
   * ledger, manifest, readiness record, lock, backups — is read from and
   * written to real files under this machine's own roots. That is what makes
   * the readiness scenarios testable at all, because they are about what
   * survives between passes rather than what one pass computes.
   *
   * Readiness thresholds default to "no waiting" so a scenario does not have
   * to sit out 90 seconds; a test that cares about the window passes its own.
   */
  async wiredPass(options: WiredPassOptions = {}): Promise<PassOutcome> {
    const guard = await this.pathGuard();
    const fs = countingGateway(this.nodeGateway(), this.io);
    const home = createHomeStore({ fs, guard, joinPath: path.join, stateRoot: this.homeRoot });
    const syncDir = createSyncDirStore({
      fs,
      guard,
      joinPath: path.join,
      syncDirRoot: this.replicaRoot,
    });

    const lock = options.withLock
      ? createFileLock({
          fs,
          home,
          workspaceId: WORKSPACE_ID,
          machineId: this.machineId,
          pid: this.name === "A" ? 4001 : 4002,
          nowMs: () => this.clock.nowMs(),
          inProcessBusy: () => this.passInFlight,
          onAcquired: () => {
            this.passInFlight = true;
          },
          onReleased: () => {
            this.passInFlight = false;
          },
        })
      : undefined;

    return runWorkspacePass({
      fs,
      guard,
      clock: this.clock,
      ids: sequentialIdGen(),
      joinPath: path.join,
      hashBytes: sha256,
      home,
      syncDir,
      binding: { ...this.binding(), ...options.binding },
      machineId: this.machineId as never,
      workspaceId: WORKSPACE_ID as never,
      providers: [{ adapter: this.adapter(), root: this.localRoot }],
      vaultRoot: this.vaultPath,
      settings: {
        maxFileSizeBytes: 20 * 1024 * 1024,
        maxFilesPerPass: 200,
        probeDelayMs: 0,
        localQuietMs: 0,
        remoteQuietMs: 0,
        clockSkewToleranceMs: 5000,
        backupKeep: options.backupKeep ?? 3,
      },
      ...(lock ? { lock } : {}),
      ...(options.barrier ? { barrier: options.barrier } : {}),
      dryRun: options.dryRun ?? false,
      firstPassAfterStartup: options.firstPassAfterStartup ?? false,
      msSinceLastStartupScrub: 0,
      verifyAll: options.verifyAll ?? false,
      readiness: options.readiness ?? { ...DEFAULT_READINESS, probes: 1, minAgeMs: 0 },
    });
  }

  /** Two wired passes: the first observes, the second can act (see `settle`). */
  async wiredSettle(options: WiredPassOptions = {}): Promise<PassOutcome> {
    await this.wiredPass(options);
    return this.wiredPass(options);
  }

  /** What the user clicking "initialise this sync directory" does (§9.6.3). */
  async initialiseSyncDir(rootId = `root-${this.name}`): Promise<void> {
    const guard = await this.pathGuard();
    const store = createSyncDirStore({
      fs: this.nodeGateway(),
      guard,
      joinPath: path.join,
      syncDirRoot: this.replicaRoot,
    });
    await store.initialise(
      newRootFile({
        rootId,
        nowIso: new Date(this.clock.nowMs()).toISOString(),
        machineId: this.machineId,
        label: this.name,
        platform: process.platform,
      }),
    );
  }

  get machineId(): string {
    return this.name === "A"
      ? "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"
      : "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
  }

  binding(): WorkspaceBinding {
    return {
      schemaVersion: STATE_SCHEMA_VERSION,
      workspaceId: WORKSPACE_ID as never,
      syncDirPath: this.replicaRoot,
      providers: { "claude-code": { enabled: true } },
      createdAt: "2026-08-08T00:00:00.000Z",
    };
  }

  private guardCache: PathGuardDeps | null = null;

  /**
   * Case sensitivity by experiment, not by platform (§9.7.4).
   *
   * Guessing from `process.platform` is exactly what the probe exists to
   * avoid: macOS can be formatted case-sensitive and a Linux CI runner can
   * mount a filesystem that is not, and either way a wrong answer turns the
   * four-root overlap check into a formality.
   */
  private async pathGuard(): Promise<PathGuardDeps> {
    if (this.guardCache) return this.guardCache;
    const probe = path.join(this.homeRoot, "case-probe");
    await fsp.writeFile(probe, "");
    const caseSensitive = !(await fsp
      .stat(path.join(this.homeRoot, "CASE-PROBE"))
      .then(() => true)
      .catch(() => false));
    await fsp.rm(probe, { force: true });

    this.guardCache = {
      fs: this.nodeGateway(),
      platform: process.platform,
      caseSensitive,
      joinPath: (...parts) => path.join(...parts),
      dirnameOf: (target) => path.dirname(target),
      splitPath: splitPathSegments,
    };
    return this.guardCache;
  }

  private nodeGateway() {
    return createNodeFsGateway({
      ids: sequentialIdGen(),
      platform: process.platform,
      pid: process.pid,
      sleep: async () => undefined,
    });
  }

  private adapter() {
    return createClaudeCodeAdapter({
      providerRoot: this.localRoot,
      vaultRealPath: this.vaultPath,
      customDirName: escapeForTest(this.vaultPath),
      joinPath: (...parts) => path.join(...parts),
      listDir: async (dir) =>
        (await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])).map((e) => ({
          name: e.name,
          isFile: e.isFile(),
        })),
      statFile: async (target) => {
        const st = await fsp.stat(target).catch(() => null);
        return st ? { mtimeMs: st.mtimeMs } : null;
      },
      readTextFile: async (target) => fsp.readFile(target, "utf8").catch(() => null),
    });
  }

  /**
   * Runs a pass that dies at `at`, the way a killed process would.
   *
   * The signal is not an Error, so nothing in the engine can catch it — commit
   * never runs, and no in-process state survives. Returns the signal so a test
   * can assert *where* it died rather than merely that it did.
   */
  async crashDuringPass(at: HookPoint): Promise<CrashSignal> {
    const barrier: Barrier = async (point) => {
      if (point === at) throw new CrashSignal(point);
    };
    try {
      await this.pass({ barrier });
    } catch (error) {
      if (isCrashSignal(error)) {
        this.restart(); // The process is gone; so is everything it remembered.
        return error;
      }
      throw error;
    }
    throw new Error(`expected a crash at ${at}, but the pass completed`);
  }

  private engineDeps(options: {
    dryRun?: boolean;
    barrier?: Barrier;
    extraAdapters?: readonly ProviderAdapter[];
  }): EngineDeps {
    const fs = countingGateway(this.nodeGateway(), this.io);
    const adapter = this.adapter();

    return {
      fs,
      clock: this.clock,
      ids: sequentialIdGen(),
      adapters: [adapter, ...(options.extraAdapters ?? [])],
      ...(options.barrier ? { barrier: options.barrier } : {}),
      replicaRoot: this.replicaRoot,
      workspaceId: WORKSPACE_ID,
      joinPath: (...parts) => path.join(...parts),
      settings: {
        maxFileSizeBytes: 20 * 1024 * 1024,
        maxFilesPerPass: 200,
        probeDelayMs: 0,
        localQuietMs: 0,
        remoteQuietMs: 0,
        clockSkewToleranceMs: 5000,
      },
      remoteReadiness: "ready",
      dryRun: options.dryRun ?? false,
      ledger: this.ledger,
      hashBytes: sha256,
      backup: async (request) => this.writeBackup(request),
      mintWritePath: async (target) => this.mint(target),
      machineIdPrefix: this.name === "A" ? "aaaaaaaa" : "bbbbbbbb",
      nowIso: () => new Date(this.clock.nowMs()).toISOString(),
    };
  }

  /** Stands in for PathGuard: accepts only paths under this machine's roots. */
  private async mint(target: string): Promise<MintOutcome> {
    const allowed = [this.localRoot, this.replicaRoot, this.backupRoot, this.quarantineRoot];
    const resolved = path.resolve(target);
    const inside = allowed.some(
      (root) => resolved === root || resolved.startsWith(root + path.sep),
    );
    if (!inside) return { ok: false, violation: "TRAVERSAL", detail: "outside every configured root" };
    await fsp.mkdir(path.dirname(resolved), { recursive: true });
    return { ok: true, value: resolved as SafeAbsolutePath };
  }

  private async writeBackup(request: {
    sourcePath: string;
    neutralRel: string;
    logicalId: LogicalId;
    remote: boolean;
  }): Promise<string | null> {
    const bytes = await fsp.readFile(request.sourcePath).catch(() => null);
    if (bytes === null) return null; // Nothing there to preserve.

    const dir = request.remote
      ? path.join(this.backupRoot, WORKSPACE_ID, "claude-code", "remote")
      : path.join(this.backupRoot, WORKSPACE_ID, "claude-code");
    await fsp.mkdir(dir, { recursive: true });

    const base = path.basename(request.sourcePath);
    for (let seq = 0; seq < 100; seq++) {
      const target = path.join(dir, `${base}.${this.clock.nowMs()}.${String(seq).padStart(2, "0")}.bak`);
      try {
        await fsp.writeFile(target, bytes, { flag: "wx" });
        return target;
      } catch {
        continue; // Name taken in the same millisecond; try the next sequence.
      }
    }
    return null;
  }
}

/**
 * Stands in for the CLI writing session files — as driven by Claudian.
 *
 * "As driven by Claudian" is load-bearing since ADR-47: admission is by the
 * vault's conversation records, so `session()` plants one, the way starting a
 * conversation in Claudian does. A session with no record — a bare terminal
 * one — is a different thing with different sync behaviour, and gets its own
 * method so a test says which one it means.
 */
export class FakeCli {
  constructor(
    private readonly projectDir: string,
    private readonly claudianStore: string,
  ) {}

  session(id: string): FakeSession {
    mkdirSync(this.claudianStore, { recursive: true });
    const record = path.join(this.claudianStore, `conv-fake-${id}.meta.json`);
    if (!existsSync(record)) {
      // Claudian's shape, measured 2026-08-12: its provider id is "claude",
      // not this plugin's "claude-code".
      writeFileSync(
        record,
        `${JSON.stringify({ id: `conv-fake-${id}`, providerId: "claude", sessionId: id }, null, 2)}
`,
      );
    }
    return new FakeSession(path.join(this.projectDir, `${id}.jsonl`));
  }

  /** The same file with no Claudian record — what a bare `claude` run leaves. */
  terminalSession(id: string): FakeSession {
    return new FakeSession(path.join(this.projectDir, `${id}.jsonl`));
  }

  /** Marks the conversation deleted, the way Claudian's markDeleted does. */
  tombstone(id: string): void {
    mkdirSync(this.claudianStore, { recursive: true });
    writeFileSync(
      path.join(this.claudianStore, `conv-fake-${id}.deleted.json`),
      `${JSON.stringify({ schemaVersion: 1, conversationId: `conv-fake-${id}`, deletedAt: 0 }, null, 2)}
`,
    );
  }

  async list(): Promise<string[]> {
    const entries = await fsp.readdir(this.projectDir).catch(() => []);
    return entries.filter((name) => name.endsWith(".jsonl")).sort();
  }
}

export class FakeSession {
  constructor(readonly filePath: string) {}

  /** Appends `lines` records, as the CLI does — always append, never rewrite. */
  async append(lines: number, options: { tail?: "lf" | "no-lf" | "half-line" } = {}): Promise<this> {
    const existing = await this.bytes();
    const start = countRecords(existing);
    let text = "";
    for (let i = 0; i < lines; i++) {
      text += `{"uuid":"r${start + i}","type":"user","text":"line ${start + i}"}\n`;
    }
    if (options.tail === "no-lf") text = text.slice(0, -1);
    if (options.tail === "half-line") text += '{"uuid":"partial","ty';

    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    await fsp.appendFile(this.filePath, text);
    return this;
  }

  async appendRaw(text: string): Promise<this> {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    await fsp.appendFile(this.filePath, text);
    return this;
  }

  async bytes(): Promise<Uint8Array> {
    return new Uint8Array(await fsp.readFile(this.filePath).catch(() => Buffer.alloc(0)));
  }

  async hash(): Promise<string> {
    return sha256(await this.bytes());
  }
}

class MemoryLedger implements LedgerView {
  private readonly entries = new Map<string, LedgerEntryView>();

  local(rel: string): LedgerEntryView | null {
    return this.entries.get(`local:${rel}`) ?? null;
  }

  remote(rel: string): LedgerEntryView | null {
    return this.entries.get(`remote:${rel}`) ?? null;
  }

  record(rel: string, side: "local" | "remote", entry: LedgerEntryView): void {
    this.entries.set(`${side}:${rel}`, entry);
  }

  clear(): void {
    this.entries.clear();
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Wraps a gateway to count reads.
 *
 * Without this, E1 is unobservable: a pass that reads every file and one that
 * reads none produce the same report and the same bytes on disk. The whole
 * point of the cache is the I/O it does not do, so the I/O is what gets
 * asserted.
 */
function countingGateway(
  inner: FsGateway,
  counts: { readFile: number; readTail: number; lstat: number; readPaths: string[] },
): FsGateway {
  return {
    ...inner,
    async lstat(target) {
      counts.lstat++;
      return inner.lstat(target);
    },
    async readFile(target) {
      counts.readFile++;
      counts.readPaths.push(target);
      return inner.readFile(target);
    },
    async readTail(target, n) {
      counts.readTail++;
      return inner.readTail(target, n);
    },
  };
}

/** Same character mapping as the real rule, applied to a test path. */
function escapeForTest(absolutePath: string): string {
  let out = "";
  for (const char of absolutePath) out += /[A-Za-z0-9-]/.test(char) ? char : "-";
  return out;
}

function countRecords(bytes: Uint8Array): number {
  let count = 0;
  for (const byte of bytes) if (byte === 0x0a) count++;
  return count;
}

async function copyTree(
  source: string,
  target: string,
  options: TransportOptions,
  nowMs: number,
): Promise<void> {
  const entries = await fsp.readdir(source, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      await fsp.mkdir(to, { recursive: true });
      await copyTree(from, to, options, nowMs);
      continue;
    }

    let bytes = await fsp.readFile(from);
    if (options.zeroByte) bytes = Buffer.alloc(0);
    else if (options.truncateBytes !== undefined) bytes = bytes.subarray(0, options.truncateBytes);

    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.writeFile(to, bytes);

    if (options.mtime === "preserve") {
      const st = await fsp.stat(from);
      await fsp.utimes(to, st.atime, st.mtime);
    } else if (options.mtime === "future") {
      const future = new Date(nowMs + 3_600_000);
      await fsp.utimes(to, future, future);
    }
  }
}

/**
 * Walks a tree into the inventory the invariants are checked against.
 *
 * `.aiss/` is skipped deliberately. I1 says no *version of a session* may
 * become unrecoverable; the manifest is a cache whose entire design is that
 * losing it costs a slow pass and nothing else, so every rewrite of it would
 * otherwise register as a version destroyed and I1 would be asserting the
 * opposite of what the manifest is for.
 */
async function collect(root: string, prefix: string, into: Map<string, Version>): Promise<void> {
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name === ".aiss") continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await collect(full, `${prefix}/${entry.name}`, into);
      continue;
    }
    const bytes = new Uint8Array(await fsp.readFile(full));
    into.set(`${prefix}/${entry.name}`, {
      hash: sha256(bytes),
      size: bytes.length,
      read: () => bytes,
    });
  }
}
