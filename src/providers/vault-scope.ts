/**
 * Which sessions belong to *this* vault — every provider's admission list
 * (architecture §6.2, ADR-46/47).
 *
 * This began as Codex's problem: `~/.codex/sessions` is one global tree for
 * every project on the machine, so without a scoping rule, enabling the
 * provider would push every Codex conversation the user ever had into this
 * vault's workspace — a privacy problem, not a tidiness one. ADR-47 then made
 * the same rule the admission model for *all* providers, because a plugin
 * named Claudian Session Sync should sync Claudian's conversations, and
 * because one scoping story is one README section instead of two.
 *
 * The answer is already in the vault. Claudian keeps one metadata file per
 * conversation under `<vault>/.claudian/sessions/`, each recording the
 * provider and the CLI's own session id; because that directory *is* inside
 * the vault, every conversation listed there belongs to this vault by
 * construction. No heuristic, no reading of session content, no guessing from
 * a `cwd` field.
 *
 * Admission is all this decides. What may *enter* the sync folder is scoped
 * here; what keeps converging once there is the engine's replica walk, which
 * compares both sides of every replica file whether or not any adapter lists
 * it. The split is load-bearing: the machine that pulled a session may never
 * hold its conversation record (Obsidian Sync does not carry dotfolders), and
 * if membership depended on this lookup, that machine's extensions would
 * silently never push back.
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
 * - **Coverage is what Claudian knows about.** A session started in a plain
 *   terminal has no conversation file here and is not admitted. That is the
 *   right scope for this plugin, and it belongs in the README rather than in
 *   a workaround.
 */

/** Lowercase UUID — the shape every measured provider uses for session ids. */
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Is this a plausible session id?
 *
 * Only ever used to filter ids read out of Claudian's vault store, which is a
 * file another program writes. The ids are matched against file *names*, never
 * joined into a path, but a store that has been edited by hand should not be
 * able to turn a listing into a wildcard either.
 */
export function isSessionUuid(value: unknown): value is string {
  return typeof value === "string" && SESSION_UUID.test(value);
}

/** Current location, and the one Claudian migrated from. */
const STORE_DIRS = [
  [".claudian", "sessions"],
  [".claude", "sessions"],
] as const;

const META_SUFFIX = ".meta.json";
/**
 * Claudian's deletion is a tombstone, not a removal: `markDeleted` writes
 * `<convId>.deleted.json` and leaves the meta file where it was, and
 * Claudian's own scan filters by the tombstones. Admission does the same —
 * a deleted conversation stops being admitted. Nothing is removed from the
 * sync folder here: that would be deletion propagation, which stays out of
 * scope until it has a design of its own (ADR-10; the resurrection race is
 * real — the other machine may still be extending its copy).
 */
const TOMBSTONE_SUFFIX = ".deleted.json";

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

    const tombstoned = new Set(
      entries
        .filter((entry) => entry.isFile && entry.name.endsWith(TOMBSTONE_SUFFIX))
        .map((entry) => entry.name.slice(0, -TOMBSTONE_SUFFIX.length)),
    );

    for (const entry of entries) {
      if (!entry.isFile || !entry.name.endsWith(META_SUFFIX)) continue;
      if (tombstoned.has(entry.name.slice(0, -META_SUFFIX.length))) continue;
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
 * `providerId` here is **Claudian's** id for the provider, which is not always
 * this plugin's: Claudian says `"claude"` where this plugin says
 * `"claude-code"` (`codex`/`grok`/`pi` agree). Each adapter passes the
 * Claudian spelling.
 *
 * Three places can carry the id — top-level `sessionId`,
 * `providerState.threadId` (Codex) and `providerState.providerSessionId`
 * (Claude) — and real samples have them equal where present. All are read
 * because a conversation that has not had its first turn yet carries
 * `sessionId: null` and no providerState at all (measured 2026-08-12), and a
 * file mid-rewrite may have one field and not another.
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
  for (const candidate of [record.sessionId, state.threadId, state.providerSessionId]) {
    if (accept(candidate)) return candidate;
  }
  return null;
}
