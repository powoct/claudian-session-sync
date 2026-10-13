/**
 * ADR-78 end to end: a conversation deleted on this device under Claudian
 * 2.3.3+ stays deleted here, through the real composition root.
 *
 * Every Claudian action below is `tests/helpers/claudian-2320.ts`, a line-for-
 * line model of what 2.3.20 does on disk — compact records, deletes that leave
 * no marker, assignment by rename, and the launch-time migration that removes
 * a record beside an older device's tombstone. The fixtures the earlier tests
 * use describe Claudian 2.2.x; they stayed green while this bug shipped.
 *
 * Each `launch()` here is an Obsidian restart as far as Claudian is concerned,
 * and the plugin's passes run after it, the way they do in Obsidian.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ActionEntry, PassReport } from "../../src/orchestration/pass-report";
import { RuntimeHarness } from "../helpers/runtime-harness";
import {
  assignToDevice,
  autoArchiveRewrite,
  deleteRecord,
  launch,
  layoutReadyCleanup,
  legacyPeerDelete,
  saveRecord,
  store,
  visibleToClaudian,
} from "../helpers/claudian-2320";

const CONV = "conv-1786422687897-15ktes7p9";
const META = `claudian/${CONV}.meta.json`;
const S1 = "11111111-1111-4111-8111-111111111111";
const DEVICE = RuntimeHarness.deviceKey("this-device");
const DAY_MS = 24 * 60 * 60 * 1000;

const machines: RuntimeHarness[] = [];
afterEach(async () => {
  while (machines.length) await machines.pop()?.dispose();
});

async function machine(version = "2.3.20", peerOf?: RuntimeHarness): Promise<RuntimeHarness> {
  const m = peerOf ? await RuntimeHarness.createPeer(peerOf) : await RuntimeHarness.create();
  machines.push(m);
  if (!peerOf) await m.configure();
  await m.installClaudian(version);
  await m.runtime.setProvider("claudian", { enabled: true });
  await fsp.mkdir(store(m), { recursive: true });
  await m.runtime.refresh();
  return m;
}

/** One pass, with what a user would see from it. */
async function pass(m: RuntimeHarness) {
  await m.runtime.syncNow();
  m.advanceClock(95_000);
  const report = m.runtime.lastPassReport() as PassReport;
  return { report, announcement: m.runtime.takeAnnouncement() };
}

/**
 * Restart after restart, passes in between, everything collected.
 *
 * `migrates: false` for a Claudian older than 2.3.3, which has no launch-time
 * migration — running it there would consume the very tombstone the test is
 * about before that device could push it.
 */
async function restarts(m: RuntimeHarness, count: number, options: { migrates?: boolean } = {}) {
  const rows: ActionEntry[] = [];
  const notices: string[] = [];
  const announcements: string[] = [];
  for (let i = 0; i < count; i++) {
    if (options.migrates !== false) await layoutReadyCleanup(await launch(m));
    for (let j = 0; j < 2; j++) {
      const { report, announcement } = await pass(m);
      rows.push(...report.actions.filter((a) => a.providerId === "claudian"));
      notices.push(...report.notices);
      if (announcement) announcements.push(announcement);
    }
  }
  return { rows, notices, announcements };
}

const local = (m: RuntimeHarness, name: string) => path.join(store(m), name);
const exists = async (target: string) => (await fsp.lstat(target).catch(() => null)) !== null;
const replicaOf = async (m: RuntimeHarness, name: string) =>
  path.join(m.syncDir, (await m.runtime.refresh()).workspaceId as string, "claudian", name);

