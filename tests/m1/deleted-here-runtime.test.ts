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
import { promises as fsp, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ActionEntry, PassReport } from "../../src/orchestration/pass-report";
import { type HarnessOptions, RuntimeHarness } from "../helpers/runtime-harness";
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

async function machine(
  version = "2.3.20",
  peerOf?: RuntimeHarness,
  options: HarnessOptions = {},
): Promise<RuntimeHarness> {
  const m = peerOf ? await RuntimeHarness.createPeer(peerOf, options) : await RuntimeHarness.create(options);
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
const memoryOf = async (m: RuntimeHarness) => {
  const ws = (await m.runtime.refresh()).workspaceId as string;
  return path.join(m.homedir, ".claudian-session-sync", "state", ws, "claudian-records.json");
};

/**
 * The store recreated — a new folder, so a new inode — before the old one
 * goes, so the test does not depend on the filesystem reusing inode numbers.
 */
async function recreate(a: RuntimeHarness): Promise<void> {
  const old = `${store(a)}-old`;
  await fsp.rename(store(a), old);
  await fsp.mkdir(path.join(store(a), "devices", DEVICE), { recursive: true });
  await fsp.rm(old, { recursive: true });
}

/**
 * `.claudian` removed entirely while Obsidian was closed. Claudian creates the
 * folder again only on its first save, so the plugin's pass comes first.
 */
async function removeStore(a: RuntimeHarness): Promise<void> {
  await fsp.rm(path.join(a.vaultRoot, ".claudian"), { recursive: true });
  a.restart();
}

/** What Claudian 2.3.2 and older leave in the sync folder for a deleted conversation. */
const LEGACY_TOMBSTONE = JSON.stringify({ schemaVersion: 1, conversationId: CONV, deletedAt: 1 }, null, 2);
const TOMB = `claudian/${CONV}.deleted.json`;

/** `recreatedPending`, and the holds, as this device's memory has them on disk. */
async function memoryFile(a: RuntimeHarness) {
  return JSON.parse(await fsp.readFile(await memoryOf(a), "utf8")) as {
    readonly recreatedPending?: readonly string[];
    readonly records: Record<string, { readonly hold?: { readonly kind: string } }>;
  };
}

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

  it("keeps no conversation text in its memory", async () => {
    const a = await machine();
    const sentinel = "Sentinel title 7f3a — never in a state file";
    await saveRecord(a, CONV, { providerId: "codex", sessionId: null, title: sentinel, lastActivityAt: 1 });
    await a.settle();
    await deleteRecord(a, CONV);
    await restarts(a, 2);
    const ws = (await a.runtime.refresh()).workspaceId as string;
    const memory = await fsp.readFile(
      path.join(a.homedir, ".claudian-session-sync", "state", ws, "claudian-records.json"),
      "utf8",
    );
    expect(memory).toContain("deleted-here");
    expect(memory).not.toContain("Sentinel");
    expect(memory).not.toContain("7f3a");
  }, 60_000);

  it("does not announce from a dry run", async () => {
    const a = await machine();
    await saveRecord(a, CONV, { providerId: "codex", sessionId: null });
    await a.settle();
    await deleteRecord(a, CONV);
    await pass(a); // the hold's first pass
    await a.runtime.syncNow({ dryRun: true }); // would be its second
    expect(a.runtime.takeAnnouncement()).toBeNull();
    const { announcement } = await pass(a); // the real second pass still announces
    expect(announcement ?? "").toContain("you deleted on this device");
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

    // The shared copy changing while it is held as moved is not "changed
    // after you deleted it": nothing here was deleted.
    const replica = await replicaOf(a, `${CONV}.meta.json`);
    await fsp.writeFile(replica, JSON.stringify({ id: CONV, providerId: "codex", sessionId: null, title: "renamed" }));
    const edited = await restarts(a, 1);
    expect(edited.notices.some((n) => n.includes("changed on another device"))).toBe(false);

    await deleteRecord(a, CONV, { device: DEVICE });
    await restarts(a, 2);
    expect(await visibleToClaudian(a, DEVICE)).not.toContain(CONV);
  }, 60_000);
});

