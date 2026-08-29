/**
 * Half-copied sessions (architecture §6.6).
 *
 * §6.6 chose not to roll back a group whose primary failed to land, because
 * undoing a write in an already-failing state is a second destructive write.
 * The price is that this machine can be left holding a session's history with
 * no commit point, and the promise attached to that choice was a command —
 * with the rule that nothing is ever deleted automatically.
 *
 * So this screen exists to be *read* before it is used. What it lists is
 * conversation content, and the CLI cannot see it: without a commit point the
 * session does not appear in any list, which is exactly why it is safe to
 * delete and exactly why the user cannot check it themselves. Hence the offer
 * to open the folder first, and a button that says what it will do rather than
 * "clean up".
 */
import { Modal, Notice, type App } from "obsidian";
import type { OrphanGroup } from "../orchestration/orphan-commands";
import type { PluginRuntime } from "../orchestration/plugin-runtime";

export class OrphanModal extends Modal {
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
    contentEl.createEl("h2", { text: "Half-copied sessions" });

    const groups = await this.runtime.orphans();
    if (groups.length === 0) {
      contentEl.createEl("p", {
        text:
          "Nothing to clean up. This fills only when copying a session was interrupted between " +
          "its history and the file that makes it visible — and the next sync usually finishes " +
          "the job by itself.",
      });
      return;
    }

    contentEl.createEl("p", {
      text:
        "These are pieces of sessions this machine received without the file that makes them " +
        "visible, so the CLI does not list them and no sync will complete them — the other " +
        "machine no longer has the missing part either. Deleting one keeps a copy in your " +
        "backups first, so this is reversible.",
    });

    for (const group of groups) this.renderOne(contentEl, group);
  }

  private renderOne(container: HTMLElement, group: OrphanGroup): void {
    const block = container.createDiv();
    block.createEl("h3", { text: describeOrphanGroup(group) });
    for (const file of group.files) {
      block.createEl("p", { text: `${file.neutralRel} — ${file.sizeBytes} bytes` });
    }

    const buttons = block.createDiv();
    const remove = buttons.createEl("button", { text: "Delete these files" });
    remove.addEventListener("click", () => {
      void this.apply(group);
    });
    const reveal = buttons.createEl("button", { text: "Show me the folder" });
    reveal.addEventListener("click", () => {
      // Offered first for a reason: what these files hold cannot be inspected
      // through the CLI, because a session with no commit point is a session
      // the CLI will not show.
      void this.revealFolder(group);
    });
  }

  private async revealFolder(group: OrphanGroup): Promise<void> {
    const first = group.files[0];
    if (!first) return;
    const folder = first.absPath.slice(0, Math.max(0, first.absPath.lastIndexOf("/")));
    const opened = await this.runtime.reveal(folder.length > 0 ? folder : first.absPath);
    new Notice(opened ? `The files are in ${folder}` : `Could not open it. The files are in ${folder}`);
  }

  private async apply(group: OrphanGroup): Promise<void> {
    const outcome = await this.runtime.removeOrphan(
      group.providerId,
      group.logicalId,
      group.files.map((file) => ({ neutralRel: file.neutralRel, sizeBytes: file.sizeBytes })),
    );
    new Notice(describeRemoval(outcome));
    await this.render();
  }
}

export function describeOrphanGroup(group: OrphanGroup): string {
  const when = new Date(group.lastTouchedMs).toLocaleString();
  return `${group.logicalId} (${group.providerId}) — ${group.files.length} file(s), ${group.totalBytes} bytes, last changed ${when}`;
}

export function describeRemoval(
  outcome: Awaited<ReturnType<PluginRuntime["removeOrphan"]>>,
): string {
  if (outcome.ok) {
    return `Deleted ${outcome.removed} file(s). ${outcome.backedUp} copy/copies are in your backups, so this can be undone.`;
  }
  switch (outcome.reason) {
    case "not-listed":
      return "That session is not half-copied any more — something completed or removed it. Reopen this list.";
    case "changed-since-listed":
      return (
        "Those files changed since this list was drawn, so what you read about them no longer " +
        "applies. Nothing was deleted; reopen the list and look again."
      );
    case "backup-failed":
      return "A copy could not be kept, so nothing was deleted.";
    case "sync-in-progress":
      return "A sync is running right now. Nothing was deleted; try again in a moment.";
    case "path-rejected":
      return "One of those paths is not somewhere this plugin may write, so nothing was deleted.";
    default:
      return `Could not delete them: ${outcome.reason}.`;
  }
}
