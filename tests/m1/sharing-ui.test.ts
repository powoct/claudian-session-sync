/**
 * The repair screen's sentences (ADR-71).
 *
 * Every row here is a fork the pass refused to decide, so the screen's whole
 * job is to make the decision an informed one. Two things must survive any
 * edit: the user is told *which version their other devices are reading* — the
 * reported failure was six records silently frozen for three days — and there
 * is no button that resolves more than one conversation, because these are
 * independent forks and one answer carries no information about the next.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { type FakeElement, Notice, makeStubApp } from "../helpers/obsidian-stub";
import { SharingModal, describePublish } from "../../src/ui/sharing-modal";
import type { PublishOutcome, SharingHold } from "../../src/orchestration/conversation-sharing";
import type { PluginRuntime } from "../../src/orchestration/plugin-runtime";

const asFake = (element: HTMLElement): FakeElement => element as unknown as FakeElement;

const buttonsIn = (root: HTMLElement): FakeElement[] =>
  asFake(root)
    .descendants()
    .filter((node) => node.tag === "button");

/** Fires the handler and lets its async work settle, as a real click would. */
async function click(root: HTMLElement, label: string): Promise<void> {
  const button = buttonsIn(root).find((node) => node.textContent === label);
  if (!button) throw new Error(`no button labelled ${label}`);
  button.dispatch("click");
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const hold = (over: Partial<SharingHold> = {}): SharingHold => ({
  conversationId: "conv-1788190814061-hrrhmqcp6",
  reason: "both copies changed since this machine published",
  devicePath: "/vault/.claudian/sessions/devices/device-ab/conv-1.meta.json",
  deviceSize: 216_814,
  deviceMtimeMs: 1_788_400_000_000,
  sharedPath: "/vault/.claudian/sessions/conv-1.meta.json",
  sharedSize: 97_090,
  sharedMtimeMs: 1_788_200_000_000,
  resolvable: true,
  ...over,
});

const stubRuntime = (holds: readonly SharingHold[], outcome: PublishOutcome = { ok: true }) =>
  ({
    sharingConflicts: async () => [...holds],
    publishSharedRecord: async () => outcome,
  }) as unknown as PluginRuntime;

afterEach(() => {
  Notice.instances.length = 0;
});

describe("the repair screen", () => {
  it("says nothing is wrong, and why the list is normally empty", async () => {
    const modal = new SharingModal(stubRuntime([]), makeStubApp() as unknown as App);
    await modal.onOpen();
    expect(asFake(modal.contentEl).allText()).toContain("Nothing to repair");
  });

  it("shows both versions, so the choice is not made blind", async () => {
    const modal = new SharingModal(stubRuntime([hold()]), makeStubApp() as unknown as App);
    await modal.onOpen();

    const text = asFake(modal.contentEl).allText();
    expect(text).toContain("conv-1788190814061-hrrhmqcp6");
    // The two sizes are the whole point: the reported case was 97 KB shared
    // against 217 KB local, and nothing on screen said so.
    expect(text).toContain("216,814");
    expect(text).toContain("97,090");
    // And which one the other machines are actually reading.
    expect(text).toContain("What your other devices read");
    expect(text).toContain("may be older than what you see here");
  });

  it("promises the replaced version is kept", async () => {
    const modal = new SharingModal(stubRuntime([hold()]), makeStubApp() as unknown as App);
    await modal.onOpen();
    expect(asFake(modal.contentEl).allText()).toContain("copied to your backups first");
  });

  it("offers no button that resolves more than one conversation", async () => {
    // Each row is an independent fork; a "publish all" would apply one
    // decision to N of them. The count is exactly what makes it tempting.
    const modal = new SharingModal(
      stubRuntime([hold(), hold({ conversationId: "conv-2" }), hold({ conversationId: "conv-3" })]),
      makeStubApp() as unknown as App,
    );
    await modal.onOpen();

    const buttons = buttonsIn(modal.contentEl);
    expect(buttons).toHaveLength(3);
    for (const button of buttons) {
      expect(button.textContent).toBe("Publish this device's version");
    }
  });

  it("offers no button for a fork the user cannot resolve this way", async () => {
    const modal = new SharingModal(
      stubRuntime([hold({ resolvable: false })]),
      makeStubApp() as unknown as App,
    );
    await modal.onOpen();
    expect(buttonsIn(modal.contentEl)).toHaveLength(0);
  });

  it("says nothing was overwritten when publishing did not happen", async () => {
    // The refusal has to say what did *not* happen, or the user clicks again.
    const modal = new SharingModal(
      stubRuntime([hold()], { ok: false, reason: "changed-again" }),
      makeStubApp() as unknown as App,
    );
    await modal.onOpen();
    await click(modal.contentEl, "Publish this device's version");

    expect(Notice.instances.at(-1)?.message).toContain("Nothing was overwritten");
  });

  it("tells a busy sync apart from a refusal, because only one is worth retrying", () => {
    // Both used to land on one sentence, and the re-check's reviewer told the
    // next operator not to trust the dialog at all — a screen a careful reader
    // is instructed to disbelieve is a bug, not a wording preference.
    const busy = describePublish({ ok: false, reason: "sync-in-progress" });
    const moved = describePublish({ ok: false, reason: "changed-again" });

    expect(busy).toContain("try again in a moment");
    expect(moved).not.toContain("try again in a moment");
    expect(busy).not.toBe(moved);
    for (const message of [busy, moved]) expect(message).toContain("Nothing was overwritten");
  });

  it("says where the replaced version went when it did", async () => {
    const modal = new SharingModal(stubRuntime([hold()]), makeStubApp() as unknown as App);
    await modal.onOpen();
    await click(modal.contentEl, "Publish this device's version");

    expect(Notice.instances.at(-1)?.message).toContain("in your backups");
  });
});
