/**
 * ADR-83: a Codex rollout compressed on this machine is not copied back
 * beside itself — unless the sync folder's copy continues exactly what was
 * compressed.
 *
 * Codex compresses a rollout left untouched for a week into
 * `<name>.jsonl.zst` beside it and removes the plain file (codex-rs
 * `rollout/src/compression.rs`), in `sessions/` and in the archive alike.
 * It reads the plain file whenever both exist, and turns the compressed one
 * back into a plain file when the conversation is resumed. Before this, the
 * next pass read "plain file missing" as "not here yet" and landed the sync
 * folder's copy beside the compressed one; round 10 counted 39 such pairs on
 * one machine (OQ-31) — most likely those landings, which a read-only probe
 * on that machine is to confirm.
 *
 * "Exactly what was compressed" is checked without a decoder: the zstd frame
 * header declares the plain file's length (Codex since rust-v0.151), and a
 * frame that declares none carries the plain file's modification time, which
 * Codex copies onto it.
 *
 * Through the real runtime and the real Codex adapter, on a real filesystem.
 * The plugin reads only a compressed file's frame header, so the fixtures
 * write real zstd frames that do not compress (`zstdRawFrame`).
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PassReport } from "../../src/orchestration/pass-report";
import { describeUnrecognised } from "../../src/providers/codex/rollout-name";
import { RuntimeHarness } from "../helpers/runtime-harness";
import { zstdRawFrame } from "../helpers/zstd-frame";

const SID = "01a003f8-172e-7421-b159-ee512a76e87d";
const OTHER = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const rollout = (id: string, time = "14-49-45") => `rollout-2026-08-15T${time}-${id}.jsonl`;
const DATE = ["2026", "08", "15"] as const;
const DAY = 24 * 60 * 60 * 1000;

const machines: RuntimeHarness[] = [];
afterEach(async () => {
  while (machines.length) await machines.pop()?.dispose();
});

const codexHome = (m: RuntimeHarness) => path.join(m.homedir, ".codex");
const activePath = (m: RuntimeHarness, name: string) => path.join(codexHome(m), "sessions", ...DATE, name);
const archivedPath = (m: RuntimeHarness, name: string) => path.join(codexHome(m), "archived_sessions", name);
const exists = (target: string) =>
  fsp
    .lstat(target)
    .then(() => true)
    .catch(() => false);

async function machine(): Promise<{ m: RuntimeHarness; replica: (name: string) => string }> {
  const m = await RuntimeHarness.create();
  machines.push(m);
  await m.configure();
  await m.runtime.setProvider("codex", { enabled: true });
  const status = await m.runtime.refresh();
  const workspaceId = status.workspaceId as string;
  return { m, replica: (name) => path.join(m.syncDir, workspaceId, "codex", ...DATE, name) };
}

async function record(m: RuntimeHarness, threadId: string): Promise<void> {
  const store = path.join(m.vaultRoot, ".claudian", "sessions");
  await fsp.mkdir(store, { recursive: true });
  await fsp.writeFile(
    path.join(store, `conv-1786422687897-${threadId.slice(0, 8)}.meta.json`),
    JSON.stringify({ id: `conv-1786422687897-${threadId.slice(0, 8)}`, providerId: "codex", sessionId: threadId }),
  );
}

async function write(target: string, text: string | Uint8Array): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, text);
}

const frameOf = (text: string) => zstdRawFrame(new TextEncoder().encode(text));

/**
 * What Codex's compression worker does: a `.zst` beside it carrying the
 * plain file's modification time, then the original removed. Since
 * rust-v0.151 the frame declares the plain file's length; `declareSize: false`
 * is a frame from before that.
 */
async function compress(plain: string, options: { declareSize?: boolean } = {}): Promise<void> {
  const before = await fsp.stat(plain);
  await fsp.writeFile(`${plain}.zst`, zstdRawFrame(await fsp.readFile(plain), options));
  await fsp.utimes(`${plain}.zst`, before.atime, before.mtime);
  await fsp.rm(plain);
}

