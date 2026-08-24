/**
 * §6.2's implementation constraint, encoded: `classifyNeutral` and
 * `listSessions` must agree, per adapter.
 *
 * The two are one whitelist worn two ways — listing applies it to names the
 * CLI wrote, classification to names another machine's sync tool delivered —
 * and nothing structural keeps them aligned: an adapter whose listing produces
 * a neutral path its own classifier refuses would push sessions the other
 * machine then reports as foreign files, and the looser drift direction writes
 * into the CLI's directory. This is the review/5 M2-3 gap: every earlier test
 * exercised one side or the other, none held the two against each other.
 *
 * Table-driven over every registered adapter, on real directories, so a new
 * provider is covered by adding a row — and forgetting the row fails loudly
 * in the PROVIDERS length check.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROVIDERS } from "../../src/providers/registry";
import { createClaudeCodeAdapter } from "../../src/providers/claude-code/adapter";
import { createCodexAdapter } from "../../src/providers/codex/adapter";
import { createClaudianAdapter } from "../../src/providers/claudian/adapter";
import { createGrokAdapter } from "../../src/providers/grok/adapter";
import type { ProviderAdapter } from "../../src/providers/provider-adapter";
import { makeRealTmpDir, removeTree } from "../helpers/fs-cleanup";

const SID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) removeTree(roots.pop() as string);
});

interface Fixture {
  readonly id: string;
  /** Builds the adapter over a real tree holding exactly one session. */
  build(): Promise<ProviderAdapter>;
}

async function claudianRecord(vault: string, providerId: string, id: string): Promise<void> {
  const store = path.join(vault, ".claudian", "sessions");
  await fsp.mkdir(store, { recursive: true });
  await fsp.writeFile(
    path.join(store, `conv-fixture-${id}.meta.json`),
    JSON.stringify({ id: `conv-fixture-${id}`, providerId, sessionId: id }),
  );
}

const fsDeps = (vault: string) => ({
  vaultRealPath: vault,
  joinPath: (...parts: string[]) => path.join(...parts),
  listDir: async (dir: string) =>
    (await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])).map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
    })),
  statFile: async (target: string) => {
    const stat = await fsp.stat(target).catch(() => null);
    return stat ? { mtimeMs: stat.mtimeMs } : null;
  },
  readTextFile: async (target: string) => fsp.readFile(target, "utf8").catch(() => null),
});

const FIXTURES: readonly Fixture[] = [
  {
    id: "claude-code",
    async build() {
      const root = makeRealTmpDir("consistency-cc");
      roots.push(root);
      const vault = path.join(root, "vault");
      const projects = path.join(root, "projects");
      const projectDir = path.join(projects, "escaped-vault");
      await fsp.mkdir(projectDir, { recursive: true });
      await fsp.writeFile(path.join(projectDir, `${SID}.jsonl`), '{"type":"user"}\n');
      await claudianRecord(vault, "claude", SID);
      return createClaudeCodeAdapter({
        ...fsDeps(vault),
        providerRoot: projects,
        customDirName: "escaped-vault",
      });
    },
  },
  {
    id: "codex",
    async build() {
      const root = makeRealTmpDir("consistency-cx");
      roots.push(root);
      const vault = path.join(root, "vault");
      const sessions = path.join(root, "sessions");
      const day = path.join(sessions, "2026", "08", "06");
      await fsp.mkdir(day, { recursive: true });
      await fsp.writeFile(
        path.join(day, `rollout-2026-08-06T12-43-59-${SID}.jsonl`),
        '{"type":"session_meta"}\n',
      );
      await claudianRecord(vault, "codex", SID);
      return createCodexAdapter({ ...fsDeps(vault), providerRoot: sessions });
    },
  },
  {
    id: "claudian",
    async build() {
      const root = makeRealTmpDir("consistency-cl");
      roots.push(root);
      const store = path.join(root, "vault", ".claudian", "sessions");
      await fsp.mkdir(store, { recursive: true });
      await fsp.writeFile(
        path.join(store, "conv-1786422687897-15ktes7p9.meta.json"),
        JSON.stringify({ id: "conv-1786422687897-15ktes7p9", providerId: "codex", sessionId: SID }),
      );
      const deps = fsDeps(path.join(root, "vault"));
      return createClaudianAdapter({
        providerRoot: store,
        joinPath: deps.joinPath,
        listDir: deps.listDir,
        statFile: deps.statFile,
      });
    },
  },
  {
    id: "grok",
    async build() {
      const root = makeRealTmpDir("consistency-gk");
      roots.push(root);
      const vault = path.join(root, "vault");
      const sessions = path.join(root, "sessions");
      // A session is a directory, and the members deliberately span both
      // decision tables plus one file the whitelist must refuse.
      const sessionDir = path.join(sessions, "encoded-vault", SID);
      await fsp.mkdir(sessionDir, { recursive: true });
      await fsp.writeFile(path.join(sessionDir, "summary.json"), '{"info":{"id":"x"}}');
      await fsp.writeFile(path.join(sessionDir, "chat_history.jsonl"), '{"type":"user"}\n');
      await fsp.writeFile(path.join(sessionDir, "updates.jsonl"), '{"jsonrpc":"2.0"}\n');
      await fsp.writeFile(path.join(sessionDir, "prompt_context.json"), "{}");
      await fsp.writeFile(path.join(sessionDir, "summary.json.lock"), "");
      await claudianRecord(vault, "grok", SID);
      return createGrokAdapter({
        ...fsDeps(vault),
        providerRoot: sessions,
        customDirName: "encoded-vault",
      });
    },
  },
];

describe("every listed session classifies as itself", () => {
  it("covers every registered provider", () => {
    // The row-forgetting check. A third provider without a fixture here is a
    // third provider whose two whitelists can drift with no test noticing.
    expect(FIXTURES.map((f) => f.id).sort()).toEqual(PROVIDERS.map((p) => p.id).sort());
  });

  it.each(FIXTURES.map((fixture) => [fixture.id, fixture] as const))(
    "%s: classifyNeutral accepts what listSessions produced, and agrees on the id",
    async (_id, fixture) => {
      const adapter = await fixture.build();
      const groups = await adapter.listSessions();
      expect(groups.length, "fixture must actually list a session").toBeGreaterThan(0);

      for (const group of groups) {
        for (const file of group.files) {
          const classified = adapter.classifyNeutral(file.neutralRel);
          expect(classified, `${adapter.id} refused its own ${file.neutralRel}`).not.toBeNull();
          expect(classified?.logicalId).toBe(group.logicalId);
          expect(classified?.role).toBe(file.role);
          expect(classified?.mode).toBe(file.mode);
        }
      }
    },
  );

  it.each(FIXTURES.map((fixture) => [fixture.id, fixture] as const))(
    "%s: classifyNeutral still refuses shapes the listing never makes",
    async (_id, fixture) => {
      // The reverse direction, so the consistency test cannot be satisfied by
      // a classifyNeutral that accepts everything.
      const adapter = await fixture.build();
      for (const rel of [
        `${adapter.id}/../escape.jsonl`,
        `${adapter.id}/auth.json`,
        `not-${adapter.id}/${SID}.jsonl`,
      ]) {
        expect(adapter.classifyNeutral(rel), rel).toBeNull();
      }
    },
  );
});
