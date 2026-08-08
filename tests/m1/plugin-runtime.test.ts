/**
 * The plugin as a whole, without Obsidian (architecture §4.1, §5.2.3, §9.6.3).
 *
 * These are the paths a user actually walks: install it, find out nothing
 * happens yet, and be told what to do about that. Every one of the three
 * refusals below is deliberate — a workspace identity, a sync folder and an
 * initialised directory are all things the plugin will not invent — so each
 * needs to be a state the user can see and act on rather than silence.
 */
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/domain/settings";
import { RuntimeHarness, sha256 } from "../helpers/runtime-harness";

const SID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

let harness: RuntimeHarness | null = null;
afterEach(async () => {
  await harness?.dispose();
  harness = null;
});

async function makeHarness(): Promise<RuntimeHarness> {
  harness = await RuntimeHarness.create();
  return harness;
}

const read = async (target: string) =>
  new Uint8Array(await fsp.readFile(target).catch(() => Buffer.alloc(0)));

const exists = async (target: string) =>
  fsp
    .stat(target)
    .then(() => true)
    .catch(() => false);

/**
 * Every string value in a JSON file, parsed.
 *
 * Not a substring search over the raw text. A Windows path inside JSON is
 * escaped — `C:\\Users\\…` — so `expect(text).toContain(windowsPath)` fails
 * where it should pass, and worse, `not.toContain` *passes* where it should
 * fail. The second direction is the one that matters: "no absolute path leaked
 * into the vault" is the assertion, and it would have held vacuously on the
 * one platform where paths look different.
 */
async function stringValuesIn(target: string): Promise<string[]> {
  const parsed = JSON.parse(await fsp.readFile(target, "utf8")) as unknown;
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(parsed);
  return out;
}

describe("first run", () => {
  it("asks for a workspace identity before anything else", async () => {
    const h = await makeHarness();
    const status = await h.runtime.refresh();

    expect(status.phase).toBe("identity-required");
    // The reason matters more than the state: the user has to understand that
    // doing this twice is the mistake, not doing it late.
    expect(status.detail).toContain("Create one here on the first machine");
  });

  it("asks for a sync folder once the identity exists", async () => {
    const h = await makeHarness();
    await h.runtime.refresh();
    await h.runtime.createIdentity("test vault");

    const status = h.runtime.currentStatus();
    expect(status.phase).toBe("no-sync-dir");
    expect(status.workspaceId).toBeTruthy();
    // Written into the vault, so it travels with it.
    expect(await exists(path.join(h.vaultRoot, ".ai-session-sync", "workspace.json"))).toBe(true);
  });

  it("refuses to create a second identity over an existing one", async () => {
    // The vault sync delivering the other machine's file between the moment
    // the button was offered and the moment it was pressed is a real race, and
    // winning it by overwriting would split one workspace into two.
    const h = await makeHarness();
    await h.runtime.refresh();
    await h.runtime.createIdentity("first");
    const first = h.runtime.currentStatus().workspaceId;

    const second = await h.runtime.createIdentity("second");

    expect(second.ok).toBe(false);
    expect(h.runtime.currentStatus().workspaceId).toBe(first);
  });

  it("waits for the user before touching an empty sync folder", async () => {
    const h = await makeHarness();
    await h.runtime.refresh();
    await h.runtime.createIdentity("test vault");
    await h.runtime.setSyncDir(h.syncDir);
    await h.runtime.setProvider("claude-code", { enabled: true });
    await h.appendSession(SID, 5);

    const status = await h.runtime.syncNow();

    expect(status.phase).toBe("await-init");
    expect(await fsp.readdir(h.syncDir), "an uninitialised folder receives nothing").toEqual([]);
  });

  it("syncs once everything has been said out loud", async () => {
    const h = await makeHarness();
    await h.appendSession(SID, 8);
    await h.configure();

    const status = await h.settle();

    expect(status.phase).toBe("ready");
    const workspaceId = status.workspaceId as string;
    expect(sha256(await read(h.replicaPath(workspaceId, SID)))).toBe(
      sha256(await read(h.sessionPath(SID))),
    );
  });
});

