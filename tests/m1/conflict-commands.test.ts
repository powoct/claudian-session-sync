/**
 * testing.md §7.2 S-04c — getting out of a conflict.
 *
 * Detection without resolution would leave the plugin able to notice a problem
 * and unable to end it, so all three ways out ship in M1. What every case here
 * checks, whichever way the user goes, is the same thing: **the branch they
 * did not choose is still reachable.** A conflict resolution that destroyed
 * the loser would be a worse outcome than the conflict.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeCause, describeConflict } from "../../src/ui/conflict-modal";
import type { ConflictEntry } from "../../src/orchestration/conflict-commands";
import { RuntimeHarness, sha256 } from "../helpers/runtime-harness";

const SID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

const machines: RuntimeHarness[] = [];
afterEach(async () => {
  while (machines.length) await machines.pop()?.dispose();
});

/**
 * Every case here drives two real machines through several full passes, and a
 * pass deliberately waits: readiness wants two observations spanning 90 s and
 * stability wants a file to hold still across a pass, so the harness jumps a
 * fake clock and runs three passes per `settle()`. Under coverage
 * instrumentation that comfortably exceeds vitest's 5 s default — which is a
 * useful default and worth keeping global, so the exception is stated here
 * rather than raised for the whole suite.
 */
const SLOW = 30_000;

const read = async (target: string) =>
  new Uint8Array(await fsp.readFile(target).catch(() => Buffer.alloc(0)));

/**
 * Two machines that have forked the same session.
 *
 * Both sides append, so neither contains the other — the shape the whole
 * prefix-safe merge rule exists to refuse to resolve on its own.
 */
async function forked() {
  const a = await RuntimeHarness.create();
  machines.push(a);
  await a.appendSession(SID, 6);
  await a.configure();
  await a.settle();

  const b = await RuntimeHarness.createPeer(a);
  machines.push(b);
  await b.settle(); // pulls A's version

  await a.appendRaw(SID, '{"uuid":"a1","type":"user","text":"written on A"}\n');
  await a.settle(); // A's extension reaches the sync folder

  // Different bytes, deliberately. Appending the *same* line on both sides
  // leaves them in a prefix relationship, which is a fork that resolves
  // itself — and a fixture that never produces the conflict it claims to.
  await b.appendRaw(SID, '{"uuid":"b1","type":"user","text":"written on B"}\n');
  const status = await b.settle();

  const workspaceId = status.workspaceId as string;
  return { a, b, workspaceId };
}

describe("a fork becomes a conflict, and the conflict can be ended", () => {
  it("lists both branches with enough to tell them apart", async () => {
    const { b } = await forked();

    const conflicts = await b.runtime.conflicts();

    expect(conflicts).toHaveLength(1);
    const only = conflicts[0];
    expect(only?.logicalIdPrefix).toBe(SID.slice(0, 8));
    // Counts and hash prefixes only — never a line of either conversation.
    expect(only?.branches).toHaveLength(2);
    for (const branch of only?.branches ?? []) {
      expect(branch.lineCount).toBeGreaterThan(0);
      expect(branch.size).toBeGreaterThan(0);
    }
    // Which branch is whose is computed from the live files at read time,
    // never from stored labels — the labels are what deadlocked machine B
    // during the M1 acceptance run.
    expect(only?.branches.filter((branch) => branch.onThisMachine)).toHaveLength(1);
    expect(only?.branches.filter((branch) => branch.inSyncFolder)).toHaveLength(1);
    expect(only?.superseded).toBe(false);
    expect(JSON.stringify(only?.branches)).not.toContain('"text"');
  }, SLOW);

  it("keeps this machine's version, and the other stays reachable", async () => {
    const { b, workspaceId } = await forked();
    const conflicts = await b.runtime.conflicts();
    const only = conflicts[0];
    const mine = sha256(await read(b.sessionPath(SID)));
    const theirs = sha256(await read(b.replicaPath(workspaceId, SID)));
    expect(mine).not.toBe(theirs);

    const outcome = await b.runtime.resolve(only?.conflictId as string, "keep-local");

    expect(outcome).toMatchObject({ ok: true, action: "PUSH_OVERWRITE" });
    expect(sha256(await read(b.replicaPath(workspaceId, SID)))).toBe(mine);
    // The abandoned branch: still in quarantine, and now also in the backup
    // area, because overwriting it was an overwrite like any other.
    expect(await fsp.readdir(only?.directory as string)).toHaveLength(3);
    if (outcome.ok && outcome.action !== "REVEAL") {
      expect(sha256(await read(outcome.backupPath as string))).toBe(theirs);
    }
  }, SLOW);

  it("keeps the other machine's version, and this one stays reachable", async () => {
    const { b, workspaceId } = await forked();
    const only = (await b.runtime.conflicts())[0];
    const mine = sha256(await read(b.sessionPath(SID)));
    const theirs = sha256(await read(b.replicaPath(workspaceId, SID)));

    const outcome = await b.runtime.resolve(only?.conflictId as string, "keep-remote");

    expect(outcome).toMatchObject({ ok: true, action: "PULL_OVERWRITE" });
    expect(sha256(await read(b.sessionPath(SID)))).toBe(theirs);
    if (outcome.ok && outcome.action !== "REVEAL") {
      expect(sha256(await read(outcome.backupPath as string))).toBe(mine);
    }
  }, SLOW);

  it("shows both without writing anything", async () => {
    // The third option is not padding: two buttons force a guess, and the
    // honest answer to "which of these do I want" is often "let me look".
    const { b, workspaceId } = await forked();
    const only = (await b.runtime.conflicts())[0];
    const before = [
      sha256(await read(b.sessionPath(SID))),
      sha256(await read(b.replicaPath(workspaceId, SID))),
    ];

    const outcome = await b.runtime.resolve(only?.conflictId as string, "reveal");

    expect(outcome).toMatchObject({ ok: true, action: "REVEAL" });
    if (outcome.ok && outcome.action === "REVEAL") {
      expect(await fsp.readdir(outcome.directory)).toContain("meta.json");
    }
    expect([
      sha256(await read(b.sessionPath(SID))),
      sha256(await read(b.replicaPath(workspaceId, SID))),
    ]).toEqual(before);
  }, SLOW);

  it("converges after a resolution instead of conflicting again", async () => {
    const { b, workspaceId } = await forked();
    const only = (await b.runtime.conflicts())[0];
    await b.runtime.resolve(only?.conflictId as string, "keep-local");

    const after = await b.settle();

    expect(after.readiness).toBe("READY");
    expect(sha256(await read(b.replicaPath(workspaceId, SID)))).toBe(
      sha256(await read(b.sessionPath(SID))),
    );
    for (const action of b.runtime.lastPassReport()?.actions ?? []) {
      expect(action.action, JSON.stringify(action)).not.toBe("CONFLICT");
    }
  }, SLOW);
});

