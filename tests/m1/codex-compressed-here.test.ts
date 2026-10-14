/**
 * ADR-83: a Codex rollout compressed on this machine is not copied back
 * beside itself — unless the sync folder's copy carries turns this machine
 * has not seen.
 *
 * Codex compresses a rollout left untouched for a week into
 * `<name>.jsonl.zst` beside it and removes the plain file (codex-rs
 * `rollout/src/compression.rs`), in `sessions/` and in the archive alike.
 * It reads the plain file whenever both exist, and turns the compressed one
 * back into a plain file when the conversation is resumed. Before this, the
 * next pass read "plain file missing" as "not here yet" and landed the sync
 * folder's copy beside the compressed one; round 10 found 39 such pairs on
 * one machine (OQ-31).
 *
 * Through the real runtime and the real Codex adapter, on a real filesystem.
 * The compressed bytes are never read by the plugin, so the fixtures write a
 * stand-in.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PassReport } from "../../src/orchestration/pass-report";
import { describeUnrecognised } from "../../src/providers/codex/rollout-name";
import { RuntimeHarness } from "../helpers/runtime-harness";

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

async function write(target: string, text: string): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, text);
}

/** What Codex's compression worker does: a `.zst` beside it, then the original removed. */
async function compress(plain: string): Promise<void> {
  await fsp.writeFile(`${plain}.zst`, "(zstd frame)");
  await fsp.rm(plain);
}