/** What resuming does: the compressed file back to a plain one, then the `.zst` removed. */
async function materialise(plain: string, text: string): Promise<void> {
  await fsp.writeFile(plain, text);
  await fsp.rm(`${plain}.zst`);
}

/** A rename, as `thread/archive` and `thread/unarchive` do it, whichever form the file is in. */
async function move(from: string, to: string): Promise<void> {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.rename(from, to);
}

async function pass(m: RuntimeHarness): Promise<PassReport> {
  await m.runtime.syncNow();
  m.advanceClock(95_000);
  return m.runtime.lastPassReport() as PassReport;
}

async function passes(m: RuntimeHarness, n: number): Promise<PassReport[]> {
  const out: PassReport[] = [];
  for (let i = 0; i < n; i++) out.push(await pass(m));
  return out;
}

const rowIn = (report: PassReport | undefined, name: string) =>
  report?.actions.find((a) => a.neutralRel.endsWith(name));
const noticesOf = (reports: PassReport[]) => reports.flatMap((r) => r.notices).join("\n");
const fullReadsOf = (m: RuntimeHarness, name: string) => m.reads.filter((read) => read.endsWith(name));

const LINES = '{"type":"session_meta"}\n{"type":"user"}\n';
const MORE = '{"type":"assistant"}\n';
const MINE = '{"type":"mine"}\n';
const LANDED = "continued on another device since";
const UNCOMPARED = "cannot tell whether it continues the compressed one";

/** Synced, then compressed by Codex: the shape most cases below start from. */
async function syncedThenCompressed(options: { declareSize?: boolean } = {}): Promise<{
  m: RuntimeHarness;
  replica: (name: string) => string;
  name: string;
}> {
  const { m, replica } = await machine();
  const name = rollout(SID);
  await record(m, SID);
  await write(activePath(m, name), LINES);
  await m.settle();
  expect(await fsp.readFile(replica(name), "utf8")).toBe(LINES);
  await compress(activePath(m, name), options);
  return { m, replica, name };
}

