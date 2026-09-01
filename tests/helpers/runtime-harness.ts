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
  /**
   * Makes writes to matching paths fail with EACCES.
   *
   * The one thing a real temp directory cannot be talked into doing on demand:
   * failing *one* file of a group while its siblings succeed. Permissions are
   * per-directory, and the siblings share it — so the seam is here rather than
   * in a fixture that would have to lie about something else instead.
   */
  readonly failWrite?: (target: string) => boolean;
}

export class RuntimeHarness {
  readonly root: string;
  readonly homedir: string;
  readonly vaultRoot: string;
  readonly syncDir: string;

  readonly providerRoot: string;
  readonly projectDir: string;
  /** `<home>/.grok/sessions`, and this vault's project directory inside it. */
  readonly grokRoot: string;
  readonly grokProjectDir: string;
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
    this.grokRoot = path.join(this.homedir, ".grok", "sessions");
    // Grok's own rule, not a stand-in for it: the CLI names the directory
    // `encodeURIComponent(<resolved cwd>)`, measured byte-exact on both
    // platforms.
    this.grokProjectDir = path.join(this.grokRoot, encodeURIComponent(this.vaultRoot));
    this.clock = fixedClock(options.nowMs ?? 1_700_000_000_000);

    const ids = sequentialIdGen();
    const real = createNodeFsGateway({
      ids,
      platform: process.platform,
      pid: process.pid,
      sleep: async () => undefined,
    });
    const refuse = (target: string) => {
      const error: NodeJS.ErrnoException = new Error(`EACCES: injected, open '${target}'`);
      error.code = "EACCES";
      return error;
    };
    const fail = options.failWrite;
    const fs = fail
      ? {
          ...real,
          writeFileAtomic: async (target: string, ...rest: never[]) => {
            if (fail(target)) throw refuse(target);
            return (real.writeFileAtomic as (...a: unknown[]) => Promise<void>)(target, ...rest);
          },
          writeFileNoReplace: async (target: string, ...rest: never[]) => {
            if (fail(target)) throw refuse(target);
            return (real.writeFileNoReplace as (...a: unknown[]) => Promise<{ ok: boolean }>)(
              target,
              ...rest,
            );
          },
        }
      : real;

