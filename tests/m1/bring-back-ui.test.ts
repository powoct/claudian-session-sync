/**
 * The bring-back screen (ADR-78): what is ticked before anyone touches it.
 *
 * Only deletions start ticked. A record that moved into a device folder is
 * still listed in Claudian under that device, and bringing its shared copy
 * back gives that device's Claudian two records for one conversation; a
 * record an older Claudian's deletion marker removed was deleted on purpose.
 * Both are offered, neither is assumed — and "Bring back" with the defaults
 * must act on the deletions alone.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { type FakeElement, Notice, makeStubApp } from "../helpers/obsidian-stub";
import { BringBackModal } from "../../src/ui/bring-back-modal";
import type { HeldRecordView, PluginRuntime } from "../../src/orchestration/plugin-runtime";

const asFake = (element: HTMLElement): FakeElement => element as unknown as FakeElement;

const held = (kind: HeldRecordView["kind"], n: number): HeldRecordView => ({
  neutralRel: `claudian/conv-178642268789${n}-abc${n}.meta.json`,
  conversationId: `conv-178642268789${n}-abc${n}`,
  kind,
  sinceMs: 1_788_000_000_000 + n,
  releaseRequested: false,
  title: `title ${n}`,
});

afterEach(() => {
  Notice.instances.length = 0;
});

describe("the bring-back screen", () => {
  it("ticks deletions only, and brings back only what is ticked", async () => {
    const asked: string[][] = [];
    const runtime = {
      heldRecords: async () => [held("deleted-here", 1), held("moved-to-device", 2), held("removed-by-tombstone", 3)],
      bringBack: async (rels: readonly string[]) => {
        asked.push([...rels]);
        return { ok: true } as const;
      },
    } as unknown as PluginRuntime;
    const modal = new BringBackModal(runtime, makeStubApp() as unknown as App);
    await modal.onOpen();

    const nodes = asFake(modal.contentEl).descendants();
    const boxes = nodes.filter((node) => node.tag === "input");
    expect(boxes.map((box) => box.checked)).toEqual([true, false, false]);

    const button = nodes.find((node) => node.tag === "button");
    button?.dispatch("click");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(asked).toEqual([[held("deleted-here", 1).neutralRel]]);
  });

  it("says why nothing happened when the provider is off", async () => {
    const runtime = {
      heldRecords: async () => [held("deleted-here", 1)],
      bringBack: async () => ({ ok: false, reason: "provider-off" }) as const,
    } as unknown as PluginRuntime;
    const modal = new BringBackModal(runtime, makeStubApp() as unknown as App);
    await modal.onOpen();
    asFake(modal.contentEl).descendants().find((node) => node.tag === "button")?.dispatch("click");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(String(Notice.instances.at(-1)?.message)).toContain("is off on this device");
  });
});