describe("a rollout Codex compressed on this machine", () => {
  it("is not copied back beside itself when the sync folder holds what was compressed", async () => {
    const { m, replica, name } = await syncedThenCompressed();
    const frame = await fsp.readFile(`${activePath(m, name)}.zst`);
    m.reads.length = 0;

    const reports = await passes(m, 3);

    for (const report of reports) {
      expect(rowIn(report, name)).toMatchObject({ action: "SKIP_COMPRESSED_HERE", reason: "compressed-here" });
    }
    expect(await exists(activePath(m, name))).toBe(false);
    expect(await fsp.readFile(`${activePath(m, name)}.zst`)).toEqual(frame);
    expect(await fsp.readFile(replica(name), "utf8")).toBe(LINES);
    expect(noticesOf(reports)).not.toContain("compressed by Codex on this device");
    // A copy no longer than what was compressed is settled from stats and a
    // header: neither file is read in full, on any pass.
    expect([...fullReadsOf(m, name), ...fullReadsOf(m, `${name}.zst`)]).toEqual([]);
  }, 30_000);

  it.each([
    ["a frame that declares its size", true],
    ["an older frame that declares none, by its modification time", false],
  ])("receives a peer's newer turns beside it, and says so once — %s", async (_shape, declareSize) => {
    const { m, replica, name } = await syncedThenCompressed({ declareSize });
    const frame = await fsp.readFile(`${activePath(m, name)}.zst`);
    await pass(m);
    await fsp.appendFile(replica(name), MORE);

    const reports = await passes(m, 3);

    expect(await fsp.readFile(activePath(m, name), "utf8")).toBe(LINES + MORE);
    expect(await fsp.readFile(`${activePath(m, name)}.zst`)).toEqual(frame);
    const said = reports.flatMap((r) => r.notices).filter((n) => n.includes(LANDED));
    expect(said).toHaveLength(1);
    // The whole id: a Codex id's first characters are a timestamp.
    expect(said[0]).toContain(SID);
    expect(said[0]).toContain("can be deleted");
  }, 30_000);

  it("waits for the sync folder's copy to settle before reading it", async () => {
    const { m, replica, name } = await syncedThenCompressed();
    await pass(m);
    await fsp.appendFile(replica(name), MORE);
    m.reads.length = 0;

    const first = await pass(m);

    expect(rowIn(first, name)).toMatchObject({ action: "DEFER", reason: "side-unstable" });
    expect(fullReadsOf(m, name)).toEqual([]);
    await passes(m, 2);
    expect(await fsp.readFile(activePath(m, name), "utf8")).toBe(LINES + MORE);
  }, 30_000);

  it.each([
    ["a frame that declares its size", true],
    ["an older frame that declares none", false],
  ])(
    "holds back when a turn added here was never seen by a pass before Codex compressed it — %s",
    async (_shape, declareSize) => {
      // The ledger last saw the converged length; the compressed file holds
      // one more turn. A plain file landed beside it would be what Codex reads
      // from then on, and that turn would drop out of sight (review
      // 2026-10-14). The frame's declared size catches it, and for an older
      // frame the modification time does.
      const { m, replica } = await machine();
      const name = rollout(SID);
      await record(m, SID);
      await write(activePath(m, name), LINES);
      await m.settle();
      await new Promise((resolve) => setTimeout(resolve, 20)); // A later modification time.
      await fsp.appendFile(activePath(m, name), MINE);
      await compress(activePath(m, name), { declareSize });
      await fsp.appendFile(replica(name), MORE);

      const reports = await passes(m, 3);

      expect(await exists(activePath(m, name))).toBe(false);
      expect(rowIn(reports[2], name)?.action).toBe("SKIP_COMPRESSED_HERE");
      expect(noticesOf(reports)).toContain(UNCOMPARED);
      expect(noticesOf(reports)).toContain(SID);
    },
    30_000,
  );

  it("holds back when the frame declares a length other than the converged one, whatever its time", async () => {
    // The two witnesses are not combined: a frame that declares a size is
    // judged by it alone, so a modification time that happens to match
    // cannot let a different length through.
    const { m, replica } = await machine();
    const name = rollout(SID);
    await record(m, SID);
    await write(activePath(m, name), LINES);
    await m.settle();
    const seen = await fsp.stat(activePath(m, name));
    await fsp.writeFile(`${activePath(m, name)}.zst`, frameOf(LINES + MINE));
    await fsp.utimes(`${activePath(m, name)}.zst`, seen.atime, seen.mtime);
    await fsp.rm(activePath(m, name));
    await fsp.appendFile(replica(name), MORE);

    const reports = await passes(m, 3);

    expect(await exists(activePath(m, name))).toBe(false);
    expect(rowIn(reports[2], name)?.action).toBe("SKIP_COMPRESSED_HERE");
  }, 30_000);

  it("holds back a copy that is longer but not an extension of what was compressed, and says so", async () => {
    const { m, replica, name } = await syncedThenCompressed();
    await pass(m);
    // Rewound on the peer and continued: longer, but not this machine's history plus more.
    await fsp.writeFile(replica(name), '{"type":"session_meta"}\n{"type":"other"}\n{"type":"more"}\n');

    const reports = await passes(m, 3);

    expect(await exists(activePath(m, name))).toBe(false);
    expect(rowIn(reports[2], name)?.action).toBe("SKIP_COMPRESSED_HERE");
    expect(noticesOf(reports)).toContain(UNCOMPARED);
    expect(noticesOf(reports)).toContain(SID);
    expect(noticesOf(reports)).toContain("quit without sending");
  }, 30_000);

  it("holds back a copy shorter than what was compressed, and says so", async () => {
    // A rewind on the peer: landing it would hide this machine's turns.
    const { m, replica, name } = await syncedThenCompressed();
    await pass(m);
    await fsp.writeFile(replica(name), '{"type":"session_meta"}\n');
    m.reads.length = 0;

    const reports = await passes(m, 3);

    expect(await exists(activePath(m, name))).toBe(false);
    expect(rowIn(reports[2], name)?.action).toBe("SKIP_COMPRESSED_HERE");
    expect(noticesOf(reports)).toContain(UNCOMPARED);
    expect(fullReadsOf(m, name)).toEqual([]);
  }, 30_000);

  it("holds back what it never synced, since it cannot know what the compressed copy holds", async () => {
    const { m, replica } = await machine();
    const name = rollout(SID);
    await write(`${activePath(m, name)}.zst`, frameOf(LINES));
    await write(replica(name), LINES + MORE);

    const reports = await passes(m, 3);

    expect(await exists(activePath(m, name))).toBe(false);
    expect(rowIn(reports[2], name)?.action).toBe("SKIP_COMPRESSED_HERE");
    expect(noticesOf(reports)).toContain(UNCOMPARED);
  }, 30_000);

  it("holds back when this machine had added turns of its own before Codex compressed it", async () => {
    // Seen growing, never converged: the compressed copy holds turns the sync
    // folder does not, and a plain file landed beside it would hide them.
    const { m, replica } = await machine();
    const name = rollout(SID);
    await record(m, SID);
    await write(activePath(m, name), LINES);
    await m.settle();
    await fsp.appendFile(activePath(m, name), MINE);
    await pass(m); // Seen, still settling — not pushed.
    await compress(activePath(m, name));
    await fsp.appendFile(replica(name), MORE);

    const reports = await passes(m, 3);

    expect(await exists(activePath(m, name))).toBe(false);
    expect(rowIn(reports[2], name)?.action).toBe("SKIP_COMPRESSED_HERE");
    expect(noticesOf(reports)).toContain(UNCOMPARED);
  }, 30_000);

  it("calls a sync-folder copy over the size limit too large, and promises no comparison", async () => {
    const { m, replica, name } = await syncedThenCompressed();
    await m.runtime.updateSettings({ maxFileSizeMB: 1 });
    await fsp.appendFile(replica(name), `{"type":"assistant","pad":"${"x".repeat(1_100_000)}"}\n`);
    m.reads.length = 0;

    const reports = await passes(m, 3);

    expect(rowIn(reports[2], name)).toMatchObject({ action: "SKIP_TOO_LARGE", reason: "over-size-limit" });
    expect(noticesOf(reports)).not.toContain(UNCOMPARED);
    expect(fullReadsOf(m, name)).toEqual([]);
    expect(await exists(activePath(m, name))).toBe(false);
  }, 30_000);

  it("counts only a regular file as the compressed form", async () => {
    // A directory of that name is nothing Codex wrote; the session is not
    // here, and lands as it always did.
    const { m, replica } = await machine();
    const name = rollout(SID);
    await record(m, SID);
    await fsp.mkdir(`${activePath(m, name)}.zst`, { recursive: true });
    await write(replica(name), LINES);

    await passes(m, 3);

    expect(await fsp.readFile(activePath(m, name), "utf8")).toBe(LINES);
  }, 30_000);

  it("remembers what it compressed for longer than the ledger keeps an unseen file", async () => {
    // The ledger forgets an entry unseen for thirty days; the plain file is
    // unseen for as long as it stays compressed.
    const { m, replica, name } = await syncedThenCompressed();
    for (let i = 0; i < 4; i++) {
      await m.runtime.syncNow();
      m.advanceClock(10 * DAY);
    }
    await fsp.appendFile(replica(name), MORE);

    await passes(m, 3);

    expect(await fsp.readFile(activePath(m, name), "utf8")).toBe(LINES + MORE);
  }, 30_000);

  it("plans as before once both the plain file and the compressed one are there", async () => {
    const { m, replica, name } = await syncedThenCompressed();
    await write(activePath(m, name), LINES);
    await fsp.appendFile(replica(name), MORE);

    const reports = await passes(m, 3);

    expect(reports.some((r) => rowIn(r, name)?.action === "SKIP_COMPRESSED_HERE")).toBe(false);
    expect(await fsp.readFile(activePath(m, name), "utf8")).toBe(LINES + MORE);
  }, 30_000);

  it("syncs again once resumed and turned back into a plain file", async () => {
    const { m, replica, name } = await syncedThenCompressed();
    await pass(m);
    await materialise(activePath(m, name), LINES);
    await fsp.appendFile(activePath(m, name), '{"type":"resumed"}\n');

    await passes(m, 3);

    expect(await fsp.readFile(replica(name), "utf8")).toBe(`${LINES}{"type":"resumed"}\n`);
  }, 30_000);
});

