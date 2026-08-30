/**
 * Grok, end to end (architecture §6.6.1, ADR-52).
 *
 * The first provider whose session is a *directory*, and whose members do not
 * agree about how they are written: `chat_history.jsonl` is appended,
 * `summary.json` is rewritten whole every turn. So the properties under test
 * are not "does a file travel" — that is settled — but the three things a
 * mixed-mode group can get wrong:
 *
 *  1. the members are carried with the right table each, and the ones the CLI
 *     rebuilds are left where they are;
 *  2. the primary lands last, so a session being created is never visible
 *     half-written (G1);
 *  3. a disagreement about one member does not freeze the others, because the
 *     CLI was measured to self-heal a mixed-age group.
 *
 * Driven through the whole runtime, because the ordering and the budget rule
 * live in the pass, not in the adapter.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ActionEntry } from "../../src/orchestration/pass-report";
import { describeConflict } from "../../src/ui/conflict-modal";
import { RuntimeHarness } from "../helpers/runtime-harness";

const SID = "01a02f27-c1aa-7aa1-9580-e4188952ef3b";
const OTHER_SID = "01a02f3c-9d1b-7c44-8e02-6a5f0c93de71";

// Each case drives at least one `settle()` — three real passes over a real
// filesystem — so they carry explicit timeouts rather than vitest's 5 s
// default, for the reason `conflict-commands.test.ts` states: on a busy
// machine the default turns load into a failure report.
const machines: RuntimeHarness[] = [];
afterEach(async () => {
  while (machines.length) await machines.pop()?.dispose();
});

async function withGrok(): Promise<RuntimeHarness> {
  const machine = await RuntimeHarness.create();
  machines.push(machine);
  await machine.configure();
  await machine.runtime.setProvider("grok", { enabled: true });
  await machine.runtime.refresh();
  return machine;
}

async function peerWithGrok(other: RuntimeHarness): Promise<RuntimeHarness> {
  const peer = await RuntimeHarness.createPeer(other);
  machines.push(peer);
  await peer.runtime.setProvider("grok", { enabled: true });
  await peer.runtime.refresh();
  return peer;
}

const replicaDir = async (machine: RuntimeHarness, sessionId: string): Promise<string> => {
  const status = await machine.runtime.refresh();
  return path.join(machine.syncDir, status.workspaceId as string, "grok", sessionId);
};

describe("a session that is a directory", () => {
  it("carries the members that matter and leaves the rebuildable ones alone", async () => {
    const machine = await withGrok();
    await machine.writeGrokSession(SID, { turns: 3 });

    await machine.settle();

    const landed = (await fsp.readdir(await replicaDir(machine, SID))).sort();
    expect(landed).toEqual(["chat_history.jsonl", "summary.json", "updates.jsonl"]);
    // Every one of these exists locally and stayed there. Named individually
    // rather than left to the equality above, so the reason each is excluded is
    // on the record: three are rebuilt by the CLI (one of them holding this
    // machine's own paths), two are counters, and the locks are flock handles
    // that are always zero bytes.
    for (const excluded of [
      "prompt_context.json",
      "system_prompt.txt",
      "events.jsonl",
      "signals.json",
      "title_refresh_idx",
      "summary.json.lock",
      "chat_history.jsonl.lock",
    ]) {
      await expect(fsp.stat(machine.grokPath(SID, excluded)), excluded).resolves.toBeTruthy();
    }
  }, 30_000);

  it("writes the primary last, so a half-landed session is never listed", async () => {
    // G1 as an ordering fact. Until `summary.json` is there the CLI does not
    // show the session, so the window in which a creation is incomplete is the
    // gap between two writes in one pass rather than a gap between passes.
    const machine = await withGrok();
    await machine.writeGrokSession(SID, { turns: 2 });

    await machine.settle();

    const report = machine.runtime.lastPassReport();
    const written = (report?.actions ?? [])
      .filter((action) => action.neutralRel.startsWith(`grok/${SID}/`))
      .map((action) => action.neutralRel);
    expect(written.length).toBeGreaterThan(1);
    expect(written[written.length - 1]).toBe(`grok/${SID}/summary.json`);
  }, 30_000);

  it("lands on a machine that has never used Grok in this vault", async () => {
    // The case the whole feature exists for: B wants to continue A's
    // conversation, so B by definition has no project directory for it yet.
    const a = await withGrok();
    await a.writeGrokSession(SID, { turns: 4 });
    await a.settle();

    const b = await peerWithGrok(a);
    await expect(fsp.stat(b.grokProjectDir)).rejects.toThrow();

    await b.settle();

    expect((await fsp.readdir(path.join(b.grokProjectDir, SID))).sort()).toEqual([
      "chat_history.jsonl",
      "summary.json",
      "updates.jsonl",
    ]);
    expect(await fsp.readFile(b.grokPath(SID, "chat_history.jsonl"), "utf8")).toBe(
      await fsp.readFile(a.grokPath(SID, "chat_history.jsonl"), "utf8"),
    );
    // The identity carrier arrived intact: `info.id` must still equal the
    // directory name, or the CLI does not recognise the session at all.
    const summary = JSON.parse(await fsp.readFile(b.grokPath(SID, "summary.json"), "utf8"));
    expect(summary.info.id).toBe(SID);
  }, 30_000);

  it("appends the history and fast-forwards the record, in one pass", async () => {
    const machine = await withGrok();
    await machine.writeGrokSession(SID, { turns: 2 });
    await machine.settle();

    // A turn happens: the history grows by append, the record is rewritten
    // whole. Two tables, one session, one pass.
    await machine.writeGrokSession(SID, { turns: 1, rev: 2 });
    const seen: ActionEntry[] = [];
    for (let i = 0; i < 3; i++) {
      await machine.runtime.syncNow();
      machine.advanceClock(95_000);
      seen.push(
        ...(machine.runtime.lastPassReport()?.actions.filter((a) =>
          a.neutralRel.startsWith(`grok/${SID}/`),
        ) ?? []),
      );
    }

    expect(seen.some((a) => a.action === "CONFLICT")).toBe(false);
    const summary = seen.find(
      (a) => a.neutralRel.endsWith("summary.json") && a.action === "PUSH_OVERWRITE",
    );
    expect(summary?.reason).toBe("remote-at-converged-base");
    expect(summary?.backupPath).toBeTruthy(); // I1: the replaced version was kept
    const dir = await replicaDir(machine, SID);
    expect(JSON.parse(await fsp.readFile(path.join(dir, "summary.json"), "utf8")).rev).toBe(2);
    expect((await fsp.readFile(path.join(dir, "chat_history.jsonl"), "utf8")).trim().split("\n")).toHaveLength(3);
  }, 60_000);

  it("keeps merging the history while the record is in conflict", async () => {
    // ADR-52's non-interlocking rule, and the one case that distinguishes it:
    // B continued the conversation, A only reopened it. The history is a clean
    // prefix relationship and must merge; the two records both moved and must
    // not be guessed at. Freezing the history because the record disagrees
    // would turn a state the CLI self-heals into one that needs a person.
    const a = await withGrok();
    await a.writeGrokSession(SID, { turns: 2 });
    await a.settle();

    const b = await peerWithGrok(a);
    await b.settle(); // b now holds the same bytes, and a converged base

    await b.writeGrokSession(SID, { turns: 2, rev: 5 }); // a real turn
    await b.settle();
    // A only opened the session: measured behaviour is that the TUI rewrites
    // summary.json without adding to the history.
    await a.writeGrokSession(SID, { turns: 0, rev: 9 });
    // Collected per pass rather than read once at the end: the pull lands in
    // whichever pass first finds both sides stable, and by the last one it is
    // a NOOP — which would make this assert nothing.
    const actions: ActionEntry[] = [];
    for (let i = 0; i < 3; i++) {
      await a.runtime.syncNow();
      a.advanceClock(95_000);
      actions.push(
        ...(a.runtime.lastPassReport()?.actions.filter((x) =>
          x.neutralRel.startsWith(`grok/${SID}/`),
        ) ?? []),
      );
    }

    // The decisive action for each member, not the first: the earliest passes
    // report DEFER while the stability window elapses, and the last ones NOOP
    // once the two sides agree.
    const decisive = (member: string) =>
      actions.find(
        (x) => x.neutralRel === `grok/${SID}/${member}` && x.action !== "DEFER" && x.action !== "NOOP",
      );
    const summary = decisive("summary.json");
    const chat = decisive("chat_history.jsonl");
    expect(summary?.action).toBe("CONFLICT");
    expect(chat?.action).toBe("PULL_OVERWRITE");
    // B's turns are on A's disk despite the conflict beside them.
    const history = await fsp.readFile(a.grokPath(SID, "chat_history.jsonl"), "utf8");
    expect(history.trim().split("\n")).toHaveLength(4);
  }, 60_000);

  it("defers the whole group rather than splitting it across passes", async () => {
    // §6.6.1: splitting would land the history now and the commit point
    // minutes later, and for that window the session is reachable by
    // `--resume <id>` with a truncated history — the id arriving separately
    // through the vault's own Claudian record.
    //
    // Two sessions and a budget of four, so the first group spends three and
    // the second finds one left. A single oversized group would prove nothing:
    // the rule has a floor, and a group that cannot fit an *untouched* budget
    // runs alone rather than deferring for ever.
    const other = "01a02f3c-8efb-7162-9974-a56283c564c7";
    const machine = await withGrok();
    await machine.writeGrokSession(SID, { turns: 2 });
    await machine.writeGrokSession(other, { turns: 2 });
    await machine.runtime.updateSettings({ maxFilesPerPass: 4 });

    await machine.settle();

    const report = machine.runtime.lastPassReport();
    const bySession = (id: string) =>
      (report?.actions ?? []).filter((a) => a.neutralRel.startsWith(`grok/${id}/`));
    const deferred = [SID, other].map(bySession).find((rows) =>
      rows.length > 0 && rows.every((a) => a.action === "DEFER" && a.result === "SKIPPED_BUDGET"),
    );
    expect(deferred, "one group must have found the budget spent").toBeDefined();
    // Whole, not partly: three members, all waiting, nothing in the replica.
    expect(deferred).toHaveLength(3);
    const waiting = (deferred ?? [])[0]?.neutralRel.split("/")[1] as string;
    await expect(fsp.readdir(await replicaDir(machine, waiting))).rejects.toThrow();
  }, 30_000);

  it("runs a group larger than the whole budget rather than deferring it for ever", async () => {
    // The floor. Without it, `maxFilesPerPass` below a group's size is a
    // setting that silently stops one provider from ever syncing — the budget
    // resets each pass and the group never gets smaller.
    const machine = await withGrok();
    await machine.writeGrokSession(SID, { turns: 2 });
    await machine.runtime.updateSettings({ maxFilesPerPass: 1 });

    await machine.settle();

    expect((await fsp.readdir(await replicaDir(machine, SID))).sort()).toEqual([
      "chat_history.jsonl",
      "summary.json",
      "updates.jsonl",
    ]);
  }, 30_000);

  it("does not push a directory that has no summary.json", async () => {
    // No primary, no commit point: pushing the history alone would put a
    // session in the sync folder that no machine can ever show.
    const machine = await withGrok();
    await machine.writeGrokSession(SID, { turns: 2 });
    await fsp.rm(machine.grokPath(SID, "summary.json"));

    await machine.settle();

    const status = await machine.runtime.refresh();
    await expect(
      fsp.readdir(path.join(machine.syncDir, status.workspaceId as string, "grok")),
    ).rejects.toThrow();
  }, 30_000);

  it("refuses a member it does not recognise, and says so instead of writing it", async () => {
    // §8.2 layer 1 on the remote side: another machine's sync tool can put
    // anything in that directory, and a name outside the whitelist must be
    // reported where it lies rather than copied into the CLI's own folder.
    const a = await withGrok();
    await a.writeGrokSession(SID, { turns: 1 });
    await a.settle();

    const dir = await replicaDir(a, SID);
    await fsp.writeFile(path.join(dir, "summary.json.lock"), "");
    await fsp.writeFile(path.join(dir, "chat_history.jsonl.sync-conflict-20260824.jsonl"), "x\n");

    const b = await peerWithGrok(a);
    await b.settle();

    const landed = (await fsp.readdir(path.join(b.grokProjectDir, SID))).sort();
    expect(landed).toEqual(["chat_history.jsonl", "summary.json", "updates.jsonl"]);
    const unknown = (b.runtime.lastPassReport()?.unknownFiles ?? []).map((u) => u.neutralRel);
    expect(unknown).toContain(`grok/${SID}/summary.json.lock`);
    expect(unknown).toContain(`grok/${SID}/chat_history.jsonl.sync-conflict-20260824.jsonl`);
  }, 30_000);

  it("does not admit a session the vault has no Claudian record for", async () => {
    // ADR-47, on a provider whose storage is shared by every project on the
    // machine: without admission this would push conversations from folders
    // that have nothing to do with this vault.
    //
    // Two sessions, one recorded — otherwise an empty record store would make
    // the provider unavailable outright and the assertion would hold for a
    // reason that has nothing to do with admission.
    const recorded = "01a02f3c-8efb-7162-9974-a56283c564c7";
    const machine = await withGrok();
    await machine.writeGrokSession(recorded, { turns: 2 });
    await machine.writeGrokSession(SID, { turns: 2, record: false });

    await machine.settle();

    const status = await machine.runtime.refresh();
    const pushed = await fsp.readdir(path.join(machine.syncDir, status.workspaceId as string, "grok"));
    expect(pushed).toEqual([recorded]);
  }, 30_000);
  it("waits rather than assembling a session whose commit point is not there yet", async () => {
    // The other machine's push was interrupted, so the sync folder holds a
    // history with no summary.json. Landing it would create a directory the
    // CLI does not list — and a resume aimed at that id was measured writing
    // the user's next turn into a *different* conversation, so "wait a pass"
    // is cheap and "assemble it" is not.
    const a = await withGrok();
    await a.writeGrokSession(SID, { turns: 2 });
    await a.settle();
    const dir = await replicaDir(a, SID);
    await fsp.rm(path.join(dir, "summary.json"));

    const b = await peerWithGrok(a);
    await b.settle();

    const actions = (b.runtime.lastPassReport()?.actions ?? []).filter((x) =>
      x.neutralRel.startsWith(`grok/${SID}/`),
    );
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((x) => x.reason === "primary-not-in-replica")).toBe(true);
    await expect(fsp.stat(path.join(b.grokProjectDir, SID))).rejects.toThrow();
  }, 30_000);

  it("says so for the quiet tear too, not only when a write errors", async () => {
    // The common way a group tears has no error in it at all: the sync tool is
    // still writing `summary.json` while the history files have already gone
    // quiet, so the aux members land and the primary defers on stability. The
    // directory is left in exactly the state the notice exists to warn about,
    // and keying the warning on FAILED_* alone would say nothing here.
    const a = await withGrok();
    await a.writeGrokSession(SID, { turns: 2 });
    await a.settle();

    const b = await peerWithGrok(a);
    const replicaSummary = path.join(await replicaDir(a, SID), "summary.json");
    const notices: string[] = [];
    for (let i = 0; i < 3; i++) {
      // Rewritten before every pass, so it never accumulates quiet time while
      // its siblings do. Nothing here fails; the primary is simply never ready.
      await fsp.writeFile(replicaSummary, JSON.stringify({ info: { id: SID }, tick: i }, null, 2));
      await b.runtime.syncNow();
      b.advanceClock(95_000);
      notices.push(...(b.runtime.lastPassReport()?.notices ?? []));
    }

    await expect(fsp.stat(b.grokPath(SID, "chat_history.jsonl"))).resolves.toBeTruthy();
    await expect(fsp.stat(b.grokPath(SID, "summary.json"))).rejects.toThrow();
    expect(notices.join(" ")).toContain("do not open it in the CLI");
  }, 30_000);

  it("says so when part of a group landed and its commit point did not", async () => {
    // ADR-30 does not roll back — rolling back is a fresh destructive write in
    // an already-failing state. So the half-written state is announced instead,
    // because between this pass and the next one the user could open it.
    const a = await withGrok();
    await a.writeGrokSession(SID, { turns: 2 });
    await a.settle();

    const b = await RuntimeHarness.createPeer(a, {
      failWrite: (target) => target.includes(".grok") && target.includes("summary.json"),
    });
    machines.push(b);
    await b.runtime.setProvider("grok", { enabled: true });
    await b.runtime.refresh();
    // Collected across passes: the tear happens in the pass where the aux
    // members land, and by the next one they are NOOPs — nothing is being
    // written any more, so there is nothing to warn about a second time.
    const notices: string[] = [];
    for (let i = 0; i < 3; i++) {
      await b.runtime.syncNow();
      b.advanceClock(95_000);
      notices.push(...(b.runtime.lastPassReport()?.notices ?? []));
    }

    expect(notices.join(" ")).toContain("do not open it in the CLI");
    // The history did land, which is exactly why the notice is needed.
    await expect(fsp.stat(b.grokPath(SID, "chat_history.jsonl"))).resolves.toBeTruthy();
    await expect(fsp.stat(b.grokPath(SID, "summary.json"))).rejects.toThrow();
  }, 30_000);
});

describe("backups of a provider whose file names repeat across sessions", () => {
  // Every Grok session holds a file called `chat_history.jsonl`. Nothing before
  // this provider did that: Claude Code's, Codex's and Claudian's file names all
  // contain the session id, so "which session is this backup from" was answerable
  // from the name alone and the whole backup area could stay one flat directory
  // per provider. It is not answerable any more.
  const OTHER = "01a02f3c-8efb-7162-9974-a56283c564c7";

  it("restores into the session it came from, not another one with the same file name", async () => {
    const machine = await withGrok();
    await machine.writeGrokSession(SID, { turns: 2 });
    await machine.writeGrokSession(OTHER, { turns: 2 });
    await machine.settle();

    // One session gets a second version, so its replica copy is overwritten and
    // a backup is taken. Deliberately the session that sorts FIRST, because a
    // name-keyed lookup resolves to whichever session was seen last — so
    // backing up the last one would agree with the bug by accident.
    await machine.writeGrokSession(SID, { turns: 2, rev: 2 });
    for (let i = 0; i < 3; i++) {
      await machine.runtime.syncNow();
      machine.advanceClock(95_000);
    }
    const untouched = await fsp.readFile(machine.grokPath(OTHER, "chat_history.jsonl"), "utf8");

    const backups = await machine.runtime.backups();
    const history = backups.filter((b) => b.originalName === "chat_history.jsonl");
    expect(history.length, "the scenario needs a chat_history backup to exist").toBeGreaterThan(0);

    for (const entry of history) {
      // Whatever the row claims, it must claim it about the session the bytes
      // actually came from — and a restore must land there and nowhere else.
      expect(entry.neutralRel).toBe(`grok/${SID}/chat_history.jsonl`);
      await machine.runtime.restore(entry.path, entry.hashPrefix, entry.liveHashPrefix);
    }

    expect(
      await fsp.readFile(machine.grokPath(OTHER, "chat_history.jsonl"), "utf8"),
      "restoring another session's backup must not touch this session",
    ).toBe(untouched);
  }, 60_000);
});

describe("what stays on this machine, and whether anyone measured it", () => {
  it("names only the members whose absence nobody checked", async () => {
    const a = await withGrok();
    await a.writeGrokSession(SID, { turns: 2 });
    await a.settle();

    const omissions = a.runtime.lastPassReport()?.unprovenOmissions ?? [];
    const names = omissions.map((o) => o.name);

    // `signals.json` is in the fixture and its removal was never tested
    // (2026-08-24 residual 3), so it is named.
    expect(names).toContain("signals.json");
    // These four were each moved away on both platforms and the session stayed
    // listed and resumed intact, so naming them would be noise, not news.
    for (const measured of [
      "prompt_context.json",
      "system_prompt.txt",
      "events.jsonl",
      "title_refresh_idx",
    ]) {
      expect(names, `${measured} has removal evidence`).not.toContain(measured);
    }
    // Locks are flock handles, measured at zero bytes in every snapshot.
    expect(names.filter((n) => n.endsWith(".lock"))).toEqual([]);
    // And nothing that actually travels.
    for (const carried of ["chat_history.jsonl", "updates.jsonl", "summary.json"]) {
      expect(names).not.toContain(carried);
    }
  }, 30_000);

  it("names the directory /compact moves the conversation into", async () => {
    // The case this exists for. `compaction/` was already in the 2026-08-24
    // census and its exclusion was a recorded decision, so a "names we have
    // never seen" detector would have said nothing while 36,811 B of
    // conversation stopped travelling. The evidential line catches it.
    const a = await withGrok();
    await a.writeGrokSession(SID, { turns: 2 });
    await fsp.mkdir(path.join(path.dirname(a.grokPath(SID, "summary.json")), "compaction"), {
      recursive: true,
    });
    await fsp.writeFile(
      path.join(path.dirname(a.grokPath(SID, "summary.json")), "compaction", "segment_000.md"),
      "# compacted away\n",
    );
    await a.settle();

    const names = (a.runtime.lastPassReport()?.unprovenOmissions ?? []).map((o) => o.name);
    expect(names, "a directory is named by its own name, not walked").toContain("compaction/");
  }, 30_000);

  it("counts a name once per provider, however many sessions hold it", async () => {
    // Twenty sessions all holding `signals.json` is one fact about the
    // provider, not twenty lines about sessions.
    const a = await withGrok();
    await a.writeGrokSession(SID, { turns: 2 });
    await a.writeGrokSession(OTHER_SID, { turns: 2 });
    await a.settle();

    const signals = (a.runtime.lastPassReport()?.unprovenOmissions ?? []).filter(
      (o) => o.name === "signals.json",
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]?.sessions).toBe(2);
    expect(signals[0]?.providerId).toBe("grok");
  }, 30_000);
});

describe("a rewind, which shortens the history on purpose (OQ-14)", () => {
  /** What a Grok rewind does to the file: keep the first `keep` records. */
  async function rewind(machine: RuntimeHarness, keep: number): Promise<number> {
    const history = machine.grokPath(SID, "chat_history.jsonl");
    const lines = (await fsp.readFile(history, "utf8")).split("\n").filter(Boolean);
    const kept = `${lines.slice(0, keep).join("\n")}\n`;
    await fsp.writeFile(history, kept);
    // The CLI rewrites the record too — measured: `summary.json` changes on a
    // rewind, and on a bare resume for that matter.
    const summaryPath = machine.grokPath(SID, "summary.json");
    const summary = JSON.parse(await fsp.readFile(summaryPath, "utf8")) as Record<string, unknown>;
    await fsp.writeFile(summaryPath, JSON.stringify({ ...summary, rewound: true }));
    return kept.length;
  }

  it("survives the next pass instead of being silently pulled back", async () => {
    // Reproduced end to end before the fix: 210 B / 6 lines -> rewind to
    // 140 B / 4 lines -> one settle -> 210 B / 6 lines again, with an empty
    // notices list. One machine is enough; what undid the rewind was this
    // machine's own earlier push sitting in the sync folder.
    const a = await withGrok();
    await a.writeGrokSession(SID, { turns: 6 });
    await a.settle();

    const rewoundSize = await rewind(a, 4);
    await a.settle();

    const after = await fsp.stat(a.grokPath(SID, "chat_history.jsonl"));
    expect(after.size, "the rewind was undone").toBe(rewoundSize);

    const actions = a.runtime.lastPassReport()?.actions ?? [];
    const history = actions.find((entry) => entry.neutralRel?.endsWith("chat_history.jsonl"));
    expect(history?.action).toBe("CONFLICT");
    expect(history?.reason).toBe("local-shrank-below-converged");
  }, 60_000);

  it("holds the record back rather than publishing it beside the old history", async () => {
    // The group's two tables disagree about direction: the history conflicts
    // while `summary.json` reads as `remote-at-converged-base` and would push.
    // Landing that pushes the post-rewind record into the sync folder next to
    // the pre-rewind history — a pairing neither machine ever held.
    const a = await withGrok();
    await a.writeGrokSession(SID, { turns: 6 });
    await a.settle();

    await rewind(a, 4);
    await a.settle();

    const replicaSummary = path.join(await replicaDir(a, SID), "summary.json");
    const published = JSON.parse(await fsp.readFile(replicaSummary, "utf8")) as { rewound?: boolean };
    expect(published.rewound, "the post-rewind record was published anyway").toBeUndefined();

    const actions = a.runtime.lastPassReport()?.actions ?? [];
    const summary = actions.find((entry) => entry.neutralRel?.endsWith("summary.json"));
    expect(summary?.reason).toBe("group-member-in-conflict");
  }, 60_000);

  it("names the session when a peer's history really does replace this machine's", async () => {
    // §9.1.6 mitigation 2, "M1 必做": the hazard is that the CLI has this
    // session open right now and its state has gone stale underneath. That is
    // true whatever the merge mode, and until now only whole-file records said
    // anything at all.
    const a = await withGrok();
    await a.writeGrokSession(SID, { turns: 2 });
    await a.settle();

    // Both machines start from the same two turns — `writeGrokSession` numbers
    // turns from the file's length, so the bytes are identical and the pair is
    // converged, which is what makes the next step a plain fast-forward.
    const b = await peerWithGrok(a);
    await b.writeGrokSession(SID, { turns: 2 });
    await b.settle();

    await a.appendGrokRaw(SID, '{"type":"user","content":"from A"}\n');
    await a.settle();

    // One pass at a time, not `settle()`: a settle is three passes and only
    // the last one's report survives, while the pull lands in whichever pass
    // first sees both sides quiet.
    const notices: string[] = [];
    for (let i = 0; i < 6; i++) {
      await b.runtime.syncNow();
      notices.push(...(b.runtime.lastPassReport()?.notices ?? []));
      b.advanceClock(95_000);
    }
    const spoken = notices.join(" ");
    expect(spoken, `notices were: ${JSON.stringify(notices)}`).toContain(SID.slice(0, 8));
    expect(spoken).toContain("quit and resume it again");
  }, 60_000);
});

