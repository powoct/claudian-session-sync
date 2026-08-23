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
import { RuntimeHarness } from "../helpers/runtime-harness";

const SID = "01a02f27-c1aa-7aa1-9580-e4188952ef3b";

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