describe("a compressed rollout and the files-per-pass budget", () => {
  // Both rollouts are only in the sync folder's listing here, whose order is
  // the filesystem's: each case runs with the roles swapped between the two
  // ids, so the one held back comes first in one of them, whatever the
  // filesystem does.
  it.each([
    ["one way round", SID, OTHER],
    ["the other", OTHER, SID],
  ])("a held-back one takes no share of it (%s)", async (_order, compressedId, incomingId) => {
    const { m, replica } = await machine();
    const compressedName = rollout(compressedId);
    await record(m, compressedId);
    await record(m, incomingId);
    await write(activePath(m, compressedName), LINES);
    await m.settle();
    await compress(activePath(m, compressedName));
    await m.runtime.updateSettings({ maxFilesPerPass: 1 });
    const incoming = rollout(incomingId, "11-00-00");
    await write(replica(incoming), LINES);

    const reports = await passes(m, 3);

    for (const report of reports) {
      expect(rowIn(report, compressedName)?.action).toBe("SKIP_COMPRESSED_HERE");
      expect(rowIn(report, incoming)?.reason).not.toBe("budget-exhausted");
    }
    expect(await fsp.readFile(activePath(m, incoming), "utf8")).toBe(LINES);
  }, 30_000);

  it("the read that proves a continuation is charged like any read", async () => {
    // Two compressed rollouts, both continued on a peer, and room for one:
    // proving the second in the same pass would be a second full read.
    const { m, replica } = await machine();
    const names = [rollout(SID), rollout(OTHER, "11-00-00")];
    await record(m, SID);
    await record(m, OTHER);
    for (const name of names) await write(activePath(m, name), LINES);
    await m.settle();
    for (const name of names) await compress(activePath(m, name));
    await m.runtime.updateSettings({ maxFilesPerPass: 1 });
    await pass(m);
    for (const name of names) await fsp.appendFile(replica(name), MORE);

    const reports = await passes(m, 4);

    const turnedAway = reports.flatMap((report) =>
      names.filter((name) => rowIn(report, name)?.reason === "budget-exhausted"),
    );
    expect(turnedAway.length, "both proved in one pass").toBeGreaterThan(0);
    for (const report of reports) {
      const landed = names.filter((name) => rowIn(report, name)?.action === "PULL_NEW");
      expect(landed.length, "more than the budget in one pass").toBeLessThanOrEqual(1);
    }
    for (const name of names) expect(await fsp.readFile(activePath(m, name), "utf8")).toBe(LINES + MORE);
  }, 30_000);
});

