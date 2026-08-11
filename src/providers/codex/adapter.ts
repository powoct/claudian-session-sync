/**
 * Codex (architecture §6.4) — the second provider, and the one that breaks
 * every shape assumption Claude Code let us get away with.
 *
 * Three differences drive everything here:
 *
 * 1. **The file name is not the id.** It is `rollout-<ts>-<uuid>.jsonl`, with
 *    the id in the tail. Matched by suffix, never by parsing a fixed prefix.
 * 2. **The layout is nested.** `sessions/YYYY/MM/DD/<file>`, and the date
 *    directories travel: the neutral path keeps them and `targetPathFor`
 *    rebuilds the same relative location. Rebuilding the date from the file
 *    name's timestamp instead would be a guess about which of the two the CLI
 *    trusts, and a session the CLI cannot find is indistinguishable from one
 *    that never arrived.
 * 3. **The storage is global.** There is no per-project partition, so which
 *    sessions belong to this vault is answered by `vault-scope.ts` — see
 *    OQ-11 for why that question has to be answered before anything is
 *    pushed.
 *
 * Discovery is a directory scan with no index to maintain (OQ-2 measured the
 * CLI finding a copied-in rollout immediately), which is what lets this be a
 * Tier A shape at all. `archived_sessions/` is deliberately **not** scanned:
 * Codex moves rollouts there, and until that lifecycle is measured on a real
 * machine, a file leaving `sessions/` is a fact this plugin only has to *not*
 * misread as a deletion — which it does not, because deletion propagation
 * does not exist.
 */
import type { LogicalId } from "../../domain/types";
import type { ProviderAdapter, SessionGroup } from "../provider-adapter";
import {
  CODEX_DATE_SEGMENT,
  CODEX_LOGICAL_ID_PATTERN,
  isCodexSessionId,
  rolloutLogicalId,
} from "./rollout-name";
import { readVaultScope } from "./vault-scope";

export const CODEX_PROVIDER_ID = "codex";

/** `<provider>/YYYY/MM/DD/<file>` — provider segment plus four. */
const NEUTRAL_SEGMENTS = 5;
/** Depth of the date tree below the sessions root. */
const DATE_DEPTH = 3;

export interface CodexAdapterDeps {
  /** `<CODEX_HOME>/sessions`, already realpath'd. */
  readonly providerRoot: string;
  readonly vaultRealPath: string;
  readonly joinPath: (...parts: string[]) => string;
  readonly listDir: (path: string) => Promise<Array<{ name: string; isFile: boolean }>>;
  readonly statFile: (path: string) => Promise<{ mtimeMs: number } | null>;
  readonly readTextFile: (path: string) => Promise<string | null>;
}

export function createCodexAdapter(deps: CodexAdapterDeps): ProviderAdapter {
  return {
    id: CODEX_PROVIDER_ID,
    // Tier A *shape*, still an unmeasured tier on this platform: OQ-2 measured
    // one macOS round. §6.1's release gate — not the development gate — is
    // what keeps that honest, and the descriptor marks it experimental.
    tier: "A",
    logicalIdPattern: CODEX_LOGICAL_ID_PATTERN,
    primaryExtensions: [".jsonl"],
    auxSuffixPattern: null,

    async healthCheck() {
      if ((await deps.statFile(deps.providerRoot)) === null) {
        return { ok: false, reason: "sessions directory not found" };
      }
      const scope = await readVaultScope(deps, CODEX_PROVIDER_ID, isCodexSessionId);
      if (!scope.storeFound) {
        // Not an error the user has to fix — it is what an unused provider
        // looks like — but saying nothing would make "syncs nothing" look
        // like a broken install.
        return { ok: false, reason: "no Claudian conversation records in this vault" };
      }
      return { ok: true };
    },

    async listSessions() {
      const scope = await readVaultScope(deps, CODEX_PROVIDER_ID, isCodexSessionId);
      if (scope.sessionIds.size === 0) return [];

      const groups: SessionGroup[] = [];
      await walk(deps.providerRoot, [], 0);
      return groups;

      async function walk(dir: string, rel: readonly string[], depth: number): Promise<void> {
        for (const entry of await deps.listDir(dir).catch(() => [])) {
          if (entry.isFile) {
            if (depth !== DATE_DEPTH) continue; // Only `YYYY/MM/DD/<file>`.
            const logicalId = rolloutLogicalId(entry.name);
            if (logicalId === null || !scope.sessionIds.has(logicalId)) continue;

            const absPath = deps.joinPath(dir, entry.name);
            const stat = await deps.statFile(absPath);
            if (stat === null) continue;
            groups.push({
              logicalId,
              files: [
                {
                  role: "primary",
                  absPath,
                  neutralRel: [CODEX_PROVIDER_ID, ...rel, entry.name].join("/"),
                  mode: "append-jsonl",
                },
              ],
              lastModifiedMs: stat.mtimeMs,
            });
            continue;
          }
          if (depth >= DATE_DEPTH || !CODEX_DATE_SEGMENT.test(entry.name)) continue;
          await walk(deps.joinPath(dir, entry.name), [...rel, entry.name], depth + 1);
        }
      }
    },

    classifyNeutral(neutralRel) {
      const parts = neutralRel.split("/");
      if (parts.length !== NEUTRAL_SEGMENTS || parts[0] !== CODEX_PROVIDER_ID) return null;
      if (!parts.slice(1, 4).every((segment) => CODEX_DATE_SEGMENT.test(segment))) return null;
      const logicalId = rolloutLogicalId(parts[4] as string);
      if (logicalId === null) return null;
      // Deliberately *not* filtered by the vault scope. Scope decides what
      // leaves this machine; the replica's `codex/` subtree is written only by
      // this plugin, from the other machine's already-scoped push. Filtering
      // here as well would make a pulled session look like a foreign file for
      // however long the vault takes to carry its conversation record over.
      return { logicalId, role: "primary", mode: "append-jsonl" };
    },

    async targetPathFor(neutralRel) {
      return deps.joinPath(deps.providerRoot, ...neutralRel.split("/").slice(1));
    },

    async reconcileLocalIndex() {
      // OQ-2: discovery is a directory scan. `session_index.jsonl` is a
      // leftover from older versions and the sqlite state DB does not
      // participate — neither is ever written or carried (§6.4 red line).
    },
  };
}

/** Where this adapter would write, for preflight's root-overlap check. */
export function codexSessionsDir(deps: {
  readonly providerRoot: string;
}): string {
  return deps.providerRoot;
}

/** Re-exported so the registry can name the id without importing the adapter. */
export type { LogicalId };
