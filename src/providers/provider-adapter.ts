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
 *
 * Tier requires measured evidence. Anything unproven stays at C.
 */
export type ProviderTier = "A" | "B" | "C";

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
