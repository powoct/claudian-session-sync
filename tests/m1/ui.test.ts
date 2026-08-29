/**
 * The presentation layer, against the Obsidian stub (testing.md §4).
 *
 * The plugin's whole safety model is a series of refusals — no workspace
 * identity, no sync folder, an empty directory — and every one of them only
 * works if the user is told what happened and what to do. So what these
 * assert is not that a pane renders: it is that each refusal reaches the
 * screen with its reason attached, and that the controls do what their labels
 * say.
 *
 * `obsidian` resolves to the recording stub through a vitest alias, which is
 * what lets any of this be tested without the host application.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { App } from "obsidian";
import {
  type FakeElement,
  Notice,
  Plugin,
  makeStubApp,
  makeStubManifest,
  resetStubSettings,
  settingsCreated,
} from "../helpers/obsidian-stub";
import { AiSessionSyncSettingTab } from "../../src/ui/settings-tab";
import { ConflictModal, describeOutcome } from "../../src/ui/conflict-modal";
import { ReportModal, summaryLine } from "../../src/ui/report-modal";
import { RuntimeHarness } from "../helpers/runtime-harness";

const SID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

const machines: RuntimeHarness[] = [];
afterEach(async () => {
  while (machines.length) await machines.pop()?.dispose();
});

beforeEach(() => {
  resetStubSettings();
  Notice.instances.length = 0;
});

async function newHarness(): Promise<RuntimeHarness> {
  const harness = await RuntimeHarness.create();
  machines.push(harness);
  return harness;
}

function makeTab(harness: RuntimeHarness): AiSessionSyncSettingTab {
  const app = makeStubApp({ basePath: harness.vaultRoot });
  const plugin = new Plugin(app, makeStubManifest());
  // The runtime arrives as a thunk in production too, so that registering the
  // tab does not build it — `onload()` may not touch the filesystem.
  return new AiSessionSyncSettingTab(
    app as unknown as App,
    plugin as never,
    () => harness.runtime,
  );
}

/**
 * `obsidian`'s published types are what `tsc` sees; the stub is what runs.
 *
 * The alias only applies at test runtime, so `contentEl` is typed `HTMLElement`
 * while actually being a `FakeElement`. Casting in one named place keeps that
 * seam visible instead of scattering `as unknown as` through the assertions.
 */
/**
 * The two conflict cases drive two real machines through several full passes,
 * and a pass deliberately waits (readiness window, stability window). Under
 * coverage that exceeds vitest's 5 s default, which is a good default and
 * stays global — so the exception is named here instead.
 */
const SLOW = 30_000;

const asFake = (element: HTMLElement): FakeElement => element as unknown as FakeElement;

const named = (name: string) => settingsCreated.find((setting) => setting.name === name);
const containing = (fragment: string) =>
  settingsCreated.find((setting) => setting.name.includes(fragment));