describe("a conversation deleted here", () => {
  it("stays deleted across restarts, and the user is told once", async () => {
    const a = await machine();
    await saveRecord(a, CONV, { providerId: "codex", sessionId: null, title: "Plan the trip" });
    await a.settle();
    expect(await exists(await replicaOf(a, `${CONV}.meta.json`))).toBe(true);

    await deleteRecord(a, CONV);
    const seen = await restarts(a, 3);

    expect(await exists(local(a, `${CONV}.meta.json`)), "the record came back").toBe(false);
    expect(await visibleToClaudian(a, null)).not.toContain(CONV);
    const mine = seen.rows.filter((r) => r.neutralRel === META);
    expect(new Set(mine.map((r) => `${r.action}/${r.reason}`))).toEqual(new Set(["SKIP_DELETED_HERE/deleted-here"]));
    expect(seen.notices.filter((n) => n.includes("being kept off"))).toHaveLength(1);
    expect(seen.announcements).toHaveLength(1);
    // The sync folder still has it: deletion does not propagate (ADR-10).
    expect(await exists(await replicaOf(a, `${CONV}.meta.json`))).toBe(true);
  }, 60_000);

  it("is still delivered to a device that never had it", async () => {
    const a = await machine();
    await saveRecord(a, CONV, { providerId: "codex", sessionId: null });
    await a.settle();
    await deleteRecord(a, CONV);
    await restarts(a, 1);

    const c = await machine("2.3.20", a);
    await c.settle();
    expect(await exists(local(c, `${CONV}.meta.json`))).toBe(true);
  }, 60_000);

  it("is held whatever the clock does, and whatever happens to the ledger", async () => {
    const a = await machine();
    await saveRecord(a, CONV, { providerId: "codex", sessionId: null });
    await a.settle();
    await deleteRecord(a, CONV);
    await restarts(a, 1);

    // Past the ledger's thirty-day forgetting…
    a.advanceClock(31 * DAY_MS);
    await restarts(a, 1);
    expect(await exists(local(a, `${CONV}.meta.json`))).toBe(false);

    // …and with the ledger gone altogether.
    const ws = (await a.runtime.refresh()).workspaceId as string;
    await fsp.rm(path.join(a.homedir, ".claudian-session-sync", "state", ws, "observations.json"));
    a.restart();
    await restarts(a, 1);
    expect(await exists(local(a, `${CONV}.meta.json`))).toBe(false);
  }, 60_000);

  it("is remembered from the ledger by the first pass after upgrading the plugin", async () => {
    const a = await machine();
    await saveRecord(a, CONV, { providerId: "codex", sessionId: null });
    await a.settle();
    // An install that predates the memory file: only the ledger knows.
    const ws = (await a.runtime.refresh()).workspaceId as string;
    await fsp.rm(path.join(a.homedir, ".claudian-session-sync", "state", ws, "claudian-records.json"));
    a.restart();

    await deleteRecord(a, CONV);
    await restarts(a, 2);
    expect(await exists(local(a, `${CONV}.meta.json`))).toBe(false);
  }, 60_000);

  it("is not a deletion when the whole store is missing", async () => {
    const a = await machine();
    await saveRecord(a, CONV, { providerId: "codex", sessionId: null });
    await a.settle();
    await fsp.rm(store(a), { recursive: true });

    const seen = await restarts(a, 1);
    expect(seen.rows.some((r) => r.action === "SKIP_DELETED_HERE")).toBe(false);
  }, 60_000);

  it("changes nothing on disk in a dry run", async () => {
    const a = await machine();
    await saveRecord(a, CONV, { providerId: "codex", sessionId: null });
    await a.settle();
    await deleteRecord(a, CONV);
    const ws = (await a.runtime.refresh()).workspaceId as string;
    const memory = path.join(a.homedir, ".claudian-session-sync", "state", ws, "claudian-records.json");
    const before = await fsp.readFile(memory, "utf8");

    await a.runtime.syncNow({ dryRun: true });
    expect(a.runtime.lastPassReport()?.actions.find((r) => r.neutralRel === META)?.action).toBe("SKIP_DELETED_HERE");
    expect(await fsp.readFile(memory, "utf8")).toBe(before);
    expect(a.runtime.takeAnnouncement()).toBeNull();
  }, 60_000);
});

describe("deleting many at once", () => {
  it("costs no share of the pass, so a peer's new conversation still arrives", async () => {
    const a = await machine();
    const ids = Array.from({ length: 12 }, (_, i) => `conv-17864226878${String(i).padStart(2, "0")}-bulk${i}`);
    for (const id of ids) await saveRecord(a, id, { providerId: "codex", sessionId: null });
    await a.settle();
    for (const id of ids) await deleteRecord(a, id);
    await a.runtime.updateSettings({ maxFilesPerPass: 3 });
    // Long enough for every delete to have been judged once.
    for (let i = 0; i < 6; i++) await pass(a);

    const b = await machine("2.3.20", a);
    const NEW = "conv-1799999999999-arrives";
    await saveRecord(b, NEW, { providerId: "codex", sessionId: null });
    await b.settle();

    await pass(a);
    await pass(a);
    expect(await exists(local(a, `${NEW}.meta.json`)), "starved by twelve holds").toBe(true);
    for (const id of ids) expect(await exists(local(a, `${id}.meta.json`))).toBe(false);
  }, 120_000);
});