describe("machine identity", () => {
  it("is created once and reused", async () => {
    const h = await makeHarness();
    await h.runtime.refresh();
    const machineFile = path.join(h.homedir, ".ai-session-sync", "machine.json");
    const first = JSON.parse(await fsp.readFile(machineFile, "utf8")) as { machineId: string };

    await h.runtime.refresh();
    const second = JSON.parse(await fsp.readFile(machineFile, "utf8")) as { machineId: string };

    expect(second.machineId).toBe(first.machineId);
  });

  it("never lands in the vault", async () => {
    // §5.6 rule 1: everything in the vault must survive being copied to
    // another machine, and a machine id is the definition of what does not.
    const h = await makeHarness();
    await h.configure();
    const identityFile = path.join(h.vaultRoot, ".ai-session-sync", "workspace.json");
    const values = await stringValuesIn(identityFile);

    expect(values.some((value) => value.includes(h.homedir))).toBe(false);
    expect(Object.keys(JSON.parse(await fsp.readFile(identityFile, "utf8")))).not.toContain(
      "machineId",
    );
  });
});

describe("settings", () => {
  it("clamps values that would break an invariant", async () => {
    // `backupKeep: 0` is the interesting one. An invariant a user can switch
    // off is not an invariant, so the setting has no way to express it.
    const h = await makeHarness();
    await h.runtime.refresh();

    await h.runtime.updateSettings({ backupKeep: 0, autoIntervalMinutes: -5 });

    expect(h.runtime.currentSettings().backupKeep).toBeGreaterThanOrEqual(1);
    expect(h.runtime.currentSettings().autoIntervalMinutes).toBe(0);
  });

  it("keeps fields written by a newer version", async () => {
    const h = await makeHarness();
    await h.runtime.refresh();
    await h.runtime.updateSettings({ backupKeep: 5 });
    await h.runtime.updateSettings({ maxFileSizeMB: 30 });

    const settings = h.runtime.currentSettings();
    expect(settings.backupKeep).toBe(5);
    expect(settings.maxFileSizeMB).toBe(30);
    expect(settings.logLevel).toBe(DEFAULT_SETTINGS.logLevel);
  });

  it("stores the sync folder per machine, not in the vault", async () => {
    const h = await makeHarness();
    await h.configure();
    const workspaceId = h.runtime.currentStatus().workspaceId as string;

    const binding = await stringValuesIn(
      path.join(h.homedir, ".ai-session-sync", "workspaces", `${workspaceId}.json`),
    );
    expect(binding).toContain(h.syncDir);

    const identity = await stringValuesIn(
      path.join(h.vaultRoot, ".ai-session-sync", "workspace.json"),
    );
    expect(
      identity.some((value) => value.includes(h.syncDir)),
      "an absolute path in the vault breaks the other machine",
    ).toBe(false);
  });
});

describe("providers", () => {
  it("stays off until the user turns it on", async () => {
    // Finding a CLI's directory is not consent to copy its conversations.
    const h = await makeHarness();
    await h.runtime.refresh();
    expect(h.runtime.providerEnabled("claude-code")).toBe(false);

    await h.runtime.createIdentity("v");
    await h.runtime.setSyncDir(h.syncDir);
    await h.runtime.setProvider("claude-code", { enabled: true });

    expect(h.runtime.providerEnabled("claude-code")).toBe(true);
  });

  it("offers a default root and accepts an override", async () => {
    const h = await makeHarness();
    await h.runtime.refresh();
    expect(h.runtime.defaultProviderRoot("claude-code")).toBe(h.providerRoot);
    expect(h.runtime.defaultProviderRoot("nope")).toBeNull();
  });
});

/**
 * Every byte under a directory, as a comparable list.
 *
 * `readdir` alone would only catch files appearing and disappearing; the
 * interesting dry-run failure is a file being *rewritten* with the same name,
 * which is what `observations.json` and `remote.json` do on a real pass.
 */
async function treeDigest(root: string, prefix = ""): Promise<string[]> {
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...(await treeDigest(full, rel)));
    else if (entry.isFile()) {
      const bytes = await fsp.readFile(full);
      out.push(`${rel}:${bytes.length}:${createHash("sha256").update(bytes).digest("hex")}`);
    }
  }
  return out.sort();
}