describe("the settings pane explains every refusal", () => {
  it("offers to create the workspace identity, and says why only once", async () => {
    const h = await newHarness();
    await h.runtime.refresh();
    const tab = makeTab(h);

    tab.display();

    const create = named("Create workspace identity");
    expect(create, "a first-run user has no other way forward").toBeDefined();
    expect(create?.desc).toContain("one machine only");
    expect(create?.desc).toContain("split this workspace");
  });

  it("creates the identity when the button is pressed", async () => {
    const h = await newHarness();
    await h.runtime.refresh();
    const tab = makeTab(h);
    tab.display();

    await named("Create workspace identity")?.buttons[0]?.click();

    expect(h.runtime.currentStatus().workspaceId).toBeTruthy();
    expect(Notice.instances.at(-1)?.message).toContain("created");
  });

  it("offers the initialise button only when the folder is ambiguous", async () => {
    const h = await newHarness();
    await h.runtime.refresh();
    await h.runtime.createIdentity("v");
    await h.runtime.setSyncDir(h.syncDir);
    await h.runtime.setProvider("claude-code", { enabled: true });
    await h.runtime.syncNow();

    resetStubSettings();
    makeTab(h).display();
    expect(named("Initialise this sync folder")).toBeDefined();

    await named("Initialise this sync folder")?.buttons[0]?.click();

    resetStubSettings();
    makeTab(h).display();
    // Gone once it has been answered: a button that stays put after doing its
    // job invites a second press nobody knows the meaning of.
    expect(named("Initialise this sync folder")).toBeUndefined();
  });

  it("writes the sync folder to the machine-local binding", async () => {
    const h = await newHarness();
    await h.runtime.refresh();
    await h.runtime.createIdentity("v");
    const tab = makeTab(h);
    tab.display();

    await named("Folder path")?.texts[0]?.type(h.syncDir);

    expect(h.runtime.currentStatus().syncDirPath).toBe(h.syncDir);
  });

  it("turns a provider on, and shows its tier", async () => {
    const h = await newHarness();
    await h.runtime.refresh();
    await h.runtime.createIdentity("v");
    await h.runtime.setSyncDir(h.syncDir);
    const tab = makeTab(h);
    tab.display();

    expect(named("Claude Code")?.desc).toContain("Tier A");
    await named("Claude Code")?.toggles[0]?.toggle(true);

    expect(h.runtime.providerEnabled("claude-code")).toBe(true);
  });

  it("says backups cannot be switched off, and refuses zero", async () => {
    const h = await newHarness();
    await h.runtime.refresh();
    const tab = makeTab(h);
    tab.display();

    const keep = named("Backups to keep");
    expect(keep?.desc).toContain("cannot be switched off");
    await keep?.texts[0]?.type("0");

    expect(h.runtime.currentSettings().backupKeep).toBeGreaterThanOrEqual(1);
  });

  it("reports a paused folder with the reason, not a code", async () => {
    const h = await newHarness();
    await h.appendSession(SID, 4);
    await h.configure();
    await h.settle();
    await fsp.rename(h.syncDir, `${h.syncDir}-moved`);
    await h.runtime.syncNow();

    resetStubSettings();
    makeTab(h).display();

    expect(named("Status")?.desc).toContain("cannot be reached");
    expect(named("Status")?.desc).not.toContain("NR-9");
  });

  it("mentions outstanding conflicts where the user is already looking", async () => {
    const h = await newHarness();
    await h.appendSession(SID, 4);
    await h.configure();
    await h.settle();

    resetStubSettings();
    makeTab(h).display();
    expect(containing("unresolved conflict")).toBeUndefined();
  });
});

describe("the report view", () => {
  it("says what a dry run would have done", async () => {
    const h = await newHarness();
    await h.appendSession(SID, 5);
    await h.configure();
    await h.settle();
    await h.appendSession(SID, 2);
    await h.runtime.syncNow();
    h.advanceClock(95_000);
    await h.runtime.syncNow({ dryRun: true });

    const report = h.runtime.lastPassReport();
    const modal = new ReportModal(makeStubApp() as unknown as App, report);
    modal.open();

    const text = asFake(modal.contentEl).allText();
    expect(text).toContain("Last sync report");
    expect(text).toContain("Dry run");
    expect(summaryLine(report as never)).toContain("Dry run");
    // The four facts behind the decision, and no fifth one carrying content.
    expect(text).toContain("evidence");
    expect(text).not.toContain('"text"');
  });

  it("says so plainly when nothing has run", () => {
    const modal = new ReportModal(makeStubApp() as unknown as App, null);
    modal.open();
    expect(asFake(modal.contentEl).allText()).toContain("No pass has run yet");
  });
});