describe("assigned, not deleted", () => {
  it("keeps the shared copy off when the record moved into a device folder, and after it is deleted there", async () => {
    const a = await machine();
    await saveRecord(a, CONV, { providerId: "codex", sessionId: null });
    await a.settle();

    await assignToDevice(a, CONV, DEVICE);
    const assigned = await restarts(a, 1);
    expect(assigned.rows.filter((r) => r.neutralRel === META).map((r) => r.reason)).toContain("moved-to-device");
    expect(assigned.announcements, "a move is not a deletion to announce").toEqual([]);
    expect(await exists(local(a, `${CONV}.meta.json`))).toBe(false);

    await deleteRecord(a, CONV, { device: DEVICE });
    await restarts(a, 2);
    expect(await visibleToClaudian(a, DEVICE)).not.toContain(CONV);
  }, 60_000);
});

describe("Claude's own automatic delete is not the user's (H3)", () => {
  async function deletedClaudeRecord(transcriptHere: boolean) {
    const a = await machine();
    await saveRecord(a, CONV, { providerId: "claude", sessionId: S1, title: "t" });
    if (transcriptHere) await fsp.writeFile(a.sessionPath(S1), '{"type":"user"}\n');
    await a.settle();
    await deleteRecord(a, CONV);
    return { a, seen: await restarts(a, 1) };
  }

  it("restores it, with a notice, when every bound transcript is missing here", async () => {
    const { a, seen } = await deletedClaudeRecord(false);
    expect(await exists(local(a, `${CONV}.meta.json`))).toBe(true);
    expect(seen.rows.find((r) => r.neutralRel === META && r.action === "PULL_NEW")?.reason).toBe(
      "remote-only-history-not-here",
    );
    expect(seen.notices.some((n) => n.includes("removed them by itself"))).toBe(true);
    expect(seen.announcements).toHaveLength(1);
  }, 60_000);

  it("keeps it deleted when its transcript is here — Claudian would only have reset it", async () => {
    const { a } = await deletedClaudeRecord(true);
    expect(await exists(local(a, `${CONV}.meta.json`))).toBe(false);
  }, 60_000);
});

describe("another device keeps using a conversation deleted here", () => {
  async function deletedHereKeptThere() {
    const a = await machine();
    await saveRecord(a, CONV, { providerId: "codex", sessionId: null, title: "one", lastActivityAt: 1 });
    await a.settle();
    const b = await machine("2.3.20", a);
    await b.settle();
    await deleteRecord(a, CONV);
    await restarts(a, 1);
    return { a, b };
  }

  async function push(b: RuntimeHarness) {
    for (let i = 0; i < 3; i++) await pass(b);
  }

  it("says nothing about rewrites nobody made — archiving, compact JSON", async () => {
    const { a, b } = await deletedHereKeptThere();
    await autoArchiveRewrite(b, CONV);
    await push(b);
    const indented = JSON.stringify(JSON.parse(await fsp.readFile(local(b, `${CONV}.meta.json`), "utf8")), null, 2);
    await fsp.writeFile(local(b, `${CONV}.meta.json`), indented);
    await push(b);

    const seen = await restarts(a, 1);
    expect(seen.notices.some((n) => n.includes("changed on another device"))).toBe(false);
  }, 90_000);

  it("names it when the conversation itself moved on, and still keeps it off", async () => {
    const { a, b } = await deletedHereKeptThere();
    await saveRecord(b, CONV, { providerId: "codex", sessionId: null, title: "one", lastActivityAt: 2 });
    await push(b);

    const seen = await restarts(a, 1);
    expect(seen.notices.filter((n) => n.includes("changed on another device"))).toHaveLength(1);
    expect(seen.notices.find((n) => n.includes("changed on another device"))).toContain(CONV);
    expect(await exists(local(a, `${CONV}.meta.json`))).toBe(false);
  }, 90_000);

  it("brings back the latest version on request", async () => {
    const { a, b } = await deletedHereKeptThere();
    await saveRecord(b, CONV, { providerId: "codex", sessionId: null, title: "renamed there", lastActivityAt: 3 });
    await push(b);
    await restarts(a, 1);

    const held = await a.runtime.heldRecords();
    expect(held.map((h) => [h.conversationId, h.kind, h.title])).toEqual([[CONV, "deleted-here", "renamed there"]]);
    expect(await a.runtime.bringBack(held.map((h) => h.neutralRel))).toEqual({ ok: true });
    await pass(a);

    expect(JSON.parse(await fsp.readFile(local(a, `${CONV}.meta.json`), "utf8")).title).toBe("renamed there");
    expect(await a.runtime.heldRecords()).toEqual([]);
    await restarts(a, 1);
    expect(await exists(local(a, `${CONV}.meta.json`))).toBe(true);
  }, 90_000);
});

