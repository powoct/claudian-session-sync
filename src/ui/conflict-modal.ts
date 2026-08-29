/**
 * Choosing between two branches of the same session (architecture §8.1).
 *
 * Three options, and the third is not padding. "Keep this one" and "keep that
 * one" are the only two a two-button dialog can offer, and offering only those
 * forces a guess — so "show me both" is a first-class answer that writes
 * nothing and opens the folder holding the two copies.
 *
 * Which branch is "this machine's" is decided by the command layer at read
 * time, by hashing the live files — never by labels stored in the quarantine
 * directory, which is shared between machines. A keep button is only offered
 * while the corresponding side still holds a quarantined branch; a button
 * that would be refused is worse than no button, because the refusal reads as
 * "conflicts cannot be resolved".
 */
import { Modal, Notice, type App } from "obsidian";
import type { ConflictResolution } from "../domain/conflict";
import type { ConflictBranchView, ConflictEntry } from "../orchestration/conflict-commands";
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
      // Deliberately not "both machines did this". The acceptance run (r4,
      // F-5) produced a conflict with only one machine involved: a pass copied
      // an intermediate state of a file the CLI was still writing, and the
      // finished version was not an extension of it. Telling that user the
      // other machine had edited the session sends them looking for something
      // that never happened.
      text:
        "These sessions have two versions that are not continuations of each other, so there " +
        "is no way to merge them. Usually that means both machines added to the session " +
        "separately. Both versions are kept whichever you choose — the one you do not pick " +
        "stays in the quarantine folder and in your backups. A conflict is settled per " +
        "machine: if the other machine has it too, it will ask once there as well.",
    });

    for (const conflict of conflicts) {
      this.renderOne(contentEl, conflict);
    }
  }

  private renderOne(container: HTMLElement, conflict: ConflictEntry): void {
    const block = container.createDiv();
    block.createEl("h3", { text: describeConflict(conflict) });
    for (const branch of conflict.branches) {
      block.createEl("p", { text: describeBranch(branch) });
    }
    if (conflict.detectedAt) {
      block.createEl("p", { text: `Detected ${conflict.detectedAt}.` });
    }
    if (conflict.superseded) {
      block.createEl("p", {
        text:
          "Neither of these versions is on either side any more — this disagreement is over " +
          "(resolved, or replaced by a newer one shown above after a sync). Kept for reference.",
      });
    }

    const buttons = block.createDiv();
    const hasLocal = conflict.branches.some((branch) => branch.onThisMachine);
    const hasRemote = conflict.branches.some((branch) => branch.inSyncFolder);
    this.addChoice(buttons, conflict, "keep-local", "Keep this machine's version", hasLocal);
    this.addChoice(buttons, conflict, "keep-remote", "Keep the other machine's version", hasRemote);
    this.addChoice(buttons, conflict, "reveal", "Show me both", true);
    if (!conflict.superseded && (!hasLocal || !hasRemote)) {
      buttons.createEl("p", {
        text:
          "A greyed-out choice means that side has changed since this conflict was recorded. " +
          "Run a sync — the current disagreement will appear as its own entry.",
      });
    }
  }

  private addChoice(
    container: HTMLElement,
    conflict: ConflictEntry,
    resolution: ConflictResolution,
    label: string,
    enabled: boolean,
  ): void {
    const button = container.createEl("button", { text: label });
    button.disabled = !enabled;
    if (!enabled) return;
    button.addEventListener("click", () => {
      void this.apply(conflict, resolution);
    });
  }

  private async apply(conflict: ConflictEntry, resolution: ConflictResolution): Promise<void> {
    const outcome = await this.runtime.resolve(conflict.conflictId, resolution);
    if (outcome.ok && outcome.action === "REVEAL") {
      // "Show me both" now shows them. It said where they were and left the
      // finding to the user, which for a directory nested five levels inside
      // a sync folder is most of the work.
      const opened = await this.runtime.reveal(outcome.directory);
      new Notice(
        opened
          ? describeOutcome(outcome, conflict)
          : `Could not open it. ${describeOutcome(outcome, conflict)}`,
      );
      return;
    }
    new Notice(describeOutcome(outcome, conflict));
    if (outcome.ok) this.onResolved();
    // Re-render on failure too: a refusal usually means the world moved (or a
    // file was briefly locked), and a list drawn a minute ago is exactly what
    // the user should not keep clicking on.
    await this.render();
  }
}