describe("a resolution refuses when it is no longer the same disagreement", () => {
  it("declines once the chosen branch has moved on", async () => {
    // The dialog froze a pair of versions; the session did not. Resolving
    // against a version the user never saw is not what they asked for.
    const { b } = await forked();
    const only = (await b.runtime.conflicts())[0];

    await b.appendSession(SID, 1);
    const outcome = await b.runtime.resolve(only?.conflictId as string, "keep-local");

    expect(outcome).toEqual({ ok: false, reason: "branch-moved" });
  }, SLOW);

  it("says unreadable, not moved, when the kept side cannot be read", async () => {
    // The sync tool takes short locks on files it is transferring; during the
    // acceptance re-run that moment was reported as a *state* change, and the
    // user re-synced and waited for a fix that was never coming. "Busy" and
    // "moved" need different words because they need different reactions.
    const { b, workspaceId } = await forked();
    const only = (await b.runtime.conflicts())[0];
    const canonical = b.replicaPath(workspaceId, SID);

    await fsp.rename(canonical, `${canonical}.held`);
    const outcome = await b.runtime.resolve(only?.conflictId as string, "keep-remote");
    await fsp.rename(`${canonical}.held`, canonical);

    expect(outcome).toEqual({ ok: false, reason: "kept-unreadable" });
    // And with the file back, the same click goes through.
    expect(await b.runtime.resolve(only?.conflictId as string, "keep-remote")).toMatchObject({
      ok: true,
      action: "PULL_OVERWRITE",
    });
  }, SLOW);

  it("declines an id that is not there", async () => {
    const { b } = await forked();
    expect(await b.runtime.resolve("deadbeefdeadbeef", "keep-local")).toEqual({
      ok: false,
      reason: "unknown-conflict",
    });
  }, SLOW);

  it("declines to push into a sync folder that is not ready", async () => {
    // Keeping *this* machine's version writes into the sync folder, and that
    // is the one direction a half-hydrated or unrecognised folder makes
    // dangerous. Keeping the other machine's version writes locally and stays
    // available, because nothing about the folder's state makes a local write
    // less safe.
    const { b } = await forked();
    const only = (await b.runtime.conflicts())[0];

    const rootPath = path.join(b.syncDir, ".aiss", "root.json");
    const rootFile = JSON.parse(await fsp.readFile(rootPath, "utf8")) as Record<string, unknown>;
    await fsp.writeFile(rootPath, JSON.stringify({ ...rootFile, rootId: "somewhere-else" }));
    const status = await b.runtime.syncNow();
    expect(status.notReadyReason).toBe("NR-2-root-id-mismatch");

    expect(await b.runtime.resolve(only?.conflictId as string, "keep-local")).toEqual({
      ok: false,
      reason: "remote-not-ready",
    });
    expect((await b.runtime.resolve(only?.conflictId as string, "keep-remote")).ok).toBe(true);
  }, SLOW);
});

