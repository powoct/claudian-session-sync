import { Notice, Plugin } from "obsidian";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { hostname, homedir } from "node:os";
import path from "node:path";
import { realpathSync } from "node:fs";
import { cryptoIdGen, systemClock } from "./infra/clock";
import { createNodeFsGateway } from "./infra/node-fs-gateway";
import { PluginRuntime, type RuntimeStatus } from "./orchestration/plugin-runtime";
import type { ConflictResolution } from "./domain/conflict";
import { AiSessionSyncSettingTab } from "./ui/settings-tab";
import { ConflictModal, describeOutcome } from "./ui/conflict-modal";
import { ReportModal } from "./ui/report-modal";
import { OrphanModal } from "./ui/orphan-modal";
import { RestoreModal } from "./ui/restore-modal";

/**
 * Assembly, and nothing else.
 *
 * Every decision this plugin makes lives below `PluginRuntime`, which knows
 * nothing about Obsidian — that is what keeps the whole thing runnable in a
 * plain Node test, and it is enforced by lint rather than left to discipline
 * (architecture §4.1).
 *
 * Two host constraints are honoured here and asserted by the bundle contract
 * tests:
 *
 *  - **`onload()` performs no filesystem reads.** The sync folder is usually a
 *    cloud drive, and Obsidian blocks while a plugin loads (testing.md §12.2c).
 *    Everything is registered synchronously and the first read happens after
 *    `onLayoutReady`.
 *  - **Nothing outlives `onunload()`.** The periodic pass goes through
 *    `registerInterval`, so disabling the plugin leaves no live handle behind.
 */

const MINUTE_MS = 60_000;

export default class AiSessionSyncPlugin extends Plugin {
  private statusBarEl: HTMLElement | null = null;
  private runtime: PluginRuntime | null = null;
  private timer: number | null = null;
  private intervalMinutes = 0;