describe("Claude's own automatic delete is not the user's (H3)", () => {
  /** Where the transcript is when the record goes; `arriving` = in the sync folder only. */
  type Where = "here" | "arriving" | "nowhere";

  /**
   * `arriving` keeps it arriving: writes of it into this machine's project
   * folder fail, the way a history that has not landed yet looks for as long
   * as a test needs it to — it never turns into `here` and masks the rule.
   */
  async function claudeRecordWithHistory(where: Where) {
    let projectDir: string | null = null;
    const a = await machine("2.3.20", undefined, {
      failWrite: (target) => where === "arriving" && projectDir !== null && target.startsWith(projectDir),
    });
    projectDir = a.projectDir;
    await saveRecord(a, CONV, { providerId: "claude", sessionId: S1, title: "t" });
    if (where === "here") await fsp.writeFile(a.sessionPath(S1), '{"type":"user"}\n');
    await a.settle();
    if (where === "arriving") {
      const ws = (await a.runtime.refresh()).workspaceId as string;
      await fsp.mkdir(path.join(a.syncDir, ws, "claude-code"), { recursive: true });
      await fsp.writeFile(path.join(a.syncDir, ws, "claude-code", `${S1}.jsonl`), '{"type":"user"}\n');
    }
    return a;
  }

  async function deletedClaudeRecord(where: Where) {
    const a = await claudeRecordWithHistory(where);
    await deleteRecord(a, CONV);
    return { a, seen: await restarts(a, 1) };
  }

  it("keeps it deleted when its history is nowhere — what Claude Code's thirty-day purge leaves", async () => {
    const { a, seen } = await deletedClaudeRecord("nowhere");
    expect(await exists(local(a, `${CONV}.meta.json`)), "restored for a history that is not coming").toBe(false);
    expect(seen.notices.some((n) => n.includes("removed them by itself"))).toBe(false);
  }, 60_000);

  it("restores it, with a notice, when every bound transcript is missing here", async () => {
    const { a, seen } = await deletedClaudeRecord("arriving");
    expect(await exists(local(a, `${CONV}.meta.json`))).toBe(true);
    expect(seen.rows.find((r) => r.neutralRel === META && r.action === "PULL_NEW")?.reason).toBe(
      "remote-only-history-not-here",
    );
    expect(seen.notices.some((n) => n.includes("removed them by itself"))).toBe(true);
    // Once. ADR-81's own pop-up for the same conversation — its history is
    // still not here — may follow a pass later; it is a different sentence.
    expect(seen.announcements.filter((a) => a.includes("removed them by itself"))).toHaveLength(1);
  }, 60_000);

  it("keeps it deleted when its transcript is here — Claudian would only have reset it", async () => {
    const { a } = await deletedClaudeRecord("here");
    expect(await exists(local(a, `${CONV}.meta.json`))).toBe(false);
  }, 60_000);

  it("does not claim a restore in a dry run", async () => {
    const a = await claudeRecordWithHistory("arriving");
    await deleteRecord(a, CONV);
    await a.runtime.syncNow({ dryRun: true });
    const report = a.runtime.lastPassReport() as PassReport;
    expect(report.actions.find((r) => r.neutralRel === META)?.reason).toBe("remote-only-history-not-here");
    expect(report.notices.some((n) => n.includes("were restored here"))).toBe(false);
    expect(a.runtime.takeAnnouncement()).toBeNull();
  }, 60_000);

  it("restores it only once: deleting it again keeps it deleted", async () => {
    const { a } = await deletedClaudeRecord("arriving");
    expect(await exists(local(a, `${CONV}.meta.json`))).toBe(true);
    // A full read re-witnesses the restored bytes; the once-only mark must
    // survive that, or a scrub between the two deletes undoes the rule.
    await a.runtime.syncNow({ verifyAll: true });
    await deleteRecord(a, CONV);
    const again = await restarts(a, 2);
    expect(await exists(local(a, `${CONV}.meta.json`)), "a delete that can never stick").toBe(false);
    expect(again.rows.find((r) => r.neutralRel === META && r.action === "SKIP_DELETED_HERE")?.reason).toBe(
      "deleted-here",
    );

    // Brought back by hand and deleted once more: still the user's delete.
    // The bring-back lands the same bytes, and must not wipe the mark that
    // says they were already restored once for their missing history.
    expect(await a.runtime.bringBack([META])).toEqual({ ok: true });
    expect(await exists(local(a, `${CONV}.meta.json`))).toBe(true);
    await deleteRecord(a, CONV);
    await restarts(a, 2);
    expect(await exists(local(a, `${CONV}.meta.json`)), "restored for its history a second time").toBe(false);
  }, 60_000);

  it("does not restore when no transcript can ever arrive here (the Claude Code provider is off)", async () => {
    const a = await machine();
    await a.runtime.setProvider("claude-code", { enabled: false });
    await saveRecord(a, CONV, { providerId: "claude", sessionId: S1, title: "t" });
    await a.settle();
    await deleteRecord(a, CONV);
    await restarts(a, 2);
    expect(await exists(local(a, `${CONV}.meta.json`))).toBe(false);
  }, 60_000);

  it("holds when there is no projects folder to look in — Claudian would not delete then either", async () => {
    const a = await machine();
    await saveRecord(a, CONV, { providerId: "claude", sessionId: S1, title: "t" });
    await a.settle();
    await fsp.rm(a.providerRoot, { recursive: true });
    await deleteRecord(a, CONV);
    await restarts(a, 2);
    expect(await exists(local(a, `${CONV}.meta.json`)), "restored on a guess").toBe(false);
  }, 60_000);

  it("looks in the projects folder the Claude Code provider is set to use", async () => {
    const a = await machine();
    const elsewhere = path.join(a.root, "claude-elsewhere");
    const dir = path.join(elsewhere, path.basename(a.projectDir));
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `${S1}.jsonl`), '{"type":"user"}\n');
    await a.runtime.setProvider("claude-code", { enabled: true, rootOverride: elsewhere });
    await saveRecord(a, CONV, { providerId: "claude", sessionId: S1, title: "t" });
    await a.settle();
    await deleteRecord(a, CONV);
    await restarts(a, 2);
    // The history is here, in the override: Claudian would have reset the
    // record, not deleted it, so the user did.
    expect(await exists(local(a, `${CONV}.meta.json`))).toBe(false);
  }, 60_000);

  it("counts a transcript this same pass pulled as not there — the typical R2", async () => {
    // B's record arrives first, its history a pass later. Claudian on A is
    // asked to resume before the history lands, finds nothing, and removes
    // the record. The very next pass pulls the history (Claude Code runs
    // before Claudian) and then judges the record — and must not read its own
    // pull as "the history was here" (review, 2026-10-14).
    const a = await machine();
    await saveRecord(a, CONV, { providerId: "claude", sessionId: S1, title: "t" });
    await a.settle();
    const b = await machine("2.3.20", a);
    await b.settle();
    await fsp.writeFile(b.sessionPath(S1), '{"type":"user","text":"hello"}\n');
    for (let i = 0; i < 3; i++) await pass(b);

    // A sees the history for the first time: too fresh to copy yet.
    const first = await pass(a);
    expect(first.report.actions.find((r) => r.neutralRel === `claude-code/${S1}.jsonl`)?.action).toBe("DEFER");
    await deleteRecord(a, CONV); // R2

    const { report } = await pass(a);
    expect(report.actions.find((r) => r.neutralRel === `claude-code/${S1}.jsonl`)?.action).toBe("PULL_NEW");
    expect(report.actions.find((r) => r.neutralRel === META)?.reason).toBe("remote-only-history-not-here");
    expect(await exists(local(a, `${CONV}.meta.json`))).toBe(true);
  }, 90_000);

  it("judges it in the pass that pulled the transcript even when the budget is spent", async () => {
    // The pull is what makes R2 visible, and it is visible for that one pass
    // only: put off by the budget to the next, the record would see a
    // transcript that is here and be held as the user's delete (review
    // 2026-10-14). So its first judgement is never put off.
    const a = await machine();
    await saveRecord(a, CONV, { providerId: "claude", sessionId: S1, title: "t" });
    await a.settle();
    const b = await machine("2.3.20", a);
    await b.settle();
    await fsp.writeFile(b.sessionPath(S1), '{"type":"user","text":"hello"}\n');
    for (let i = 0; i < 3; i++) await pass(b);
    await a.runtime.updateSettings({ maxFilesPerPass: 1 });

    await pass(a);
    await deleteRecord(a, CONV); // R2
    const { report } = await pass(a);

    expect(report.actions.find((r) => r.neutralRel === `claude-code/${S1}.jsonl`)?.action).toBe("PULL_NEW");
    expect(report.actions.find((r) => r.neutralRel === META)?.reason).toBe("remote-only-history-not-here");
    expect(await exists(local(a, `${CONV}.meta.json`))).toBe(true);
  }, 90_000);
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
    expect(seen.announcements.join(" ")).toContain("changed on another device");
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
    // The command runs its own pass: the record is back before any timer.
    expect(await exists(local(a, `${CONV}.meta.json`)), "bring-back waited for the next sync").toBe(true);

    expect(JSON.parse(await fsp.readFile(local(a, `${CONV}.meta.json`), "utf8")).title).toBe("renamed there");
    expect(await a.runtime.heldRecords()).toEqual([]);
    await restarts(a, 1);
    expect(await exists(local(a, `${CONV}.meta.json`))).toBe(true);
  }, 90_000);
});

