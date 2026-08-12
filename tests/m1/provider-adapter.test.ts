/**
 * testing.md §8.2 — the filename whitelist, which is the security boundary
 * (architecture §8.2 layer 1).
 *
 * Whitelist-first is the correction of a real design mistake: the earlier
 * version treated conflict-copy *patterns* as the boundary, and OneDrive's
 * `-<hostname>` suffix matches any logicalId containing a hyphen. That would
 * move legitimate sessions into quarantine — which, to a user, looks exactly
 * like the plugin losing a conversation.
 */
import { describe, expect, it } from "vitest";
import {
  CLAUDE_LOGICAL_ID_PATTERN,
  claudeCodeProjectDir,
  createClaudeCodeAdapter,
} from "../../src/providers/claude-code/adapter";
import { classifyFileName } from "../../src/providers/provider-adapter";
import {
  CrashSignal,
  hashPrefix,
  idPrefix,
  isCrashSignal,
  isErrorResult,
  noopBarrier,
} from "../../src/orchestration/pass-report";

const SID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

const claude = {
  logicalIdPattern: CLAUDE_LOGICAL_ID_PATTERN,
  primaryExtensions: [".jsonl"],
  auxSuffixPattern: /^\.origin\.json$/,
};

describe("classifyFileName", () => {
  it("recognises a session file", () => {
    expect(classifyFileName(claude, `${SID}.jsonl`)).toEqual({ kind: "primary", logicalId: SID });
  });

  it("recognises our own aux file", () => {
    expect(classifyFileName(claude, `${SID}.origin.json`)).toEqual({ kind: "aux", logicalId: SID });
  });

  it.each([
    ["a conflict copy", `${SID}.sync-conflict-20260807-120000-ABCDEF.jsonl`],
    ["a OneDrive-style hostname suffix", `${SID}-ct-mbp.jsonl`],
    ["a backup", `${SID}.jsonl.bak`],
    ["a temp file", `${SID}.jsonl.tmp`],
    ["a credential file", "auth.json"],
    ["an unrelated name", "notes.jsonl"],
    ["an uppercase uuid", `${SID.toUpperCase()}.jsonl`],
  ])("does not treat %s as a session", (_label, name) => {
    // Not a session means: not landed, not decided about, not overwriting
    // anything. Files this rejects are reported, never moved or deleted.
    expect(classifyFileName(claude, name).kind).toBe("unknown");
  });

  it("requires the id at the very start, not merely somewhere in the name", () => {
    expect(classifyFileName(claude, `copy-of-${SID}.jsonl`).kind).toBe("unknown");
  });
});

