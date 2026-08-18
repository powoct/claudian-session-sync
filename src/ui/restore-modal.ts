/**
 * Putting a version back (architecture §9.3, §11).
 *
 * Every row here is a version this plugin already destroyed once, on purpose,
 * and kept because I1 says it must stay reachable. The screen's whole job is
 * to make the promise usable — and to be honest about what pressing the button
 * will actually produce, which for an append-only session is often "the next
 * sync will bring the newer version back". A restore that silently reverts an
 * hour later is the R2-1 failure mode with a different mask: the user believes
 * something happened that did not last.
 *
 * So each row says what will follow *before* it is clicked: nothing (already
 * identical), a revert (the live file grew out of this one), or a conflict
 * where both versions survive and the user picks. The third is the case
 * restore actually exists for — a resolution that kept the wrong branch.
 */
import { Modal, Notice, type App } from "obsidian";
import type { BackupEntry } from "../orchestration/restore-commands";
import type { PluginRuntime } from "../orchestration/plugin-runtime";

/** Enough to choose from without turning the dialog into a file manager. */
const MAX_ROWS = 60;

export class RestoreModal extends Modal {
  constructor(
    app: App,
    private readonly runtime: PluginRuntime,
    private readonly onRestored: () => void,
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
    contentEl.createEl("h2", { text: "Restore an earlier version" });

    const backups = await this.runtime.backups();
    if (backups.length === 0) {
      contentEl.createEl("p", {
        text:
          "There are no backups yet. One is written every time a version would be " +
          "overwritten, so this fills up only as sessions travel between machines.",
      });
      return;
    }

    contentEl.createEl("p", {
      text:
        "Each of these is a version that was about to be overwritten and was kept instead. " +
        "Restoring one writes it back and keeps what is there now as a new backup, so a " +
        "restore can itself be undone.",
    });
    contentEl.createEl("p", {
      // §9.1.6: on macOS and Linux a running CLI holds an open handle, and
      // replacing the file leaves it writing into an inode nothing points at.
      // The manual recipe in §9.3.4 opens with this line; automating the
      // recipe is not a reason to drop it.
      text:
        "Quit the CLI for a session before restoring it. If it is running, anything it writes " +
        "after the restore goes into the replaced file and is lost.",
    });

    for (const backup of backups.slice(0, MAX_ROWS)) this.renderOne(contentEl, backup);
    if (backups.length > MAX_ROWS) {
      contentEl.createEl("p", {
        text: `…and ${backups.length - MAX_ROWS} older ones, in the backup folder.`,
      });
    }
  }

  private renderOne(container: HTMLElement, backup: BackupEntry): void {
    const block = container.createDiv();
    block.createEl("h3", { text: describeSession(backup) });
    block.createEl("p", { text: describeVersion(backup) });
    block.createEl("p", { text: describeWhatFollows(backup) });

    const buttons = block.createDiv();
    // One state, not two: the prose below and the button must agree. A row
    // whose target cannot be resolved says "nowhere to put it back", so it
    // must not also offer to put it back.
    const restorable =
      backup.neutralRel !== null &&
      backup.liveRelation !== "identical" &&
      backup.liveRelation !== "unknown";
    const button = buttons.createEl("button", { text: "Restore this version" });
    button.disabled = !restorable;
    if (restorable) {
      button.addEventListener("click", () => {
        void this.apply(backup);
      });
    }
    const reveal = buttons.createEl("button", { text: "Show me the folder" });
    reveal.addEventListener("click", () => {
      // The escape hatch for every case the buttons above cannot serve —
      // including a session that no longer exists anywhere, where writing it
      // back would mean inventing a path. It opens the folder for real, and
      // says the path either way: a button labelled "show me" that shows
      // nothing is a small version of the same lie as a resolution that
      // silently does nothing.
      void this.revealFolder(backup.path);
    });
  }

  private async revealFolder(target: string): Promise<void> {
    const folder = target.slice(0, Math.max(0, target.lastIndexOf("/")));
    const opened = await this.runtime.reveal(folder.length > 0 ? folder : target);
    new Notice(opened ? `The backup is at ${target}` : `Could not open it. The backup is at ${target}`);
  }

  private async apply(backup: BackupEntry): Promise<void> {
    const outcome = await this.runtime.restore(
      backup.path,
      backup.hashPrefix,
      backup.liveHashPrefix,
    );
    new Notice(describeRestore(outcome, backup));
    if (outcome.ok) this.onRestored();
    // Re-rendered either way: a restore changes what every other row of the
    // same session relates to, and a refusal usually means the world moved.
    await this.render();
  }
}

