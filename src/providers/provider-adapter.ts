/**
 * What a provider adapter answers (architecture §6.2).
 *
 * Adapters do not decide anything. They answer five questions — what sessions
 * exist here, where does a neutral file land locally, which group does it
 * belong to, does anything need converting, and how is a local index rebuilt —
 * and the engine decides. That separation is what keeps the decision table
 * exhaustively testable without a CLI installed.
 *
 * The engine does not trust adapter output either. An adapter is our code, but
 * it is written to tolerate CLI versions it has never seen, so a structure
 * change upstream can make it emit nonsense. Everything it returns goes through
 * PathGuard before it reaches the filesystem (testing.md §8.2).
 */
import type { LogicalId } from "../domain/types";

/**
 * A: append-only primary file, discovered by scanning a directory.
 * B: needs an external index updated before the CLI can see a session.
 * C: read-only — structure understood, lifecycle unverified.
 * R: whole-file rewrites — synced by the opaque table (§7.2b): converged-base
 *    fast-forward or a manual conflict, never a picked side.
 *
 * Tier requires measured evidence. Anything unproven stays at C.
 */
export type ProviderTier = "A" | "B" | "C" | "R";

export type FileMode = "append-jsonl" | "opaque-file" | "derived";

export interface SessionFileRef {
  readonly role: "primary" | "aux";
  readonly absPath: string;
  /** POSIX-separated path under the workspace subtree; validated before use. */
  readonly neutralRel: string;
  readonly mode: FileMode;
}

export interface SessionGroup {
  readonly logicalId: LogicalId;
  readonly files: readonly SessionFileRef[];
  readonly lastModifiedMs: number;
  /**
   * Local paths that say whether this session is *being written right now*
   * (§9.1, OQ-17). Stat-only: never read, never written, never synced.
   *
   * Per-file quiescence asks "has this file held still", and for a provider
   * that spreads one turn across several files that is the wrong question.
   * Grok was measured leaving `chat_history.jsonl` untouched for 23 seconds in
   * the middle of a turn while `events.jsonl` advanced about ninety times — so
   * the file looks settled precisely while the conversation is in flight, and
   * a pass that believes it copies a version the finished turn does not
   * extend. The cheapest honest answer is to ask the whole session instead,
   * which is what these paths are for.
   *
   * Empty (the default) means "judge my files individually", which is correct
   * for every provider whose session is one file.
   */
  readonly witnessPaths?: readonly string[];
  /**
   * Member names this session holds that do **not** travel, and whose absence
   * on the other machine has never been measured.
   *
   * Not "names we do not recognise" — that line would have been useless here.
   * `compaction/` was in the 2026-08-24 census and its exclusion was a recorded
   * decision, so a novelty detector would have stayed quiet while `/compact`
   * moved 37 KB of conversation into a file that does not travel (OQ-14). The
   * line that catches it is evidential: a member is silent only when someone
   * measured that the CLI rebuilds it, or that its absence changes nothing.
   * Everything else is named, because "we never checked" is exactly what the
   * user is entitled to know before wondering where their history went.
   *
   * The list therefore shrinks as measurements land, which is the incentive it
   * is meant to create. Reported, never acted on: §8.2's whitelist still
   * decides what is carried, and ADR-34 still forbids touching the rest.
   */
  readonly unprovenOmissions?: readonly string[];
}

/**
 * What a neutral path found in the replica means locally (architecture §6.2).
 *
 * `null` is the §8.2 whitelist applied to the *remote* side, and it is the
 * whole reason this method exists as a first-class part of the contract: the
 * local side gets its whitelist for free, because discovery is the adapter
 * listing names it recognises, while the remote side is a directory another
 * machine's sync tool writes into. Reconstructing a session from "a file was
 * there" is how a Syncthing conflict copy ends up in the CLI's own directory.
 */
export interface NeutralClassification {
  readonly logicalId: LogicalId;
  readonly role: "primary" | "aux";
  readonly mode: FileMode;
  /**
   * Ours, and only ever in the sync directory.
   *
   * Recognised so the report does not call it a foreign artifact, and never
   * landed in the CLI's own directory — Claude Code's `<sid>.origin.json` is
   * the only one (§6.3). Distinct from `derived`, which describes a file the
   * CLI rebuilds: this one has no local counterpart at all, so there is
   * nothing to say about it each pass.
   */
  readonly replicaOnly?: boolean;
}

/**
 * The `healthCheck` reason every CLI provider gives when the vault has no
 * Claudian records to admit sessions by (ADR-47). One string, because the
 * engine matches it: a pass that creates the records folder says that once,
 * in place of these lines (D12).
 */
export const NO_RECORDS_REASON = "no Claudian conversation records in this vault";

export interface ProviderAdapter {
  readonly id: string;
  readonly tier: ProviderTier;
  /**
   * The security boundary (§8.2 layer 1). A filename must match this as its
   * leading segment, and the remainder must be a known extension or aux
   * suffix — anything else is not treated as a session at all.
   */
  readonly logicalIdPattern: RegExp;
  readonly primaryExtensions: readonly string[];
  readonly auxSuffixPattern: RegExp | null;