describe("claude-code adapter", () => {
  const deps = {
    providerRoot: "/home/testuser/.claude/projects",
    vaultRealPath: "/home/testuser/vault",
    joinPath: (...parts: string[]) => parts.join("/"),
    readTextFile: async () => null,
  };

  const STORE = "/home/testuser/vault/.claudian/sessions";
  /** A vault whose Claudian knows exactly the given session ids. */
  const vaultWith = (ids: readonly string[]) => ({
    listDir: async (dir: string) =>
      dir === STORE
        ? ids.map((_id, i) => ({ name: `conv-${i}.meta.json`, isFile: true }))
        : [],
    readTextFile: async (target: string) => {
      const index = /conv-(\d+)\.meta\.json$/.exec(target);
      const id = index ? ids[Number(index[1])] : undefined;
      return id === undefined ? null : JSON.stringify({ providerId: "claude", sessionId: id });
    },
  });

  it("derives the project directory from the escape rule", () => {
    expect(claudeCodeProjectDir(deps)).toBe(
      "/home/testuser/.claude/projects/-home-testuser-vault",
    );
  });

  it("honours a custom directory name, the escape hatch for rule changes", () => {
    expect(claudeCodeProjectDir({ ...deps, customDirName: "manual-name" })).toBe(
      "/home/testuser/.claude/projects/manual-name",
    );
  });

  it("reports unhealthy when the project directory is absent", async () => {
    const adapter = createClaudeCodeAdapter({
      ...deps,
      listDir: async () => [],
      statFile: async () => null,
    });
    expect(await adapter.healthCheck()).toMatchObject({ ok: false });
  });

  it("lists only files whose name is exactly <uuid>.jsonl", async () => {
    const vault = vaultWith([SID]);
    const adapter = createClaudeCodeAdapter({
      ...deps,
      ...vault,
      listDir: async (dir: string) =>
        dir === STORE
          ? vault.listDir(dir)
          : [
              { name: `${SID}.jsonl`, isFile: true },
              { name: `${SID}.jsonl.bak`, isFile: true },
              { name: "memory", isFile: false }, // F-7: a real subdirectory, not synced in M1
              { name: "notes.jsonl", isFile: true },
            ],
      statFile: async () => ({ mtimeMs: 1 }),
    });

    const sessions = await adapter.listSessions();
    expect(sessions.map((s) => s.logicalId)).toEqual([SID]);
    expect(sessions[0]?.files[0]?.neutralRel).toBe(`claude-code/${SID}.jsonl`);
  });

  it("admits only sessions this vault has a Claudian record for (ADR-47)", async () => {
    const other = "9a1b2c3d-4e5f-4a1b-8c2d-3e4f5a6b7c8d"; // a bare-terminal session
    const vault = vaultWith([SID]);
    const adapter = createClaudeCodeAdapter({
      ...deps,
      ...vault,
      listDir: async (dir: string) =>
        dir === STORE
          ? vault.listDir(dir)
          : [
              { name: `${SID}.jsonl`, isFile: true },
              { name: `${other}.jsonl`, isFile: true },
            ],
      statFile: async () => ({ mtimeMs: 1 }),
    });

    expect((await adapter.listSessions()).map((s) => s.logicalId)).toEqual([SID]);
  });

  it("says out loud when the vault has no Claudian records at all", async () => {
    // Same message as Codex: "syncs nothing" must be tellable from "broken".
    const adapter = createClaudeCodeAdapter({
      ...deps,
      listDir: async () => [],
      statFile: async () => ({ mtimeMs: 1 }),
    });
    expect(await adapter.healthCheck()).toMatchObject({
      ok: false,
      reason: "no Claudian conversation records in this vault",
    });
  });

  it("is Tier A, which OQ-8 measured rather than assumed", async () => {
    const adapter = createClaudeCodeAdapter({ ...deps, listDir: async () => [], statFile: async () => null });
    expect(adapter.tier).toBe("A");
    // Tier A means discovery is a directory scan, so there is no index to fix.
    await expect(adapter.reconcileLocalIndex([])).resolves.toBeUndefined();
  });

  it("maps a neutral path back into the local project directory", async () => {
    const adapter = createClaudeCodeAdapter({ ...deps, listDir: async () => [], statFile: async () => null });
    expect(await adapter.targetPathFor(`claude-code/${SID}.jsonl`)).toBe(
      `/home/testuser/.claude/projects/-home-testuser-vault/${SID}.jsonl`,
    );
  });
});

describe("report helpers", () => {
  it("truncates ids and hashes to what the content whitelist allows", () => {
    expect(idPrefix(SID)).toBe("3f2504e0");
    expect(hashPrefix("sha256:deadbeefcafebabe")).toBe("deadbeef");
    expect(hashPrefix("deadbeefcafebabe")).toBe("deadbeef");
  });

  it("counts only real I/O failures as errors", () => {
    expect(isErrorResult("FAILED_IO")).toBe(true);
    expect(isErrorResult("FAILED_BACKUP")).toBe(true);
    // These are ordinary outcomes: the pass did its job by declining to act.
    expect(isErrorResult("DEFERRED")).toBe(false);
    expect(isErrorResult("ABORTED_PRECONDITION")).toBe(false);
    expect(isErrorResult("SKIPPED_BUDGET")).toBe(false);
  });

  it("makes a crash signal distinguishable from an Error", () => {
    // The engine catches only known errno values, so an injected crash must not
    // look like one — otherwise the crash-point matrix would be testing
    // recovery from something that never happened.
    const signal = new CrashSignal("P6:before-rename");
    expect(isCrashSignal(signal)).toBe(true);
    expect(signal instanceof Error).toBe(false);
    expect(isCrashSignal(new Error("io"))).toBe(false);
    expect(isCrashSignal(null)).toBe(false);
  });

  it("has a barrier that costs nothing in production", async () => {
    await expect(noopBarrier("P4:planned", {})).resolves.toBeUndefined();
  });
});