describe("a rollout archived here and then compressed (ADR-79 with ADR-83)", () => {
  async function archivedThenCompressed() {
    const { m, replica } = await machine();
    const name = rollout(SID);
    await record(m, SID);
    await write(activePath(m, name), LINES);
    await m.settle();
    await fsp.appendFile(activePath(m, name), MORE);
    await m.settle();
    await move(activePath(m, name), archivedPath(m, name));
    await compress(archivedPath(m, name));
    return { m, replica, name };
  }

  it("is still archived here: not copied back into sessions/", async () => {
    const { m, replica, name } = await archivedThenCompressed();
    await fsp.appendFile(replica(name), '{"type":"peer"}\n');

    const reports = await passes(m, 3);

    expect(rowIn(reports[2], name)).toMatchObject({ action: "SKIP_ARCHIVED_HERE", reason: "archived-here" });
    expect(await exists(activePath(m, name))).toBe(false);
  }, 30_000);

  it("is predicted as archived here by the restore list", async () => {
    const { m, name } = await archivedThenCompressed();

    const row = (await m.runtime.backups()).find((entry) => entry.remote && entry.originalName === name);
    expect(row?.outcome).toBe("archived-here");
  }, 30_000);

  it("receives the peer's turns after it is unarchived, however long it was away", async () => {
    // Codex compresses the archive too, and unarchiving moves the compressed
    // file back into `sessions/`, touched. The converged base ADR-83 decides
    // by has to outlive the ledger's thirty days in the archive.
    const { m, replica, name } = await archivedThenCompressed();
    for (let i = 0; i < 4; i++) {
      await m.runtime.syncNow();
      m.advanceClock(10 * DAY);
    }
    await move(`${archivedPath(m, name)}.zst`, `${activePath(m, name)}.zst`);
    const touched = new Date();
    await fsp.utimes(`${activePath(m, name)}.zst`, touched, touched);
    await fsp.appendFile(replica(name), '{"type":"peer"}\n');

    await passes(m, 3);

    expect(await fsp.readFile(activePath(m, name), "utf8")).toBe(`${LINES}${MORE}{"type":"peer"}\n`);
  }, 30_000);
});