  /**
   * Is this provider usable on this machine right now?
   *
   * `warnings` is for the case this has no other word for: the provider works,
   * and something about the way it works deserves a sentence anyway. It exists
   * because 2026-09-01's failure had no channel — an upstream layout change
   * meant sessions stopped being admitted, and an unadmitted session produces
   * no group, no action and no report line, so a pass with nothing to say said
   * "up to date". Every other diagnostic this plugin has hangs off a file it
   * decided something about; this one has to survive there being none.
   */
  healthCheck(): Promise<{
    readonly ok: boolean;
    readonly reason?: string;
    readonly warnings?: readonly string[];
  }>;
  listSessions(): Promise<SessionGroup[]>;
  /**
   * The inverse of `listSessions`, for a file only the replica has.
   *
   * Must be as strict as listing is: a name this returns non-null for is a name
   * the engine will write into the CLI's directory. Returning something for a
   * path shape the provider does not use is the same mistake as listing a file
   * the CLI never wrote.
   */
  classifyNeutral(neutralRel: string): NeutralClassification | null;
  /** Where a neutral-relative file lands locally. Must realpath before escaping. */
  targetPathFor(neutralRel: string): Promise<string>;
  /**
   * Where the CLI keeps this file once the user has archived the session, or
   * null when the path is not one of this provider's (ADR-79).
   *
   * Asked only about a file missing from `targetPathFor`: a regular file here
   * means the session is on this machine, archived, and copying the sync
   * folder's copy back would hand the CLI a second one. Never written, never
   * read for its bytes, never listed.
   *
   * Optional: only Codex moves a session out of the place it was written.
   */
  archivedPathFor?(neutralRel: string): string | null;
  /**
   * Where the CLI keeps a compressed form of the file at `localPath`, or null
   * (ADR-83). Codex compresses a rollout left untouched for a week into
   * `<name>.jsonl.zst` beside it and removes the original; it reads the plain
   * file whenever both exist, and turns the compressed one back into a plain
   * file when the session is resumed.
   *
   * Asked of a target path, and of an archived one, that has nothing at it. A
   * regular file here means the session is on this machine, compressed — not
   * yet to arrive. Never written, never listed, and never decompressed: only
   * its first `COMPRESSED_HEADER_BYTES` are read, for `compressedContentSize`.
   *
   * Optional: only Codex compresses its sessions.
   */
  compressedSiblingOf?(localPath: string): string | null;
  /**
   * How long the file was before it was compressed, as the compressed file's
   * own header declares it — given at most its first `COMPRESSED_HEADER_BYTES`
   * — or null when the header does not say (ADR-83).
   */
  compressedContentSize?(header: Uint8Array): number | null;
  /**
   * Sessions on this machine that are missing their commit point (§6.6).
   *
   * Separate from `listSessions` on purpose: that one deliberately drops a
   * group with no primary, because a session the engine cannot commit is a
   * session it must not assemble or push. But the cleanup command has to see
   * exactly those, and asking a provider "what do you hold that is
   * incomplete" keeps the answer where the layout knowledge is — the
   * alternative is a directory walk in generic code, which is how a file the
   * CLI wrote ends up being offered for deletion.
   *
   * Optional: a provider whose session is a single file has no such state.
   */
  listIncompleteSessions?(): Promise<SessionGroup[]>;

  /**
   * How this vault's Claudian records name this provider's sessions — for the
   * read-only audit only (ADR-81, H8), never for a decision about a file.
   *
   * Optional: the records provider names nothing but itself.
   */
  readonly records?: RecordNaming;

  /** Tier B only; a no-op elsewhere. */
  reconcileLocalIndex(desired: readonly SessionGroup[]): Promise<void>;
}

/**
 * Every path at which the provider's archive holds this session: the archived
 * file, and its compressed form — Codex compresses archived rollouts as well
 * (ADR-79, ADR-83). Empty for a provider without an archive.
 */
/** Enough of a compressed file for any header `compressedContentSize` reads. */
export const COMPRESSED_HEADER_BYTES = 18;

export function archivedPathsFor(
  adapter: Pick<ProviderAdapter, "archivedPathFor" | "compressedSiblingOf">,
  neutralRel: string,
): string[] {
  const archived = adapter.archivedPathFor?.(neutralRel) ?? null;
  if (archived === null) return [];
  const compressed = adapter.compressedSiblingOf?.(archived) ?? null;
  return compressed === null ? [archived] : [archived, compressed];
}

export interface RecordNaming {
  /** Claudian's spelling of this provider — `claude` for Claude Code. */
  readonly claudianProviderId: string;
  /**
   * The session id a record names for this file of the sync folder, or null
   * for a path this provider does not use. Codex records name the thread, and
   * a rollout's file name carries the thread in its tail.
   */
  sessionIdOf(neutralRel: string): string | null;
}

/**
 * Classifies a filename against the adapter's whitelist.
 *
 * Whitelist-first, on purpose (§8.2): the previous design treated conflict-copy
 * *patterns* as the safety boundary, and OneDrive's `-<hostname>` suffix is
 * broad enough to match any logicalId containing a hyphen — which would move
 * legitimate sessions into quarantine, i.e. make a user think they had lost a
 * conversation. Pattern matching now only explains files the whitelist has
 * already rejected.
 */
export function classifyFileName(
  adapter: Pick<ProviderAdapter, "logicalIdPattern" | "primaryExtensions" | "auxSuffixPattern">,
  name: string,
): { readonly kind: "primary" | "aux" | "unknown"; readonly logicalId?: string } {
  const match = adapter.logicalIdPattern.exec(name);
  if (!match || match.index !== 0) return { kind: "unknown" };

  const logicalId = match[0];
  const remainder = name.slice(logicalId.length);

  if (adapter.primaryExtensions.includes(remainder)) return { kind: "primary", logicalId };
  if (adapter.auxSuffixPattern?.test(remainder)) return { kind: "aux", logicalId };
  return { kind: "unknown" };
}
