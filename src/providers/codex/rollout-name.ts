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
import { classifyExternalArtifact } from "../../domain/external-artifacts";

/** Lowercase UUID, the form both Claude Code and Codex use for session ids. */
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * A whole file name, anchored at both ends.
 *
 * Anchored on purpose: this is the §8.2 whitelist for this provider, so it has
 * to reject `rollout-…-<uuid>.jsonl.bak` and every conflict-copy shape rather
 * than matching a prefix of them.
 */
export const CODEX_ROLLOUT_NAME = new RegExp(`^(?:.+-)?(${UUID})(?:_(${UUID}))?\\.jsonl$`);

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

/**
 * The two ids in a rollout file name, or null if this is not one.
 *
 * Codex names a rollout `rollout-<ts>-<threadId>.jsonl` while the file it is
 * writing *is* the thread, and `rollout-<ts>-<threadId>_<rolloutId>.jsonl`
 * once the two differ (`rollout_file_name.rs` `render()`). They differ after a
 * **revert**: `revert_thread.rs` mints a fresh rollout id, writes a new file,
 * leaves the old ones intact, and moves only a SQLite pointer. So one thread
 * can own several files, and the newest one carries the `_` form.
 *
 * The old pattern had no `_` branch, so it returned null for exactly that file
 * — the *current* one. `listSessions` skipped it and `classifyNeutral` refused
 * it, which meant a rewound conversation's live history silently never synced
 * while its stale predecessor kept syncing and the pass said "up to date".
 * Claudian has the same blind spot (`CodexHistoryStore.ts` matches
 * `endsWith("-<threadId>.jsonl")`), which is why the conversation record still
 * exists to admit against even though Claudian cannot open the file.
 *
 * **The two ids are used for different things, and that split is the design.**
 * Admission asks "does this vault know this conversation", which is a question
 * about the *thread* — Claudian records the thread id and nothing else. The
 * logical id is this plugin's per-file identity, so it takes the *rollout* id,
 * which is unique per file. For a thread that was never reverted the two are
 * the same string, so nothing that exists today changes identity: no backup
 * directory moves, no conflict id changes.
 *
 * Keying on the thread id instead would give two files one logical id, and the
 * group-activity ledger is keyed `<provider>/<logicalId>` — two groups would
 * overwrite each other's signature every pass and both would defer forever.
 */
export function rolloutIds(name: string): { threadId: string; rolloutId: LogicalId } | null {
  const match = CODEX_ROLLOUT_NAME.exec(name);
  if (!match) return null;
  const threadId = match[1] as string;
  return { threadId, rolloutId: (match[2] ?? threadId) as LogicalId };
}

/** The per-file identity: the rollout id, which is the thread id until a revert. */
export function rolloutLogicalId(name: string): LogicalId | null {
  return rolloutIds(name)?.rolloutId ?? null;
}

/** Codex ids are the shared session-uuid shape; the check lives with the store reader. */
export { isSessionUuid as isCodexSessionId } from "../vault-scope";

/**
 * Names under `YYYY/MM/DD` that this version does not recognise as a rollout.
 *
 * A **census, not an enumeration**: it counts what the parser refuses without
 * asking why. That is the whole point. The 2026-09-09 defect was upstream
 * renaming a file — `rollout-<ts>-<threadId>_<rolloutId>.jsonl` after a revert
 * — and the failure was not that we got it wrong, it was that we said nothing:
 * the file was skipped, no report line existed to attach a warning to, and the
 * pass said "up to date" while a conversation's live history sat unsynced. The
 * same thing had already happened once, when Claudian moved its records into
 * `devices/` (ADR-66). A detector that only knows the shapes we have already
 * seen would have caught neither on the day it mattered.
 *
 * So this fires for the `_` form, for a `.jsonl.zst` compressed sibling when
 * upstream turns that on, and for whatever comes next.
 *
 * Names another program is *known* to own are excluded rather than counted:
 * a sync tool's conflict copy and this plugin's own temp files are expected
 * company in that directory, and a warning that is always on is one nobody
 * reads. Everything else counts, including things we could guess at — being
 * wrong about the reason costs a sentence, being silent costs a conversation.
 */
export function unrecognisedRolloutNames(names: readonly string[]): string[] {
  return names.filter(
    (name) =>
      rolloutIds(name) === null &&
      classifyExternalArtifact(name, names).kind === "unknown" &&
      !name.includes(TEMP_MARKER),
  );
}

/** The plugin's own in-flight writes (`fs-gateway`'s `tempName`). */
const TEMP_MARKER = ".aiss-tmp-";

/** The sentence an adapter hands `healthCheck` for the names it skipped. */
export function describeUnrecognised(names: readonly string[]): string[] {
  if (names.length === 0) return [];
  const shown = names.slice(0, 2).join(", ");
  const rest = names.length > 2 ? ` and ${names.length - 2} more` : "";
  return [
    `Codex's sessions folder has ${names.length} file(s) this version does not recognise ` +
      `and will not sync (${shown}${rest}). If Codex has been updated, this plugin probably ` +
      "needs to catch up — the conversations in them are not travelling.",
  ];
}