describe("the sync folder audit", () => {
  it("says a session compressed here is on this device", async () => {
    const { m, replica } = await machine();
    const name = rollout(SID);
    await write(`${activePath(m, name)}.zst`, frameOf(LINES));
    await write(replica(name), LINES);

    const audit = await m.runtime.auditSyncFolder();

    if (!audit.ok) throw new Error("audit unavailable");
    expect(audit.audit.unrecorded.map((s) => [s.sessionId, s.here])).toEqual([[SID, "compressed-here"]]);
  }, 30_000);

  it("says a session archived and then compressed is archived here", async () => {
    const { m, replica } = await machine();
    const name = rollout(SID);
    await write(`${archivedPath(m, name)}.zst`, frameOf(LINES));
    await write(replica(name), LINES);

    const audit = await m.runtime.auditSyncFolder();

    if (!audit.ok) throw new Error("audit unavailable");
    expect(audit.audit.unrecorded.map((s) => [s.sessionId, s.here])).toEqual([[SID, "archived-here"]]);
  }, 30_000);

  it("puts an archived copy ahead of a compressed one left in sessions/, as the engine does", async () => {
    // What archiving leaves after a peer's turns landed beside the compressed
    // file: Codex moves the plain one and leaves the `.zst` where it was.
    const { m, replica } = await machine();
    const name = rollout(SID);
    await write(`${activePath(m, name)}.zst`, frameOf(LINES));
    await write(archivedPath(m, name), LINES + MORE);
    await write(replica(name), LINES + MORE);

    const audit = await m.runtime.auditSyncFolder();

    if (!audit.ok) throw new Error("audit unavailable");
    expect(audit.audit.unrecorded.map((s) => [s.sessionId, s.here])).toEqual([[SID, "archived-here"]]);
  }, 30_000);
});

describe("restoring an older version of a rollout compressed here", () => {
  async function withBackupsThenCompressed() {
    const { m, replica } = await machine();
    const name = rollout(SID);
    await record(m, SID);
    await write(activePath(m, name), LINES);
    await m.settle();
    // A push over the sync folder's copy leaves a remote backup…
    await fsp.appendFile(activePath(m, name), MINE);
    await m.settle();
    // …and a pull over this machine's copy, a local one.
    await fsp.appendFile(replica(name), MORE);
    await m.settle();
    expect(await fsp.readFile(activePath(m, name), "utf8")).toBe(LINES + MINE + MORE);
    await compress(activePath(m, name));
    return { m, replica, name };
  }

  it("is refused on this machine: Codex would read it instead of the compressed one", async () => {
    const { m, name } = await withBackupsThenCompressed();

    const row = (await m.runtime.backups()).find((entry) => !entry.remote && entry.originalName === name);
    expect(row?.outcome).toBe("compressed-here");
    const outcome = await m.runtime.restore(row?.path as string, row?.hashPrefix as string, null);

    expect(outcome).toEqual({ ok: false, reason: "target-compressed" });
    expect(await exists(activePath(m, name))).toBe(false);
  }, 30_000);

  it("is predicted as compressed here when put back into the sync folder", async () => {
    const { m, name } = await withBackupsThenCompressed();

    const row = (await m.runtime.backups()).find((entry) => entry.remote && entry.originalName === name);

    expect(row).toBeDefined();
    expect(row?.outcome).toBe("compressed-here");
  }, 30_000);
});