describe("deletion markers from Claudian 2.3.2 and older", () => {
  it("are not reported as deletions here after upgrading Claudian, and nothing retired is published", async () => {
    // The 2.2.x shape: a deleted conversation keeps its record beside an
    // indented tombstone, plus the inputs sidecar 2.3.3 retired.
    const a = await machine("2.3.2");
    await fsp.writeFile(local(a, `${CONV}.meta.json`), JSON.stringify({ id: CONV, providerId: "codex" }, null, 2));
    await fsp.writeFile(
      local(a, `${CONV}.deleted.json`),
      JSON.stringify({ schemaVersion: 1, conversationId: CONV, deletedAt: 1 }, null, 2),
    );
    await fsp.writeFile(local(a, `${CONV}.inputs.json`), "{}");
    await a.settle();

    await a.installClaudian("2.3.20");
    const seen = await restarts(a, 3);

    expect(seen.announcements).toEqual([]);
    expect(seen.notices.some((n) => n.includes("being kept off"))).toBe(false);
    expect(new Set(seen.rows.map((r) => `${r.action}/${r.reason}`))).toEqual(
      new Set([
        "SKIP_DELETED_HERE/removed-by-tombstone",
        "SKIP_DELETED_HERE/tombstone-consumed",
        "SKIP_RETIRED/retired-sidecar",
      ]),
    );
    expect(seen.rows.some((r) => r.action.startsWith("PUSH"))).toBe(false);
    expect((await fsp.readdir(store(a))).filter((n) => n.startsWith(CONV))).toEqual([]);
  }, 90_000);

  it("still carry an older device's delete to this one", async () => {
    const a = await machine();
    await saveRecord(a, CONV, { providerId: "codex", sessionId: null });
    await a.settle();
    const b = await machine("2.3.2", a);
    await b.settle();

    await legacyPeerDelete(b, CONV);
    await restarts(b, 1, { migrates: false });
    const seen = await restarts(a, 2);

    expect(await visibleToClaudian(a, null)).not.toContain(CONV);
    expect(seen.announcements).toEqual([]);
    expect(seen.rows.find((r) => r.neutralRel === META && r.action === "SKIP_DELETED_HERE")?.reason).toBe(
      "removed-by-tombstone",
    );
  }, 90_000);

  it("never land the inputs sidecar on a markerless device, before or after Claudian's cleanup", async () => {
    const a = await machine("2.3.2");
    await saveRecord(a, CONV, { providerId: "codex", sessionId: null });
    await fsp.writeFile(local(a, `${CONV}.inputs.json`), "{}");
    await a.settle();
    await a.installClaudian("2.3.20");

    // A pass while the sidecar is still here (cleanup runs after layout-ready)…
    const pending = await launch(a);
    const before = await pass(a);
    // …and passes after it is gone.
    await layoutReadyCleanup(pending);
    const after = await restarts(a, 2);
    const rows = [...before.report.actions, ...after.rows].filter((r) => r.neutralRel.endsWith(".inputs.json"));
    expect(new Set(rows.map((r) => `${r.action}/${r.reason}`))).toEqual(new Set(["SKIP_RETIRED/retired-sidecar"]));
    expect(await exists(local(a, `${CONV}.inputs.json`))).toBe(false);
  }, 90_000);
});

