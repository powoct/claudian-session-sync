/**
 * Codex file names (architecture §6.4).
 *
 * The one rule worth stating: **the id is the tail, not the head.** A rollout
 * is `rollout-<timestamp>-<uuid>.jsonl`, and the temptation is to pin the
 * whole thing with one regex including the timestamp format. Claudian — which
 * has to keep working across Codex versions — deliberately does not: it
 * matches `endsWith("-<threadId>.jsonl")` and never parses the prefix
 * (`findCodexSessionFileAsync` in `CodexHistoryStore.ts`, unchanged through
 * 2.3.20). This follows that, because a timestamp
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

/**
 * Codex's compressed form of a rollout, `<name>.jsonl.zst` (codex-rs
 * `rollout/src/compression.rs`, ADR-83). Not a shape this version syncs —
 * zstd output has no prefix relation, and two machines compressing the same
 * history produce different bytes — but a shape it knows, so the census can
 * say what it is instead of guessing.
 */
export const CODEX_COMPRESSED_SUFFIX = ".zst";

/** A rollout Codex compressed, as opposed to a name nobody recognises. */
export function isCompressedRollout(name: string): boolean {
  return (
    name.endsWith(CODEX_COMPRESSED_SUFFIX) && rolloutIds(name.slice(0, -CODEX_COMPRESSED_SUFFIX.length)) !== null
  );
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

/**
 * The sentences an adapter hands `healthCheck` for the names it skipped.
 *
 * Compressed rollouts get their own: "this plugin probably needs to catch up"
 * is the right guess about a name nobody recognises, and the wrong thing to
 * say about one we do — the user can act on the second, by resuming.
 */
export function describeUnrecognised(names: readonly string[]): string[] {
  const compressed = names.filter(isCompressedRollout);
  const unknown = names.filter((name) => !isCompressedRollout(name));
  const sentences: string[] = [];
  if (unknown.length > 0) {
    const shown = unknown.slice(0, 2).join(", ");
    const rest = unknown.length > 2 ? ` and ${unknown.length - 2} more` : "";
    sentences.push(
      `Codex's sessions folder has ${unknown.length} file(s) this version does not recognise ` +
        `and will not sync (${shown}${rest}). If Codex has been updated, this plugin probably ` +
        "needs to catch up — the conversations in them are not travelling.",
    );
  }
  if (compressed.length > 0) {
    sentences.push(
      `Codex has compressed ${compressed.length} conversation file(s) in its sessions folder ` +
        "(.jsonl.zst — it does this to conversations left untouched for a while). This version " +
        "does not sync compressed files: one your other devices do not have yet stays on this " +
        "device until you resume it in Codex, which turns it back into a plain file that syncs " +
        "as usual.",
    );
  }
  return sentences;
}