describe("a session with several conflicting members (acceptance r4, F-4)", () => {
  it("lists one conflict per member and names the file in each", async () => {
    // Real-machine finding. A fork of one Grok session produces a conflict per
    // member, and every provider before this one had exactly one file per
    // session — so the conflict screen headed each entry with the session id
    // and the provider, and nothing else. Three conflicts of one session
    // therefore rendered as three blocks reading `Session 01a03d22 (grok)`,
    // identical down to the buttons. The acceptance operator resolved two,
    // could not tell which two, and reported the third as "missing from the
    // panel" — it was there, and indistinguishable.
    const a = await withGrok();
    await a.writeGrokSession(SID, { turns: 2 });
    await a.settle();

    const b = await peerWithGrok(a);
    await b.settle();

    // Both machines continue the same session, differently: every append-only
    // member diverges, which is exactly what a fork looks like.
    await a.appendGrokRaw(SID, '{"type":"user","content":"from A"}\n');
    await a.settle();
    await b.appendGrokRaw(SID, '{"type":"user","content":"from B, longer"}\n');
    await b.settle();
    await b.settle();

    const conflicts = await b.runtime.conflicts();
    const mine = conflicts.filter((c) => c.providerId === "grok");
    expect(mine.length, "one conflict per diverged member").toBeGreaterThan(1);

    // Each entry must say which file it is about — the session id alone is
    // shared by all of them.
    const headings = mine.map((c) => describeConflict(c));
    expect(new Set(headings).size, `headings must be distinct: ${headings.join(" | ")}`).toBe(
      headings.length,
    );
    for (const conflict of mine) {
      const member = conflict.neutralRel.slice(conflict.neutralRel.lastIndexOf("/") + 1);
      expect(describeConflict(conflict)).toContain(member);
    }
  }, 60_000);
});