describe("forgetting a hold", () => {
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "does not count a pass whose listing of the sync folder failed",
    async () => {
      const a = await machine();
      await saveRecord(a, CONV, { providerId: "codex", sessionId: null });
      await a.settle();
      await deleteRecord(a, CONV);
      await restarts(a, 1);

      // Traversable and writable, but not listable: the walk fails while every
      // stat inside still works, so the passes run in full. (0o000 would fail
      // the stats too, abort every pass, and prove nothing.)
      const folder = path.dirname(await replicaOf(a, `${CONV}.meta.json`));
      await fsp.chmod(folder, 0o311);
      try {
        for (let i = 0; i < 3; i++) {
          await pass(a);
          expect(a.runtime.lastPassReport()?.outcome, "the pass must actually run").not.toBe("aborted");
        }
      } finally {
        await fsp.chmod(folder, 0o755);
      }
      // The ledger remembers the record on its own; take it away, so that only
      // the memory can keep the hold.
      const ws = (await a.runtime.refresh()).workspaceId as string;
      await fsp.rm(path.join(a.homedir, ".claudian-session-sync", "state", ws, "observations.json"));
      a.restart();
      await restarts(a, 1);
      expect(await exists(local(a, `${CONV}.meta.json`)), "an unreadable folder released the hold").toBe(false);
    },
    60_000,
  );
});

describe("the sharing step runs under the pass's own lock (pre-1)", () => {
  it("stops writing when the lock is taken over mid-step", async () => {
    let steal: (() => Promise<void>) | null = null;
    const a = await RuntimeHarness.create({
      claudianDeviceKey: DEVICE,
      beforeReadDir: async (target) => {
        if (steal && target.endsWith(DEVICE)) await steal();
      },
    });
    machines.push(a);
    await a.configure();
    await a.settle();
    await a.runtime.setShareConversations(true);
    await saveRecord(a, CONV, { providerId: "codex", sessionId: null }, { device: DEVICE });

    const ws = (await a.runtime.refresh()).workspaceId as string;
    const lockFile = path.join(a.homedir, ".claudian-session-sync", "locks", `${ws}.lock`);
    steal = async () => {
      steal = null;
      const held = JSON.parse(await fsp.readFile(lockFile, "utf8")) as { epoch: number };
      await fsp.writeFile(lockFile, JSON.stringify({ ...held, epoch: held.epoch + 1 }));
    };
    await a.runtime.syncNow();

    expect(steal, "the step never listed this device's folder").toBeNull();
    expect(await exists(local(a, `${CONV}.meta.json`)), "moved after the lock was lost").toBe(false);
    expect(await exists(path.join(store(a), "devices", DEVICE, `${CONV}.meta.json`))).toBe(true);
  }, 60_000);
});

describe("the other ways a hold ends, and one it must not", () => {
  async function held() {
    const a = await machine();
    await saveRecord(a, CONV, { providerId: "codex", sessionId: null, title: "kept" });
    await a.settle();
    const bytes = await fsp.readFile(local(a, `${CONV}.meta.json`));
    await deleteRecord(a, CONV);
    await restarts(a, 1);
    expect((await a.runtime.heldRecords()).map((h) => h.conversationId)).toEqual([CONV]);
    return { a, bytes };
  }

  it("ends the moment the record reappears here, before it has even settled", async () => {
    const { a, bytes } = await held();
    await fsp.writeFile(local(a, `${CONV}.meta.json`), bytes);
    // One pass: the file is new to the ledger, so it defers rather than
    // converges — and the bring-back screen must already stop offering it.
    const { report } = await pass(a);
    expect(report.actions.find((r) => r.neutralRel === META)?.action).toBe("DEFER");
    expect(await a.runtime.heldRecords()).toEqual([]);
    const seen = await restarts(a, 1);
    expect(seen.rows.some((r) => r.action === "SKIP_DELETED_HERE")).toBe(false);
  }, 60_000);

  it("ends when the sync folder loses the record as well", async () => {
    const { a } = await held();
    await fsp.rm(await replicaOf(a, `${CONV}.meta.json`));
    await restarts(a, 1);
    expect(await a.runtime.heldRecords()).toEqual([]);
  }, 60_000);

  it("is rebuilt from the ledger, and said once, when the memory file is unreadable", async () => {
    // Nothing held, so no pass would change the rebuilt memory: it has to be
    // saved for being rebuilt, or it is rebuilt — and announced — every pass.
    const a = await machine();
    await saveRecord(a, CONV, { providerId: "codex", sessionId: null });
    await a.settle();
    const ws = (await a.runtime.refresh()).workspaceId as string;
    await fsp.writeFile(path.join(a.homedir, ".claudian-session-sync", "state", ws, "claudian-records.json"), "{ torn");
    a.restart();
    const seen = await restarts(a, 2);
    expect(seen.notices.filter((n) => n.includes("could not be read, so it was rebuilt"))).toHaveLength(1);
  }, 60_000);

  it("keeps a hold through a rebuild, from what the ledger still knows", async () => {
    const { a } = await held();
    const ws = (await a.runtime.refresh()).workspaceId as string;
    await fsp.writeFile(path.join(a.homedir, ".claudian-session-sync", "state", ws, "claudian-records.json"), "{ torn");
    a.restart();
    const seen = await restarts(a, 2);
    expect(seen.notices.filter((n) => n.includes("could not be read, so it was rebuilt"))).toHaveLength(1);
    // Rebuilt from the ledger, which still knew the record: still held.
    expect(await exists(local(a, `${CONV}.meta.json`))).toBe(false);
  }, 60_000);
});

