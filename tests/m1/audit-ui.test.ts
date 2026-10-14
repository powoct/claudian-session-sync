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
import type { SyncFolderAudit, Whereabouts } from "../../src/orchestration/sync-folder-audit";

const asFake = (element: HTMLElement): FakeElement => element as unknown as FakeElement;

const session = (providerId: string, sessionId: string, here: Whereabouts) => ({
  providerId,
  sessionId,
  files: [{ neutralRel: `${providerId}/${sessionId}.jsonl`, sizeBytes: 2048 }],
  totalBytes: 2048,
  newestMs: 1_788_000_000_000,
  here,
});

const AUDIT: SyncFolderAudit = {
  storeFound: true,
  recordsUnread: 0,
  deletedHere: "tracked",
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
    {
      conversationId: "conv-1786422687898-2abcdefgh",
      kind: "removed-by-tombstone",
      sinceMs: 1_788_000_000_000,
      title: "Marked",
      recordProvider: "codex",
      sessions: [],
      totalBytes: 0,
    },
  ],
  heldNotInFolder: 1,
  unrecorded: [
    session("codex", "01a003f8-172e-7421-b159-ee512a76e87d", "archived-here"),
    session("grok", "55555555-5555-4555-8555-555555555555", "unchecked"),
  ],
  legacyOnly: [
    {
      conversationId: "conv-1786422687899-3abcdefgh",
      folder: ".claude/sessions",
      title: "Old one",
      recordProvider: "claude",
      sessionId: "33333333-3333-4333-8333-333333333333",
    },
  ],
  legacyStillListed: false,
  unreadDirs: [],
};

async function open(outcome: AuditOutcome): Promise<FakeElement[]> {
  const runtime = { auditSyncFolder: async () => outcome } as unknown as PluginRuntime;
  const modal = new AuditModal(runtime, makeStubApp() as unknown as App);
  await modal.onOpen();
  return asFake(modal.contentEl).descendants();
}

const text = (nodes: FakeElement[]) => nodes.map((node) => node.textContent).join("\n");
const shown = async (audit: Partial<SyncFolderAudit>) => text(await open({ ok: true, audit: { ...AUDIT, ...audit } }));

describe("the sync folder audit screen", () => {
  it("shows all three lists, and has no button, checkbox or link to act with", async () => {
    const nodes = await open({ ok: true, audit: AUDIT });
    expect(nodes.filter((node) => ["button", "input", "a"].includes(node.tag))).toEqual([]);
    const all = text(nodes);
    expect(all).toContain("Kept off this device (2)");
    expect(all).toContain("Plan the trip — 2.0 KB");
    expect(all).toContain("conv-1786422687897-15ktes7p9 · deleted here");
    expect(all).toContain("conv-1786422687898-2abcdefgh · removed by a deletion marker");
    expect(all).toContain("1 more kept off this device are no longer in the sync folder at all");
    expect(all).toContain("In the sync folder, with no record in this vault (2)");
    expect(all).toContain("on this device, archived");
    expect(all).toContain("not checked on this device — its provider is off here");
    expect(all).toContain("Do not take this list as permission to delete.");
    expect(all).toContain("Only in .claude/sessions (1)");
    expect(all).toContain("session 33333333-3333-4333-8333-333333333333");
    expect(all).not.toContain("Measuring");
  });

  it("says what removing files by hand really does — a few come back, more stop every device", async () => {
    const all = await shown({});
    expect(all).toContain("nothing on this screen deletes");
    expect(all).toContain("copies them straight back");
    expect(all).toContain("more than three files and more than a tenth of them, or more than a quarter of the bytes");
    expect(all).toContain("writes nothing until they are put back by hand");
  });

  it("does not say a deletion-marker row was deleted here, or that other devices surely have it", async () => {
    const all = await shown({});
    expect(all).toContain("unless you deleted them on your other devices too");
    expect(all).toContain("deleted on another device, by a Claudian 2.3.2 or older");
  });

  it("says why list ① may be empty, instead of a bare \"None.\"", async () => {
    const off = await shown({ held: [], heldNotInFolder: 0, deletedHere: "records-provider-off" });
    expect(off).toContain("only while the conversation-records provider is on, and it is off");
    const unreadable = await shown({ held: [], heldNotInFolder: 0, deletedHere: "unreadable" });
    expect(unreadable).toContain("memory of conversations deleted here could not be read");
    expect(await shown({ held: [], heldNotInFolder: 0 })).toMatch(/Kept off this device \(0\)[\s\S]*None\./);
  });

  it("says when records or folders could not be read, so the lists may be incomplete", async () => {
    const all = await shown({ recordsUnread: 2, unreadDirs: ["codex/2026/"] });
    expect(all).toContain("2 of this vault's record folders or records could not be read");
    expect(all).toContain("Some folders in the sync folder could not be read (codex/2026/)");
  });

  it("explains a missing store rather than letting every session look orphaned", async () => {
    expect(await shown({ storeFound: false })).toContain("This vault has no .claudian/sessions folder");
  });

  it("words list ③ for the Claudian installed", async () => {
    expect(await shown({ legacyStillListed: true })).toContain("Your Claudian still lists these");
    expect(await shown({ legacyStillListed: false })).toContain("no longer reads that folder, so these are not listed");
    expect(await shown({ legacyStillListed: null })).toContain("if yours is one of them");
  });

  it("says when there is no sync folder to look at", async () => {
    expect(text(await open({ ok: false, reason: "unreachable" }))).toContain("cannot be reached");
    expect(text(await open({ ok: false, reason: "not-set-up" }))).toContain("not set up");
  });

  it("says it is measuring while it does, and draws nothing into a screen closed meanwhile", async () => {
    let resolve: (outcome: AuditOutcome) => void = () => undefined;
    const runtime = {
      auditSyncFolder: () => new Promise<AuditOutcome>((done) => (resolve = done)),
    } as unknown as PluginRuntime;
    const modal = new AuditModal(runtime, makeStubApp() as unknown as App);
    const opening = modal.onOpen();
    expect(text(asFake(modal.contentEl).descendants())).toContain("Measuring the sync folder…");
    modal.onClose();
    resolve({ ok: true, audit: AUDIT });
    await opening;
    expect(text(asFake(modal.contentEl).descendants())).not.toContain("Kept off this device");
  });
});
