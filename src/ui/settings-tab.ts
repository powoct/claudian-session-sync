/**
 * The settings tab (architecture §5.2.3, §9.6.3, §12).
 *
 * The panel is organised around what the plugin refuses to do without being
 * told, because that is what a user actually has to act on:
 *
 *  1. this vault has no workspace identity → create one, once, here;
 *  2. this machine has no sync folder → choose one;
 *  3. the sync folder is empty → say whether it is new or still downloading.
 *
 * None of those can be inferred safely (ADR-16, ADR-20), so each gets a
 * sentence explaining the risk rather than a bare field. A setting whose only
 * label is its name teaches nothing; here the labels are the argument for why
 * the plugin stopped.
 */
import { type App, Notice, type Plugin, PluginSettingTab, Setting } from "obsidian";
import type { PortableSettings } from "../domain/settings";
import { boundsFor } from "../domain/settings";
import type { PluginRuntime, RuntimeStatus } from "../orchestration/plugin-runtime";
import { PROVIDERS, type ProviderDescriptor } from "../providers/registry";

export class AiSessionSyncSettingTab extends PluginSettingTab {
  /**
   * The runtime arrives as a thunk, not an instance.
   *
   * Building it resolves the vault's real path, and `onload()` — where the tab
   * is registered — may not touch the filesystem at all (testing.md §12.2c).
   * Obsidian does not construct a settings tab's contents until the user opens
   * it, so deferring costs nothing and keeps startup clean.
   */
  constructor(
    app: App,
    plugin: Plugin,
    private readonly getRuntime: () => PluginRuntime,
  ) {
    super(app, plugin);
  }

  private get runtime(): PluginRuntime {
    return this.getRuntime();
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const status = this.runtime.currentStatus();

    this.renderStatus(containerEl, status);
    this.renderIdentity(containerEl, status);
    this.renderSyncFolder(containerEl, status);
    this.renderProviders(containerEl);
    this.renderBehaviour(containerEl, this.runtime.currentSettings());
  }

  private redraw(): void {
    this.display();
  }

  private renderStatus(containerEl: HTMLElement, status: RuntimeStatus): void {
    new Setting(containerEl).setName("Claudian Session Sync").setHeading();
    new Setting(containerEl).setName("Status").setDesc(status.detail);

    if (status.phase === "await-init") {
      // The one button that exists because guessing is unsafe (ADR-16): an
      // empty folder is either brand new or not downloaded yet, and only the
      // user knows which.
      new Setting(containerEl)
        .setName("Initialise this sync folder")
        .setDesc(
          "Only if this folder is new. If another machine's data should be here, wait for " +
            "your sync tool instead — initialising now would push this machine's history into " +
            "a folder that is still filling up.",
        )
        .addButton((button) =>
          button
            .setButtonText("Initialise")
            .setCta()
            .onClick(async () => {
              const outcome = await this.runtime.initialiseSyncDir();
              new Notice(
                outcome.ok
                  ? "Sync folder initialised."
                  : `Could not initialise: ${outcome.reason ?? "unknown"}`,
              );
              this.redraw();
            }),
        );
    }

    if (status.conflicts > 0) {
      new Setting(containerEl)
        .setName(`${status.conflicts} unresolved conflict${status.conflicts === 1 ? "" : "s"}`)
        .setDesc(
          "Both machines changed the same session in ways neither contains. Both versions are " +
            "kept; use the “Show conflicts” command to choose.",
        );
    }
  }

  private renderIdentity(containerEl: HTMLElement, status: RuntimeStatus): void {
    new Setting(containerEl).setName("Workspace").setHeading();

    if (status.workspaceId) {
      new Setting(containerEl)
        .setName("Workspace id")
        .setDesc(
          `${status.workspaceId} — stored in this vault and shared with every machine that ` +
            "syncs it.",
        );
      return;
    }

    new Setting(containerEl)
      .setName("Create workspace identity")
      .setDesc(
        "Do this on one machine only. The identity travels with the vault; creating a second " +
          "one on another machine would split this workspace into two that can never see each " +
          "other.",
      )
      .addButton((button) =>
        button
          .setButtonText("Create")
          .setCta()
          .onClick(async () => {
            const outcome = await this.runtime.createIdentity(this.app.vault.getName());
            new Notice(
              outcome.ok
                ? "Workspace identity created."
                : `Could not create it: ${outcome.reason ?? "unknown"}`,
            );
            this.redraw();
          }),
      );
  }

