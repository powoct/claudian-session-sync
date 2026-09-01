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
const OTHER_SID = "2b631f15-c463-4c0c-b66e-e6b04835aa8a";

/**
 * The exception `conflict-commands.test.ts` states, applied here too.
 *
 * A case that drives a pass drives a real one: three passes per `settle()`,
 * over a real filesystem, under coverage instrumentation. Vitest's 5 s default
 * is a good default and stays global — but on the two-core Windows runner the
 * slowest case in a *passing* run finished 105 ms inside it, which is not a
 * margin, it is luck. Past that point the default no longer reports a bug, it
 * reports how busy the machine was. So every pass-driving case carries this,
 * and a case without it is a case that is genuinely quick.
 */
const SLOW = 30_000;

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
    expect(await exists(path.join(h.vaultRoot, ".claudian-session-sync", "workspace.json"))).toBe(true);
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
  }, SLOW);

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
  }, SLOW);
});

describe("machine identity", () => {
  it("is created once and reused", async () => {
    const h = await makeHarness();
    await h.runtime.refresh();
    const machineFile = path.join(h.homedir, ".claudian-session-sync", "machine.json");
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
    const identityFile = path.join(h.vaultRoot, ".claudian-session-sync", "workspace.json");
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
      path.join(h.homedir, ".claudian-session-sync", "workspaces", `${workspaceId}.json`),
    );
    expect(binding).toContain(h.syncDir);

    const identity = await stringValuesIn(
      path.join(h.vaultRoot, ".claudian-session-sync", "workspace.json"),
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
    ["state", path.join(h.homedir, ".claudian-session-sync")],
    ["vault", path.join(h.vaultRoot, ".claudian-session-sync")],
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
  }, SLOW);

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
  }, SLOW);

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
  }, SLOW);
});

describe("Claudian 2.2.5 files new conversations under devices/ (2026-09-01)", () => {
  // Upstream moved every *new* conversation's record from
  // `.claudian/sessions/<conv>.meta.json` to
  // `.claudian/sessions/devices/device-<64 hex>/<conv>.meta.json`
  // (`storagePaths.ts`: DEVICE_SESSIONS_PATH, getDeviceSessionsPath). The
  // admission scan listed one level and dropped every directory entry, so
  // those conversations stopped being admitted — and because admission
  // failures produce no action, the pass said "up to date" while the session
  // never left the machine. That silence is what made it expensive to find.
  const DEVICE = RuntimeHarness.deviceKey("mac-mini");

  it("admits a session whose record lives in a device directory", async () => {
    const h = await makeHarness();
    await h.appendSession(SID, 4);
    await h.scopeRecordToDevice(SID, DEVICE);
    await h.configure();
    await h.settle();

    const status = await h.runtime.refresh();
    const landed = path.join(
      h.syncDir,
      status.workspaceId as string,
      "claude-code",
      `${SID}.jsonl`,
    );
    await expect(fsp.stat(landed), "the session never reached the sync folder").resolves.toBeTruthy();
  }, SLOW);

  it("still admits the legacy records that stayed at the top level", async () => {
    // 2.2.5 leaves existing conversations where they were — the vault that
    // found this had 111 of them beside 2 device-scoped ones — so the old
    // layout is not a migration step to pass through, it is half the store.
    const h = await makeHarness();
    await h.appendSession(SID, 4);
    await h.appendSession(OTHER_SID, 4);
    await h.scopeRecordToDevice(OTHER_SID, DEVICE);
    await h.configure();
    await h.settle();

    const status = await h.runtime.refresh();
    for (const id of [SID, OTHER_SID]) {
      const landed = path.join(h.syncDir, status.workspaceId as string, "claude-code", `${id}.jsonl`);
      await expect(fsp.stat(landed), `${id} did not land`).resolves.toBeTruthy();
    }
  }, SLOW);

  it("admits records from another machine's device directory", async () => {
    // The whole point of the plugin. Upstream's own listing is device-scoped —
    // `selectSessionMetadataCandidate` returns null when a record belongs to a
    // different device — but admission here answers a different question: does
    // this vault know this session id. If it were device-scoped too, a
    // conversation started on the Mac could never have its bytes carried to
    // the Windows box, which is the one thing this plugin exists to do.
    const h = await makeHarness();
    await h.appendSession(SID, 4);
    await h.scopeRecordToDevice(SID, RuntimeHarness.deviceKey("some-other-machine"));
    await h.configure();
    await h.settle();

    const status = await h.runtime.refresh();
    const landed = path.join(h.syncDir, status.workspaceId as string, "claude-code", `${SID}.jsonl`);
    await expect(fsp.stat(landed)).resolves.toBeTruthy();
  }, SLOW);
});

