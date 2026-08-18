/**
 * §9.3.4 — the backups have to be findable, and "show me" has to show.
 *
 * The section is titled "M1 最小可用性" and lists four things; three shipped and
 * this one did not. Its absence had the same shape as the bug this project
 * keeps re-learning: a button labelled "Show me the folder" that only printed
 * a path, and a resolution's "Show me both" that did the same — small
 * versions of R2-1, where the interface claims an action it did not perform.
 *
 * So there are two assertions per surface: it asks the desktop to open the
 * right directory, and when the desktop refuses it says so rather than
 * repeating the success wording.
 */
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { type FakeElement, Notice, makeStubApp } from "../helpers/obsidian-stub";
import { RestoreModal } from "../../src/ui/restore-modal";
import { ConflictModal } from "../../src/ui/conflict-modal";
import type { BackupEntry } from "../../src/orchestration/restore-commands";
import type { ConflictEntry } from "../../src/orchestration/conflict-commands";
import type { PluginRuntime } from "../../src/orchestration/plugin-runtime";
import { RuntimeHarness } from "../helpers/runtime-harness";

const asFake = (element: HTMLElement): FakeElement => element as unknown as FakeElement;
const SID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

const machines: RuntimeHarness[] = [];
afterEach(async () => {
  Notice.instances.length = 0;
  while (machines.length) await machines.pop()?.dispose();
});

const backupEntry: BackupEntry = {
  path: "/backups/ws/claude-code/s.jsonl.20260816T110000-000Z.00.bak",
  name: "s.jsonl.20260816T110000-000Z.00.bak",
  providerId: "claude-code",
  originalName: `${SID}.jsonl`,
  takenAtMs: 1_786_000_000_000,
  sizeBytes: 4096,
  lineCount: 40,
  hashPrefix: "a1b2c3d4",
  remote: false,
  action: "PULL_OVERWRITE",
  neutralRel: `claude-code/${SID}.jsonl`,
  liveRelation: "differs",
  liveHashPrefix: "9f8e7d6c",
  outcome: "will-conflict",
};

const conflictEntry = {
  conflictId: "abc123",
  providerId: "claude-code",
  logicalId: SID,
  logicalIdPrefix: SID.slice(0, 8),
  detectedAt: "2026-08-16T00:00:00.000Z",
  directory: "/replica/.quarantine/ws/claude-code/abc123",
  neutralRel: `claude-code/${SID}.jsonl`,
  branches: [
    {
      hash: "sha256:aa",
      hashPrefix: "aaaaaaaa",
      size: 10,
      lineCount: 1,
      copyName: "branch-aaaaaaaa.jsonl",
      onThisMachine: true,
      inSyncFolder: false,
    },
  ],
  superseded: false,
} as ConflictEntry;

function stubRuntime(opened: string[], succeeds: boolean) {
  return {
    backups: async () => [backupEntry],
    conflicts: async () => [conflictEntry],
    reveal: async (target: string) => {
      opened.push(target);
      return succeeds;
    },
    resolve: async () => ({ ok: true, action: "REVEAL", directory: conflictEntry.directory }),
  } as unknown as PluginRuntime;
}

const click = (element: HTMLElement, label: string) => {
  const button = asFake(element)
    .descendants()
    .find((node) => node.textContent === label);
  expect(button, `no button labelled ${label}`).toBeTruthy();
  (button as unknown as { dispatch(event: string): void }).dispatch("click");
};

describe("the restore list's folder button", () => {
  it("asks the desktop to open the directory the backup is in", async () => {
    const opened: string[] = [];
    const modal = new RestoreModal(makeStubApp() as unknown as App, stubRuntime(opened, true), () => {});
    await modal.onOpen();

    click(modal.contentEl, "Show me the folder");
    await Promise.resolve();
    await Promise.resolve();

    // The folder, not the file: this is where the user goes looking.
    expect(opened).toEqual(["/backups/ws/claude-code"]);
  });

  it("says it could not open it, rather than repeating the success wording", async () => {
    const opened: string[] = [];
    const modal = new RestoreModal(makeStubApp() as unknown as App, stubRuntime(opened, false), () => {});
    await modal.onOpen();

    click(modal.contentEl, "Show me the folder");
    await Promise.resolve();
    await Promise.resolve();

    expect(Notice.instances.at(-1)?.message).toContain("Could not open it");
    // And still says where it is, because that is what the user needs.
    expect(Notice.instances.at(-1)?.message).toContain(backupEntry.path);
  });
});

describe("the conflict dialog's “show me both”", () => {
  it("opens the quarantine directory instead of only naming it", async () => {
    const opened: string[] = [];
    const modal = new ConflictModal(makeStubApp() as unknown as App, stubRuntime(opened, true), () => {});
    await modal.onOpen();

    click(modal.contentEl, "Show me both");
    for (let i = 0; i < 8; i++) await Promise.resolve();

    expect(opened).toEqual([conflictEntry.directory]);
  });
});

describe("the backups folder, from the command palette and the settings panel", () => {
  it("points at this workspace's own backup root", async () => {
    const machine = await RuntimeHarness.create();
    machines.push(machine);
    await machine.configure();

    const dir = await machine.runtime.backupsDir();
    const status = await machine.runtime.refresh();

    expect(dir).toBe(
      path.join(machine.homedir, ".claudian-session-sync", "backups", status.workspaceId as string),
    );
    expect(await machine.runtime.reveal(dir as string)).toBe(true);
    expect(machine.opened).toEqual([dir]);
  }, 30_000);

  it("has nowhere to point before the vault has an identity", async () => {
    // Absence stated as a fact about configuration, not as "no backups".
    const machine = await RuntimeHarness.create();
    machines.push(machine);

    expect(await machine.runtime.backupsDir()).toBeNull();
  });
});