  private renderSyncFolder(containerEl: HTMLElement, status: RuntimeStatus): void {
    new Setting(containerEl).setName("Sync folder").setHeading();

    new Setting(containerEl)
      .setName("Folder path")
      .setDesc(
        "An absolute path your sync tool keeps in step across machines — a Dropbox, iCloud, " +
          "OneDrive or Syncthing folder. It must be outside the vault, and outside your home " +
          "directory's root.",
      )
      .addText((text) =>
        text
          // No sample path: one written for macOS reads as wrong on Windows, and
          // the secret scanner rejects a literal home directory either way.
          .setPlaceholder("Absolute path to your synced folder")
          .setValue(status.syncDirPath ?? "")
          .setDisabled(status.workspaceId === null)
          .onChange(async (value) => {
            const trimmed = value.trim();
            if (trimmed.length === 0) return;
            await this.runtime.setSyncDir(trimmed);
          }),
      );

    if (status.machineLabel) {
      new Setting(containerEl)
        .setName("This machine")
        .setDesc(
          `${status.machineLabel}. The folder path above is stored per machine and never ` +
            "synced, so each machine can point at its own copy.",
        );
    }
  }

  private renderProviders(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Share this device's conversations with your other devices")
      .setDesc(
        "Claudian 2.2.5 files each new conversation under the device that made it, and a " +
          "device only reads its own folder — so a conversation started here is missing from " +
          "the other machine's list even after its session file has synced. This moves the " +
          "record into the layer every device reads, so all of them list it and all of them " +
          "write to the same one. Three things to know. Claudian decides where to save a " +
          "conversation once per session, so after a move it keeps writing a copy here until " +
          "you next restart Obsidian; each sync folds that copy forward, and where it cannot " +
          "tell which version should win it leaves both and asks you — see \"Repair shared " +
          "conversation records\". Turning this back off stops further moves but does not " +
          "bring back what has already been shared. And a shared conversation carries any " +
          "folders it had been given access to, as absolute paths — on the other machine " +
          "those paths may mean something else. Off by default, and set per machine.",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.runtime.sharesConversations()).onChange(async (value) => {
          await this.runtime.setShareConversations(value);
        }),
      );

    new Setting(containerEl).setName("Agent CLIs").setHeading();