describe("bringing back", () => {
  it("refuses, and says why, while the records provider is off", async () => {
    const a = await machine();
    await saveRecord(a, CONV, { providerId: "codex", sessionId: null });
    await a.settle();
    await deleteRecord(a, CONV);
    await restarts(a, 1);
    const held = await a.runtime.heldRecords();
    await a.runtime.setProvider("claudian", { enabled: false });
    expect(await a.runtime.bringBack(held.map((h) => h.neutralRel))).toEqual({ ok: false, reason: "provider-off" });
  }, 60_000);

  it("keeps the pop-up of a pass it started itself, for the next time the host asks", async () => {
    const a = await machine();
    const OTHER = "conv-1786422687000-another";
    await saveRecord(a, CONV, { providerId: "codex", sessionId: null });
    await saveRecord(a, OTHER, { providerId: "codex", sessionId: null });
    await a.settle();
    await deleteRecord(a, CONV);
    await restarts(a, 1);
    a.runtime.takeAnnouncement();

    await deleteRecord(a, OTHER);
    await pass(a); // OTHER's hold starts
    a.runtime.takeAnnouncement();
    // Bringing CONV back runs a pass: OTHER's second, the one that announces.
    // Nobody shows it then; the next timer pass must not throw it away.
    await a.runtime.bringBack([META]);
    await a.runtime.syncNow();
    expect(a.runtime.takeAnnouncement() ?? "").toContain("you deleted on this device");
  }, 60_000);
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
    const onB = await restarts(b, 1, { migrates: false });
    // On the 2.3.2 device itself the marker is local, and its own delete is
    // held silently: that Claudian hides the record by the marker anyway.
    expect(new Set(onB.rows.filter((r) => r.neutralRel === META).map((r) => `${r.action}/${r.reason}`))).toEqual(
      new Set(["SKIP_DELETED_HERE/removed-by-tombstone"]),
    );
    expect(onB.announcements).toEqual([]);
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

describe("what does not end a hold", () => {
  async function heldX() {
    const a = await machine();
    await saveRecord(a, CONV, { providerId: "codex", sessionId: null });
    const KEEP = "conv-1786422687000-keepme";
    await saveRecord(a, KEEP, { providerId: "codex", sessionId: null });
    await a.settle();
    const bytes = await fsp.readFile(local(a, `${CONV}.meta.json`));
    await deleteRecord(a, CONV);
    await restarts(a, 1);
    return { a, bytes };
  }

  it("is not the sync folder losing the record: a device that pushes it again later is kept out", async () => {
    // The first version forgot the whole entry after two passes without the
    // file, witness included — and a peer that still had the conversation
    // brought it straight back (review, 2026-10-14, reproduced twice).
    const { a, bytes } = await heldX();
    const replica = await replicaOf(a, `${CONV}.meta.json`);
    await fsp.rm(replica);
    const gone = await restarts(a, 2);
    expect(gone.rows.some((r) => r.neutralRel === META)).toBe(false);
    // Nothing to bring back while the folder lacks it, so it is not offered…
    expect(await a.runtime.heldRecords()).toEqual([]);

    // …and when another device pushes it again, it stays off — silently,
    // because the user was told the first time.
    await fsp.writeFile(replica, bytes);
    const back = await restarts(a, 2);
    expect(await exists(local(a, `${CONV}.meta.json`)), "a peer's push brought it back").toBe(false);
    expect(back.announcements).toEqual([]);
    expect(back.rows.filter((r) => r.neutralRel === META).map((r) => r.action)).toContain("SKIP_DELETED_HERE");
  }, 90_000);

  it("is not a move to a new sync folder", async () => {
    const { a, bytes } = await heldX();
    const fresh = path.join(a.root, "sync-2");
    await fsp.mkdir(fresh, { recursive: true });
    await a.runtime.setSyncDir(fresh);
    await a.runtime.initialiseSyncDir();
    await a.settle();
    await restarts(a, 2);

    // Much later a device that still has it moves to the new folder too.
    const ws = (await a.runtime.refresh()).workspaceId as string;
    await fsp.mkdir(path.join(fresh, ws, "claudian"), { recursive: true });
    await fsp.writeFile(path.join(fresh, ws, "claudian", `${CONV}.meta.json`), bytes);
    await restarts(a, 2);
    expect(await exists(local(a, `${CONV}.meta.json`)), "a new sync folder undid the delete").toBe(false);
  }, 90_000);
});

describe("an unreadable memory", () => {
  it("lands nothing it cannot place, and is not overwritten", async () => {
    const a = await machine();
    await saveRecord(a, CONV, { providerId: "codex", sessionId: null });
    await a.settle();
    await deleteRecord(a, CONV);
    await restarts(a, 1);

    const ws = (await a.runtime.refresh()).workspaceId as string;
    const memory = path.join(a.homedir, ".claudian-session-sync", "state", ws, "claudian-records.json");
    const before = await fsp.readFile(memory, "utf8");
    // Thirty-one quiet days: the ledger has forgotten the record, so only
    // the memory knows it was deleted here.
    a.advanceClock(31 * DAY_MS);
    await restarts(a, 1);

    // A path that is there and cannot be read as a file — the portable
    // stand-in for EBUSY or EACCES, which no CI platform produces on demand.
    await fsp.rm(memory);
    await fsp.mkdir(memory);
    const { report } = await pass(a);
    await pass(a);
    expect(report.notices.some((n) => n.includes("could not be opened"))).toBe(true);
    expect(await exists(local(a, `${CONV}.meta.json`)), "landed while the memory was unreadable").toBe(false);
    expect((await fsp.lstat(memory)).isDirectory(), "a rebuild was saved over it").toBe(true);

    await fsp.rmdir(memory);
    await fsp.writeFile(memory, before);
    await restarts(a, 1);
    expect(await exists(local(a, `${CONV}.meta.json`))).toBe(false);
  }, 90_000);
});

describe("the restore screen, for a record held here", () => {
  it("does not promise that restoring the sync folder's copy brings it to this machine", async () => {
    const a = await machine();
    await saveRecord(a, CONV, { providerId: "codex", sessionId: null, title: "one" });
    await a.settle();
    // A rewrite here fast-forwards the sync folder's copy, backing up the old.
    await saveRecord(a, CONV, { providerId: "codex", sessionId: null, title: "two" });
    await restarts(a, 1);
    await deleteRecord(a, CONV);
    await restarts(a, 1);

    const backup = (await a.runtime.backups()).find((b) => b.neutralRel === META && b.remote);
    expect(backup, "no backup of the sync folder's copy to look at").toBeDefined();
    expect(backup?.outcome).toBe("held-here");
  }, 60_000);
});

describe("a memory written by a newer build", () => {
  it("is used, never written, and said", async () => {
    const a = await machine();
    await saveRecord(a, CONV, { providerId: "codex", sessionId: null });
    await a.settle();
    const ws = (await a.runtime.refresh()).workspaceId as string;
    const memory = path.join(a.homedir, ".claudian-session-sync", "state", ws, "claudian-records.json");
    const newer = JSON.stringify({ schemaVersion: 999, records: {}, fromTheFuture: true });
    await fsp.writeFile(memory, newer);
    await deleteRecord(a, CONV);
    const seen = await restarts(a, 1);
    expect(seen.notices.some((n) => n.includes("written by a newer version"))).toBe(true);
    expect(await fsp.readFile(memory, "utf8")).toBe(newer);
    // Still kept off, from what the ledger knows.
    expect(await exists(local(a, `${CONV}.meta.json`))).toBe(false);
  }, 60_000);
});

describe("a recreated store", () => {
  it("restores what is missing from it, and keeps holding what was deleted before", async () => {
    // A vault downloaded again, or `.claudian` removed: Claudian recreates the
    // folder on its first save, and every record missing from it at once is
    // not the user deleting them.
    const a = await machine();
    const KEEP = "conv-1786422687000-keepme";
    await saveRecord(a, CONV, { providerId: "codex", sessionId: null });
    await saveRecord(a, KEEP, { providerId: "codex", sessionId: null });
    await a.settle();
    await deleteRecord(a, CONV);
    await restarts(a, 1);

    // A new folder — a new inode — before the old one goes, so the test does
    // not depend on the filesystem reusing inode numbers.
    const old = `${store(a)}-old`;
    await fsp.rename(store(a), old);
    await fsp.mkdir(path.join(store(a), "devices", DEVICE), { recursive: true });
    await fsp.rm(old, { recursive: true });

    const seen = await restarts(a, 2);
    expect(seen.notices.some((n) => n.includes("was recreated"))).toBe(true);
    expect(await exists(local(a, `${KEEP}.meta.json`)), "kept off a recreated store").toBe(true);
    expect(await exists(local(a, `${CONV}.meta.json`)), "a deletion undone by the recreation").toBe(false);
    expect(seen.announcements).toEqual([]);
  }, 90_000);

  it("restores everything missing even when there are more records than the budget", async () => {
    // The recreation is seen on one pass; a record whose judgement the budget
    // put off to the next would be judged against a store that looked
    // healthy, and held as deleted (review 2026-10-14).
    const a = await machine();
    const convs = Array.from({ length: 6 }, (_, n) => `conv-178642268700${n}-many${n}`);
    for (const conv of convs) await saveRecord(a, conv, { providerId: "codex", sessionId: null });
    await a.settle();
    await a.runtime.updateSettings({ maxFilesPerPass: 2 });
    await recreate(a);

    const seen = await restarts(a, 2);

    for (const conv of convs) expect(await exists(local(a, `${conv}.meta.json`)), conv).toBe(true);
    expect(seen.rows.filter((r) => r.action === "SKIP_DELETED_HERE")).toEqual([]);
    expect(seen.announcements).toEqual([]);
  }, 90_000);

  it("still counts as recreated for a record whose copy in the sync folder was moving that pass", async () => {
    // Another device saved the conversation just as this one found its store
    // recreated: the record is put off as unsettled, and judged a pass later
    // — still as a record missing from a recreated store.
    const a = await machine();
    await saveRecord(a, CONV, { providerId: "codex", sessionId: null, title: "one" });
    await a.settle();
    await recreate(a);
    const shared = await replicaOf(a, `${CONV}.meta.json`);
    const record = JSON.parse(await fsp.readFile(shared, "utf8")) as Record<string, unknown>;
    await fsp.writeFile(shared, JSON.stringify({ ...record, title: "two" }));

    const first = await pass(a);
    expect(first.report.actions.find((r) => r.neutralRel === META)?.action).toBe("DEFER");
    const seen = await restarts(a, 1);

    expect(await exists(local(a, `${CONV}.meta.json`))).toBe(true);
    expect(seen.rows.filter((r) => r.action === "SKIP_DELETED_HERE")).toEqual([]);
    expect(seen.announcements).toEqual([]);

    // Judged, so the recreation is over for it: deleting it now is a delete.
    await deleteRecord(a, CONV);
    const after = await restarts(a, 1);
    expect(await exists(local(a, `${CONV}.meta.json`))).toBe(false);
    expect(after.rows.some((r) => r.neutralRel === META && r.action === "SKIP_DELETED_HERE")).toBe(true);
  }, 90_000);

  it("still charges a record that has never been here — only a deletion's first judgement is free", async () => {
    const a = await machine();
    await a.settle();
    const b = await machine("2.3.20", a);
    const convs = Array.from({ length: 3 }, (_, n) => `conv-178642268710${n}-peer${n}`);
    for (const conv of convs) await saveRecord(b, conv, { providerId: "codex", sessionId: null });
    for (let i = 0; i < 3; i++) await pass(b);
    await a.runtime.updateSettings({ maxFilesPerPass: 1 });

    const reports: PassReport[] = [];
    // Long enough for the allowance for the starved: at a budget of one, the
    // pass's scrub sample can take the slot.
    for (let i = 0; i < 10; i++) reports.push((await pass(a)).report);

    const isPeer = (r: ActionEntry) => convs.some((conv) => r.neutralRel === `claudian/${conv}.meta.json`);
    const first = reports.find((report) => report.actions.some((r) => isPeer(r) && r.action === "PULL_NEW"));
    expect(first, "none of them arrived").toBeDefined();
    expect(first?.actions.filter((r) => isPeer(r) && r.action === "PULL_NEW")).toHaveLength(1);
    expect(first?.actions.filter((r) => isPeer(r) && r.reason === "budget-exhausted").length).toBeGreaterThan(0);
    for (const conv of convs) expect(await exists(local(a, `${conv}.meta.json`)), conv).toBe(true);
  }, 90_000);
});

describe("a store that is not there", () => {
  // What a device the vault sync does not bring `.claudian` to looks like on
  // its first pull (Obsidian Sync, a new device): the plugin's own pulls
  // create the folder (D12, 2026-10-15).
  const KEEP = "conv-1786422687000-keepme";
  const KEEP_META = `claudian/${KEEP}.meta.json`;
  const UNAVAILABLE = "provider claudian unavailable: no .claudian/sessions directory in this vault";
  const NO_RECORDS = "no Claudian conversation records in this vault";
  const RESTORED_INTO = "Claudian's conversation folder was not in this vault";

  it("creates the folder with what the sync folder has, and still holds what was deleted here", async () => {
    const a = await machine();
    await saveRecord(a, CONV, { providerId: "codex", sessionId: null });
    await saveRecord(a, KEEP, { providerId: "codex", sessionId: null });
    await a.settle();
    await deleteRecord(a, CONV);
    await restarts(a, 1);
    await removeStore(a);

    const first = await pass(a);
    const row = (report: PassReport, rel: string) => report.actions.find((r) => r.neutralRel === rel);
    expect(row(first.report, KEEP_META)).toMatchObject({
      action: "PULL_NEW",
      reason: "remote-only",
      result: "APPLIED",
    });
    expect(row(first.report, META)).toMatchObject({ action: "SKIP_DELETED_HERE", reason: "deleted-here" });
    expect(await exists(local(a, `${KEEP}.meta.json`))).toBe(true);
    expect(await exists(local(a, `${CONV}.meta.json`))).toBe(false);
    // One sentence for what happened, in place of "unavailable" from the
    // claudian provider and "no records" from every CLI provider.
    expect(first.report.notices.filter((n) => n.includes(RESTORED_INTO))).toEqual([
      "Claudian's conversation folder was not in this vault, so it was created with 1 conversation(s) " +
        "from the sync folder. Conversations this device was already keeping off stay off. Sessions " +
        "these conversations use on this device sync from the next sync.",
    ]);
    expect(first.report.notices.filter((n) => n.startsWith("provider claudian unavailable"))).toEqual([]);
    expect(first.report.notices.filter((n) => n.includes(NO_RECORDS))).toEqual([]);

    // The folder the pass created is not a recreation, and what it restored
    // is simply here now.
    const second = await pass(a);
    expect(second.report.notices.filter((n) => n.includes("was recreated"))).toEqual([]);
    expect(row(second.report, KEEP_META)).toMatchObject({ action: "NOOP", reason: "e1-cache-hit" });
    expect(second.report.actions.filter((r) => r.action === "SKIP_DELETED_HERE").map((r) => r.neutralRel)).toEqual([
      META,
    ]);
    expect([first.announcement, second.announcement]).toEqual([null, null]);
    expect((await a.runtime.heldRecords()).map((h) => h.conversationId)).toEqual([CONV]);
  }, 90_000);

  it("still says the provider is unavailable when there is nothing to restore", async () => {
    const a = await machine();
    await a.settle();
    await removeStore(a);

    const { report } = await pass(a);
    expect(report.notices).toContain(UNAVAILABLE);
    expect(report.notices).toContain(`provider claude-code unavailable: ${NO_RECORDS}`);
    expect(report.notices.filter((n) => n.includes(RESTORED_INTO))).toEqual([]);
    expect(await exists(path.join(a.vaultRoot, ".claudian"))).toBe(false);
  }, 60_000);

  it("creates nothing, remembers nothing and claims no restore in a dry run", async () => {
    const a = await machine();
    await saveRecord(a, KEEP, { providerId: "codex", sessionId: null });
    await a.settle();
    const memory = await memoryOf(a);
    const before = await fsp.readFile(memory, "utf8");
    await removeStore(a);

    await a.runtime.syncNow({ dryRun: true });
    const report = a.runtime.lastPassReport() as PassReport;
    expect(report.actions.find((r) => r.neutralRel === KEEP_META)).toMatchObject({
      action: "PULL_NEW",
      result: "DEFERRED",
    });
    expect(await exists(path.join(a.vaultRoot, ".claudian"))).toBe(false);
    expect(await fsp.readFile(memory, "utf8")).toBe(before);
    // Planned is not restored: the line stays what it was.
    expect(report.notices).toContain(UNAVAILABLE);
    expect(report.notices.filter((n) => n.includes(RESTORED_INTO))).toEqual([]);
  }, 60_000);

  it("restores a record whose write failed even when no identity of the folder was ever remembered", async () => {
    // The first pass after upgrading from 0.3.5, which kept no memory file: it
    // is seeded from the ledger, without the store's identity, so the pass
    // after this one cannot tell the folder this one created from a first
    // sighting of it.
    let failing = false;
    const a = await machine("2.3.20", undefined, {
      failWrite: (target) => failing && target.endsWith(path.join(".claudian", "sessions", `${CONV}.meta.json`)),
    });
    await saveRecord(a, CONV, { providerId: "codex", sessionId: null });
    await saveRecord(a, KEEP, { providerId: "codex", sessionId: null });
    await a.settle();
    await fsp.rm(await memoryOf(a));
    await removeStore(a);

    failing = true;
    const first = await pass(a);
    failing = false;
    expect(first.report.actions.find((r) => r.neutralRel === META)).toMatchObject({
      action: "PULL_NEW",
      result: "FAILED_IO",
    });
    expect(await exists(local(a, `${KEEP}.meta.json`)), "nothing created the folder").toBe(true);
    // Counted from what landed: two were to be restored, one was.
    expect(first.report.notices.filter((n) => n.includes(RESTORED_INTO))).toEqual([
      expect.stringContaining("created with 1 conversation(s)"),
    ]);

    const seen = await restarts(a, 2);
    expect(await exists(local(a, `${CONV}.meta.json`)), "held as deleted here").toBe(true);
    expect(seen.rows.filter((r) => r.action === "SKIP_DELETED_HERE")).toEqual([]);
    expect(seen.announcements).toEqual([]);
  }, 90_000);

  it("counts conversations, not the files that came with them", async () => {
    // Claudian 2.3.2 and older keep an inputs sidecar beside each record, and
    // it is restored beside it: two files, one conversation. With no CLI
    // provider on there is no session to speak of either.
    const a = await machine("2.3.2");
    await saveRecord(a, KEEP, { providerId: "codex", sessionId: null });
    await fsp.writeFile(local(a, `${KEEP}.inputs.json`), "{}");
    await a.settle();
    await a.runtime.setProvider("claude-code", { enabled: false });
    await removeStore(a);

    const { report } = await pass(a);
    const landed = report.actions.filter((r) => r.providerId === "claudian" && r.result === "APPLIED");
    expect(landed.map((r) => `${r.action} ${r.neutralRel}`).sort()).toEqual([
      `PULL_NEW claudian/${KEEP}.inputs.json`,
      `PULL_NEW ${KEEP_META}`,
    ]);
    expect(report.notices.filter((n) => n.includes(RESTORED_INTO))).toEqual([
      // Nothing is held here, so nothing is said to be kept off.
      "Claudian's conversation folder was not in this vault, so it was created with 1 conversation(s) " +
        "from the sync folder.",
    ]);
  }, 60_000);

  it("claims no conversation for a deletion marker that came without one", async () => {
    // A device on Claudian 2.3.2 or older deleted it, and left its record and
    // its marker in the sync folder: the record is retired, the marker lands.
    // The folder is created, with no conversation in it to speak of.
    const a = await machine();
    const shared = await replicaOf(a, `${CONV}.meta.json`);
    await fsp.mkdir(path.dirname(shared), { recursive: true });
    await fsp.writeFile(shared, JSON.stringify({ id: CONV, providerId: "codex", sessionId: null }));
    await fsp.writeFile(await replicaOf(a, `${CONV}.deleted.json`), LEGACY_TOMBSTONE);
    await removeStore(a);

    const reports = [(await pass(a)).report, (await pass(a)).report];
    const rows = reports.flatMap((r) => r.actions);
    expect(rows.filter((r) => r.neutralRel === META).map((r) => `${r.action}/${r.reason}`)).toContain(
      "SKIP_RETIRED/tombstoned-in-replica",
    );
    const landed = reports.find((r) =>
      r.actions.some((row) => row.neutralRel === TOMB && row.action === "PULL_NEW" && row.result === "APPLIED"),
    );
    expect(landed, "the marker never landed").toBeDefined();
    expect(landed?.notices).toContain(UNAVAILABLE);
    expect(reports.flatMap((r) => r.notices).filter((n) => n.includes(RESTORED_INTO))).toEqual([]);
    // Retired is settled: a record this device will not land is not carried.
    expect((await memoryFile(a)).recreatedPending).toBeUndefined();
  }, 60_000);

  it("says nothing of a folder that was there, only empty, and the providers' lines stay", async () => {
    // Another device's conversation arriving in an empty folder is an
    // ordinary pull, and at the start of that pass the CLI providers did have
    // no records to admit sessions by.
    const a = await machine();
    const shared = await replicaOf(a, `${KEEP}.meta.json`);
    await fsp.mkdir(path.dirname(shared), { recursive: true });
    await fsp.writeFile(shared, JSON.stringify({ id: KEEP, providerId: "codex", sessionId: null }));

    const reports = [(await pass(a)).report, (await pass(a)).report];
    const landed = reports.find((r) =>
      r.actions.some((row) => row.neutralRel === KEEP_META && row.action === "PULL_NEW" && row.result === "APPLIED"),
    );
    expect(landed, "never pulled").toBeDefined();
    expect(landed?.notices.filter((n) => n.includes(RESTORED_INTO))).toEqual([]);
    expect(landed?.notices).toContain(`provider claude-code unavailable: ${NO_RECORDS}`);
  }, 60_000);
});

describe.each([
  ["not there", removeStore],
  ["recreated", recreate],
] as const)("a record missing from a store that was %s", (_situation, situation) => {
  // A store that is not there, or was recreated, makes every absence this
  // pass "not here yet" — and the pass that sees it is the only one that
  // does: a store this pass recreated or created looks healthy to the next.
  // A record judged so and not landed has to carry that with it, whatever
  // stopped it (ADR-78 ③); one that landed must not. KEEP lands beside it, so
  // that a folder which was not there exists by the end of the pass.
  const KEEP = "conv-1786422687000-keepme";

  async function twoRecords(options: HarnessOptions = {}): Promise<RuntimeHarness> {
    const a = await machine("2.3.20", undefined, options);
    await saveRecord(a, CONV, { providerId: "codex", sessionId: null, title: "one" });
    await saveRecord(a, KEEP, { providerId: "codex", sessionId: null });
    await a.settle();
    return a;
  }

  /** The record lands, on a later pass, and is never held on the way. */
  async function expectRestored(a: RuntimeHarness): Promise<void> {
    const seen = await restarts(a, 2);
    expect(await exists(local(a, `${CONV}.meta.json`)), "held as deleted here").toBe(true);
    expect(await exists(local(a, `${KEEP}.meta.json`))).toBe(true);
    expect(seen.rows.filter((r) => r.action === "SKIP_DELETED_HERE")).toEqual([]);
    expect(seen.announcements).toEqual([]);
    expect(await a.runtime.heldRecords()).toEqual([]);
  }

  const rowOf = (report: PassReport) => report.actions.find((r) => r.neutralRel === META);

  it("is restored on a later pass when its copy in the sync folder was moving at the stability gate", async () => {
    const a = await twoRecords();
    await situation(a);
    const shared = await replicaOf(a, `${CONV}.meta.json`);
    const record = JSON.parse(await fsp.readFile(shared, "utf8")) as Record<string, unknown>;
    await fsp.writeFile(shared, JSON.stringify({ ...record, title: "two" }));

    const { report } = await pass(a);
    expect(rowOf(report)).toMatchObject({ action: "DEFER", reason: "side-unstable" });
    expect(rowOf(report)?.evidence.level, "read after all").toBe("E0/E0");
    await expectRestored(a);
  }, 90_000);

  it("is restored on a later pass when its copy in the sync folder changed after it was read", async () => {
    // The P3:bytes-read moment, from outside: the first stat of the copy
    // after its read is the O3 one, and the copy is rewritten just before it.
    let race: string | null = null;
    let a: RuntimeHarness | null = null;
    a = await twoRecords({
      failLstat: (target) => {
        if (race !== null && target === race && a?.reads.includes(race)) {
          writeFileSync(race, JSON.stringify({ id: CONV, providerId: "codex", sessionId: null, title: "raced" }));
          race = null;
        }
        return false;
      },
    });
    await situation(a);
    a.reads.length = 0;
    race = await replicaOf(a, `${CONV}.meta.json`);

    const { report } = await pass(a);
    expect(race, "the copy was never read").toBeNull();
    expect(rowOf(report)).toMatchObject({ action: "DEFER", reason: "side-unstable" });
    expect(rowOf(report)?.evidence.level, "read, then moved (O3)").toBe("E0/E2");
    await expectRestored(a);
  }, 90_000);

  it("is restored on a later pass when its copy in the sync folder was zero bytes", async () => {
    // Only reachable with a ledger that never saw the copy with bytes — a
    // moved sync folder, a lost ledger: otherwise the empty copy is NR-8 and
    // the whole sync folder is not ready, which judges nothing. That ledger
    // also makes every copy new, so the pass that judges is the second.
    const a = await twoRecords();
    const shared = await replicaOf(a, `${CONV}.meta.json`);
    const whole = await fsp.readFile(shared);
    const ws = (await a.runtime.refresh()).workspaceId as string;
    await fsp.rm(path.join(a.homedir, ".claudian-session-sync", "state", ws, "observations.json"));
    await fsp.writeFile(shared, "");
    await situation(a);
    a.restart();

    expect(rowOf((await pass(a)).report)).toMatchObject({ action: "DEFER", reason: "side-unstable" });
    const { report } = await pass(a);
    expect(rowOf(report)).toMatchObject({ action: "DEFER", reason: "opaque-zero-byte-side" });
    expect(await exists(local(a, `${KEEP}.meta.json`))).toBe(true);
    await fsp.writeFile(shared, whole);
    await expectRestored(a);
  }, 90_000);

  it("is restored on a later pass when writing it failed", async () => {
    let failing = false;
    const a = await twoRecords({
      failWrite: (target) => failing && target.endsWith(path.join(".claudian", "sessions", `${CONV}.meta.json`)),
    });
    await situation(a);

    failing = true;
    const { report } = await pass(a);
    failing = false;
    expect(rowOf(report)).toMatchObject({ action: "PULL_NEW", result: "FAILED_IO" });
    await expectRestored(a);
  }, 90_000);

  it("is restored on a later pass when bringing it back did not write it", async () => {
    // Held, with its release requested: planned rather than short-circuited,
    // and as a held record not among the witnessed ones carried above, so
    // the stat gate is all that carries it. A deletion marker Claudian
    // consumed here, because a store that looks healthy holds that again
    // despite the request; a `.meta.json` is restored by the request itself.
    let failing = false;
    const a = await twoRecords({
      failWrite: (target) =>
        failing && target.endsWith(path.join(".claudian", "sessions", `${CONV}.deleted.json`)),
    });
    // An older device's delete, consumed by this device's Claudian at launch.
    await fsp.writeFile(await replicaOf(a, `${CONV}.deleted.json`), LEGACY_TOMBSTONE);
    await restarts(a, 2);
    expect((await memoryFile(a)).records[TOMB]?.hold?.kind).toBe("tombstone-consumed");
    await situation(a);
    await a.runtime.refresh();

    failing = true;
    expect(await a.runtime.bringBack([TOMB])).toEqual({ ok: true });
    failing = false;
    a.advanceClock(95_000);
    const brought = a.runtime.lastPassReport() as PassReport;
    expect(brought.actions.find((r) => r.neutralRel === TOMB)).toMatchObject({
      action: "PULL_NEW",
      result: "FAILED_IO",
    });

    // Passes, not restarts: Claudian's next launch consumes the marker again,
    // which is what bringing one back comes to and not what this is about.
    const later = [(await pass(a)).report, (await pass(a)).report];
    expect(await exists(local(a, `${CONV}.deleted.json`)), "held again").toBe(true);
    const rows = later.flatMap((r) => r.actions).filter((r) => r.neutralRel === TOMB);
    expect(rows.filter((r) => r.action === "SKIP_DELETED_HERE")).toEqual([]);
    expect((await memoryFile(a)).records[TOMB]?.hold).toBeUndefined();
  }, 90_000);

  it("is restored on a later pass when its copy in the sync folder was gone for that pass", async () => {
    // A peer rewriting it, a sync client between its delete and its create:
    // the record is in neither listing, so no row of the pass ever sees it
    // missing — and the store that pass adopts looks healthy to the next.
    const a = await twoRecords();
    await situation(a);
    const shared = await replicaOf(a, `${CONV}.meta.json`);
    const whole = await fsp.readFile(shared);
    await fsp.rm(shared);

    const { report } = await pass(a);
    expect(rowOf(report), "seen after all").toBeUndefined();
    expect(await exists(local(a, `${KEEP}.meta.json`))).toBe(true);
    await fsp.writeFile(shared, whole);
    await expectRestored(a);
  }, 90_000);

  it("stays carried while its copy in the sync folder stays gone, at the cost of one line in the memory", async () => {
    // Gone from both sides for as long as it likes: no row, no notice, no
    // read, and the memory written once — and the pass the copy is back,
    // judged as the recreation it was missing from.
    const a = await twoRecords();
    await situation(a);
    const shared = await replicaOf(a, `${CONV}.meta.json`);
    const whole = await fsp.readFile(shared);
    await fsp.rm(shared);
    await pass(a);
    const memory = await memoryOf(a);
    const carried = await fsp.readFile(memory, "utf8");
    expect((JSON.parse(carried) as { recreatedPending?: unknown }).recreatedPending).toEqual([META]);

    a.reads.length = 0;
    const seen = await restarts(a, 2);
    expect(await fsp.readFile(memory, "utf8"), "rewritten for it").toBe(carried);
    expect(seen.rows.filter((r) => r.neutralRel === META)).toEqual([]);
    expect(seen.notices.filter((n) => n.includes(CONV) || n.includes("was recreated"))).toEqual([]);
    expect(a.reads.filter((p) => p.includes(CONV))).toEqual([]);

    await fsp.writeFile(shared, whole);
    await expectRestored(a);
    const after = JSON.parse(await fsp.readFile(memory, "utf8")) as { recreatedPending?: unknown };
    expect(after.recreatedPending, "landed, and still carried").toBeUndefined();
  }, 90_000);

  it("is let go once it is here again by other means: deleted after that, it stays deleted", async () => {
    // Carried while its copy in the sync folder is gone, then brought back
    // here by the vault's own sync. Here, it is no longer missing — and a
    // carry that outlived that would undo every later delete of it.
    const a = await twoRecords();
    await situation(a);
    const shared = await replicaOf(a, `${CONV}.meta.json`);
    const whole = await fsp.readFile(shared);
    await fsp.rm(shared);
    await pass(a);
    await fsp.writeFile(local(a, `${CONV}.meta.json`), whole);
    const seen = await restarts(a, 1);
    expect(seen.rows.filter((r) => r.neutralRel === META && r.result === "APPLIED").map((r) => r.action)).toEqual([
      "PUSH_NEW",
    ]);

    await deleteRecord(a, CONV);
    const { report } = await pass(a);
    expect(rowOf(report)).toMatchObject({ action: "SKIP_DELETED_HERE", reason: "deleted-here" });
    expect(await exists(local(a, `${CONV}.meta.json`))).toBe(false);
  }, 90_000);

  it("is let go when it is here again by its turn in the pass: deleted after that, it stays deleted", async () => {
    // Listed nowhere at the start of the pass — the store was not there, or
    // did not have it — and here when its turn comes: the vault's own sync
    // delivering `.claudian/sessions` mid-pass. Here, it is not missing.
    let arriving: { readonly target: string; readonly bytes: Buffer } | null = null;
    const a = await twoRecords({
      failLstat: (target) => {
        if (arriving !== null && target === arriving.target) {
          mkdirSync(path.dirname(target), { recursive: true });
          writeFileSync(target, arriving.bytes);
          arriving = null;
        }
        return false;
      },
    });
    const bytes = await fsp.readFile(local(a, `${CONV}.meta.json`));
    await situation(a);
    arriving = { target: local(a, `${CONV}.meta.json`), bytes };

    const { report } = await pass(a);
    expect(arriving, "it never arrived").toBeNull();
    expect(rowOf(report)).toMatchObject({ action: "DEFER", reason: "side-unstable" });
    expect((await memoryFile(a)).recreatedPending, "carried, although here").toBeUndefined();

    await deleteRecord(a, CONV);
    const after = await pass(a);
    expect(rowOf(after.report)).toMatchObject({ action: "SKIP_DELETED_HERE", reason: "deleted-here" });
    expect(await exists(local(a, `${CONV}.meta.json`))).toBe(false);
  }, 90_000);

  it("is let go when it turns up here just as it is written: deleted after that, it stays deleted", async () => {
    // After its stat and before its write: the pull's last look finds the
    // record in its way and is refused — and the record is here again.
    let arriving: { readonly target: string; readonly bytes: Buffer; looks: number } | null = null;
    const a = await twoRecords({
      failLstat: (target) => {
        if (arriving !== null && target === arriving.target && ++arriving.looks === 2) {
          mkdirSync(path.dirname(target), { recursive: true });
          writeFileSync(target, arriving.bytes);
          arriving = null;
        }
        return false;
      },
    });
    const bytes = await fsp.readFile(local(a, `${CONV}.meta.json`));
    await situation(a);
    arriving = { target: local(a, `${CONV}.meta.json`), bytes, looks: 0 };

    const { report } = await pass(a);
    expect(arriving, "it never arrived").toBeNull();
    expect(rowOf(report)).toMatchObject({ action: "PULL_NEW", result: "ABORTED_PRECONDITION" });
    expect((await memoryFile(a)).recreatedPending, "carried, although here").toBeUndefined();

    await deleteRecord(a, CONV);
    const after = await pass(a);
    expect(rowOf(after.report)).toMatchObject({ action: "SKIP_DELETED_HERE", reason: "deleted-here" });
    expect(await exists(local(a, `${CONV}.meta.json`))).toBe(false);
  }, 90_000);

  it("carries nothing for a record already held here", async () => {
    // Its hold settles it before any judgement, whatever the store did; in
    // the carry it would only be a line in the memory, written for nothing.
    const a = await twoRecords();
    await deleteRecord(a, CONV);
    await restarts(a, 1);
    await situation(a);

    expect(rowOf((await pass(a)).report)).toMatchObject({ action: "SKIP_DELETED_HERE", reason: "deleted-here" });
    const memory = JSON.parse(await fsp.readFile(await memoryOf(a), "utf8")) as { recreatedPending?: unknown };
    expect(memory.recreatedPending).toBeUndefined();
    expect((await a.runtime.heldRecords()).map((h) => h.conversationId)).toEqual([CONV]);
  }, 90_000);

  it("carries nothing for a record held in the same pass", async () => {
    // An older device's deletion marker beside it here and in the sync
    // folder: held as removed by that marker, a verdict reached before the
    // store is asked about — so the pass that missed it settles it too.
    const a = await twoRecords();
    await fsp.writeFile(await replicaOf(a, `${CONV}.deleted.json`), LEGACY_TOMBSTONE);
    await pass(a);
    await pass(a);
    expect(await exists(local(a, `${CONV}.deleted.json`)), "the marker never landed").toBe(true);
    await situation(a);

    expect(rowOf((await pass(a)).report)).toMatchObject({
      action: "SKIP_DELETED_HERE",
      reason: "removed-by-tombstone",
    });
    expect((await memoryFile(a)).recreatedPending).toBeUndefined();
  }, 90_000);

  it("is here from the pass that restored it: deleted straight after, it stays deleted", async () => {
    const a = await twoRecords();
    await situation(a);
    expect(rowOf((await pass(a)).report)).toMatchObject({ action: "PULL_NEW", result: "APPLIED" });

    await deleteRecord(a, CONV);
    const { report } = await pass(a);
    expect(rowOf(report)).toMatchObject({ action: "SKIP_DELETED_HERE", reason: "deleted-here" });
    expect(await exists(local(a, `${CONV}.meta.json`))).toBe(false);
  }, 90_000);
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

describe("the ways a hold ends", () => {
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

    expect(await a.runtime.publishSharedRecord(CONV)).toEqual({ ok: true, replaced: false });
    expect(JSON.parse(await fsp.readFile(local(a, `${CONV}.meta.json`), "utf8")).title).toBe("two");
  }, 60_000);

  it("stops when the lock is taken over while it works", async () => {
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
    await saveRecord(a, CONV, { providerId: "codex", sessionId: null, title: "one" }, { device: DEVICE });
    await a.runtime.syncNow();
    await saveRecord(a, CONV, { providerId: "codex", sessionId: null, title: "two" }, { device: DEVICE });
    await deleteRecord(a, CONV);
    await a.runtime.syncNow();

    const ws = (await a.runtime.refresh()).workspaceId as string;
    const lockFile = path.join(a.homedir, ".claudian-session-sync", "locks", `${ws}.lock`);
    steal = async () => {
      steal = null;
      const held = JSON.parse(await fsp.readFile(lockFile, "utf8")) as { epoch: number };
      await fsp.writeFile(lockFile, JSON.stringify({ ...held, epoch: held.epoch + 1 }));
    };
    const outcome = await a.runtime.publishSharedRecord(CONV);
    expect(steal, "the click never listed this device's folder").toBeNull();
    expect(outcome.ok).toBe(false);
    expect(await exists(local(a, `${CONV}.meta.json`)), "published after the lock was lost").toBe(false);
  }, 60_000);
});