describe("switching a provider on for the first time (acceptance r4, F-1)", () => {
  it("runs a dry run first, and says it was the first time", async () => {
    // §6.1 documents this gate and the r4 acceptance found it had never been
    // built: enabling Grok admitted fourteen historical sessions across two
    // machines — 56 files — with nothing shown beforehand. What the switch
    // decides is which of this machine's *existing* conversations start
    // travelling, and that set is rarely the one the user has in mind.
    const machine = await RuntimeHarness.create();
    machines.push(machine);
    await machine.configure();
    await machine.writeGrokSession(SID, { turns: 2 });

    const first = await machine.runtime.setProvider("grok", { enabled: true });

    expect(first.firstEnable).toBe(true);
    expect(machine.runtime.lastPassReport()?.dryRun).toBe(true);
    // ADR-27: a dry run writes nothing at all, so the scope was shown without
    // any of it having happened.
    const status = await machine.runtime.refresh();
    await expect(
      fsp.readdir(path.join(machine.syncDir, status.workspaceId as string, "grok")),
    ).rejects.toThrow();
  }, 30_000);

  it("does not do it again when the provider is switched off and back on", async () => {
    // The gate is about the introduction, not about every toggle — repeating
    // it would train people to click past it.
    const machine = await RuntimeHarness.create();
    machines.push(machine);
    await machine.configure();
    await machine.runtime.setProvider("grok", { enabled: true });

    await machine.runtime.setProvider("grok", { enabled: false });
    const again = await machine.runtime.setProvider("grok", { enabled: true });

    expect(again.firstEnable).toBe(false);
  }, 30_000);
});