describe("a quiet pass leaves the shared manifest alone (acceptance D-1)", () => {
  it("does not rewrite .aiss/manifest.json when nothing changed", async () => {
    // The manifest lives in the sync folder, so a rewrite is not private
    // churn: two idle machines re-stamping it every timer pass is what the
    // acceptance run's sync tool turned into a stream of manufactured
    // "conflicted copy" files. A pass that verified everything and found it
    // exactly as remembered has nothing to write.
    const h = await makeHarness();
    await h.appendSession(SID, 4);
    await h.configure();
    await h.settle(); // pushes, and legitimately writes the manifest

    const manifestPath = path.join(h.syncDir, ".aiss", "manifest.json");
    const before = await read(manifestPath);
    await h.settle();
    await h.settle();

    expect(sha256(await read(manifestPath))).toBe(sha256(before));
  }, SLOW);
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
    expect(acted.short).toBe("Claudian Session Sync: 1 change");
    // And the steady state does not report itself as a count of nothing.
    expect(settled.short).toBe("Claudian Session Sync: up to date");
  }, SLOW);

  it("says 'conflict' exactly once per conflict, and stops once it is settled", async () => {
    // Acceptance defect D-4: a CONFLICT action's result is APPLIED, so it was
    // counted as a change *and* suffixed as a conflict — "1 change, 1
    // conflict · 1 conflict" for a single conflicted session. And the count
    // came from quarantine directories, which survive resolution on purpose,
    // so the bar kept saying "1 conflict" after the user had resolved it.
    const a = await makeHarness();
    await a.appendSession(SID, 5);
    await a.configure();
    await a.settle();
    const b = await RuntimeHarness.createPeer(a);
    try {
      await b.settle();
      await a.appendRaw(SID, '{"uuid":"a1","fork":"A"}\n');
      await a.settle();
      await b.appendRaw(SID, '{"uuid":"b1","fork":"B"}\n');
      const conflicted = await b.settle();

      expect(conflicted.short).toBe("Claudian Session Sync: up to date · 1 conflict");
      expect(conflicted.short.match(/conflict/g)).toHaveLength(1);

      const only = (await b.runtime.conflicts())[0];
      const outcome = await b.runtime.resolve(only?.conflictId as string, "keep-local");
      expect(outcome.ok).toBe(true);
      // Resolution runs a pass itself; the quarantine directory still exists
      // (both branches stay reachable), but it is no longer a conflict.
      expect(b.runtime.currentStatus().conflicts).toBe(0);
      expect(b.runtime.currentStatus().short).not.toContain("conflict");
    } finally {
      await b.dispose();
    }
  }, SLOW);

  it("keeps counting a conflict through a pass that only DEFERred it", async () => {
    // A divergent pair whose side just changed is DEFERred, not judged — and a
    // report with no CONFLICT action must not read as "up to date". On the
    // re-run this exact sequence (failed resolution, then a DEFER round)
    // showed a clean status bar over a live disagreement.
    const a = await makeHarness();
    await a.appendSession(SID, 5);
    await a.configure();
    await a.settle();
    const b = await RuntimeHarness.createPeer(a);
    try {
      await b.settle();
      await a.appendRaw(SID, '{"uuid":"a1","fork":"A"}\n');
      await a.settle();
      await b.appendRaw(SID, '{"uuid":"b1","fork":"B"}\n');
      const conflicted = await b.settle();
      expect(conflicted.conflicts).toBe(1);

      // The local branch moves again (a third-party writer, a resumed view) —
      // the very next pass can only observe, and observes an unstable side.
      await b.appendRaw(SID, '{"uuid":"b2","fork":"B-again"}\n');
      const deferred = await b.runtime.syncNow();

      const report = b.runtime.lastPassReport();
      const line = report?.actions.find((x) => x.neutralRel.includes(SID));
      expect(line?.action, JSON.stringify(line)).toBe("DEFER");
      expect(deferred.conflicts, "a DEFER must not clear the count").toBe(1);
      expect(deferred.short).toContain("conflict");

      // Settled and resolved, the count reaches zero the honest way.
      await b.settle();
      const live = (await b.runtime.conflicts()).find((c) =>
        c.branches.some((branch) => branch.onThisMachine),
      );
      const outcome = await b.runtime.resolve(live?.conflictId as string, "keep-remote");
      expect(outcome.ok).toBe(true);
      expect(b.runtime.currentStatus().conflicts).toBe(0);
    } finally {
      await b.dispose();
    }
  }, SLOW);

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
  }, SLOW);
});