    const host: RuntimeHost = {
      fs: fs as typeof real,
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
      // Grok installed, this vault never used with it — the state a machine is
      // in right before it pulls its first session. The project directory is
      // deliberately *not* created.
      harness.grokRoot,
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
    for (const dir of [peer.homedir, peer.vaultRoot, peer.projectDir, peer.grokRoot]) {
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

  /**
   * Moves a conversation's record into a device directory, as Claudian 2.2.5
   * does for every new conversation.
   *
   * The `.meta.json` moves; nothing else does — `.inputs.json` is written from
   * `SESSIONS_PATH` upstream and stays at the top level, which is what split
   * one conversation's files across two layers and made this worth a fixture.
   */
  async scopeRecordToDevice(sessionId: string, deviceKey: string): Promise<void> {
    const store = path.join(this.vaultRoot, ".claudian", "sessions");
    const name = `conv-fake-${sessionId}.meta.json`;
    const deviceDir = path.join(store, "devices", deviceKey);
    await fsp.mkdir(deviceDir, { recursive: true });
    await fsp.rename(path.join(store, name), path.join(deviceDir, name));
  }

  /** A device key of the shape upstream requires: `device-` + 64 hex. */
  static deviceKey(seed: string): string {
    return `device-${createHash("sha256").update(seed).digest("hex")}`;
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
   * What the runtime thinks the time is.
   *
   * Needed whenever a fixture has to age a file: the clock is injected and
   * starts well before the wall clock, so `utimes(Date.now() - an hour)` makes
   * a file look like it was written in the *future* to anything reading the
   * runtime's clock.
   */
  nowMs(): number {
    return this.clock.nowMs();
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

  /**
   * Writes a Grok session the way the CLI leaves one: a directory whose
   * members disagree about how they are written.
   *
   * `chat_history.jsonl` and `updates.jsonl` are appended; `summary.json` is
   * rewritten whole, pretty-printed and without a trailing newline, which is
   * the shape whose tail the append table would otherwise call truncated. The
   * derived members are written too — they must be visibly *not* synced rather
   * than absent from the fixture.
   */
  async writeGrokSession(
    sessionId: string,
    options: { readonly turns?: number; readonly rev?: number; readonly record?: boolean } = {},
  ): Promise<void> {
    const dir = path.join(this.grokProjectDir, sessionId);
    await fsp.mkdir(dir, { recursive: true });

    if (options.record !== false) {
      const store = path.join(this.vaultRoot, ".claudian", "sessions");
      await fsp.mkdir(store, { recursive: true });
      await fsp.writeFile(
        path.join(store, `conv-grok-${sessionId}.meta.json`),
        `${JSON.stringify({ id: `conv-grok-${sessionId}`, providerId: "grok", sessionId }, null, 2)}\n`,
      );
    }

    const chat = path.join(dir, "chat_history.jsonl");
    const existing = await fsp.readFile(chat, "utf8").catch(() => "");
    const start = existing.split("\n").length - 1;
    let appended = "";
    let updates = "";
    for (let i = 0; i < (options.turns ?? 0); i++) {
      appended += `{"type":"user","content":"turn ${start + i}"}\n`;
      updates += `{"method":"update","params":{"sessionId":"${sessionId}","n":${start + i}}}\n`;
    }
    if (appended) {
      await fsp.appendFile(chat, appended);
      await fsp.appendFile(path.join(dir, "updates.jsonl"), updates);
    } else if (existing === "") {
      await fsp.writeFile(chat, "");
      await fsp.writeFile(path.join(dir, "updates.jsonl"), "");
    }

    // The identity carrier: `info.id` equals the directory name, and the CLI
    // does not recognise a session where the two disagree.
    await fsp.writeFile(
      path.join(dir, "summary.json"),
      JSON.stringify(
        {
          info: { id: sessionId },
          num_messages: start + (options.turns ?? 0),
          grok_home: path.join(this.homedir, ".grok"),
          rev: options.rev ?? 1,
        },
        null,
        2,
      ),
    );
    // Derived and machine-local: holds this machine's paths, rebuilt by the
    // CLI when absent. Present in every fixture so "not synced" is a fact the
    // tests observe rather than a fixture that never had it.
    await fsp.writeFile(
      path.join(dir, "prompt_context.json"),
      JSON.stringify({ working_directory: this.vaultRoot, shell_path: "/bin/zsh" }),
    );
    // The rest of what a real session directory holds. Written so that "these
    // are not synced" is something the tests observe rather than something the
    // fixture arranges by omission — the whitelist is only a boundary if there
    // is something on the other side of it.
    await fsp.writeFile(path.join(dir, "system_prompt.txt"), "you are grok\n");
    await fsp.writeFile(path.join(dir, "events.jsonl"), '{"e":"turn"}\n');
    await fsp.writeFile(path.join(dir, "signals.json"), JSON.stringify({ turnCount: 1 }));
    await fsp.writeFile(path.join(dir, "title_refresh_idx"), "0");
    await fsp.writeFile(path.join(dir, "summary.json.lock"), "");
    await fsp.writeFile(path.join(dir, "chat_history.jsonl.lock"), "");
  }

  /**
   * Appends exact bytes to a Grok session's history.
   *
   * `writeGrokSession` numbers its turns from the file's length, so two
   * machines appending to the same base produce identical lines and stay in a
   * prefix relationship — a fork that never conflicts. Divergence has to be
   * spelled out.
   */
  async appendGrokRaw(sessionId: string, text: string): Promise<void> {
    for (const member of ["chat_history.jsonl", "updates.jsonl"]) {
      await fsp.appendFile(this.grokPath(sessionId, member), text);
    }
  }

  grokPath(sessionId: string, member: string): string {
    return path.join(this.grokProjectDir, sessionId, member);
  }

  async dispose(): Promise<void> {
    removeTree(this.root);
  }
}