/** The five trees of testing.md §8.6, for one machine. */
async function fiveTrees(h: RuntimeHarness): Promise<string[]> {
  const roots = [
    ["local", h.providerRoot],
    ["replica", h.syncDir],
    ["state", path.join(h.homedir, ".ai-session-sync")],
    ["vault", path.join(h.vaultRoot, ".ai-session-sync")],
  ] as const;
  const out: string[] = [];
  for (const [name, root] of roots) {
    out.push(...(await treeDigest(root)).map((line) => `${name}/${line}`));
  }
  return out;
}

describe("dry run", () => {
  it("leaves all five trees byte-identical (ADR-27, §8.6)", async () => {
    // "Absolutely read-only" has to have no exceptions to remember, or the
    // promise stops being checkable. Two of them existed: the readiness write
    // probe (writes a file and deletes it — no net change, still a write) and
    // persisting the readiness record (no visible file change, but it moves
    // what the *next* pass decides).
    const h = await makeHarness();
    await h.appendSession(SID, 6);
    await h.configure();
    await h.settle();

    const before = await fiveTrees(h);
    await h.runtime.syncNow({ dryRun: true });
    await h.runtime.syncNow({ dryRun: true });
    const after = await fiveTrees(h);

    expect(after).toEqual(before);
  });

  it("still reports what it would have done", async () => {
    const h = await makeHarness();
    await h.appendSession(SID, 6);
    await h.configure();
    await h.settle();
    await h.appendSession(SID, 3);
    await h.runtime.syncNow();
    h.advanceClock(95_000);

    const before = await fiveTrees(h);
    await h.runtime.syncNow({ dryRun: true });
    const after = await fiveTrees(h);

    const report = h.runtime.lastPassReport();
    expect(report?.dryRun).toBe(true);
    // It decided to push and said so, without pushing.
    expect(report?.actions.map((a) => a.action)).toContain("PUSH_OVERWRITE");
    expect(report?.actions.every((a) => a.result !== "APPLIED")).toBe(true);
    expect(after).toEqual(before);
  });

  it("produces a report and changes nothing", async () => {
    const h = await makeHarness();
    await h.appendSession(SID, 6);
    await h.configure();
    await h.settle(); // reach a state where a pass would actually do something

    await h.appendSession(SID, 3); // …and give it something to do
    await h.runtime.syncNow();
    h.advanceClock(95_000);

    const before = await fsp.readdir(h.syncDir, { recursive: true });
    const status = await h.runtime.syncNow({ dryRun: true });
    const after = await fsp.readdir(h.syncDir, { recursive: true });

    expect(status.phase).toBe("ready");
    const report = h.runtime.lastPassReport();
    expect(report?.dryRun).toBe(true);
    expect(report?.actions.length).toBeGreaterThan(0);
    expect([...after].sort()).toEqual([...before].sort());
  });
});

describe("what the status bar says", () => {
  it("names the count of changes, then goes quiet", async () => {
    const h = await makeHarness();
    await h.appendSession(SID, 4);
    await h.configure();

    // Two passes to reach the one that acts: the first only observes.
    await h.runtime.syncNow();
    h.advanceClock(95_000);
    const acted = await h.runtime.syncNow();
    h.advanceClock(95_000);
    const settled = await h.runtime.syncNow();

    // A loose /change/ would also match "0 changes" — which is what this said
    // for a while, with every push silently failing behind it.
    expect(acted.short).toBe("AI Session Sync: 1 change");
    // And the steady state does not report itself as a count of nothing.
    expect(settled.short).toBe("AI Session Sync: up to date");
  });

  it("explains a folder that has gone missing rather than reporting a number", async () => {
    const h = await makeHarness();
    await h.appendSession(SID, 4);
    await h.configure();
    await h.settle();

    await fsp.rename(h.syncDir, `${h.syncDir}-moved`);
    const status = await h.runtime.syncNow();

    expect(status.phase).toBe("not-ready");
    expect(status.notReadyReason).toBe("NR-9-sync-dir-unreachable");
    expect(status.detail).toContain("cannot be reached");
  });
});
