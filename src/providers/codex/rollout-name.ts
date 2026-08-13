/**
 * Codex file names (architecture §6.4).
 *
 * The one rule worth stating: **the id is the tail, not the head.** A rollout
 * is `rollout-<timestamp>-<uuid>.jsonl`, and the temptation is to pin the
 * whole thing with one regex including the timestamp format. Claudian — which
 * has to keep working across Codex versions — deliberately does not: it
 * matches `endsWith("-<threadId>.jsonl")` and never parses the prefix
 * (`CodexHistoryStore.ts:1522`). This follows that, because a timestamp
 * format change upstream should cost us nothing, and because a session we
 * fail to recognise is a session that silently stops syncing.
 *
 * Bare `<uuid>.jsonl` is accepted too: it is the first thing Claudian looks
 * for, so it is a shape the CLI is known to produce.
 *
 * These patterns are NOT the path-safety layer. A name they accept still goes
 * through `parseNeutralRel` and the write-path mint before any byte moves —
 * a colon-bearing timestamp, for instance, passes here and is refused there.
 * Keeping the prefix lenient is what survives an upstream format change;
 * keeping path safety elsewhere is what makes that leniency free.
 */
import type { LogicalId } from "../../domain/types";

/** Lowercase UUID, the form both Claude Code and Codex use for session ids. */
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * A whole file name, anchored at both ends.
 *
 * Anchored on purpose: this is the §8.2 whitelist for this provider, so it has
 * to reject `rollout-…-<uuid>.jsonl.bak` and every conflict-copy shape rather
 * than matching a prefix of them.
 */
export const CODEX_ROLLOUT_NAME = new RegExp(`^(?:.+-)?(${UUID})\\.jsonl$`);

/**
 * The pattern the adapter publishes as its whitelist.
 *
 * Note it is not usable with `classifyFileName`, whose contract is "the id is
 * the leading segment". Codex breaks that assumption, which is exactly why
 * this provider does its own name handling — see `classifyNeutral`.
 */
export const CODEX_LOGICAL_ID_PATTERN = CODEX_ROLLOUT_NAME;

/** `YYYY` / `MM` / `DD` as Codex writes them — digits only, no other shape. */
export const CODEX_DATE_SEGMENT = /^\d{2,4}$/;

/** The session id inside a rollout file name, or null if this is not one. */
export function rolloutLogicalId(name: string): LogicalId | null {
  const match = CODEX_ROLLOUT_NAME.exec(name);
  return match ? (match[1] as LogicalId) : null;
}

/** Codex ids are the shared session-uuid shape; the check lives with the store reader. */
export { isSessionUuid as isCodexSessionId } from "../vault-scope";