describe("a conflict on a rollout compressed here since", () => {
  async function conflictedThenGone(gone: (m: RuntimeHarness, name: string) => Promise<void>) {
    const { m, replica } = await machine();
    const name = rollout(SID);
    await record(m, SID);
    await write(activePath(m, name), LINES);
    await m.settle();
    await fsp.appendFile(activePath(m, name), '{"type":"here"}\n');
    await fsp.appendFile(replica(name), '{"type":"there"}\n');
    await m.settle();
    expect(rowIn(m.runtime.lastPassReport() as PassReport, name)?.action).toBe("CONFLICT");
    await gone(m, name);
    const entry = (await m.runtime.conflicts()).find((c) => c.neutralRel.endsWith(name));
    return { m, name, entry };
  }

  it("cannot be resolved until it is opened in Codex, and says so rather than 'try again'", async () => {
    const { m, name, entry } = await conflictedThenGone((m, name) => compress(activePath(m, name)));

    expect(entry).toMatchObject({ localCompressed: true, localArchived: false });
    for (const resolution of ["keep-local", "keep-remote"] as const) {
      expect(await m.runtime.resolve(entry?.conflictId as string, resolution)).toEqual({
        ok: false,
        reason: "local-compressed",
      });
    }
    expect(await exists(activePath(m, name))).toBe(false);
  }, 30_000);

  it("counts a compressed copy in the archive as archived", async () => {
    const { m, entry } = await conflictedThenGone(async (m, name) => {
      await move(activePath(m, name), archivedPath(m, name));
      await compress(archivedPath(m, name));
    });

    expect(entry).toMatchObject({ localArchived: true, localCompressed: false });
    expect(await m.runtime.resolve(entry?.conflictId as string, "keep-remote")).toEqual({
      ok: false,
      reason: "local-archived",
    });
  }, 30_000);
});

describe("the census of Codex's sessions folder", () => {
  const compressedName = `rollout-2026-08-06T12-43-59-${SID}.jsonl.zst`;

  it("says what a compressed rollout is and what to do, instead of asking for an update", () => {
    const [sentence, ...rest] = describeUnrecognised([compressedName]);
    expect(rest).toEqual([]);
    expect(sentence).toContain("Codex has compressed 1 of this vault's conversation file(s)");
    expect(sentence).toContain("until you resume it in Codex, which turns it back into a plain file");
    expect(sentence).not.toContain("needs to catch up");
  });

  it("keeps the unknown-name sentence for everything else, alongside", () => {
    const sentences = describeUnrecognised([compressedName, "rollout-2026-08-06T12-43-59-somethingnew.jsonl"]);
    expect(sentences).toHaveLength(2);
    expect(sentences[0]).toContain("1 file(s) this version does not recognise");
    expect(sentences[0]).toContain("somethingnew");
    expect(sentences[0]).not.toContain(".zst");
    expect(sentences[1]).toContain("Codex has compressed 1");
  });

  it("does not call a compressed file of an unrecognised name a compressed rollout", () => {
    const [sentence] = describeUnrecognised(["notarollout.jsonl.zst"]);
    expect(sentence).toContain("does not recognise");
  });

  it("leaves out another vault's compressed conversations when this vault's are known", () => {
    expect(describeUnrecognised([compressedName], new Set([OTHER]))).toEqual([]);
    expect(describeUnrecognised([compressedName], new Set([SID]))).toHaveLength(1);
  });
});
