/**
 * Grok (architecture §6.1.1, §6.6.1, ADR-52) — the first real multi-file group.
 *
 * A Grok session is a *directory*, and its members do not agree with each
 * other about how they are written. That is the whole difference from the
 * providers shipped before it, and it is measured rather than assumed
 * (2026-08-24, both platforms, 38 lifecycle snapshots):
 *
 *   summary.json          rewritten whole, every turn      → opaque table §7.2b
 *   chat_history.jsonl    strictly appended                → prefix table §7.2
 *   updates.jsonl         strictly appended
 *   rewind_points.jsonl   strictly appended
 *
 * `summary.json` is the primary because it is the one file whose absence takes
 * the session out of `grok sessions list`, and the one file the CLI does *not*
 * rebuild. It also carries the session's identity: the uuid at `info.id`
 * equals the directory name, so a directory may never be renamed.
 *
 * Everything else the CLI writes is left alone. `prompt_context.json` and
 * `system_prompt.txt` and `events.jsonl` are all rebuilt when missing — the
 * first two deterministically (system_prompt.txt showed a single hash across
 * every snapshot on both machines) — so copying them buys nothing and costs a
 * whole-file merge. `prompt_context.json` additionally holds this machine's
 * `working_directory` and `shell_path`, which is the §7.3 hazard in its
 * purest form. The `.lock` files are always exactly zero bytes: they are flock
 * handles, not content.
 *
 * The per-session file set varies by CLI version and by which features a
 * conversation used — the real-machine census found `updates.jsonl` in 11 of
 * 22 sessions and `signals.json` in 8 — so this adapter never requires a
 * member to exist. It only declares which names it recognises.
 */
import type { LogicalId } from "../../domain/types";
import type {
  FileMode,
  ProviderAdapter,
  SessionFileRef,
  SessionGroup,
} from "../provider-adapter";
import { describeUnreadDirs, isSessionUuid, readVaultScope } from "../vault-scope";

export const GROK_PROVIDER_ID = "grok";

/** Claudian's name for this provider, and ours, happen to agree. */
const CLAUDIAN_PROVIDER_ID = "grok";

/**
 * A session directory name: the uuid, anchored both ends.
 *
 * Anchored at the end unlike Claude Code's, because here the whole directory
 * name is the id — there is no extension to absorb a suffix, so an unanchored
 * pattern would accept `<uuid>.sync-conflict-…` as a session directory.
 */
export const GROK_SESSION_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The §8.2 whitelist, as a table rather than a pattern.
 *
 * Grok's member names are a fixed vocabulary, so the whitelist is literally
 * the list. A name absent from it is not synced in either direction — which
 * for a file the CLI rebuilds is the intended outcome, and for a file a future
 * version introduces is the fail-closed one.
 */
const MEMBERS: ReadonlyMap<string, { readonly role: "primary" | "aux"; readonly mode: FileMode }> =
  new Map([
    ["summary.json", { role: "primary" as const, mode: "opaque-file" as const }],
    ["chat_history.jsonl", { role: "aux" as const, mode: "append-jsonl" as const }],
    ["updates.jsonl", { role: "aux" as const, mode: "append-jsonl" as const }],
    ["rewind_points.jsonl", { role: "aux" as const, mode: "append-jsonl" as const }],
  ]);

/**
 * Members whose absence on the other machine has **measured** backing.
 *
 * 2026-08-24, both platforms, one file moved away at a time (§6b.5): the CLI
 * rebuilt `prompt_context.json`, `system_prompt.txt` (byte-identical) and
 * `events.jsonl`, and `title_refresh_idx` turned out to carry no ordering
 * information at all — the session stayed listed and resumed intact without
 * each of them. `*.lock` files were measured at zero bytes in every snapshot
 * on both machines; they are flock handles, not content.
 *
 * Everything else a session directory holds is named in the report instead.
 * Not because it is suspicious — most of it is machine-local state — but
 * because nobody has checked, and `compaction/` is what that costs: its
 * exclusion was a deliberate, recorded decision, and it still took a probe to
 * notice that `/compact` had moved the conversation into it.
 */
const ABSENCE_MEASURED = new Set([
  "prompt_context.json",
  "system_prompt.txt",
  "events.jsonl",
  "title_refresh_idx",
]);