describe("a machine with more than one vault (OQ-19, ADR-59)", () => {
  const extra: RuntimeHarness[] = [];
  afterEach(async () => {
    while (extra.length) await extra.pop()?.dispose();
  });

  it("picks the binding that belongs to the vault that is open", async () => {
    // The bound workspace used to be whichever sorted first, which is only
    // ever right with one vault. With two, the panel showed the other
    // workspace's configuration, the folder field was disabled, and the
    // identity check called this vault CHANGED and stopped syncing — a
    // fail-closed guard firing on a configuration that is not an anomaly.
    const first = await RuntimeHarness.create();
    extra.push(first);
    await first.configure();
    const firstStatus = await first.runtime.refresh();

    // A second vault on the same machine, sharing its home directory — which
    // is where bindings live, and therefore the whole point.
    const second = await RuntimeHarness.create();
    extra.push(second);
    Object.assign(second, { homedir: first.homedir });
    // Its identity is written directly so the two vaults genuinely differ: the
    // harness's id generator is per-instance and would hand both the same one.
    const OTHER = "00000000-0000-4000-8000-0000000000ff";
    await fsp.mkdir(path.join(second.vaultRoot, ".claudian-session-sync"), { recursive: true });
    await fsp.writeFile(
      path.join(second.vaultRoot, ".claudian-session-sync", "workspace.json"),
      JSON.stringify({ schemaVersion: 1, workspaceId: OTHER, label: "the other vault", createdAt: "" }, null, 2),
    );
    await second.runtime.refresh();
    await second.runtime.setSyncDir(second.syncDir);

    const secondStatus = await second.runtime.refresh();
    expect(secondStatus.workspaceId).toBe(OTHER);
    // The binding, not just what the vault claims: the visible symptom was a
    // panel showing the *other* workspace's folder and provider switches, so
    // that is what has to be asserted.
    expect(secondStatus.syncDirPath).toBe(second.syncDir);
    expect(secondStatus.syncDirPath).not.toBe(firstStatus.syncDirPath);
    expect(secondStatus.phase).not.toBe("identity-blocked");

    // And the first vault still resolves to its own binding, not to whichever
    // sorts first now that there are two.
    const firstAgain = await first.runtime.refresh();
    expect(firstAgain.workspaceId).toBe(firstStatus.workspaceId);
    expect(firstAgain.syncDirPath).toBe(first.syncDir);
  }, SLOW);

  it("still stops when a vault's identity really did change", async () => {
    // The guard this must not loosen (ADR-21). Selecting by vault path makes
    // it sharper, not weaker: the binding that claims *this* vault is the one
    // its identity is compared against, so a replaced identity file is still
    // an anomaly — and must not be answered by offering to mint a second id
    // for a vault that already has one (ADR-20).
    const machine = await RuntimeHarness.create();
    extra.push(machine);
    await machine.configure();

    await fsp.writeFile(
      path.join(machine.vaultRoot, ".claudian-session-sync", "workspace.json"),
      JSON.stringify(
        { schemaVersion: 1, workspaceId: "00000000-0000-4000-8000-0000000000ee", label: "x", createdAt: "" },
        null,
        2,
      ),
    );

    const status = await machine.runtime.refresh();
    expect(status.phase).toBe("identity-blocked");
    expect(status.detail.toLowerCase()).toContain("identity");
  }, SLOW);
});
