/**
 * Claude Code (architecture §6.1.1, §6.3) — Tier A, and the M1 mainline.
 *
 * Tier A is earned, not assumed: OQ-8 measured 36 lifecycle snapshots across
 * macOS and Windows with zero prefix violations, including compact, fork, retry
 * and SIGKILL. Compact and fork both turned out to be physical appends that
 * keep the same file and sessionId, which is what makes prefix-safe merge
 * applicable at all.
 */
import type { LogicalId } from "../../domain/types";
import { type ProviderAdapter, type SessionGroup, classifyFileName } from "../provider-adapter";
import { escapeProjectPath } from "./path-escape";

/** Lowercase UUID, matched as the leading segment (§6.3). */
export const CLAUDE_LOGICAL_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

export interface ClaudeCodeAdapterDeps {
  readonly providerRoot: string;
  /** Absolute vault path, already realpath'd — the escape rule's measured input. */
  readonly vaultRealPath: string;
  readonly joinPath: (...parts: string[]) => string;
  readonly listDir: (path: string) => Promise<Array<{ name: string; isFile: boolean }>>;
  readonly statFile: (path: string) => Promise<{ mtimeMs: number } | null>;
  /** Overrides the derived directory name; the `custom` escape strategy (§6.3). */
  readonly customDirName?: string;
}

export function createClaudeCodeAdapter(deps: ClaudeCodeAdapterDeps): ProviderAdapter {
  const projectDirName = deps.customDirName ?? escapeProjectPath(deps.vaultRealPath);
  const projectDir = deps.joinPath(deps.providerRoot, projectDirName);

  /**
   * The §8.2 whitelist, declared once and used on both sides.
   *
   * Both sides matters: `listSessions` applies it to names the CLI wrote, and
   * `classifyNeutral` applies the same rule to names another machine's sync
   * tool put in the replica. Two copies of this rule would eventually disagree,
   * and the side that drifted looser is the side that writes into the CLI's
   * directory.
   */
  const whitelist = {
    logicalIdPattern: CLAUDE_LOGICAL_ID_PATTERN,
    primaryExtensions: [".jsonl"],
    // Only ever written in the sync directory, never pulled into the provider
    // directory — OQ-5 showed the CLI tolerates unknown extensions, but there
    // is no reason to test that tolerance with our own files.
    auxSuffixPattern: /^\.origin\.json$/,
  } as const;

  return {
    id: "claude-code",
    tier: "A",
    ...whitelist,

    async healthCheck() {
      const dir = await deps.statFile(projectDir);
      return dir === null
        ? { ok: false, reason: "project directory not found" }
        : { ok: true };
    },

    async listSessions() {
      const entries = await deps.listDir(projectDir).catch(() => []);
      const groups: SessionGroup[] = [];

      for (const entry of entries) {
        if (!entry.isFile) continue; // `memory/` is a directory; F-7, not synced in M1
        const match = CLAUDE_LOGICAL_ID_PATTERN.exec(entry.name);
        if (!match || match.index !== 0 || entry.name !== `${match[0]}.jsonl`) continue;

        const absPath = deps.joinPath(projectDir, entry.name);
        const stat = await deps.statFile(absPath);
        if (stat === null) continue;

        groups.push({
          logicalId: match[0] as LogicalId,
          files: [
            {
              role: "primary",
              absPath,
              // The neutral layout is provider-first under the workspace, so
              // the directory name (which is machine-specific) never travels.
              neutralRel: `claude-code/${entry.name}`,
              mode: "append-jsonl",
            },
          ],
          lastModifiedMs: stat.mtimeMs,
        });
      }
      return groups;
    },

    classifyNeutral(neutralRel) {
      // Claude Code's layout is flat: exactly `claude-code/<name>`. Anything
      // deeper is not this provider's shape, and guessing that a nested file
      // "probably belongs to us" is how a foreign tree gets flattened into the
      // CLI's directory — `targetPathFor` keeps only the basename.
      const parts = neutralRel.split("/");
      const name = parts.length === 2 && parts[0] === "claude-code" ? parts[1] : undefined;
      if (name === undefined) return null;
      const classified = classifyFileName(whitelist, name);
      if (classified.kind === "unknown") return null;
      return {
        logicalId: classified.logicalId as LogicalId,
        role: classified.kind,
        // Both shapes are jsonl the CLI appends to; the aux file is ours and is
        // never pulled anyway (the engine acts on primaries only).
        mode: "append-jsonl" as const,
      };
    },

    async targetPathFor(neutralRel) {
      const fileName = neutralRel.slice(neutralRel.lastIndexOf("/") + 1);
      return deps.joinPath(projectDir, fileName);
    },

    async reconcileLocalIndex() {
      // Tier A: discovery is a directory scan, so there is no index to rebuild.
    },
  };
}

/** Where this adapter would put its files, for preflight's root-overlap check. */
export function claudeCodeProjectDir(deps: {
  readonly providerRoot: string;
  readonly vaultRealPath: string;
  readonly joinPath: (...parts: string[]) => string;
  readonly customDirName?: string;
}): string {
  const name = deps.customDirName ?? escapeProjectPath(deps.vaultRealPath);
  return deps.joinPath(deps.providerRoot, name);
}
