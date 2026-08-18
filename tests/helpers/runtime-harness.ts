/**
 * A `PluginRuntime` on real directories, with no Obsidian in sight.
 *
 * The whole point of the runtime is that it can be driven without the host, so
 * this harness is short by construction: four temp directories, a `RuntimeHost`
 * that reads them, and an in-memory stand-in for Obsidian's `data.json`.
 *
 * The directories are realpath'd. Every containment check downstream compares
 * against these strings, and the plugin's own preflight refuses a root that is
 * not its own realpath — a fixture that skipped that would test a
 * configuration the plugin declines to run.
 */
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { fixedClock, sequentialIdGen } from "../../src/infra/clock";
import { createNodeFsGateway } from "../../src/infra/node-fs-gateway";
import { PluginRuntime, type RuntimeHost } from "../../src/orchestration/plugin-runtime";
import { escapeProjectPath } from "../../src/providers/claude-code/path-escape";
import { makeRealTmpDir, removeTree } from "./fs-cleanup";

export const sha256 = (bytes: Uint8Array): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export interface HarnessOptions {
  readonly hostname?: string;
  readonly nowMs?: number;
}

export class RuntimeHarness {
  readonly root: string;
  readonly homedir: string;
  readonly vaultRoot: string;
  readonly syncDir: string;

  readonly providerRoot: string;
  readonly projectDir: string;
  readonly runtime: PluginRuntime;

  private stored: unknown = null;
  /** Folders the plugin asked the desktop to open, for the §9.3.4 tests. */
  readonly opened: string[] = [];
  private readonly clock;

  private constructor(root: string, options: HarnessOptions) {
    this.root = root;
    this.homedir = path.join(root, "home");
    this.vaultRoot = path.join(root, "vault");
    this.syncDir = path.join(root, "sync");
    this.providerRoot = path.join(this.homedir, ".claude", "projects");
    // The escape rule for real: the directory name is derived from this
    // vault's path, so two harnesses genuinely differ.
    this.projectDir = path.join(this.providerRoot, escapeProjectPath(this.vaultRoot));
    this.clock = fixedClock(options.nowMs ?? 1_700_000_000_000);

    const ids = sequentialIdGen();
    const fs = createNodeFsGateway({
      ids,
      platform: process.platform,
      pid: process.pid,
      sleep: async () => undefined,
    });

    const host: RuntimeHost = {
      fs,
      clock: this.clock,
      ids,
      joinPath: (...parts) => path.join(...parts),
      dirnameOf: (target) => path.dirname(target),
      hashBytes: sha256,
      platform: process.platform,
      hostname: options.hostname ?? "test-machine",
      homedir: this.homedir,
      vaultRoot: this.vaultRoot,
      pid: process.pid,
      openFolder: async (target: string) => {
        this.opened.push(target);
        return true;
      },
      loadSettings: async () => this.stored,
      saveSettings: async (value) => {
        this.stored = value;
      },
    };
    this.runtime = new PluginRuntime(host);
  }

  static async create(options: HarnessOptions = {}): Promise<RuntimeHarness> {
    const harness = new RuntimeHarness(makeRealTmpDir("aiss-runtime-"), options);
    for (const dir of [
      harness.homedir,
      harness.vaultRoot,
      harness.syncDir,
      harness.projectDir,
    ]) {
      await fsp.mkdir(dir, { recursive: true });
    }
    return harness;
  }

