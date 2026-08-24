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

  /** Is this provider usable on this machine right now? */
  healthCheck(): Promise<{ readonly ok: boolean; readonly reason?: string }>;
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
  /** Tier B only; a no-op elsewhere. */
  reconcileLocalIndex(desired: readonly SessionGroup[]): Promise<void>;
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
