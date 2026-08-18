/**
 * The claudian provider, end to end (ADR-48).
 *
 * Everything here runs through the full PluginRuntime — the same composition
 * root production uses — because two of the things under test live outside the
 * engine: the preflight exemption that lets this provider's root sit inside
 * the vault at all, and the registry plumbing that derives that root from the
 * vault rather than the home directory.
 *
 * The behavioural spine is the converged-base cycle: a record pushed once can
 * be rewritten on its home machine and fast-forward (no conflict, no manual
 * step), because the replica still holds the exact bytes this machine last
 * converged on. A fork — both sides rewritten — stays a conflict. That split
 * is the entire difference between "usable for a store Claudian rewrites every
 * turn" and "a conflict generator".
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeHarness } from "../helpers/runtime-harness";

const CONV = "conv-1786422687897-15ktes7p9";
const META = `${CONV}.meta.json`;

// Each case drives at least one `settle()`, and a settle is three real passes
// through the real composition root. Explicit timeouts rather than vitest's
// 5 s default, for the reason `conflict-commands.test.ts` states: on a busy
// machine the default turns load into a failure report.
const machines: RuntimeHarness[] = [];
afterEach(async () => {
  while (machines.length) await machines.pop()?.dispose();
});

async function harnessWithClaudian(): Promise<RuntimeHarness> {
  const machine = await RuntimeHarness.create();
  machines.push(machine);
  await machine.configure();
  await machine.runtime.setProvider("claudian", { enabled: true });
  await machine.runtime.refresh();
  return machine;
}

const storeDir = (machine: RuntimeHarness) =>
  path.join(machine.vaultRoot, ".claudian", "sessions");

async function writeRecord(machine: RuntimeHarness, name: string, body: unknown): Promise<void> {
  await fsp.mkdir(storeDir(machine), { recursive: true });
  // As Claudian writes it: whole JSON, pretty-printed, no trailing newline —
  // the exact shape whose tail the append table would call "truncated".
  await fsp.writeFile(path.join(storeDir(machine), name), JSON.stringify(body, null, 2));
}

describe("a provider whose root lives inside the vault", () => {
  it("passes preflight — the vault-contains-claudian overlap is definitional", async () => {
    const machine = await harnessWithClaudian();
    await writeRecord(machine, META, { id: CONV, providerId: "codex", sessionId: null });

    await machine.runtime.syncNow();
    const report = machine.runtime.lastPassReport();

    // The report must be a real pass, not a root-overlap abort.
    expect(report?.abortReason ?? null).toBeNull();
  }, 30_000);

  it("pushes a record and fast-forwards its rewrites without a conflict", async () => {
    const machine = await harnessWithClaudian();
    await writeRecord(machine, META, { id: CONV, providerId: "codex", sessionId: null, rev: 1 });

    await machine.settle();
    const first = machine.runtime.lastPassReport();
    const status = await machine.runtime.refresh();
    const replica = path.join(
      machine.syncDir,
      status.workspaceId as string,
      "claudian",
      META,
    );
    expect(JSON.parse(await fsp.readFile(replica, "utf8")).rev).toBe(1);
    expect(first?.actions.some((a) => a.action === "CONFLICT")).toBe(false);

    // Claudian rewrites the whole file — a turn happened, the title changed,
    // whatever. The replica still holds rev 1, which this machine converged
    // on, so this must fast-forward, not conflict. The overwrite lands in
    // whichever pass first finds the file stable, so reports are collected
    // per pass rather than read once at the end (by then it is a NOOP).
    await writeRecord(machine, META, { id: CONV, providerId: "codex", sessionId: null, rev: 2 });
    const seen = [];
    for (let i = 0; i < 3; i++) {
      await machine.runtime.syncNow();
      machine.advanceClock(95_000);
      const report = machine.runtime.lastPassReport();
      seen.push(...(report?.actions.filter((a) => a.neutralRel === `claudian/${META}`) ?? []));
    }

    expect(JSON.parse(await fsp.readFile(replica, "utf8")).rev).toBe(2);
    expect(seen.map((a) => a.action)).not.toContain("CONFLICT");
    const overwrite = seen.find((a) => a.action === "PUSH_OVERWRITE");
    expect(overwrite?.reason).toBe("remote-at-converged-base");
    // I1: the overwritten replica version was backed up first.
    expect(overwrite?.backupPath).toBeTruthy();
  }, 30_000);

  it("pulls the other machine's records, tombstones included", async () => {
    const a = await harnessWithClaudian();
    await writeRecord(a, META, { id: CONV, providerId: "codex", sessionId: null });
    await writeRecord(a, `${CONV}.deleted.json`, {
      schemaVersion: 1,
      conversationId: CONV,
      deletedAt: 1,
    });
    await a.settle();

    const b = await RuntimeHarness.createPeer(a);
    machines.push(b);
    await b.runtime.setProvider("claudian", { enabled: true });
    await b.runtime.refresh();
    await b.settle();

    const landed = await fsp.readdir(storeDir(b));
    expect(landed.sort()).toEqual([`${CONV}.deleted.json`, META]);
    // The tombstone arriving IS the record layer's deletion propagation:
    // Claudian on this machine now hides the conversation, and this plugin's
    // own admission stops carrying its sessions (ADR-47). No session file was
    // deleted anywhere — ADR-10 still holds.
  }, 30_000);

  it("turns a genuine fork into a conflict, never a picked side", async () => {
    const a = await harnessWithClaudian();
    await writeRecord(a, META, { id: CONV, providerId: "codex", sessionId: null, rev: 1 });
    await a.settle();

    const b = await RuntimeHarness.createPeer(a);
    machines.push(b);
    await b.runtime.setProvider("claudian", { enabled: true });
    await b.runtime.refresh();
    await b.settle(); // b now has rev 1 and a converged base

    // Both machines rewrite, differently: A renames the conversation, B pins
    // it. Neither is at the base any more.
    await writeRecord(a, META, { id: CONV, providerId: "codex", sessionId: null, rev: "a2" });
    await a.settle(); // replica now holds A's rewrite
    await writeRecord(b, META, { id: CONV, providerId: "codex", sessionId: null, rev: "b2" });
    await b.settle();
    const report = b.runtime.lastPassReport();

    const action = report?.actions.find((x) => x.neutralRel === `claudian/${META}`);
    expect(action?.action).toBe("CONFLICT");
    expect(action?.reason).toBe("opaque-divergent-both-moved");
    expect(action?.conflictId).toBeTruthy();
    // Neither original moved: B still holds its own rewrite, the replica A's.
    const bLocal = JSON.parse(await fsp.readFile(path.join(storeDir(b), META), "utf8"));
    expect(bLocal.rev).toBe("b2");
  }, 30_000);

  it("says out loud that retention has stopped bounding the backup folder", async () => {
    // §9.3.3 deletes only what a survivor provably contains, and for whole-file
    // records nothing ever is — so `backupKeep` quietly stops applying and the
    // folder grows for as long as this provider is on. Keeping is the safe
    // direction; keeping *silently* is not, and the flag that would have said
    // so was being dropped between the writer and the report.
    const machine = await harnessWithClaudian();
    await writeRecord(machine, META, { id: CONV, providerId: "codex", sessionId: null, rev: 1 });
    await machine.settle();

    // Enough rewrites that the retention limit would have bitten for an
    // append-only file: default keep is 3.
    const notices: string[] = [];
    for (let rev = 2; rev <= 6; rev++) {
      await writeRecord(machine, META, { id: CONV, providerId: "codex", sessionId: null, rev });
      for (let i = 0; i < 3; i++) {
        await machine.runtime.syncNow();
        machine.advanceClock(95_000);
        notices.push(...(machine.runtime.lastPassReport()?.notices ?? []));
      }
    }

    expect(notices.join(" ")).toContain("claudian");
    expect(notices.join(" ")).toContain("kept past the retention limit");
  }, 60_000);

  it("conflicts rather than guesses when there is no witnessed base", async () => {
    // Two populated stores meeting for the first time: same record name,
    // different content, and neither machine has ever seen them agree. The
    // only honest answer is a conflict.
    const a = await harnessWithClaudian();
    await writeRecord(a, META, { id: CONV, providerId: "codex", sessionId: null, rev: "a" });
    await a.settle();

    const b = await RuntimeHarness.createPeer(a);
    machines.push(b);
    await b.runtime.setProvider("claudian", { enabled: true });
    await b.runtime.refresh();
    await writeRecord(b, META, { id: CONV, providerId: "codex", sessionId: null, rev: "b" });
    await b.settle();
    const report = b.runtime.lastPassReport();

    const action = report?.actions.find((x) => x.neutralRel === `claudian/${META}`);
    expect(action?.action).toBe("CONFLICT");
    expect(action?.reason).toBe("opaque-divergent-no-base");
  }, 30_000);
});