describe("a session that is still being written (OQ-17, §9.1)", () => {
  it("waits while a sibling is moving, even when the synced files hold still", async () => {
    // The measurement this exists for: mid-turn, Grok left `chat_history.jsonl`
    // untouched for 23 seconds while `events.jsonl` advanced about ninety
    // times. Per-file quiescence therefore calls the file settled at precisely
    // the moment the conversation is in flight, and what it copies is a
    // version the finished turn does not extend — one machine, one ordinary
    // conversation, one conflict (acceptance r4, F-5).
    const machine = await withGrok();
    await machine.writeGrokSession(SID, { turns: 2 });

    // The turn is still running: nothing the plugin syncs changes, but the
    // event log does, on every pass.
    for (let i = 0; i < 3; i++) {
      await fsp.appendFile(machine.grokPath(SID, "events.jsonl"), `{"e":${i}}\n`);
      await machine.runtime.syncNow();
      machine.advanceClock(95_000);
    }

    const status = await machine.runtime.refresh();
    await expect(
      fsp.readdir(path.join(machine.syncDir, status.workspaceId as string, "grok", SID)),
    ).rejects.toThrow();
    const rows = (machine.runtime.lastPassReport()?.actions ?? []).filter((a) =>
      a.neutralRel.startsWith(`grok/${SID}/`),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((a) => a.reason === "session-being-written")).toBe(true);
  }, 30_000);

  it("goes through once the session stops moving", async () => {
    // The other half: the gate must open, or it is just a longer outage.
    const machine = await withGrok();
    await machine.writeGrokSession(SID, { turns: 2 });
    await fsp.appendFile(machine.grokPath(SID, "events.jsonl"), '{"e":"last"}\n');

    await machine.settle();

    expect((await fsp.readdir(await replicaDir(machine, SID))).sort()).toEqual([
      "chat_history.jsonl",
      "summary.json",
      "updates.jsonl",
    ]);
  }, 30_000);

  it("leaves single-file providers judged exactly as before", async () => {
    // Only Grok declares witnesses. A provider whose session is one file must
    // not start waiting on a group gate that has nothing to look at.
    const machine = await RuntimeHarness.create();
    machines.push(machine);
    await machine.appendSession("3f2504e0-4f89-41d3-9a0c-0305e82c3301", 4);
    await machine.configure();

    await machine.settle();

    const status = await machine.runtime.refresh();
    expect(
      await fsp.readdir(path.join(machine.syncDir, status.workspaceId as string, "claude-code")),
    ).toContain("3f2504e0-4f89-41d3-9a0c-0305e82c3301.jsonl");
  }, 30_000);
});
