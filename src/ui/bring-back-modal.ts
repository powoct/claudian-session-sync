/**
 * Conversations kept off this device because they were removed here (ADR-78).
 *
 * The undo for the deleted-here rule. The rule decides on what this device
 * witnessed, and it can be wrong in one known way — a conversation Claudian
 * removed by itself, in a setup where its history folder is not the one this
 * plugin looks in — so the way back has to be one click from the report that
 * names it.
 *
 * Only deletions are ticked to start with. A record that moved into a device
 * folder is still listed in Claudian under that device; bringing its shared
 * copy back gives that device's Claudian two records for one conversation. A
 * record removed by an older Claudian's deletion marker was deleted on
 * another device on purpose. Both are offered, neither is assumed.
 */
import { Modal, Notice, type App } from "obsidian";
import type { HeldRecordView, PluginRuntime } from "../orchestration/plugin-runtime";

const KIND_TEXT: Record<HeldRecordView["kind"], string> = {
  "deleted-here": "Deleted on this device",
  "moved-to-device": "Assigned to a device (still listed there)",
  "removed-by-tombstone": "Deleted on a device running an older Claudian",
};

export class BringBackModal extends Modal {
  constructor(
    private readonly runtime: PluginRuntime,
    app: App,
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
    contentEl.createEl("h2", { text: "Conversations deleted on this device" });

    const held = await this.runtime.heldRecords();
    if (held.length === 0) {
      contentEl.createEl("p", {
        text:
          "Nothing is being kept off this device. This lists conversations whose Claudian record " +
          "was removed here while the sync folder still has it — they stay removed here until you " +
          "bring them back.",
      });
      return;
    }

    contentEl.createEl("p", {
      text:
        "The sync folder and your other devices still have these. Bringing one back copies its " +
        "record from the sync folder — the latest version, including anything another device " +
        "changed since — and Claudian lists it again after its next restart. Nothing on your " +
        "other devices changes.",
    });

    const chosen = new Set<string>();
    const list = contentEl.createDiv({ cls: "aiss-bring-back-list" });
    for (const record of held) {
      const row = list.createDiv({ cls: "aiss-bring-back-row" });
      const label = row.createEl("label");
      const box = label.createEl("input", { type: "checkbox" });
      box.checked = record.kind === "deleted-here" || record.releaseRequested;
      if (box.checked) chosen.add(record.neutralRel);
      box.addEventListener("change", () => {
        if (box.checked) chosen.add(record.neutralRel);
        else chosen.delete(record.neutralRel);
      });
      label.appendText(` ${record.title ?? "(untitled)"}`);
      row.createEl("div", {
        cls: "setting-item-description",
        text:
          `${KIND_TEXT[record.kind]} · ${record.conversationId} · since ` +
          `${new Date(record.sinceMs).toLocaleString()}` +
          (record.releaseRequested ? " · coming back with the next sync" : ""),
      });
    }

    const button = contentEl.createEl("button", { text: "Bring back the ticked conversations" });
    button.addEventListener("click", () => {
      void this.bringBack([...chosen], button);
    });
  }

  private async bringBack(rels: string[], button: HTMLButtonElement): Promise<void> {
    if (rels.length === 0) {
      new Notice("Nothing is ticked.");
      return;
    }
    button.disabled = true;
    const outcome = await this.runtime.bringBack(rels);
    new Notice(
      outcome.ok
        ? `Bringing back ${rels.length} conversation(s). Restart Obsidian, or reopen Claudian, to see them listed.`
        : outcome.reason === "sync-in-progress"
          ? "A sync is running right now. Nothing was changed; try again in a moment."
          : "Nothing was changed — this vault's sync is not set up right now, or these are no longer held.",
    );
    await this.render();
  }
}
