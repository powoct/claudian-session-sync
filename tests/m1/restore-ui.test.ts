/**
 * The restore screen's sentences (§9.3, §11).
 *
 * These are not cosmetic. The failure this project keeps re-learning — R2-1 —
 * is a user believing something happened that did not, and a restore has two
 * of those built in: an older version of an append-only session gets reverted
 * by the very next sync, and a refusal that says only what went wrong leaves
 * someone clicking the same button again. So every row must say what will
 * follow, and every refusal must say what to do next.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { type FakeElement, Notice, makeStubApp } from "../helpers/obsidian-stub";
import {
  RestoreModal,
  describeRestore,
  describeVersion,
  describeWhatFollows,
} from "../../src/ui/restore-modal";
import type { BackupEntry } from "../../src/orchestration/restore-commands";
import type { PluginRuntime } from "../../src/orchestration/plugin-runtime";

const asFake = (element: HTMLElement): FakeElement => element as unknown as FakeElement;

const entry = (over: Partial<BackupEntry> = {}): BackupEntry => ({
  path: "/home/<user>/.claudian-session-sync/backups/ws/claude-code/s.jsonl.20260816T110000-000Z.00.bak",
  name: "s.jsonl.20260816T110000-000Z.00.bak",
  providerId: "claude-code",
  originalName: "3f2504e0-4f89-41d3-9a0c-0305e82c3301.jsonl",
  takenAtMs: 1_786_000_000_000,
  sizeBytes: 4096,
  lineCount: 40,
  hashPrefix: "a1b2c3d4",
  remote: false,
  action: "PULL_OVERWRITE",
  neutralRel: "claude-code/3f2504e0-4f89-41d3-9a0c-0305e82c3301.jsonl",
  liveRelation: "differs",
  liveHashPrefix: "9f8e7d6c",
  outcome: "will-conflict",
  ...over,
});

const stubRuntime = (backups: readonly BackupEntry[]) =>
  ({
    backups: async () => [...backups],
    backupCount: async () => backups.length,
    restore: async () => ({
      ok: true,
      neutralRel: "claude-code/s.jsonl",
      backupPath: "/b.bak",
      created: false,
    }),
  }) as unknown as PluginRuntime;

afterEach(() => {
  Notice.instances.length = 0;
});

describe("what a row promises before it is clicked", () => {
  it.each([
    // What the write does here...
    ["identical" as const, "nothing" as const, "nothing to put back"],
    ["unknown" as const, "unknown" as const, "nowhere to put it back"],
    ["absent" as const, "will-propagate" as const, "puts the session back"],
    ["differs" as const, "will-conflict" as const, "kept as a new backup first"],
  ])("%s says what the write does", (liveRelation, outcome, fragment) => {
    expect(describeWhatFollows(entry({ liveRelation, outcome }))).toContain(fragment);
  });

  it.each([
    // ...and what the next sync makes of it, which is the half that decides
    // whether the restore lasts and whether it leaves this machine.
    ["nothing" as const, "does nothing"],
    ["will-be-undone" as const, "undoes this"],
    ["will-propagate" as const, "on to your other machines"],
    ["will-conflict" as const, "raises a conflict"],
    ["whole-file" as const, "no way to merge"],
  ])("%s says what the next sync does", (outcome, fragment) => {
    expect(describeWhatFollows(entry({ outcome }))).toContain(fragment);
  });

  it("names the side the next sync will compare against, not the side written", () => {
    // The blocker the design review caught: predicting from the side being
    // written to describes a comparison that never happens.
    expect(describeWhatFollows(entry({ remote: false, outcome: "will-propagate" }))).toContain(
      "the sync folder",
    );
    expect(describeWhatFollows(entry({ remote: true, outcome: "will-propagate" }))).toContain(
      "this machine",
    );
  });

  it("identifies a version by prefix and counts, never by content", () => {
    const text = describeVersion(entry());
    expect(text).toContain("40 lines");
    expect(text).toContain("a1b2c3d4");
    expect(text).toContain("PULL_OVERWRITE");
    // §11.1: an 8-character prefix, and no whole hash anywhere.
    expect(text).not.toMatch(/[0-9a-f]{16}/);
  });

  it("says nothing about the cause when the index could not be read", () => {
    expect(describeVersion(entry({ action: "" }))).not.toContain("before a");
  });
});

describe("every refusal says what to do next", () => {
  it.each([
    ["target-not-located", "copy it by hand"],
    ["remote-not-ready", "can still be restored"],
    ["backup-changed", "Reopen the list"],
    ["backup-unreadable", "try again in a few seconds"],
    ["backup-failed", "nothing was overwritten"],
    ["target-changed", "reopen the list"],
    ["target-exists", "sync landed it first"],
    ["unknown-backup", "Reopen this list"],
  ] as const)("%s", (reason, fragment) => {
    expect(describeRestore({ ok: false, reason }, entry())).toContain(fragment);
  });

  it("tells the user a success is itself reversible", () => {
    const message = describeRestore(
      { ok: true, neutralRel: "claude-code/s.jsonl", backupPath: "/b.bak", created: false },
      entry(),
    );
    expect(message).toContain("reversible");
    expect(message).toContain("a1b2c3d4");
    // The success message repeats what the sync will do, so a restore that is
    // about to be undone says so at the moment it lands, not only before.
    expect(message).toContain("raises a conflict");
  });
});

describe("the list", () => {
  it("offers a restore for a version that differs from what is live", async () => {
    const modal = new RestoreModal(makeStubApp() as unknown as App, stubRuntime([entry()]), () => {});
    await modal.onOpen();

    const text = asFake(modal.contentEl).allText();
    expect(text).toContain("Restore an earlier version");
    expect(text).toContain("raises a conflict");
    expect(text).toContain("Restore this version");
  });

  it("refuses to offer one for a version already on disk, or one with nowhere to go", async () => {
    // A button that would be refused is worse than no button — the same rule
    // the conflict dialog follows for a side that has moved on.
    const modal = new RestoreModal(
      makeStubApp() as unknown as App,
      stubRuntime([
        entry({ liveRelation: "identical", outcome: "nothing" }),
        entry({ neutralRel: null, liveRelation: "unknown", outcome: "unknown" }),
      ]),
      () => {},
    );
    await modal.onOpen();

    const buttons = asFake(modal.contentEl)
      .descendants()
      .filter((element) => element.textContent === "Restore this version");
    expect(buttons.length).toBe(2);
    expect(buttons.every((element) => (element as unknown as { disabled: boolean }).disabled)).toBe(
      true,
    );
  });

  it("says so plainly when nothing has ever been overwritten", async () => {
    const modal = new RestoreModal(makeStubApp() as unknown as App, stubRuntime([]), () => {});
    await modal.onOpen();

    expect(asFake(modal.contentEl).allText()).toContain("no backups yet");
  });
});