  /**
   * A second machine on the same workspace and the same sync folder.
   *
   * The vault's identity file is copied rather than re-created, which is what
   * a vault sync does and the only way two machines ever agree on a workspace
   * id (§5.2.3). Its home directory and provider root are its own — those are
   * the things that must never be shared.
   *
   * The sync folder is shared directly instead of going through a modelled
   * transport: that belongs to the L2 world, and what these tests are about is
   * two machines disagreeing, not the delay before they find out.
   */
  static async createPeer(other: RuntimeHarness, options: HarnessOptions = {}): Promise<RuntimeHarness> {
    const peer = new RuntimeHarness(makeRealTmpDir("aiss-runtime-peer-"), {
      hostname: "peer-machine",
      ...options,
    });
    // Same sync folder, different everything else.
    Object.assign(peer, { syncDir: other.syncDir });
    for (const dir of [peer.homedir, peer.vaultRoot, peer.projectDir]) {
      await fsp.mkdir(dir, { recursive: true });
    }
    await fsp.mkdir(path.join(peer.vaultRoot, ".claudian-session-sync"), { recursive: true });
    await fsp.copyFile(
      path.join(other.vaultRoot, ".claudian-session-sync", "workspace.json"),
      path.join(peer.vaultRoot, ".claudian-session-sync", "workspace.json"),
    );

    await peer.runtime.refresh();
    await peer.runtime.setSyncDir(peer.syncDir);
    await peer.runtime.setProvider("claude-code", { enabled: true });
    await peer.runtime.refresh();
    return peer;
  }

  /** Everything a first-run user does, in order, so tests can skip past it. */
  async configure(): Promise<void> {
    await this.runtime.refresh();
    await this.runtime.createIdentity("test vault");
    await this.runtime.setSyncDir(this.syncDir);
    await this.runtime.setProvider("claude-code", { enabled: true });
    await this.runtime.initialiseSyncDir();
    await this.runtime.refresh();
  }

  /** Appends records the way the CLI does — always append, never rewrite. */
  async appendSession(sessionId: string, lines: number): Promise<void> {
    // Admission is by the vault's Claudian records (ADR-47), so creating a
    // session the way a Claudian conversation would means leaving one.
    const store = path.join(this.vaultRoot, ".claudian", "sessions");
    await fsp.mkdir(store, { recursive: true });
    await fsp.writeFile(
      path.join(store, `conv-fake-${sessionId}.meta.json`),
      `${JSON.stringify({ id: `conv-fake-${sessionId}`, providerId: "claude", sessionId }, null, 2)}
`,
    );
    const target = path.join(this.projectDir, `${sessionId}.jsonl`);
    let text = "";
    const existing = await fsp.readFile(target, "utf8").catch(() => "");
    const start = existing.split("\n").length - 1;
    for (let i = 0; i < lines; i++) {
      text += `{"uuid":"r${start + i}","type":"user","text":"line ${start + i}"}\n`;
    }
    await fsp.appendFile(target, text);
  }

  /**
   * Appends exact bytes.
   *
   * Needed whenever two machines must genuinely diverge: `appendSession`
   * numbers its records from the file's length, so two machines appending to
   * the same base produce *identical* lines and their files stay in a prefix
   * relationship. That is a fork that never conflicts, and a fixture built on
   * it quietly tests the wrong thing.
   */
  async appendRaw(sessionId: string, text: string): Promise<void> {
    await fsp.appendFile(path.join(this.projectDir, `${sessionId}.jsonl`), text);
  }

  sessionPath(sessionId: string): string {
    return path.join(this.projectDir, `${sessionId}.jsonl`);
  }

  replicaPath(workspaceId: string, sessionId: string): string {
    return path.join(this.syncDir, workspaceId, "claude-code", `${sessionId}.jsonl`);
  }

  advanceClock(ms: number): void {
    this.clock.advance(ms);
  }

  /**
   * Runs passes until the plugin is willing to act, then one more.
   *
   * Three passes and two clock jumps, because two separate waits have to
   * elapse and neither is skipped here: readiness wants `probes` observations
   * spanning `minAgeMs` before it calls a sync folder settled (§9.6.3), and
   * stability wants a file to hold the same signature across a pass before it
   * is copied (§9.1). The harness deliberately uses the *real* defaults rather
   * than zeroing them — a fixture that turns off the waiting is a fixture that
   * cannot notice them being wrong.
   */
  async settle(options: { dryRun?: boolean; verifyAll?: boolean } = {}) {
    await this.runtime.syncNow(options);
    this.advanceClock(95_000);
    await this.runtime.syncNow(options);
    this.advanceClock(95_000);
    return this.runtime.syncNow(options);
  }

  async dispose(): Promise<void> {
    removeTree(this.root);
  }
}
