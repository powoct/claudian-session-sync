import { Notice, Plugin, PluginSettingTab, Setting, type App } from "obsidian";

/**
 * M0 scaffold entry point.
 *
 * Deliberately assembly-only: it registers the UI surface and queues a first
 * pass, and contains no sync logic at all. M1 replaces the `notImplemented`
 * bodies with SyncEngine calls. Two constraints this file already has to honour,
 * because the bundle contract test in tests/build/ asserts them:
 *
 *  - `onload()` resolves fast and performs no filesystem reads. The sync
 *    directory is typically a cloud-drive folder, and Obsidian blocks on plugin
 *    load (testing.md §12.2c).
 *  - Everything registered here is unregistered by Obsidian on unload; anything
 *    with a timer must go through `registerInterval` so `onunload()` leaves no
 *    live handles.
 */

const STATUS_IDLE = "AI Session Sync: idle";

export default class AiSessionSyncPlugin extends Plugin {
  private statusBarEl: HTMLElement | null = null;

  override async onload(): Promise<void> {
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.setText(STATUS_IDLE);

    this.addRibbonIcon("refresh-cw", "AI Session Sync: sync now", () => {
      this.notImplemented("sync-now");
    });

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => {
        this.notImplemented("sync-now");
      },
    });

    this.addCommand({
      id: "dry-run",
      name: "Dry-run sync (no writes)",
      callback: () => {
        this.notImplemented("dry-run");
      },
    });

    this.addCommand({
      id: "show-last-report",
      name: "Show last sync report",
      callback: () => {
        this.notImplemented("show-last-report");
      },
    });

    this.addSettingTab(new AiSessionSyncSettingTab(this.app, this));

    // Queued, never awaited: the first pass must not sit in Obsidian's startup
    // path (testing.md §12.2c).
    this.app.workspace.onLayoutReady(() => {
      void this.queueInitialPass();
    });
  }

  override onunload(): void {
    this.statusBarEl = null;
  }

  /** M1: hand off to Scheduler. M0 has no engine to run. */
  private async queueInitialPass(): Promise<void> {
    return Promise.resolve();
  }

  private notImplemented(action: string): void {
    new Notice(`AI Session Sync: "${action}" is not implemented yet (M0 scaffold).`);
  }
}

class AiSessionSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: AiSessionSyncPlugin) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("AI Session Sync").setHeading();

    new Setting(containerEl)
      .setName("Status")
      .setDesc(
        `Scaffold build ${this.plugin.manifest.version}. No provider is wired up yet; ` +
          "nothing is read from or written to any sync directory.",
      );
  }
}