  override async onload(): Promise<void> {
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.setText("Claudian Session Sync: starting");

    this.addRibbonIcon("refresh-cw", "Claudian Session Sync: sync now", () => {
      void this.sync();
    });

    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.sync() });
    this.addCommand({
      id: "dry-run",
      name: "Dry-run sync (no writes)",
      callback: () => void this.sync({ dryRun: true }),
    });
    this.addCommand({
      id: "verify-all",
      name: "Verify all files (full read)",
      callback: () => void this.sync({ verifyAll: true }),
    });
    this.addCommand({
      id: "show-last-report",
      name: "Show last sync report",
      callback: () => {
        new ReportModal(this.app, this.runtime?.lastPassReport() ?? null).open();
      },
    });
    this.addCommand({
      id: "restore-backup",
      name: "Restore an earlier version",
      callback: () => this.openRestore(),
    });
    this.addCommand({
      id: "clean-half-copied",
      name: "Clean up half-copied sessions",
      callback: () => this.openOrphans(),
    });
    this.addCommand({
      id: "open-backups-folder",
      name: "Open the backups folder",
      callback: () => void this.openBackupsFolder(),
    });
    this.addCommand({
      id: "show-conflicts",
      name: "Show conflicts",
      callback: () => this.openConflicts(),
    });

    // The three resolutions of §8.1 as palette entries. Each acts directly
    // when there is exactly one conflict — the common case, and the one where
    // opening a list to pick the only row is friction — and otherwise opens
    // the list, because a palette command cannot name which session it meant.
    for (const [id, name, resolution] of [
      ["conflict-keep-local", "Conflict: keep this machine's version", "keep-local"],
      ["conflict-keep-remote", "Conflict: keep the other machine's version", "keep-remote"],
      ["conflict-reveal", "Conflict: show me both versions", "reveal"],
    ] as ReadonlyArray<[string, string, ConflictResolution]>) {
      this.addCommand({ id, name, callback: () => void this.resolveSingle(resolution) });
    }

    // A thunk, so registering the tab does not build the runtime — that would
    // resolve the vault path and break the no-I/O-in-onload contract.
    this.addSettingTab(new AiSessionSyncSettingTab(this.app, this, () => this.getRuntime()));

    // Queued, never awaited — and queued through a timer rather than straight
    // into the callback. Enabling the plugin from the settings pane makes
    // `onLayoutReady` fire *synchronously, inside `onload()`*, so deferring to
    // it is not by itself enough: the work has to leave this turn as well
    // (testing.md §12.2c). Registered for cleanup so a plugin disabled in the
    // same tick leaves no handle behind.
    this.app.workspace.onLayoutReady(() => {
      const handle = setTimeout(() => void this.start(), 0);
      this.register(() => clearTimeout(handle));
    });
  }

  override onunload(): void {
    this.statusBarEl = null;
    this.runtime = null;
    this.timer = null;
  }

  /**
   * Builds the runtime lazily, so `onload()` stays free of I/O.
   *
   * `realpathSync` on the vault path is the one exception, and it is a
   * resolution rather than a read: every containment check downstream compares
   * against this string, and preflight refuses a root that is not its own
   * realpath rather than failing one write at a time.
   */
  private getRuntime(): PluginRuntime {
    if (this.runtime) return this.runtime;
    // Injected rather than reached for, so the layers below stay testable
    // without a crypto module (§4.1).
    const ids = cryptoIdGen(randomUUID, (n) => new Uint8Array(randomBytes(n)));
    const fs = createNodeFsGateway({
      ids,
      platform: process.platform,
      pid: process.pid,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });

    this.runtime = new PluginRuntime({
      fs,
      clock: systemClock(),
      ids,
      joinPath: (...parts) => path.join(...parts),
      dirnameOf: (target) => path.dirname(target),
      hashBytes: (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      platform: process.platform,
      hostname: hostname(),
      homedir: homedir(),
      vaultRoot: this.vaultRoot(),
      pid: process.pid,
      // Claudian keeps its installation seed in localStorage, and Obsidian
      // gives every plugin the same renderer, so this machine can derive its
      // own key exactly as Claudian does (`utils/env.ts`). Only ever read
      // here, never written, and never sent anywhere: it names a folder in
      // this vault, and the whole point is that the other machine's key is
      // different.
      claudianDeviceKey: () => {
        try {
          const seed = window.localStorage.getItem("claudian.deviceSettingsKey")?.trim();
          if (!seed) return null;
          return `device-${createHash("sha256").update(seed, "utf8").digest("hex")}`;
        } catch {
          return null;
        }
      },
      loadSettings: () => this.loadData(),
      saveSettings: (value) => this.saveData(value),
      openFolder: (target) => openInFileManager(target),
    });

    this.runtime.onChange((status) => this.renderStatus(status));
    return this.runtime;
  }

  private vaultRoot(): string {
    // `basePath` is on the desktop FileSystemAdapter; the plugin is
    // desktop-only (`isDesktopOnly: true`) so it is always there.
    const adapter = this.app.vault.adapter as { getBasePath?: () => string };
    const base = adapter.getBasePath?.() ?? "";
    try {
      return realpathSync.native(base);
    } catch {
      return base;
    }
  }

  private async start(): Promise<void> {
    const runtime = this.getRuntime();
    await runtime.refresh();
    this.rescheduleIfNeeded();
    await this.sync();
  }

  private async sync(options: { dryRun?: boolean; verifyAll?: boolean } = {}): Promise<void> {
    const runtime = this.getRuntime();
    const status = await runtime.syncNow(options);
    this.rescheduleIfNeeded();
    if (options.dryRun) new ReportModal(this.app, runtime.lastPassReport()).open();
    else if (status.phase === "error") new Notice(status.detail);
  }

  /**
   * Keeps one interval alive, matching the current setting.
   *
   * Re-created only when the number changed: `registerInterval` hands cleanup
   * to Obsidian, so replacing it on every pass would accumulate registrations
   * for the lifetime of the plugin even though each individual one is tidy.
   */
  private rescheduleIfNeeded(): void {
    const minutes = this.getRuntime().currentSettings().autoIntervalMinutes;
    if (minutes === this.intervalMinutes) return;
    this.intervalMinutes = minutes;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (minutes <= 0) return;
    // `globalThis` rather than `window`: the bundle is loaded head-first by
    // the contract tests in plain Node, where `window` does not exist, and a
    // ReferenceError there would be a test-harness failure standing in for a
    // production one.
    this.timer = this.registerInterval(
      globalThis.setInterval(() => void this.sync(), minutes * MINUTE_MS) as unknown as number,
    );
  }

  private openConflicts(): void {
    const runtime = this.getRuntime();
    new ConflictModal(this.app, runtime, () => void runtime.refresh()).open();
  }

  private openRestore(): void {
    const runtime = this.getRuntime();
    new RestoreModal(this.app, runtime, () => void runtime.refresh()).open();
  }

  /** §6.6's promise: a way to clear a half-copied session, never automatic. */
  private openOrphans(): void {
    new OrphanModal(this.getRuntime(), this.app).open();
  }

  /**
   * §9.3.4's first requirement: the user can find the backups.
   *
   * Always says the path, whether or not the folder opened. A file manager
   * that refuses is an inconvenience; a message that claims to have opened
   * something and did not is the failure this project keeps naming.
   */
  private async openBackupsFolder(): Promise<void> {
    const runtime = this.getRuntime();
    const dir = await runtime.backupsDir();
    if (dir === null) {
      new Notice(
        "There is no backup folder yet — this vault has no workspace identity, so nothing " +
          "has been synced or backed up.",
      );
      return;
    }
    const opened = await runtime.reveal(dir);
    new Notice(opened ? `Backups are in ${dir}` : `Could not open it. Backups are in ${dir}`);
  }

  /** Applies a resolution directly when there is exactly one conflict. */
  private async resolveSingle(resolution: ConflictResolution): Promise<void> {
    const runtime = this.getRuntime();
    const conflicts = await runtime.conflicts();
    if (conflicts.length === 0) {
      new Notice("Nothing is in conflict.");
      return;
    }
    if (conflicts.length > 1) {
      this.openConflicts();
      return;
    }
    const only = conflicts[0];
    if (!only) return;
    const outcome = await runtime.resolve(only.conflictId, resolution);
    new Notice(describeOutcome(outcome, only));
  }

  private renderStatus(status: RuntimeStatus): void {
    this.statusBarEl?.setText(status.short);
  }
}

/**
 * Shows a directory in the desktop file manager (§9.3.4).
 *
 * `electron` is required lazily and defensively. It is external to the bundle
 * and always present in Obsidian desktop, which this plugin declares itself
 * to be (`isDesktopOnly`) — but a missing shell must degrade to "here is the
 * path" rather than throwing out of a click handler, because the path is the
 * thing the user actually needs and the folder opening is a convenience.
 */
async function openInFileManager(target: string): Promise<boolean> {
  try {
    // Not a static import: `electron` has no types here and is external to
    // the bundle, so the module specifier is built at runtime to keep the
    // bundler from trying to resolve it at all.
    const electron = (await import(/* @vite-ignore */ String("electron"))) as {
      shell?: { openPath?: (path: string) => Promise<string> };
    };
    const openPath = electron.shell?.openPath;
    if (!openPath) return false;
    // `openPath` resolves to "" on success and to an error message otherwise,
    // which is a return value worth checking rather than a promise worth
    // assuming.
    return (await openPath(target)) === "";
  } catch {
    return false;
  }
}
