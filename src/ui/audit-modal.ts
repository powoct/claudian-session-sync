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
  unchecked: "not checked on this device — its provider is off here",
};

export class AuditModal extends Modal {
  private closed = false;

  constructor(
    private readonly runtime: PluginRuntime,
    app: App,
  ) {
    super(app);
  }

  override async onOpen(): Promise<void> {
    const { contentEl } = this;
    this.closed = false;
    contentEl.empty();
    contentEl.createEl("h2", { text: "What the sync folder holds" });
    // A large sync folder on a network or cloud drive takes a while to walk.
    contentEl.createEl("p", { text: "Measuring the sync folder…" });

    const outcome = await this.runtime.auditSyncFolder();
    if (this.closed) return;
    contentEl.empty();
    contentEl.createEl("h2", { text: "What the sync folder holds" });
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
    this.closed = true;
    this.contentEl.empty();
  }
}

function render(el: HTMLElement, audit: SyncFolderAudit): void {
  el.createEl("p", {
    text:
      "Nothing here is deleted, and nothing on this screen deletes. This plugin never removes files " +
      "from the sync folder: a deletion stays on the device that made it. Removing files from the sync " +
      "folder yourself does less, or more, than it looks. Remove a few, and any device that still has " +
      "those sessions copies them straight back. Remove more than a few — more than three files and more " +
      "than a tenth of them, or more than a quarter of the bytes — and every device that had seen them " +
      "stops syncing with \"fewer files than before\" and writes nothing until they are put back by hand. " +
      "And a device that has not received a session yet loses its only copy.",
  });
  if (audit.unreadDirs.length > 0) {
    el.createEl("p", {
      text:
        `Some folders in the sync folder could not be read (${audit.unreadDirs.slice(0, 3).join(", ")}` +
        `${audit.unreadDirs.length > 3 ? ` and ${audit.unreadDirs.length - 3} more` : ""}), so the lists ` +
        "below may be missing sessions.",
    });
  }

  section(el, "Kept off this device", audit.held.length);
  el.createEl("p", {
    cls: "setting-item-description",
    text:
      "Conversations this device keeps off itself that the sync folder still carries, with the history " +
      "files their records name there. Ones marked \"deleted here\" were deleted on this device; unless " +
      "you deleted them on your other devices too, those still have them. Ones marked \"removed by a " +
      "deletion marker\" were deleted on another device, by a Claudian 2.3.2 or older, which left the " +
      "marker. A new device would still receive either kind.",
  });
  if (audit.deletedHere === "records-provider-off") {
    el.createEl("p", {
      text:
        "This device keeps track of conversations deleted here only while the conversation-records " +
        "provider is on, and it is off. Any deleted here since then are not in this list; their history " +
        "is in the next one.",
    });
  } else if (audit.deletedHere === "unreadable") {
    el.createEl("p", {
      text:
        "This device's memory of conversations deleted here could not be read, so this list may be " +
        "missing some; their history is in the next one.",
    });
  } else if (audit.held.length === 0) {
    el.createEl("p", { text: "None." });
  }
  for (const held of audit.held) {
    const row = el.createDiv({ cls: "aiss-audit-row" });
    row.createEl("div", { text: `${held.title ?? "(untitled)"} — ${formatBytes(held.totalBytes)}` });
    row.createEl("div", {
      cls: "setting-item-description",
      text:
        `${held.conversationId} · ${held.kind === "deleted-here" ? "deleted here" : "removed by a deletion marker"} ` +
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
      text: `${audit.heldNotInFolder} more kept off this device are no longer in the sync folder at all.`,
    });
  }

  section(el, "In the sync folder, with no record in this vault", audit.unrecorded.length);
  el.createEl("p", {
    cls: "setting-item-description",
    text:
      "Do not take this list as permission to delete. A session ends up here without a record when it " +
      "was deleted, when its record has not reached this vault yet, when its record is in another " +
      "device's folder this vault has not received, or when it was started from a terminal — and " +
      "nothing on disk tells those apart." +
      (audit.storeFound
        ? ""
        : " This vault has no .claudian/sessions folder, so only records in .claude/sessions, if any, count."),
  });
  if (audit.recordsUnread > 0) {
    el.createEl("p", {
      text:
        `${audit.recordsUnread} of this vault's record folders or records could not be read (or were ` +
        "larger than Max file size), so this list may include sessions they name.",
    });
  }
  if (audit.unrecorded.length === 0) el.createEl("p", { text: "None." });
  for (const session of audit.unrecorded) {
    const row = el.createDiv({ cls: "aiss-audit-row" });
    sessionLine(row, session);
  }

  section(el, "Only in .claude/sessions", audit.legacyOnly.length);
  el.createEl("p", {
    cls: "setting-item-description",
    text:
      "Records in the folder Claudian used before .claudian/sessions. " +
      (audit.legacyStillListed === true
        ? "Your Claudian still lists these; Claudian 2.3.6 and later stop. "
        : audit.legacyStillListed === false
          ? "Your Claudian (2.3.6 or later) no longer reads that folder, so these are not listed in it. "
          : "Claudian 2.3.6 and later no longer read that folder, so if yours is one of them, these are not " +
            "listed in it. ") +
      "The CLI can still resume one from a terminal in this vault by the session id shown.",
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