export interface GrokAdapterDeps {
  /** `<GROK_HOME>/sessions` or `~/.grok/sessions`, already realpath'd. */
  readonly providerRoot: string;
  /**
   * Absolute vault path, already realpath'd.
   *
   * realpath, not `path.resolve`: the CLI names its project directory from its
   * own resolved cwd (measured byte-exact on both platforms), so a vault
   * reached through a symlink lands under the resolved name. Claudian's own
   * resolver uses `path.resolve` and falls back to scanning — this plugin
   * matches the CLI, because the CLI is what creates the directory.
   */
  readonly vaultRealPath: string;
  readonly joinPath: (...parts: string[]) => string;
  readonly listDir: (path: string) => Promise<Array<{ name: string; isFile: boolean }>>;
  readonly statFile: (path: string) => Promise<{ mtimeMs: number } | null>;
  /** For the vault's conversation records only — never for session bytes. */
  readonly readTextFile: (path: string) => Promise<string | null>;
  /** Overrides the derived directory name, for a version that encodes differently. */
  readonly customDirName?: string;
}

/**
 * `encodeURIComponent(<absolute cwd>)` — measured byte-exact on macOS and
 * Windows (`C%3A%5CUsers%5C…`), and the same expression Claudian's own
 * resolver uses.
 */
export function grokProjectDirName(vaultRealPath: string): string {
  return encodeURIComponent(vaultRealPath);
}