describe("the acceptance-run deadlock (D-3): the second machine can always take the settled version", () => {
  it("keep-remote succeeds although this machine's branch has moved on", async () => {
    const { b, workspaceId } = await forked();
    // A third-party writer appends to B's branch after it was quarantined —
    // the acceptance run saw Claudian's ai-title feature do exactly this to a
    // conflicted session, which under the frozen-viewpoint rule locked
    // resolution on B permanently.
    await b.appendRaw(SID, '{"uuid":"b2","type":"ai-title","note":"third-party append"}\n');
    await b.settle(); // quarantines the fresh pair under its own conflict id

    const conflicts = await b.runtime.conflicts();
    const live = conflicts.find((c) => c.branches.some((branch) => branch.inSyncFolder));
    expect(live).toBeTruthy();
    const alpha = sha256(await read(b.replicaPath(workspaceId, SID)));
    const betaPrime = sha256(await read(b.sessionPath(SID)));
    expect(alpha).not.toBe(betaPrime);

    const outcome = await b.runtime.resolve(live?.conflictId as string, "keep-remote");

    expect(outcome).toMatchObject({ ok: true, action: "PULL_OVERWRITE" });
    // B's local is now the settled version; the discarded branch — including
    // the third-party line nobody reviewed — is in the backups.
    expect(sha256(await read(b.sessionPath(SID)))).toBe(alpha);
    if (outcome.ok && outcome.action !== "REVEAL") {
      expect(sha256(await read(outcome.backupPath as string))).toBe(betaPrime);
    }
    // And the machines converge instead of re-conflicting.
    const after = await b.settle();
    expect(after.readiness).toBe("READY");
    for (const action of b.runtime.lastPassReport()?.actions ?? []) {
      expect(action.action, JSON.stringify(action)).not.toBe("CONFLICT");
    }
  }, SLOW);

  it("resolves a pre-fix directory holding both machines' viewpoint pairs", async () => {
    // Before the fix, each machine wrote its own `local-*`/`remote-*` pair
    // into the shared directory — four copies naming the same two branches,
    // and a picker that could pair the same branch as both sides. Directories
    // like this exist on real machines; they must still resolve.
    const { b, workspaceId } = await forked();
    const only = (await b.runtime.conflicts())[0];
    const dir = only?.directory as string;
    const alpha = await fsp.readFile(b.replicaPath(workspaceId, SID));
    const beta = await fsp.readFile(b.sessionPath(SID));
    for (const name of await fsp.readdir(dir)) await fsp.rm(path.join(dir, name));
    await fsp.writeFile(path.join(dir, "local-c1166ecf.jsonl"), alpha);
    await fsp.writeFile(path.join(dir, "remote-4d2413fa.jsonl"), beta);
    await fsp.writeFile(path.join(dir, "local-4d2413fa.jsonl"), beta);
    await fsp.writeFile(path.join(dir, "remote-c1166ecf.jsonl"), alpha);
    await fsp.writeFile(
      path.join(dir, "meta.json"),
      JSON.stringify({
        schemaVersion: 1,
        logicalId: SID,
        conflictId: only?.conflictId,
        localHashPrefix: "c1166ecf",
        remoteHashPrefix: "4d2413fa",
        localSize: alpha.length,
        remoteSize: beta.length,
        localLineCount: 6,
        remoteLineCount: 7,
        detectedBy: "aaaaaaaa",
        detectedAt: "2026-08-10T18:04:29.000Z",
      }),
    );

    const listed = (await b.runtime.conflicts())[0];
    expect(listed?.branches, "four copies, two branches").toHaveLength(2);

    const outcome = await b.runtime.resolve(listed?.conflictId as string, "keep-remote");

    expect(outcome).toMatchObject({ ok: true, action: "PULL_OVERWRITE" });
    expect(sha256(await read(b.sessionPath(SID)))).toBe(sha256(new Uint8Array(alpha)));
  }, SLOW);
});