describe("a deletion marker on a markerless device", () => {
  it("is never published, however it got here", async () => {
    // A 2.3.2 device's tombstone that the vault sync delivered before this
    // device's Claudian launched and consumed it.
    const a = await machine();
    await saveRecord(a, CONV, { providerId: "codex", sessionId: null });
    await a.settle();
    await fsp.writeFile(
      local(a, `${CONV}.deleted.json`),
      JSON.stringify({ schemaVersion: 1, conversationId: CONV, deletedAt: 1 }, null, 2),
    );
    const seen = await restarts(a, 1, { migrates: false });
    expect(seen.rows.filter((r) => r.neutralRel.endsWith(".deleted.json")).map((r) => r.action)).not.toContain(
      "PUSH_NEW",
    );
    expect(await exists(await replicaOf(a, `${CONV}.deleted.json`))).toBe(false);
  }, 60_000);
});

describe("the memory outlives the ledger", () => {
  it("knows a record this device held even when the ledger was lost before the delete", async () => {
    const a = await machine();
    await saveRecord(a, CONV, { providerId: "codex", sessionId: null });
    await a.settle();

    // The ledger goes first — a machine-id mismatch, a moved sync folder —
    // and only then does the user delete. Nothing but the memory knows.
    const ws = (await a.runtime.refresh()).workspaceId as string;
    await fsp.rm(path.join(a.homedir, ".claudian-session-sync", "state", ws, "observations.json"));
    a.restart();
    await deleteRecord(a, CONV);
    await restarts(a, 2);
    expect(await exists(local(a, `${CONV}.meta.json`)), "a record this device held came back").toBe(false);
  }, 60_000);
});

describe("publishing a held shared record from the repair screen (ADR-78 H9)", () => {
  it("publishes it, and says so", async () => {
    const a = await RuntimeHarness.create({ claudianDeviceKey: DEVICE });
    machines.push(a);
    await a.configure();
    await a.settle();
    await a.runtime.setShareConversations(true);
    await saveRecord(a, CONV, { providerId: "codex", sessionId: null, title: "one" }, { device: DEVICE });
    await a.runtime.syncNow();
    expect(await exists(local(a, `${CONV}.meta.json`)), "the first move").toBe(true);

    // Claudian's stale write target recreates the device copy, and another
    // device deletes the shared one — markerless.
    await saveRecord(a, CONV, { providerId: "codex", sessionId: null, title: "two" }, { device: DEVICE });
    await deleteRecord(a, CONV);
    await a.runtime.syncNow();
    expect(await exists(local(a, `${CONV}.meta.json`)), "published again on its own").toBe(false);
    expect((await a.runtime.sharingConflicts()).map((h) => h.conversationId)).toEqual([CONV]);

    expect(await a.runtime.publishSharedRecord(CONV)).toEqual({ ok: true });
    expect(JSON.parse(await fsp.readFile(local(a, `${CONV}.meta.json`), "utf8")).title).toBe("two");
  }, 60_000);
});
