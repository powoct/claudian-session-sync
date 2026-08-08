/**
 * Choosing between two branches of the same session (architecture §8.1).
 *
 * Three options, and the third is not padding. "Keep this one" and "keep that
 * one" are the only two a two-button dialog can offer, and offering only those
 * forces a guess — so "show me both" is a first-class answer that writes
 * nothing and opens the folder holding the two copies.
 *
 * The wording avoids "local" and "remote" entirely. Those words swap meaning
 * depending on which machine you are sitting at, which is precisely the
 * confusion that made conflict identity content-derived in the first place.
 */
import { Modal, Notice, type App } from "obsidian";
import type { ConflictResolution } from "../domain/conflict";
import type { ConflictEntry } from "../orchestration/conflict-commands";
import type { PluginRuntime } from "../orchestration/plugin-runtime";

export class ConflictModal extends Modal {
  constructor(
    app: App,
    private readonly runtime: PluginRuntime,
    /** Called after a resolution lands, so the status bar can catch up. */
    private readonly onResolved: () => void,
  ) {
    super(app);
  }

  override async onOpen(): Promise<void> {
    await this.render();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private async render(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Session conflicts" });

    const conflicts = await this.runtime.conflicts();
    if (conflicts.length === 0) {
      contentEl.createEl("p", { text: "Nothing is in conflict." });
      return;
    }

    contentEl.createEl("p", {
      text:
        "Both machines added to these sessions separately, so neither version contains the " +
        "other. Both are kept whichever you choose — the one you do not pick stays in the " +
        "quarantine folder and in your backups.",
    });

    for (const conflict of conflicts) {
      this.renderOne(contentEl, conflict);
    }
  }

  private renderOne(container: HTMLElement, conflict: ConflictEntry): void {
    const block = container.createDiv();
    block.createEl("h3", { text: `Session ${conflict.logicalIdPrefix} (${conflict.providerId})` });
    block.createEl("p", {
      text:
        `This machine: ${conflict.meta.localLineCount} lines, ${conflict.meta.localSize} bytes ` +
        `(${conflict.meta.localHashPrefix}). ` +
        `Other machine: ${conflict.meta.remoteLineCount} lines, ${conflict.meta.remoteSize} bytes ` +
        `(${conflict.meta.remoteHashPrefix}). Detected ${conflict.meta.detectedAt}.`,
    });

    const buttons = block.createDiv();
    this.addChoice(buttons, conflict, "keep-local", "Keep this machine's version");
    this.addChoice(buttons, conflict, "keep-remote", "Keep the other machine's version");
    this.addChoice(buttons, conflict, "reveal", "Show me both");
  }

  private addChoice(
    container: HTMLElement,
    conflict: ConflictEntry,
    resolution: ConflictResolution,
    label: string,
  ): void {
    const button = container.createEl("button", { text: label });
    button.addEventListener("click", () => {
      void this.apply(conflict, resolution);
    });
  }

  private async apply(conflict: ConflictEntry, resolution: ConflictResolution): Promise<void> {
    const outcome = await this.runtime.resolve(conflict.conflictId, resolution);
    new Notice(describeOutcome(outcome, conflict));
    if (outcome.ok && outcome.action !== "REVEAL") {
      this.onResolved();
      await this.render();
    }
  }
}

/**
 * What to tell the user, per outcome.
 *
 * `branch-moved` gets a full sentence because it is the one failure that is
 * not a malfunction: the session changed while the dialog was open, so the
 * disagreement they were looking at is no longer the one on disk.
 */
export function describeOutcome(
  outcome: Awaited<ReturnType<PluginRuntime["resolve"]>>,
  conflict: ConflictEntry,
): string {
  if (outcome.ok && outcome.action === "REVEAL") {
    return `Both versions are in ${outcome.directory}`;
  }
  if (outcome.ok) {
    return `Resolved session ${conflict.logicalIdPrefix}. The other version is still in quarantine and in your backups.`;
  }
  switch (outcome.reason) {
    case "branch-moved":
      return "That session changed since this list was drawn, so this is no longer the same disagreement. Run a sync and try again.";
    case "remote-not-ready":
      return "The sync folder is not ready, so nothing may be written to it yet.";
    case "backup-failed":
      return "The backup could not be written, so nothing was overwritten.";
    case "unknown-conflict":
      return "That conflict is no longer there — it may already be resolved.";
    default:
      return `Could not resolve it: ${outcome.reason}.`;
  }
}
