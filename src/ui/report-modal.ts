/**
 * The last pass, shown to the user (architecture §11).
 *
 * A dry run's only output is this view, so it has to say what *would* happen
 * and why — which is why every row carries the four facts the decision rested
 * on rather than a message. The `PassReport` type has nowhere to put a line of
 * conversation (§11.2), so this cannot leak one however it renders.
 */
import { Modal, type App } from "obsidian";
import { describeExternalArtifact } from "../domain/external-artifacts";
import type { ActionEntry, PassReport } from "../orchestration/pass-report";

/** Enough to show the shape of the problem; the rest is a count (§11). */
const MAX_UNKNOWN_SHOWN = 20;

export class ReportModal extends Modal {
  constructor(
    app: App,
    private readonly report: PassReport | null,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Last sync report" });

    if (this.report === null) {
      contentEl.createEl("p", { text: "No pass has run yet in this session." });
      return;
    }

    const report = this.report;
    contentEl.createEl("p", { text: summaryLine(report) });

    if (report.notices.length > 0) {
      contentEl.createEl("h3", { text: "Notices" });
      const list = contentEl.createEl("ul");
      for (const notice of report.notices) list.createEl("li", { text: notice });
    }

    if (report.violations.length > 0) {
      contentEl.createEl("h3", { text: "Rejected paths" });
      const list = contentEl.createEl("ul");
      for (const violation of report.violations) {
        list.createEl("li", {
          text: `${violation.rootSymbol}/${violation.relativePath} — ${violation.violation}${
            violation.detail ? ` (${violation.detail})` : ""
          }`,
        });
      }
    }

    if (report.unknownFiles.length > 0) {
      // Named for what actually happened to them. "Ignored" would be accurate
      // and still wrong: a user who has just noticed a file missing from the
      // other machine reads "ignored" as "the plugin did something to it".
      contentEl.createEl("h3", { text: "Files left alone" });
      const list = contentEl.createEl("ul");
      for (const unknown of report.unknownFiles.slice(0, MAX_UNKNOWN_SHOWN)) {
        list.createEl("li", {
          text: `${unknown.neutralRel} — ${describeExternalArtifact(unknown)}`,
        });
      }
      if (report.unknownFiles.length > MAX_UNKNOWN_SHOWN) {
        list.createEl("li", {
          text: `…and ${report.unknownFiles.length - MAX_UNKNOWN_SHOWN} more.`,
        });
      }
    }

    if (report.unprovenOmissions.length > 0) {
      // Deliberately not "Files left alone" — that heading is about the sync
      // folder and about somebody else's artifacts. This is the CLI's own
      // directory, and the honest thing to say is not "we ignored these" but
      // "these stay here, and we cannot tell you it is safe".
      contentEl.createEl("h3", { text: "Stays on this machine" });
      contentEl.createEl("p", {
        text:
          "These sit inside sessions that are syncing, but they are not carried — and " +
          "unlike the rest, nobody has measured what the other machine loses without them. " +
          "Named so you can ask, not because anything is wrong.",
      });
      const list = contentEl.createEl("ul");
      for (const omission of report.unprovenOmissions.slice(0, MAX_UNKNOWN_SHOWN)) {
        list.createEl("li", {
          text: `${omission.name} (${omission.providerId}) — in ${omission.sessions} session${
            omission.sessions === 1 ? "" : "s"
          }`,
        });
      }
      if (report.unprovenOmissions.length > MAX_UNKNOWN_SHOWN) {
        list.createEl("li", {
          text: `…and ${report.unprovenOmissions.length - MAX_UNKNOWN_SHOWN} more.`,
        });
      }
    }

    if (report.actions.length === 0) {
      contentEl.createEl("p", { text: "No files were considered." });
      return;
    }

    contentEl.createEl("h3", { text: "Files" });
    const table = contentEl.createEl("table");
    const header = table.createEl("tr");
    for (const label of ["Session", "Action", "Result", "Why"]) {
      header.createEl("th", { text: label });
    }
    for (const action of report.actions) {
      const row = table.createEl("tr");
      row.createEl("td", { text: action.logicalIdPrefix });
      row.createEl("td", { text: action.action });
      row.createEl("td", { text: action.result });
      row.createEl("td", { text: explain(action) });
    }
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

export function summaryLine(report: PassReport): string {
  const when = new Date(report.finishedAtMs).toLocaleString();
  const took = report.finishedAtMs - report.startedAtMs;
  const mode = report.dryRun ? "Dry run" : "Sync";
  if (report.outcome === "aborted") {
    return `${mode} at ${when}: did nothing (${report.abortReason ?? "aborted"}).`;
  }
  return `${mode} at ${when}: ${report.outcome}, ${report.actions.length} file(s), ${took} ms.`;
}

/**
 * The four-tuple of §11, in one line.
 *
 * Sizes, line counts, evidence tier and hash *prefixes* only. Enough to audit
 * a decision — "it thought these two were the same file and here is what it
 * compared" — and never enough to read one.
 */
function explain(action: ActionEntry): string {
  const parts = [action.reason, `evidence ${action.evidence.level}`, action.evidence.relation];
  if (action.evidence.localLines !== null || action.evidence.remoteLines !== null) {
    parts.push(`lines ${action.evidence.localLines ?? "?"}/${action.evidence.remoteLines ?? "?"}`);
  }
  if (action.evidence.localHashPrefix || action.evidence.remoteHashPrefix) {
    parts.push(
      `hash ${action.evidence.localHashPrefix ?? "?"}/${action.evidence.remoteHashPrefix ?? "?"}`,
    );
  }
  if (action.flags.length > 0) parts.push(action.flags.join(","));
  if (action.backupPath) parts.push("backed up");
  if (action.noReplaceUnavailable) parts.push("no-replace unavailable");
  return parts.join(" · ");
}