function describeSession(backup: BackupEntry): string {
  const side = backup.remote ? "sync folder" : "this machine";
  return `${backup.originalName} (${backup.providerId}, from the ${side})`;
}

export function describeVersion(backup: BackupEntry): string {
  const when = new Date(backup.takenAtMs).toLocaleString();
  const cause = backup.action === "" ? "" : ` before a ${backup.action}`;
  return `Kept ${when}${cause}: ${backup.lineCount} lines, ${backup.sizeBytes} bytes, version ${backup.hashPrefix}.`;
}

/**
 * The sentence that keeps a restore from being a surprise.
 *
 * Two facts, in the order they matter. First what the write does here; then
 * what the next sync makes of it — computed against the *other* side, since
 * that is the pair the decision table compares. The second sentence is the
 * one that stops a restore from quietly reverting an hour later, or from
 * travelling to machines the user never meant to touch.
 */
export function describeWhatFollows(backup: BackupEntry): string {
  if (backup.liveRelation === "unknown") {
    return (
      "This session is not on this machine or in the sync folder any more, so there is " +
      "nowhere to put it back. Use “Show me the folder” and copy it wherever you need it."
    );
  }
  if (backup.liveRelation === "identical") {
    return "This is what the file already holds — there is nothing to put back.";
  }
  const here =
    backup.liveRelation === "absent"
      ? "Nothing is there now, so this puts the session back in place."
      : "This replaces what is there now, which is kept as a new backup first.";
  return `${here} ${describeNextSync(backup)}`;
}

function describeNextSync(backup: BackupEntry): string {
  const otherSide = backup.remote ? "this machine" : "the sync folder";
  switch (backup.outcome) {
    case "nothing":
      return `${capitalise(otherSide)} already holds exactly this, so the next sync does nothing.`;
    case "will-be-undone":
      return (
        `${capitalise(otherSide)} has a longer version that continues on from this one, so the ` +
        "next sync brings that back and undoes this. Useful for looking at, rarely for keeping."
      );
    case "will-propagate":
      return (
        `This version continues on from what ${otherSide} holds, so the next sync copies it ` +
        "there — and on to your other machines. Not just a local change."
      );
    case "will-conflict":
      return (
        `${capitalise(otherSide)} holds a version that is not a continuation of this one, so ` +
        "the next sync raises a conflict where both are kept and you choose. This is the case " +
        "restoring is for."
      );
    case "whole-file":
      return (
        "This provider stores whole records rather than appended lines, so the next sync " +
        "either copies this version to your other machines or asks you to choose between " +
        "them — there is no way to merge the two."
      );
    default:
      return "What the next sync will do with it cannot be worked out from here.";
  }
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function describeRestore(
  outcome: Awaited<ReturnType<PluginRuntime["restore"]>>,
  backup: BackupEntry,
): string {
  if (outcome.ok) {
    const kept = outcome.created
      ? "Nothing was there, so nothing had to be kept."
      : "What was there is now a backup of its own, so this is reversible.";
    return `Put version ${backup.hashPrefix} back. ${kept} ${describeNextSync(backup)}`;
  }
  switch (outcome.reason) {
    case "target-not-located":
      return (
        "That session is not on this machine or in the sync folder any more, so there is no " +
        "file to put it back into. Use “Show me the folder” and copy it by hand."
      );
    case "sync-in-progress":
      return "A sync is running right now. Nothing was changed; try again in a moment.";
    case "remote-not-ready":
      return (
        "The sync folder is not ready, so nothing may be written to it yet. Backups taken " +
        "from this machine can still be restored."
      );
    case "backup-changed":
      return (
        "That backup is not the version this list described any more. Reopen the list and " +
        "look again before restoring."
      );
    case "backup-unreadable":
      return (
        "The backup could not be read just now — your sync tool may be busy with the " +
        "folder. Nothing was changed; try again in a few seconds."
      );
    case "backup-failed":
      return "What is there now could not be backed up, so nothing was overwritten.";
    case "target-changed":
      return (
        "That session changed since this list was drawn, so what you read about it no longer " +
        "applies. Nothing was changed; reopen the list and look again."
      );
    case "target-exists":
      return (
        "The session came back while this was being restored — a sync landed it first. " +
        "Nothing was overwritten; reopen the list to see where things stand."
      );
    case "unknown-backup":
      return "That backup is no longer listed. Reopen this list to see what is there now.";
    default:
      return `Could not restore it: ${outcome.reason}.`;
  }
}