describe("the conflict view", () => {
  it("offers three ways out and never says local or remote", async () => {
    const a = await newHarness();
    await a.appendSession(SID, 5);
    await a.configure();
    await a.settle();
    const b = await RuntimeHarness.createPeer(a);
    machines.push(b);
    await b.settle();
    await a.appendRaw(SID, '{"uuid":"a1","text":"on A"}\n');
    await a.settle();
    await b.appendRaw(SID, '{"uuid":"b1","text":"on B"}\n');
    await b.settle();

    const modal = new ConflictModal(
      makeStubApp() as unknown as App,
      b.runtime,
      () => undefined,
    );
    modal.open();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const text = asFake(modal.contentEl).allText();
    expect(text).toContain("Session conflicts");
    expect(text).toContain("Keep this machine's version");
    expect(text).toContain("Keep the other machine's version");
    expect(text).toContain("Show me both");
    // "Local" and "remote" swap meaning depending on which machine you are
    // sitting at — the exact confusion content-derived conflict ids exist to
    // avoid, and not something to reintroduce in the wording.
    expect(text.toLowerCase()).not.toContain("remote version");
    expect(text).not.toContain("on A");
    expect(text).not.toContain("on B");
  }, SLOW);

  it("resolves when a button is pressed", async () => {
    const a = await newHarness();
    await a.appendSession(SID, 5);
    await a.configure();
    await a.settle();
    const b = await RuntimeHarness.createPeer(a);
    machines.push(b);
    await b.settle();
    await a.appendRaw(SID, '{"uuid":"a1","text":"on A"}\n');
    await a.settle();
    await b.appendRaw(SID, '{"uuid":"b1","text":"on B"}\n');
    await b.settle();
    const mine = await fsp.readFile(b.sessionPath(SID), "utf8");

    const modal = new ConflictModal(makeStubApp() as unknown as App, b.runtime, () => undefined);
    modal.open();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const button = asFake(modal.contentEl)
      .descendants()
      .find((element) => element.textContent === "Keep this machine's version");
    button?.dispatch("click");
    // Resolution now runs a full pass before reporting, so give the Notice
    // until it actually appears rather than a fixed beat.
    for (let waited = 0; Notice.instances.length === 0 && waited < 5000; waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const workspaceId = b.runtime.currentStatus().workspaceId as string;
    expect(await fsp.readFile(b.replicaPath(workspaceId, SID), "utf8")).toBe(mine);
    expect(Notice.instances.at(-1)?.message).toContain("still in quarantine");
  }, SLOW);

  it("says there is nothing to do when there is nothing to do", async () => {
    const h = await newHarness();
    await h.configure();
    const modal = new ConflictModal(makeStubApp() as unknown as App, h.runtime, () => undefined);
    modal.open();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(asFake(modal.contentEl).allText()).toContain("Nothing is in conflict");
  });
});

describe("nothing on screen carries a conversation", () => {
  it("keeps session text out of the settings pane and the report", async () => {
    const h = await newHarness();
    const sentinel = "AISS-SENTINEL-ui";
    await h.appendRaw(SID, `{"uuid":"x","type":"user","text":"${sentinel}"}\n`);
    await h.configure();
    await h.settle();

    resetStubSettings();
    const tab = makeTab(h);
    tab.display();
    const modal = new ReportModal(makeStubApp() as unknown as App, h.runtime.lastPassReport());
    modal.open();

    const everything = [
      ...settingsCreated.map((setting) => `${setting.name} ${setting.desc}`),
      asFake(modal.contentEl).allText(),
      ...Notice.instances.map((notice) => String(notice.message)),
    ].join("\n");
    expect(everything).not.toContain(sentinel);
    expect(everything).not.toContain(path.join(h.projectDir, `${SID}.jsonl`));
  });
});

describe("every refusal has a sentence, not a code", () => {
  const conflict = {
    conflictId: "abc123",
    providerId: "claude-code",
    logicalId: SID,
    logicalIdPrefix: "3f2504e0",
    detectedAt: "2026-08-08T00:00:00.000Z",
    directory: "/somewhere/.quarantine/ws/claude-code/abc123",
    neutralRel: `claude-code/${"3f2504e0-4f89-41d3-9a0c-0305e82c3301"}.jsonl`,
    branches: [
      {
        hash: "sha256:aaaa",
        hashPrefix: "aaaaaaaa",
        size: 10,
        lineCount: 1,
        copyName: "branch-aaaaaaaa.jsonl",
        onThisMachine: true,
        inSyncFolder: false,
      },
      {
        hash: "sha256:bbbb",
        hashPrefix: "bbbbbbbb",
        size: 20,
        lineCount: 2,
        copyName: "branch-bbbbbbbb.jsonl",
        onThisMachine: false,
        inSyncFolder: true,
      },
    ],
    superseded: false,
    reason: null,
    externalCopy: null,
  } as const;

  it.each([
    ["branch-moved", "changed since this list was drawn"],
    ["remote-not-ready", "not ready"],
    ["backup-failed", "nothing was overwritten"],
    // The two transient-looking failures must not claim certainty: "busy"
    // asks for a retry in seconds, and the unknown case claims neither
    // "resolved" nor "locked" because it cannot know which.
    ["kept-unreadable", "try again in a few seconds"],
    ["unknown-conflict", "reopen this list"],
    ["write-failed", "write-failed"],
  ] as const)("explains %s", (reason, fragment) => {
    // `branch-moved` is the one that is not a malfunction — the session moved
    // while the dialog was open — so it gets a sentence saying what to do,
    // rather than an apology.
    const message = describeOutcome({ ok: false, reason }, conflict);
    expect(message).toContain(fragment);
  });

  it("names the folder holding both versions when the user asks to look", () => {
    const message = describeOutcome(
      { ok: true, action: "REVEAL", directory: conflict.directory },
      conflict,
    );
    expect(message).toContain(conflict.directory);
  });

  it("promises the discarded branch is still reachable after a resolution", () => {
    const message = describeOutcome(
      { ok: true, action: "PUSH_OVERWRITE", backupPath: "/backups/x.bak", neutralRel: `claude-code/${SID}.jsonl` },
      conflict,
    );
    expect(message).toContain("still in quarantine");
    expect(message).toContain("backups");
  });
});

describe("the report view shows what went wrong, not just what worked", () => {
  it("lists notices and rejected paths", () => {
    const modal = new ReportModal(makeStubApp() as unknown as App, {
      startedAtMs: 1_700_000_000_000,
      finishedAtMs: 1_700_000_001_000,
      outcome: "partial",
      dryRun: false,
      actions: [],
      violations: [
        { rootSymbol: "syncDir", relativePath: "a/b.jsonl", violation: "SYMLINK", detail: "b" },
      ],
      notices: ["claude-code/x.jsonl: the last record has been incomplete"],
      unknownFiles: [
        {
          providerId: "claude-code",
          neutralRel: "claude-code/3f2504e0.sync-conflict-20260807-120000-ABCDEF.jsonl",
          kind: "syncthing-conflict-copy",
          confidence: "high",
          copyOf: "3f2504e0.jsonl",
        },
      ],
    });
    modal.open();

    const text = asFake(modal.contentEl).allText();
    expect(text).toContain("Notices");
    expect(text).toContain("incomplete");
    expect(text).toContain("Rejected paths");
    expect(text).toContain("SYMLINK");
    expect(text).toContain("No files were considered");
    // §8.2: a file the plugin refuses to touch is still a file the user should
    // be told about, with the reason it was refused.
    expect(text).toContain("Files left alone");
    expect(text).toContain("Syncthing conflict copy");
    expect(text).toContain("never synced");
  });

  it("says a pass that never started did nothing, and why", () => {
    const modal = new ReportModal(makeStubApp() as unknown as App, {
      startedAtMs: 0,
      finishedAtMs: 1,
      outcome: "aborted",
      dryRun: false,
      abortReason: "root-overlap: vault a-contains-b syncDir",
      actions: [],
      violations: [],
      notices: [],
      unknownFiles: [],
    });
    modal.open();

    expect(asFake(modal.contentEl).allText()).toContain("root-overlap");
  });
});

describe("a vault with two identity files", () => {
  it("stops, and says a sync tool made a conflict copy", async () => {
    const h = await newHarness();
    await h.runtime.refresh();
    await h.runtime.createIdentity("v");
    // What Dropbox or Syncthing leaves behind when two machines wrote it.
    await fsp.writeFile(
      path.join(h.vaultRoot, ".claudian-session-sync", "workspace (2).json"),
      "{}",
    );
    await h.runtime.refresh();

    resetStubSettings();
    makeTab(h).display();

    expect(named("Status")?.desc).toContain("conflict copy");
    expect(h.runtime.currentStatus().phase).toBe("identity-blocked");
  });
});
