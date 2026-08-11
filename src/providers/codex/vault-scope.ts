/**
 * Which Codex sessions belong to *this* vault (architecture §6.4, OQ-11).
 *
 * Claude Code partitions its storage by project, so "sessions of this vault"
 * is a directory. Codex does not: `~/.codex/sessions` is one global tree for
 * every project on the machine. Enabling the provider without an answer to
 * this would push every Codex conversation the user has ever had into this
 * vault's workspace subtree — a privacy problem, not a tidiness one.
 *
 * The answer is already in the vault. Claudian keeps one metadata file per
 * conversation under `<vault>/.claudian/sessions/`, each recording the
 * provider and the CLI's own session id; because that directory *is* inside
 * the vault, every conversation listed there belongs to this vault by
 * construction. No heuristic, no reading of session content, no guessing from
 * a `cwd` field.
 *
 * Three deliberate limits:
 *
 * - **Read-only, and never the paths.** These files also carry absolute paths
 *   from whichever machine wrote them (`providerState.sessionFilePath`). Those
 *   are meaningless here and are ignored; only the id is taken, and the local
 *   file is found by matching names.
 * - **Fail closed.** A missing, unreadable or unrecognised store yields an
 *   empty set, which syncs nothing. The failure mode of this lookup must be
 *   "too few sessions", never "everything on this machine".
 * - **Coverage is what Claudian knows about.** A Codex session started in a
 *   terminal has no conversation file here and will not sync. That is the
 *   right scope for this plugin, and it belongs in the README rather than in
 *   a workaround.
 */

/** Current location, and the one Claudian migrated from. */
const STORE_DIRS = [
  [".claudian", "sessions"],
  [".claude", "sessions"],
] as const;

const META_SUFFIX = ".meta.json";

export interface VaultScopeDeps {
  readonly vaultRealPath: string;
  readonly joinPath: (...parts: string[]) => string;
  readonly listDir: (path: string) => Promise<Array<{ name: string; isFile: boolean }>>;
  readonly readTextFile: (path: string) => Promise<string | null>;
}

export interface VaultScope {
  /** Session ids of conversations this vault has, for one provider. */
  readonly sessionIds: ReadonlySet<string>;
  /** Whether a store was found at all — the difference between "none" and "no store". */
  readonly storeFound: boolean;
}

/**
 * Reads the vault-side conversation store and returns the ids for one provider.
 *
 * `accept` filters ids to shapes this provider recognises; anything else is
 * dropped rather than trusted, since these files are written by another
 * program and may have been edited by hand.
 */
export async function readVaultScope(
  deps: VaultScopeDeps,
  providerId: string,
  accept: (value: unknown) => value is string,
): Promise<VaultScope> {
  const sessionIds = new Set<string>();
  let storeFound = false;

  for (const parts of STORE_DIRS) {
    const dir = deps.joinPath(deps.vaultRealPath, ...parts);
    const entries = await deps.listDir(dir).catch(() => []);
    if (entries.length === 0) continue;
    storeFound = true;

    for (const entry of entries) {
      if (!entry.isFile || !entry.name.endsWith(META_SUFFIX)) continue;
      const text = await deps.readTextFile(deps.joinPath(dir, entry.name));
      if (text === null) continue;
      const id = sessionIdOf(text, providerId, accept);
      if (id !== null) sessionIds.add(id);
    }
  }

  return { sessionIds, storeFound };
}

/**
 * One conversation file → its provider session id, if it is this provider's.
 *
 * Two places carry the id — the top-level `sessionId` and
 * `providerState.threadId` — and the sample from a real vault has them equal.
 * Both are read because a file mid-write may have one and not the other, and
 * neither is worth failing over.
 */
function sessionIdOf(
  text: string,
  providerId: string,
  accept: (value: unknown) => value is string,
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A torn read of a file being rewritten in place. Claudian rewrites these
    // wholesale on every turn, so catching a half-written one is expected —
    // and the next pass will read it whole.
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  if (record.providerId !== providerId) return null;

  const state = typeof record.providerState === "object" && record.providerState !== null
    ? (record.providerState as Record<string, unknown>)
    : {};
  for (const candidate of [record.sessionId, state.threadId]) {
    if (accept(candidate)) return candidate;
  }
  return null;
}