    for (const provider of PROVIDERS) {
      new Setting(containerEl)
        .setName(provider.label)
        .setDesc(describeProvider(provider))
        .addToggle((toggle) =>
          toggle.setValue(this.isEnabled(provider.id)).onChange(async (value) => {
            const outcome = await this.runtime.setProvider(provider.id, { enabled: value });
            if (outcome.firstEnable) {
              // §6.1's first-enable gate. The report is the point: what this
              // switch decides is which of this machine's existing
              // conversations start travelling, and that set is usually much
              // larger than the one the user has in mind.
              new Notice(
                `A dry run just listed what enabling ${provider.label} would copy. ` +
                  "Nothing has been copied yet — open “Show last sync report” to read it, " +
                  "and switch this back off if it is more than you meant.",
                12_000,
              );
            }
            this.redraw();
          }),
        );

      new Setting(containerEl)
        .setName(`${provider.label} storage folder`)
        .setDesc(provider.rootDescription)
        .addText((text) =>
          text
            .setPlaceholder(this.runtime.defaultProviderRoot(provider.id) ?? "")
            .setValue(this.rootOverride(provider.id))
            .onChange(async (value) => {
              const trimmed = value.trim();
              // `null`, not an omitted key: emptying the box has to mean "go
              // back to the detected path", and a patch that just leaves the
              // field out cannot say that.
              await this.runtime.setProvider(provider.id, {
                rootOverride: trimmed.length > 0 ? trimmed : null,
              });
            }),
        );
    }
  }

  private renderBehaviour(containerEl: HTMLElement, settings: PortableSettings): void {
    new Setting(containerEl).setName("Behaviour").setHeading();

    // §9.3.4: a user must be able to *find* the backups, from here as well as
    // from the command palette. The retention setting immediately below is
    // the natural place to wonder where they are.
    new Setting(containerEl)
      .setName("Backups folder")
      .setDesc(
        "Every version this plugin was about to overwrite is kept here. “Restore an earlier " +
          "version” in the command palette lists them and puts one back.",
      )
      .addButton((button) =>
        button.setButtonText("Open").onClick(async () => {
          const dir = await this.runtime.backupsDir();
          if (dir === null) {
            new Notice("There is no backup folder yet — nothing has been backed up.");
            return;
          }
          const opened = await this.runtime.reveal(dir);
          new Notice(opened ? `Backups are in ${dir}` : `Could not open it. Backups are in ${dir}`);
        }),
      );

    const keep = boundsFor("backupKeep");
    new Setting(containerEl)
      .setName("Backups to keep")
      .setDesc(
        `Per file, ${keep.min}–${keep.max}. Backups cannot be switched off: every overwrite ` +
          "must stay reversible, and a version that no surviving backup can reproduce is kept " +
          "past this number rather than deleted.",
      )
      .addText((text) =>
        text.setValue(String(settings.backupKeep)).onChange(async (value) => {
          await this.runtime.updateSettings({ backupKeep: Number(value) });
        }),
      );

    new Setting(containerEl)
      .setName("Automatic sync interval")
      .setDesc("Minutes between passes. 0 turns automatic syncing off; manual sync still works.")
      .addText((text) =>
        text.setValue(String(settings.autoIntervalMinutes)).onChange(async (value) => {
          await this.runtime.updateSettings({ autoIntervalMinutes: Number(value) });
        }),
      );

    new Setting(containerEl)
      .setName("Maximum file size")
      .setDesc("Megabytes. Larger sessions are reported and skipped rather than copied.")
      .addText((text) =>
        text.setValue(String(settings.maxFileSizeMB)).onChange(async (value) => {
          await this.runtime.updateSettings({ maxFileSizeMB: Number(value) });
        }),
      );

    new Setting(containerEl)
      .setName("Log level")
      .setDesc("Debug writes a log file under your home directory. It never records session text.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("off", "Off")
          .addOption("info", "Info")
          .addOption("debug", "Debug")
          .setValue(settings.logLevel)
          .onChange(async (value) => {
            await this.runtime.updateSettings({
              logLevel: value === "off" || value === "debug" ? value : "info",
            });
          }),
      );
  }

  private isEnabled(providerId: string): boolean {
    return this.runtime.providerEnabled(providerId);
  }

  private rootOverride(providerId: string): string {
    return this.runtime.providerRootOverride(providerId) ?? "";
  }
}

/**
 * What the user is agreeing to when they turn a provider on.
 *
 * The experimental line is not a disclaimer for its own sake: §6.1 puts the
 * evidence gate at release, so a provider can ship with its shape implemented
 * and its lifecycle measured on one platform only. Saying which is which is
 * the difference between an informed choice and a surprise.
 */
function describeProvider(provider: ProviderDescriptor): string {
  const tier =
    provider.tier === "A"
      ? "Measured append-only, so its sessions can be merged safely."
      : provider.tier === "R"
        ? "Whole-file records: identical is left alone, a one-sided change fast-forwards " +
          "(with backup), anything else becomes a conflict for you to settle."
        : "Unverified lifecycle — read-only until measured.";
  const experimental = provider.experimental
    ? " Experimental: its lifecycle has not been measured on every platform yet."
    : "";
  const scope = provider.scopeNote ? ` ${provider.scopeNote}` : "";
  return `Tier ${provider.tier}. ${tier}${experimental}${scope}`;
}