/** What resuming does: the compressed file back to a plain one, then the `.zst` removed. */
async function materialise(plain: string, text: string): Promise<void> {
  await fsp.writeFile(plain, text);
  await fsp.rm(`${plain}.zst`);
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

const LINES = '{"type":"session_meta"}\n{"type":"user"}\n';
const MORE = '{"type":"assistant"}\n';

/** Synced, then compressed by Codex: the shape every case below starts from. */
async function syncedThenCompressed(): Promise<{
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
  await compress(activePath(m, name));
  return { m, replica, name };
}

describe("a rollout Codex compressed on this machine", () => {
  it("is not copied back beside itself when the sync folder holds what was compressed", async () => {
    const { m, replica, name } = await syncedThenCompressed();

    const reports = await passes(m, 3);

    for (const report of reports) {
      expect(rowIn(report, name)).toMatchObject({ action: "SKIP_COMPRESSED_HERE", reason: "compressed-here" });
    }
    expect(await exists(activePath(m, name))).toBe(false);
    expect(await fsp.readFile(`${activePath(m, name)}`.concat(".zst"), "utf8")).toBe("(zstd frame)");
    expect(await fsp.readFile(replica(name), "utf8")).toBe(LINES);
    expect(noticesOf(reports)).not.toContain("compressed by Codex on this device");
  }, 30_000);

  it("receives a peer's newer turns beside it, and says so once", async () => {
    const { m, replica, name } = await syncedThenCompressed();
    await pass(m);
    await fsp.appendFile(replica(name), MORE);

    const reports = await passes(m, 3);

    expect(await fsp.readFile(activePath(m, name), "utf8")).toBe(LINES + MORE);
    expect(await fsp.readFile(`${activePath(m, name)}.zst`, "utf8")).toBe("(zstd frame)");
    const said = reports.flatMap((r) => r.notices).filter((n) => n.includes("received newer turns"));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("1 conversation(s)");
  }, 30_000);

  it("holds back a copy that is longer but not an extension of what was compressed, and says so", async () => {
    const { m, replica, name } = await syncedThenCompressed();
    await pass(m);
    // Rewound on the peer and continued: longer, but not this machine's history plus more.
    await fsp.writeFile(replica(name), '{"type":"session_meta"}\n{"type":"other"}\n{"type":"more"}\n');

    const reports = await passes(m, 3);

    expect(await exists(activePath(m, name))).toBe(false);
    expect(rowIn(reports[2], name)?.action).toBe("SKIP_COMPRESSED_HERE");
    expect(noticesOf(reports)).toContain("cannot compare it with the compressed one");
    expect(noticesOf(reports)).toContain(SID.slice(0, 8));
  }, 30_000);

  it("holds back a copy shorter than what was compressed", async () => {
    // A rewind on the peer: landing it would hide this machine's turns.
    const { m, replica, name } = await syncedThenCompressed();
    await pass(m);
    await fsp.writeFile(replica(name), '{"type":"session_meta"}\n');

    const reports = await passes(m, 3);

    expect(await exists(activePath(m, name))).toBe(false);
    expect(rowIn(reports[2], name)?.action).toBe("SKIP_COMPRESSED_HERE");
  }, 30_000);

  it("holds back what it never synced, since it cannot know what the compressed copy holds", async () => {
    const { m, replica } = await machine();
    const name = rollout(SID);
    await write(`${activePath(m, name)}.zst`, "(zstd frame)");
    await write(replica(name), LINES + MORE);

    const reports = await passes(m, 3);

    expect(await exists(activePath(m, name))).toBe(false);
    expect(rowIn(reports[2], name)?.action).toBe("SKIP_COMPRESSED_HERE");
    expect(noticesOf(reports)).toContain("cannot compare it with the compressed one");
  }, 30_000);

  it("holds back when this machine had added turns of its own before Codex compressed it", async () => {
    // Seen growing, never converged: the compressed copy holds turns the sync
    // folder does not, and a plain file landed beside it would hide them.
    const { m, replica } = await machine();
    const name = rollout(SID);
    await record(m, SID);
    await write(activePath(m, name), LINES);
    await m.settle();
    await fsp.appendFile(activePath(m, name), '{"type":"mine"}\n');
    await pass(m); // Seen, still settling — not pushed.
    await compress(activePath(m, name));
    await fsp.appendFile(replica(name), MORE);

    const reports = await passes(m, 3);

    expect(await exists(activePath(m, name))).toBe(false);
    expect(rowIn(reports[2], name)?.action).toBe("SKIP_COMPRESSED_HERE");
    expect(noticesOf(reports)).toContain("cannot compare it with the compressed one");
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

  it("does not take a share of the files-per-pass budget", async () => {
    const { m, replica, name } = await syncedThenCompressed();
    await m.runtime.updateSettings({ maxFilesPerPass: 1 });
    const incoming = rollout(OTHER, "11-00-00");
    await write(replica(incoming), LINES);

    const reports = await passes(m, 3);

    for (const report of reports) expect(rowIn(report, name)?.action).toBe("SKIP_COMPRESSED_HERE");
    expect(await fsp.readFile(activePath(m, incoming), "utf8")).toBe(LINES);
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
    await fsp.mkdir(path.dirname(archivedPath(m, name)), { recursive: true });
    await fsp.rename(activePath(m, name), archivedPath(m, name));
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

  it("is predicted as archived here by the restore list, and shown so by the audit", async () => {
    const { m, name } = await archivedThenCompressed();

    const row = (await m.runtime.backups()).find((entry) => entry.remote && entry.originalName === name);
    expect(row?.outcome).toBe("archived-here");
    const audit = await m.runtime.auditSyncFolder();
    if (!audit.ok) throw new Error("audit unavailable");
    expect(audit.audit.unrecorded).toEqual([]);
  }, 30_000);
});

describe("the sync folder audit", () => {
  it("says a session compressed here is on this device", async () => {
    const { m, replica } = await machine();
    const name = rollout(SID);
    await write(`${activePath(m, name)}.zst`, "(zstd frame)");
    await write(replica(name), LINES);

    const audit = await m.runtime.auditSyncFolder();

    if (!audit.ok) throw new Error("audit unavailable");
    expect(audit.audit.unrecorded.map((s) => [s.sessionId, s.here])).toEqual([[SID, "compressed-here"]]);
  }, 30_000);
});

describe("the census of Codex's sessions folder", () => {
  const compressedName = `rollout-2026-08-06T12-43-59-${SID}.jsonl.zst`;

  it("says what a compressed rollout is and what to do, instead of asking for an update", () => {
    const [sentence, ...rest] = describeUnrecognised([compressedName]);
    expect(rest).toEqual([]);
    expect(sentence).toContain("Codex has compressed 1 conversation file(s)");
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
});