export function createGrokAdapter(deps: GrokAdapterDeps): ProviderAdapter {
  const projectDir = deps.joinPath(
    deps.providerRoot,
    deps.customDirName ?? grokProjectDirName(deps.vaultRealPath),
  );

  return {
    id: GROK_PROVIDER_ID,
    // Per file, not per provider: the group spans both tables (ADR-52). The
    // single value here is the conservative one — what a user reading "Tier"
    // needs to know is that some of this provider's files are whole-file
    // rewrites and can need a manual choice.
    tier: "R",
    logicalIdPattern: GROK_SESSION_DIR,
    // Declared for the shared machinery's sake; Grok's names are matched
    // against MEMBERS instead, because its logicalId is the *directory* and
    // the file names are a closed vocabulary.
    primaryExtensions: [],
    auxSuffixPattern: null,

    async healthCheck() {
      // The provider root, not this vault's project directory — the same gate
      // Codex uses, and for the same reason. A machine where Grok is installed
      // but has never held a conversation in this vault has no project
      // directory yet, and that is exactly the machine that is about to pull
      // one; saying "unavailable" there would be a notice every pass for a
      // state that is not a problem. An empty listing says it better.
      if ((await deps.statFile(deps.providerRoot)) === null) {
        return { ok: false, reason: "sessions directory not found" };
      }
      const scope = await readVaultScope(deps, CLAUDIAN_PROVIDER_ID, isSessionUuid);
      if (!scope.storeFound) {
        return { ok: false, reason: "no Claudian conversation records in this vault" };
      }
      return { ok: true, warnings: describeUnreadDirs(scope.unreadDirs) };
    },

    async listSessions() {
      // ADR-47: admission is the vault's Claudian records, for every provider.
      // Claudian stores the Grok session id — the directory name — in the
      // record's `sessionId`, which its own path resolver then joins onto the
      // encoded cwd. So the record and the directory name are the same string,
      // and admission needs no guessing.
      const scope = await readVaultScope(deps, CLAUDIAN_PROVIDER_ID, isSessionUuid);
      if (scope.sessionIds.size === 0) return [];

      const groups: SessionGroup[] = [];
      for (const entry of await deps.listDir(projectDir).catch(() => [])) {
        if (entry.isFile) continue; // `session_search.sqlite` and friends
        if (!GROK_SESSION_DIR.test(entry.name)) continue;
        if (!scope.sessionIds.has(entry.name)) continue;

        const sessionDir = deps.joinPath(projectDir, entry.name);
        const files: SessionFileRef[] = [];
        const witnessPaths: string[] = [];
        const unprovenOmissions: string[] = [];
        let lastModifiedMs = 0;

        for (const member of await deps.listDir(sessionDir).catch(() => [])) {
          if (!member.isFile) {
            // A directory is named and not descended into. `compaction/` holds
            // the conversation `/compact` moved out of `chat_history.jsonl`
            // (36,811 B of it, measured), so the name is the part worth
            // reporting; walking inside would only turn one honest line into
            // several, and none of it travels either way.
            unprovenOmissions.push(`${member.name}/`);
            continue;
          }
          // Everything the CLI writes counts as a sign of life, whether or not
          // it travels — `events.jsonl` is the most sensitive of them (roughly
          // ten writes a second during a turn) and is deliberately not synced,
          // so using it costs no transfer at all. Locks are excluded: they are
          // always zero bytes and exist for the whole life of the process, so
          // they say nothing about whether it is writing (findings 2026-08-24).
          if (!member.name.endsWith(".lock")) {
            witnessPaths.push(deps.joinPath(sessionDir, member.name));
          }
          const known = MEMBERS.get(member.name);
          if (known === undefined) {
            if (!member.name.endsWith(".lock") && !ABSENCE_MEASURED.has(member.name)) {
              unprovenOmissions.push(member.name);
            }
            continue;
          }

          const absPath = deps.joinPath(sessionDir, member.name);
          const stat = await deps.statFile(absPath);
          if (stat === null) continue;
          files.push({
            role: known.role,
            absPath,
            // The project directory name is this machine's vault path, encoded,
            // so it must not travel. `<uuid>/<member>` is machine-neutral, and
            // the uuid segment has to survive because the CLI matches it
            // against `info.id` inside summary.json.
            neutralRel: `${GROK_PROVIDER_ID}/${entry.name}/${member.name}`,
            mode: known.mode,
          });
          lastModifiedMs = Math.max(lastModifiedMs, stat.mtimeMs);
        }

        // No primary, no group. A directory without summary.json is one the
        // CLI does not list either — most likely a half-written session — and
        // pushing its history without its commit point would put a session in
        // the sync folder that no machine can ever show.
        if (!files.some((file) => file.role === "primary")) continue;
        groups.push({
          logicalId: entry.name as LogicalId,
          files,
          lastModifiedMs,
          witnessPaths,
          unprovenOmissions,
        });
      }
      return groups;
    },

    async listIncompleteSessions() {
      // The same walk as `listSessions`, kept to the sessions it drops: a
      // directory this vault's records admit, holding members, with no
      // `summary.json`. Admission still applies — a session this vault has no
      // Claudian record for is none of this plugin's business, even to clean.
      const scope = await readVaultScope(deps, CLAUDIAN_PROVIDER_ID, isSessionUuid);
      const groups: SessionGroup[] = [];
      for (const entry of await deps.listDir(projectDir).catch(() => [])) {
        if (entry.isFile) continue;
        if (!GROK_SESSION_DIR.test(entry.name)) continue;
        if (!scope.sessionIds.has(entry.name)) continue;

        const sessionDir = deps.joinPath(projectDir, entry.name);
        const files: SessionFileRef[] = [];
        let lastModifiedMs = 0;
        let hasPrimary = false;
        for (const member of await deps.listDir(sessionDir).catch(() => [])) {
          if (!member.isFile) continue;
          const known = MEMBERS.get(member.name);
          if (known === undefined) continue;
          if (known.role === "primary") hasPrimary = true;
          const absPath = deps.joinPath(sessionDir, member.name);
          const stat = await deps.statFile(absPath);
          if (stat === null) continue;
          files.push({
            role: known.role,
            absPath,
            neutralRel: `${GROK_PROVIDER_ID}/${entry.name}/${member.name}`,
            mode: known.mode,
          });
          lastModifiedMs = Math.max(lastModifiedMs, stat.mtimeMs);
        }
        if (hasPrimary || files.length === 0) continue;
        groups.push({ logicalId: entry.name as LogicalId, files, lastModifiedMs });
      }
      return groups;
    },

    classifyNeutral(neutralRel) {
      const parts = neutralRel.split("/");
      if (parts.length !== 3 || parts[0] !== GROK_PROVIDER_ID) return null;
      const [, sessionId, name] = parts as [string, string, string];
      if (!GROK_SESSION_DIR.test(sessionId)) return null;
      const known = MEMBERS.get(name);
      if (known === undefined) return null;
      return { logicalId: sessionId as LogicalId, role: known.role, mode: known.mode };
    },

    async targetPathFor(neutralRel) {
      // Every segment after the provider prefix is kept, as Codex does for its
      // date directories: the session id is part of the location, not just a
      // label, and taking the basename alone — which is right for the flat
      // providers — would pile every session's files into one directory.
      // A malformed rel therefore produces a path under the project directory
      // rather than an exception, and PathGuard refuses it from there.
      return deps.joinPath(projectDir, ...neutralRel.split("/").slice(1));
    },

    async reconcileLocalIndex() {
      // Discovery is a directory scan. `sessions/session_search.sqlite` exists
      // but is a search cache, not a gate: a session copied into a GROK_HOME
      // with no index at all was listed, and the index was created on demand.
      // Nothing to rebuild, and nothing that may be carried between machines.
    },
  };
}

/** Where this adapter would write, for preflight's root-overlap check. */
export function grokProjectDir(deps: {
  readonly providerRoot: string;
  readonly vaultRealPath: string;
  readonly joinPath: (...parts: string[]) => string;
  readonly customDirName?: string;
}): string {
  return deps.joinPath(
    deps.providerRoot,
    deps.customDirName ?? grokProjectDirName(deps.vaultRealPath),
  );
}