describe("the heading that has to identify a conflict (acceptance r4, F-4)", () => {
  const view = (over: Partial<ConflictEntry>): ConflictEntry =>
    ({
      conflictId: "c",
      providerId: "claude-code",
      logicalId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      logicalIdPrefix: "3f2504e0",
      detectedAt: "",
      directory: "/q",
      neutralRel: "claude-code/3f2504e0-4f89-41d3-9a0c-0305e82c3301.jsonl",
      branches: [],
      superseded: false,
      reason: null,
      externalCopy: null,
      ...over,
    }) as ConflictEntry;

  it("stays as it was for a provider whose file name is its session id", () => {
    // Adding the file name here would print the id twice and say nothing new.
    expect(describeConflict(view({}))).toBe("Session 3f2504e0 (claude-code)");
    expect(
      describeConflict(
        view({
          providerId: "codex",
          neutralRel:
            "codex/sessions/2026/08/06/rollout-2026-08-06T12-43-59-3f2504e0-4f89-41d3-9a0c-0305e82c3301.jsonl",
        }),
      ),
    ).toBe("Session 3f2504e0 (codex)");
  });

  it("names the file when the file name does not identify the session", () => {
    const members = ["chat_history.jsonl", "updates.jsonl", "summary.json"].map((name) =>
      describeConflict(
        view({
          providerId: "grok",
          neutralRel: `grok/3f2504e0-4f89-41d3-9a0c-0305e82c3301/${name}`,
        }),
      ),
    );
    expect(members).toEqual([
      "Session 3f2504e0 · chat_history.jsonl (grok)",
      "Session 3f2504e0 · updates.jsonl (grok)",
      "Session 3f2504e0 · summary.json (grok)",
    ]);
    // The property that actually matters: three conflicts of one session are
    // three different sentences.
    expect(new Set(members).size).toBe(3);
  });
});

describe("the heading, on a provider whose ids are not uuids (acceptance r5, F-3)", () => {
  const claudian = (kind: "meta" | "inputs"): ConflictEntry =>
    ({
      conflictId: `c-${kind}`,
      providerId: "claudian",
      logicalId: `conv-1787925819663-qj5gp9vhq.${kind}`,
      logicalIdPrefix: "conv-178",
      detectedAt: "",
      directory: "/q",
      neutralRel: `claudian/conv-1787925819663-qj5gp9vhq.${kind}.json`,
      branches: [],
      superseded: false,
      reason: null,
      externalCopy: null,
    }) as ConflictEntry;

  it("tells the two records of one conversation apart", () => {
    // One fork of one conversation produces a conflict per record file, and
    // both of them abbreviate to `conv-178` — the eight-character prefix is
    // the epoch millisecond, and the half that says which file is at the end.
    // The panel showed two identical headings on the real machines.
    const headings = [describeConflict(claudian("meta")), describeConflict(claudian("inputs"))];
    expect(new Set(headings).size, headings.join(" | ")).toBe(2);
    expect(headings[0]).toContain(".meta");
    expect(headings[1]).toContain(".inputs");
  });

  it("still abbreviates a uuid, and still names the file when the name needs it", () => {
    // The three providers whose ids are uuids must read exactly as before.
    const uuid = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
    const base = { conflictId: "c", detectedAt: "", directory: "/q", branches: [], superseded: false, reason: null, externalCopy: null };
    expect(
      describeConflict({
        ...base, providerId: "claude-code", logicalId: uuid, logicalIdPrefix: "3f2504e0",
        neutralRel: `claude-code/${uuid}.jsonl`,
      } as ConflictEntry),
    ).toBe("Session 3f2504e0 (claude-code)");
    expect(
      describeConflict({
        ...base, providerId: "grok", logicalId: uuid, logicalIdPrefix: "3f2504e0",
        neutralRel: `grok/${uuid}/chat_history.jsonl`,
      } as ConflictEntry),
    ).toBe("Session 3f2504e0 · chat_history.jsonl (grok)");
  });
});

describe("the sentence for a conflict the standing paragraph would describe wrongly (ADR-57)", () => {
  const entry = (over: Partial<ConflictEntry>): ConflictEntry =>
    ({
      conflictId: "c", providerId: "claudian", logicalId: "conv-1-a.meta",
      logicalIdPrefix: "conv-1-a", detectedAt: "", directory: "/q",
      neutralRel: "claudian/conv-1-a.meta.json", branches: [], superseded: false,
      reason: null, externalCopy: null, ...over,
    }) as ConflictEntry;

  it("says nothing for an ordinary fork — the standing paragraph is right there", () => {
    expect(describeCause(entry({ reason: "opaque-divergent-both-moved" }))).toBeNull();
    expect(describeCause(entry({ reason: null }))).toBeNull();
  });

  it("corrects the record when only one machine wrote", () => {
    // "Both machines added to this session separately" is the one conclusion
    // the user must not draw here: the second version exists because the sync
    // tool had two files and picked one.
    const text = describeCause(
      entry({
        reason: "opaque-push-set-aside-by-sync-tool",
        externalCopy: "claudian/conv-1-a.meta (conflicted copy 2026-08-30).json",
      }),
    );
    expect(text).toContain("set this machine's aside");
    expect(text).toContain("conflicted copy 2026-08-30");
    expect(text).toContain("Nothing here was overwritten");
    // What the bytes establish is that the tool chose, not why.
    expect(text).not.toContain("discarded");
  });
});
