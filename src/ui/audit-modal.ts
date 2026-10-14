/**
 * The sync folder audit (ADR-81, H8): three lists, and no button that acts on
 * them.
 *
 * Deliberately read-only. The question it answers — "what is in the sync
 * folder that this vault does not list any more" — is one people ask in order
 * to clean up, and every answer it can give is ambiguous in a way that makes
 * a delete button the wrong tool: a session with no record here may be
 * another device's, or one whose record has not arrived. So it measures,
 * labels, and says why removing files by hand is worse than it looks.
 */
import { Modal, type App } from "obsidian";
import type { PluginRuntime } from "../orchestration/plugin-runtime";
import type { AuditSession, SyncFolderAudit, Whereabouts } from "../orchestration/sync-folder-audit";

const HERE_TEXT: Record<Whereabouts, string> = {
  here: "also on this device",
  "archived-here": "on this device, archived",
  "not-here": "not on this device",
};

export class AuditModal extends Modal {
  constructor(
    private readonly runtime: PluginRuntime,
    app: App,
  ) {
    super(app);
  }

  override async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "What the sync folder holds" });

    const outcome = await this.runtime.auditSyncFolder();
    if (!outcome.ok) {
      contentEl.createEl("p", {
        text:
          outcome.reason === "unreachable"
            ? "The sync folder cannot be reached right now, so there is nothing to look at."
            : "This vault's sync is not set up, so there is no sync folder to look at.",
      });
      return;
    }
    render(contentEl, outcome.audit);
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

function render(el: HTMLElement, audit: SyncFolderAudit): void {
  el.createEl("p", {
    text:
      "Nothing here is deleted, and nothing on this screen deletes. This plugin never removes files " +
      "from the sync folder: a deletion stays on the device that made it. Removing files from the " +
      "sync folder yourself is riskier than it looks — every device pauses syncing when the folder " +
      "holds fewer files than before, and stays paused until they are back; a device that still has " +
      "a session copies it back; and a device that has not received a session yet loses its only copy.",
  });
  if (audit.unreadDirs.length > 0) {
    el.createEl("p", {
      text:
        `Some folders in the sync folder could not be read (${audit.unreadDirs.slice(0, 3).join(", ")}` +
        `${audit.unreadDirs.length > 3 ? ` and ${audit.unreadDirs.length - 3} more` : ""}), so the lists ` +
        "below may be missing sessions.",
    });
  }

  section(el, "Deleted on this device", audit.held.length);
  el.createEl("p", {
    cls: "setting-item-description",
    text:
      "Conversations you deleted here that the sync folder still carries, with the history files " +
      "their records name there. Your other devices still have them, and a new device would still " +
      "receive them.",
  });
  if (audit.held.length === 0) el.createEl("p", { text: "None." });
  for (const held of audit.held) {
    const row = el.createDiv({ cls: "aiss-audit-row" });
    row.createEl("div", { text: `${held.title ?? "(untitled)"} — ${formatBytes(held.totalBytes)}` });
    row.createEl("div", {
      cls: "setting-item-description",
      text:
        `${held.conversationId} · ${held.kind === "deleted-here" ? "deleted here" : "deleted with a deletion marker"} ` +
        `· since ${new Date(held.sinceMs).toLocaleString()}` +
        (held.recordProvider === null ? " · its record could not be read" : ` · ${held.recordProvider}`),
    });
    if (held.sessions.length === 0) {
      row.createEl("div", { cls: "setting-item-description", text: "No history files for it in the sync folder." });
    }
    for (const session of held.sessions) sessionLine(row, session);
  }
  if (audit.heldNotInFolder > 0) {
    el.createEl("p", {
      cls: "setting-item-description",
      text: `${audit.heldNotInFolder} more deleted here are no longer in the sync folder at all.`,
    });
  }

  section(el, "In the sync folder, with no record in this vault", audit.unrecorded.length);
  el.createEl("p", {
    cls: "setting-item-description",
    text:
      "Do not take this list as permission to delete. A session ends up here without a record when it " +
      "was deleted, when its record has not reached this vault yet, when its record is in another " +
      "device's folder this vault has not received, when it was started from a terminal, or when " +
      "Claudian cleared its id — and nothing on disk tells those apart." +
      (audit.storeFound
        ? ""
        : " This vault has no .claudian/sessions folder at all, which on its own puts every session here."),
  });
  if (audit.unrecorded.length === 0) el.createEl("p", { text: "None." });
  for (const session of audit.unrecorded) {
    const row = el.createDiv({ cls: "aiss-audit-row" });
    sessionLine(row, session);
  }

  section(el, "Only in .claude/sessions", audit.legacyOnly.length);
  el.createEl("p", {
    cls: "setting-item-description",
    text:
      "Records in the folder Claudian used before .claudian/sessions. Claudian 2.3.6 and later no " +
      "longer read it, so these conversations are not listed in Claudian. The CLI can still resume " +
      "one from a terminal in this vault by the session id shown.",
  });
  if (audit.legacyOnly.length === 0) el.createEl("p", { text: "None." });
  for (const record of audit.legacyOnly) {
    const row = el.createDiv({ cls: "aiss-audit-row" });
    row.createEl("div", { text: record.title ?? "(untitled)" });
    row.createEl("div", {
      cls: "setting-item-description",
      text:
        `${record.conversationId} · ${record.folder}` +
        (record.recordProvider === null ? " · could not be read" : ` · ${record.recordProvider}`) +
        (record.sessionId === null ? " · no session id" : ` · session ${record.sessionId}`),
    });
  }
}

function section(el: HTMLElement, title: string, count: number): void {
  el.createEl("h3", { text: `${title} (${count})` });
}

function sessionLine(el: HTMLElement, session: AuditSession): void {
  el.createEl("div", {
    cls: "setting-item-description",
    text:
      `${session.providerId} · ${session.sessionId} · ${session.files.length} file(s), ` +
      `${formatBytes(session.totalBytes)} · last changed ${new Date(session.newestMs).toLocaleString()} · ` +
      HERE_TEXT[session.here],
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
