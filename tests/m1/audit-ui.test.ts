/**
 * The sync folder audit screen (ADR-81, H8): it lists and it labels, and it
 * offers nothing to click. A delete button is the one thing this screen must
 * never grow — every list on it is ambiguous in a way that makes removing
 * files the wrong move (see `sync-folder-audit.ts`).
 */
import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { type FakeElement, makeStubApp } from "../helpers/obsidian-stub";
import { AuditModal } from "../../src/ui/audit-modal";
import type { AuditOutcome, PluginRuntime } from "../../src/orchestration/plugin-runtime";
import type { SyncFolderAudit } from "../../src/orchestration/sync-folder-audit";

const asFake = (element: HTMLElement): FakeElement => element as unknown as FakeElement;

const session = (providerId: string, sessionId: string, here: "here" | "archived-here" | "not-here") => ({
  providerId,
  sessionId,
  files: [{ neutralRel: `${providerId}/${sessionId}.jsonl`, sizeBytes: 2048 }],
  totalBytes: 2048,
  newestMs: 1_788_000_000_000,
  here,
});

const AUDIT: SyncFolderAudit = {
  storeFound: true,
  held: [
    {
      conversationId: "conv-1786422687897-15ktes7p9",
      kind: "deleted-here",
      sinceMs: 1_788_000_000_000,
      title: "Plan the trip",
      recordProvider: "claude",
      sessions: [session("claude-code", "11111111-1111-4111-8111-111111111111", "here")],
      totalBytes: 2048,
    },
  ],
  heldNotInFolder: 1,
  unrecorded: [session("codex", "01a003f8-172e-7421-b159-ee512a76e87d", "archived-here")],
  legacyOnly: [
    {
      conversationId: "conv-1786422687899-3abcdefgh",
      folder: ".claude/sessions",
      title: "Old one",
      recordProvider: "claude",
      sessionId: "33333333-3333-4333-8333-333333333333",
    },
  ],
  unreadDirs: [],
};

async function open(outcome: AuditOutcome): Promise<FakeElement[]> {
  const runtime = { auditSyncFolder: async () => outcome } as unknown as PluginRuntime;
  const modal = new AuditModal(runtime, makeStubApp() as unknown as App);
  await modal.onOpen();
  return asFake(modal.contentEl).descendants();
}

const text = (nodes: FakeElement[]) => nodes.map((node) => node.textContent).join("\n");

describe("the sync folder audit screen", () => {
  it("shows all three lists, and has no button, checkbox or link to act with", async () => {
    const nodes = await open({ ok: true, audit: AUDIT });
    expect(nodes.filter((node) => ["button", "input", "a"].includes(node.tag))).toEqual([]);
    const shown = text(nodes);
    expect(shown).toContain("Deleted on this device (1)");
    expect(shown).toContain("Plan the trip — 2.0 KB");
    expect(shown).toContain("1 more deleted here are no longer in the sync folder");
    expect(shown).toContain("In the sync folder, with no record in this vault (1)");
    expect(shown).toContain("on this device, archived");
    expect(shown).toContain("Do not take this list as permission to delete.");
    expect(shown).toContain("Only in .claude/sessions (1)");
    expect(shown).toContain("session 33333333-3333-4333-8333-333333333333");
  });

  it("says why removing files by hand is riskier than it looks", async () => {
    const shown = text(await open({ ok: true, audit: AUDIT }));
    expect(shown).toContain("nothing on this screen deletes");
    expect(shown).toContain("every device pauses syncing");
  });

  it("explains an empty store rather than letting every session look orphaned", async () => {
    const shown = text(await open({ ok: true, audit: { ...AUDIT, storeFound: false } }));
    expect(shown).toContain("no .claudian/sessions folder at all");
  });

  it("says when there is no sync folder to look at", async () => {
    expect(text(await open({ ok: false, reason: "unreachable" }))).toContain("cannot be reached");
    expect(text(await open({ ok: false, reason: "not-set-up" }))).toContain("not set up");
  });
});
