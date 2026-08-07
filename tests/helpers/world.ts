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
import { mkdirSync, mkdtempSync, promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LogicalId, SafeAbsolutePath } from "../../src/domain/types";
import { fixedClock, sequentialIdGen } from "../../src/infra/clock";
import { createNodeFsGateway } from "../../src/infra/node-fs-gateway";
import { createClaudeCodeAdapter } from "../../src/providers/claude-code/adapter";
import {
  type EngineDeps,
  type LedgerEntryView,
  type LedgerView,
  type MintOutcome,
  runPass,
} from "../../src/orchestration/sync-engine";
import type { Barrier, PassReport } from "../../src/orchestration/pass-report";
import { removeTree } from "./fs-cleanup";

export type MachineName = "A" | "B";

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
    const root = mkdtempSync(path.join(tmpdir(), "aiss-world-"));
    return new World(root);
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
  readonly backupRoot: string;
  readonly quarantineRoot: string;
  readonly vaultPath: string;
  readonly cli: FakeCli;

  private clock = fixedClock(1_700_000_000_000);
  private readonly ledger = new MemoryLedger();
  private readonly projectDir: string;

  constructor(
    readonly name: MachineName,
    root: string,
    now: () => number,
  ) {
    this.localRoot = path.join(root, "local");
    this.replicaRoot = path.join(root, "replica");
    this.backupRoot = path.join(root, "backups");
    this.quarantineRoot = path.join(root, "quarantine");
    this.vaultPath = path.join(root, "vault");
    this.clock = fixedClock(now());

    // The escape rule is exercised for real: the project directory name is
    // derived from this machine's vault path, so A and B genuinely differ.
    this.projectDir = path.join(this.localRoot, escapeForTest(this.vaultPath));
    for (const dir of [this.projectDir, this.replicaRoot, this.backupRoot, this.quarantineRoot, this.vaultPath]) {
      mkdirSync(dir, { recursive: true });
    }
    mkdirSync(path.join(this.replicaRoot, WORKSPACE_ID, "claude-code"), { recursive: true });
    this.cli = new FakeCli(this.projectDir);
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
  }

  async pass(options: { dryRun?: boolean; barrier?: Barrier } = {}): Promise<PassReport> {
    return runPass(this.engineDeps(options));
  }

  private engineDeps(options: { dryRun?: boolean; barrier?: Barrier }): EngineDeps {
    const fs = createNodeFsGateway({
      ids: sequentialIdGen(),
      platform: process.platform,
      pid: process.pid,
      sleep: async () => undefined,
    });

    const adapter = createClaudeCodeAdapter({
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
    });

    return {
      fs,
      clock: this.clock,
      ids: sequentialIdGen(),
      adapters: [adapter],
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

/** Stands in for the real CLI writing session files. */
export class FakeCli {
  constructor(private readonly projectDir: string) {}

  session(id: string): FakeSession {
    return new FakeSession(path.join(this.projectDir, `${id}.jsonl`));
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

async function collect(root: string, prefix: string, into: Map<string, Version>): Promise<void> {
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
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
