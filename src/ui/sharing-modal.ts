/**
 * Conversation records that differ on this device and in the shared layer.
 *
 * Every row here is a fork the plugin refused to resolve on its own, and the
 * refusal is the point: the shared copy is not the one this machine published,
 * so something else wrote it, and picking a winner would be deciding for the
 * other machine. What the pass can do it already did — this screen exists only
 * for what is left.
 *
 * Two rules shape it. **One at a time**: each row is an independent fork and a
 * decision about one carries no information about the next, so there is no
 * "publish all" button however tempting the count makes it. And **the losing
 * version is kept**: publishing backs the shared copy up first, and a backup
 * that cannot be taken cancels the write.
 *
 * The rows are also the honest answer to the reported failure. Six records had
 * been frozen for three days before anyone noticed, because the only signal
 * was a line in a report that is overwritten every pass. A record that needs a
 * person now stays somewhere a person can find it.
 */
import { Modal, Notice, type App } from "obsidian";
import type { SharingHold } from "../orchestration/conversation-sharing";
import type { PluginRuntime } from "../orchestration/plugin-runtime";

export class SharingModal extends Modal {
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
    contentEl.createEl("h2", { text: "Repair shared conversation records" });

    const holds = await this.runtime.sharingConflicts();
    if (holds.length === 0) {
      contentEl.createEl("p", {
        text:
          "Nothing to repair. This fills only when a conversation record differs between this " +
          "device and the copy your other devices read, and the sync could not tell which one " +
          "should win.",
      });
      return;
    }

    contentEl.createEl("p", {
      text:
        "Each of these exists twice: once on this device, and once in the layer your other " +
        "devices read. They no longer match, and the shared one is not the copy this machine " +
        "last published — so something else wrote it, and choosing for you would mean " +
        "overwriting whatever that was. Your other devices are currently reading the shared " +
        "version, which may be older than what you see here.",
    });
    contentEl.createEl("p", {
      text:
        "Publishing replaces the shared version with this device's. The version it replaces is " +
        "copied to your backups first, so this is reversible. Decide one at a time — these are " +
        "separate conversations and what is right for one says nothing about the next.",
    });

    for (const hold of holds) {
      this.renderRow(hold);
    }
  }

  private renderRow(hold: SharingHold): void {
    const row = this.contentEl.createDiv({ cls: "aiss-sharing-row" });
    row.createEl("h3", { text: hold.conversationId });
    row.createEl("p", { text: hold.reason });

    const table = row.createEl("table");
    const header = table.createEl("tr");
    header.createEl("th", { text: "" });
    header.createEl("th", { text: "Size" });
    header.createEl("th", { text: "Last written" });
    add(table, "On this device", hold.deviceSize, hold.deviceMtimeMs);
    add(table, "What your other devices read", hold.sharedSize, hold.sharedMtimeMs);

    if (!hold.resolvable) return;
    const button = row.createEl("button", { text: "Publish this device's version" });
    button.addEventListener("click", () => {
      void this.publish(hold, button);
    });
  }

  private async publish(hold: SharingHold, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    const done = await this.runtime.publishSharedRecord(hold.conversationId);
    new Notice(
      done
        ? "Published. Your other devices will show this version once the vault syncs; the one " +
          "it replaced is in your backups."
        : "Nothing was published — the shared version changed again, or it could not be backed " +
          "up. Nothing was overwritten.",
    );
    await this.render();
  }
}

function add(
  table: HTMLTableElement,
  label: string,
  size: number | null,
  mtimeMs: number | null,
): void {
  const row = table.createEl("tr");
  row.createEl("td", { text: label });
  row.createEl("td", { text: size === null ? "—" : `${size.toLocaleString()} bytes` });
  row.createEl("td", {
    text: mtimeMs === null ? "—" : new Date(mtimeMs).toLocaleString(),
  });
}