function describeBranch(branch: ConflictBranchView): string {
  const where =
    branch.onThisMachine && branch.inSyncFolder
      ? "on this machine and in the sync folder"
      : branch.onThisMachine
        ? "currently on this machine"
        : branch.inSyncFolder
          ? "currently in the sync folder — the other machine's version"
          : "no longer on either side";
  return `Version ${branch.hashPrefix}: ${branch.lineCount} lines, ${branch.size} bytes (${where}).`;
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
    return (
      `Resolved session ${conflict.logicalIdPrefix}. The other version is still in quarantine ` +
      "and in your backups. If the other machine also extended this session, it will ask once there too."
    );
  }
  switch (outcome.reason) {
    case "branch-moved":
      return (
        "That side changed since this list was drawn, so this is no longer the same " +
        "disagreement. Run a sync and reopen — the current one will appear as its own entry."
      );
    case "sync-in-progress":
      // Not an error, and specifically not a reason to go looking: a sync is
      // applying right now and this would be a second writer on the same
      // files. Seconds, not minutes.
      return "A sync is running right now. Nothing was changed; try again in a moment.";
    case "remote-not-ready":
      // Naming the other button matters: from the user's side the two look
      // symmetric, and being told one of them is unavailable without being
      // told the other still works reads as "conflicts cannot be resolved".
      return (
        "The sync folder is not ready, so nothing may be written to it yet. " +
        "Only keeping this machine's version writes to the sync folder — keeping the other " +
        "machine's version writes here and is still available."
      );
    case "backup-failed":
      return "The backup could not be written, so nothing was overwritten.";
    case "kept-unreadable":
      // Not "the state changed": a user told that re-syncs and waits for
      // nothing. The honest message is that a file was busy — the sync tool
      // takes short locks on files it is transferring — and a retry in a few
      // seconds is the whole remedy.
      return (
        "The version to keep could not be read just now — your sync tool may be busy with " +
        "that file. Nothing was changed; try again in a few seconds."
      );
    case "unknown-conflict":
      // This outcome cannot tell "already resolved" from "briefly unreadable",
      // so the message claims neither. On the acceptance re-run it confidently
      // said "may already be resolved" over a conflict that was still there,
      // and the user reasonably took a no-op for a success.
      return (
        "That conflict could not be found just now — it may be resolved already, or your " +
        "sync tool briefly locked one of its files. Nothing was changed; reopen this list " +
        "to see its current state."
      );
    default:
      return `Could not resolve it: ${outcome.reason}.`;
  }
}

/**
 * The heading, which has to tell two conflicts of one session apart.
 *
 * It did not, and the acceptance run (r4, F-4) is what that costs. A Grok
 * session is a folder, so one fork produces a conflict per member — and every
 * provider before it had one file per session, which made "session id plus
 * provider" a complete identity. Three conflicts then rendered as three blocks
 * reading `Session 01a03d22 (grok)`, identical down to the buttons: the
 * operator resolved two without being able to tell which two, and reported the
 * third as missing from the panel. It was there.
 *
 * The file name is added only when it does not already identify the session.
 * Claude Code's `<uuid>.jsonl`, Codex's `rollout-<ts>-<uuid>.jsonl` and
 * Claudian's `conv-<id>.meta.json` all carry the id, so for them this is the
 * sentence it always was; Grok's `chat_history.jsonl` does not, so it says so.
 */
export function describeConflict(conflict: ConflictEntry): string {
  // Eight characters is a friendly abbreviation of a uuid and a destructive one
  // of anything else. Claudian's ids are `conv-<epochMs>-<rand>.<kind>`, where
  // the half that says *which file* is at the end — truncating to `conv-178`
  // threw it away and put two conflicts of one conversation under one heading,
  // which is the same failure this function was written to fix, on a different
  // provider (acceptance r5, F-3). So abbreviate only what abbreviates safely.
  const id = SESSION_UUID.test(conflict.logicalId) ? conflict.logicalIdPrefix : conflict.logicalId;
  const file = conflict.neutralRel.slice(conflict.neutralRel.lastIndexOf("/") + 1);
  const named = file.includes(id) ? "" : ` · ${file}`;
  return `Session ${id}${named} (${conflict.providerId})`;
}

/** The one id shape short enough to read and long enough to stay unique at 8. */
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
