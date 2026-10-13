/**
 * A conversation record deleted on this device stays deleted here (ADR-78).
 *
 * Claudian 2.3.3 (#1386) deletes a conversation by removing its record and
 * nothing else — no tombstone, no marker. The "Claudian conversation records"
 * provider used to restore any record the sync folder had and this device did
 * not, on the reasoning that "not here yet" was the only way to be missing
 * one. A markerless delete makes that reasoning restore the conversation the
 * user just deleted, on every restart.
 *
 * The rule here is the narrowest one that tells the two apart: **a record this
 * device once held, and no longer holds, was removed here.** "Once held" is
 * witnessed convergence — this device read it on both sides and saw them
 * agree, or wrote it itself — remembered past the ledger's own forgetting. A
 * record this device never held is still "not here yet", and still lands.
 *
 * Every verdict this module can return either lands a record in the way the
 * engine already would (a no-replace create) or withholds that write. Nothing
 * here can authorise an overwrite or a deletion, so getting a case wrong costs
 * a conversation shown or not shown on one device — and both are reversible
 * from the sync folder, which this rule never touches.
 *
 * Pure. Each probe that needs the disk is passed in and asked only when the
 * decision order reaches it, because one of them parses a record that can be
 * tens of megabytes and the common case — a record that simply has not
 * arrived — never needs it.
 */

/** The three kinds of file Claudian has written per conversation. */
export type ClaudianRecordKind = "meta" | "inputs" | "deleted";

/** `claudian/<conv>.<kind>.json` → its parts, or null for anything else. */
export function claudianRecordOf(
  neutralRel: string,
): { readonly conversationId: string; readonly kind: ClaudianRecordKind } | null {
  const match = /^claudian\/(conv-[0-9]+-[a-z0-9]+)\.(meta|inputs|deleted)\.json$/.exec(neutralRel);
  if (!match) return null;
  return { conversationId: match[1] as string, kind: match[2] as ClaudianRecordKind };
}

/**
 * Why a record is being kept off this device.
 *
 * - `deleted-here` — the user deleted it here. The one kind they are told
 *   about and offered back.
 * - `moved-to-device` — it left the shared layer for a device folder: "Assign
 *   to this device", or Claudian finishing an assignment another device made.
 *   The conversation is still listed; restoring the shared copy would only
 *   leave a stale duplicate under it.
 * - `removed-by-tombstone` — a deletion marker beside it, written by Claudian
 *   2.3.2 or older. Usually another device's: Claudian 2.3.3+ carries it out at
 *   launch by removing both files, so nobody here deleted anything. On a
 *   device still running 2.3.2 it is this device's own delete, which that
 *   Claudian hides by the marker whether or not the record comes back.
 * - `tombstone-consumed` — that marker itself, gone for the same reason.
 */
export type HoldKind = "deleted-here" | "moved-to-device" | "removed-by-tombstone" | "tombstone-consumed";

/**
 * Why a file is neither landed nor published, whatever this device has seen.
 *
 * - `retired-sidecar` — `<conv>.inputs.json`, which Claudian 2.3.3+ no longer
 *   reads and deletes at every launch. Landing it would hand the next launch
 *   something to delete, and the sync after that something to restore.
 * - `tombstoned-in-replica` — a record whose deletion marker is beside it in
 *   the sync folder. On a device that never held it, landing it would only
 *   give Claudian something to delete at launch.
 */
export type RetiredReason = "retired-sidecar" | "tombstoned-in-replica";

export type AbsentHere =
  | { readonly verdict: "restore"; readonly reason: "remote-only" | "remote-only-history-not-here" | "brought-back" }
  | { readonly verdict: "hold"; readonly kind: HoldKind }
  | { readonly verdict: "retired"; readonly reason: RetiredReason }
  /**
   * This device's memory could not be read this pass, so "not here yet" and
   * "removed here" cannot be told apart. Neither is acted on: no record is
   * landed, and no hold is created. The next pass asks again.
   */
  | { readonly verdict: "wait"; readonly reason: "memory-unreadable" };

/** What a pass did before ADR-78: a record only the sync folder has, landed. */
export const RESTORE: AbsentHere = { verdict: "restore", reason: "remote-only" };

export interface AbsentHereInput {
  readonly kind: ClaudianRecordKind;
  /** The installed Claudian deletes without markers (2.3.3+). False when unknown. */
  readonly markerless: boolean;
  /**
   * `.claudian/sessions` exists on this device this pass.
   *
   * A missing store is a vault that has not run Claudian, or one whose sync
   * has not delivered the folder yet — never a conversation someone deleted.
   */
  readonly storeHealthy: boolean;
  /** This device converged on this file at some point, and remembers it. */
  readonly witnessed: boolean;
  /** The user asked for this held record back. */
  readonly releaseRequested: boolean;
  /** `<conv>.deleted.json` is in the sync folder or in this device's store. */
  readonly tombstoneBeside: boolean;
  /**
   * This device already restored exactly these bytes once because Claudian
   * might have removed them by itself. A second removal of the same record is
   * the user's: restoring again would make a conversation whose history never
   * reaches this device impossible to delete here.
   */
  readonly restoredForMissingHistory: boolean;
  /** This device's memory could not be read this pass (see `wait`). */
  readonly memoryUnreadable: boolean;
}

export interface AbsentHereProbes {
  /** Does any `devices/<key>/` folder in this vault hold `<conv>.meta.json`? */
  readonly movedToDevice: () => Promise<boolean>;
  /** See `judgeClaudeHistory`. Asked last, and only of a witnessed record. */
  readonly claudeHistory: () => Promise<ClaudeHistory>;
}

/**
 * Should a Claudian record the sync folder has, and this device does not, be
 * landed here?
 *
 * Only asked where the engine would otherwise create it: every DEFER and SKIP
 * the opaque table applies first (readiness, size, placeholder, stability,
 * zero bytes) has already declined to.
 *
 * The order is the design:
 *
 * 1. A retired sidecar is never landed, whatever this device has seen.
 * 2. A record whose deletion marker sits beside it is a deletion in progress,
 *    not a deletion here: kept off silently if this device held it, never
 *    landed if it did not.
 * 3. A store that is not there, or a record never held here, is "not here
 *    yet" — today's answer, unchanged.
 * 4. The user's own "bring it back" wins over everything below.
 * 5. A marker this device held and Claudian then consumed is kept off
 *    silently. One it never held is still landed (rule 3), which is how a
 *    deletion made on a Claudian 2.3.2 device still reaches this one.
 * 6. A record that moved into a device folder is kept off, labelled as moved.
 * 7. Claude's own automatic delete is not the user's (see `ClaudeHistory`),
 *    once per version of the record.
 * 8. Everything left was deleted here.
 *
 * And over all of it: when this device's memory could not be read, a verdict
 * that would land a record waits instead — the memory is what tells a record
 * removed here from one not here yet, and guessing "not here yet" is the bug
 * this exists to fix.
 */
export async function decideAbsentHere(
  input: AbsentHereInput,
  probes: AbsentHereProbes,
): Promise<AbsentHere> {
  const verdict = await decide(input, probes);
  return input.memoryUnreadable && verdict.verdict === "restore"
    ? { verdict: "wait", reason: "memory-unreadable" }
    : verdict;
}

async function decide(input: AbsentHereInput, probes: AbsentHereProbes): Promise<AbsentHere> {
  if (input.kind === "inputs") {
    return input.markerless ? { verdict: "retired", reason: "retired-sidecar" } : RESTORE;
  }
  if (input.kind === "meta" && input.tombstoneBeside && !input.releaseRequested) {
    return input.witnessed
      ? { verdict: "hold", kind: "removed-by-tombstone" }
      : { verdict: "retired", reason: "tombstoned-in-replica" };
  }
  if (!input.storeHealthy || !input.witnessed) return RESTORE;
  if (input.releaseRequested && input.kind === "meta") {
    return { verdict: "restore", reason: "brought-back" };
  }
  if (input.kind === "deleted") return { verdict: "hold", kind: "tombstone-consumed" };

  if (await probes.movedToDevice()) return { verdict: "hold", kind: "moved-to-device" };
  if (!input.restoredForMissingHistory && (await probes.claudeHistory()) === "all-absent") {
    return { verdict: "restore", reason: "remote-only-history-not-here" };
  }
  return { verdict: "hold", kind: "deleted-here" };
}

/**
 * Could Claudian itself have removed this record, rather than the user?
 *
 * Claudian deletes a Claude conversation on its own when a send fails with
 * "no conversation found" and **every** session id bound to it is missing on
 * this machine (`ClaudeConversationHistoryService`, the R2 path). That is the
 * case where the conversation's history simply had not arrived yet — keeping
 * it deleted would turn a sync delay into a lost conversation. So:
 *
 * - `all-absent` — every bound transcript is missing from this machine's
 *   Claude project directory, **and at least one is in the sync folder** on
 *   its way here. Claudian could have done this; restore it.
 * - `nowhere` — missing here and from the sync folder too. Nothing is on its
 *   way, so "not arrived yet" is not the story: Claude Code purges transcripts
 *   after thirty days, and old conversations — the ones a user cleans up —
 *   are exactly the ones with none left anywhere. Restoring those would bring
 *   back every one the user deletes, with a promise of history that will not
 *   come (completeness review, 2026-10-14).
 * - `some-present` — at least one is here, or one Claudian cannot check.
 *   Claudian resets such a record rather than deleting it, so the user did.
 * - `unknown` — the record cannot be read, or the projects folder is not
 *   there to look in (Claudian calls that "unknown" too, and does not delete).
 * - `not-applicable` — not a Claude record, or one with no current session.
 *   Codex and Grok reset and never delete. A record with no current session
 *   cannot have failed to resume one — upstream returns "preserve" before it
 *   looks at any id — and that includes the reset shape Claudian writes when
 *   its Claude environment changes (`sessionId: null`, the old ids moved into
 *   `previousProviderSessionIds`).
 *
 * Deliberately biased toward restoring when it cannot rule the automatic
 * delete out — a transcript Claudian would find in another project folder
 * reads as absent here. The price is a conversation the user deleted coming
 * back once, with a notice; the alternative's price is one Claudian deleted
 * staying gone. "Once" is enforced by the caller (`restoredForMissingHistory`).
 */
export type ClaudeHistory = "all-absent" | "nowhere" | "some-present" | "unknown" | "not-applicable";

/**
 * Where one bound transcript is, as the caller can tell: on this machine; not
 * here but in the sync folder (and small enough to be copied); in neither; or
 * not determinable.
 */
export type TranscriptWhere = "present" | "arriving" | "nowhere" | "unknown";

export async function judgeClaudeHistory(
  text: string,
  conversationId: string,
  transcript: (sessionId: string) => Promise<TranscriptWhere>,
): Promise<ClaudeHistory> {
  const bound = claudeBoundSessionIds(text, conversationId);
  if (bound.status === "unreadable") return "unknown";
  if (bound.status === "not-claude" || !bound.hasCurrent || bound.ids.length === 0) return "not-applicable";
  // An id Claudian cannot turn into a path is one it calls "unknown", and an
  // unknown id is kept — so its record was not deleted automatically.
  if (bound.ids.some((id) => typeof id !== "string" || !isPathSafeId(id))) return "some-present";
  let arriving = false;
  for (const id of bound.ids as string[]) {
    const found = await transcript(id);
    if (found === "present") return "some-present";
    if (found === "unknown") return "unknown";
    if (found === "arriving") arriving = true;
  }
  return arriving ? "all-absent" : "nowhere";
}

/**
 * The session ids Claudian checks before deleting a Claude conversation, read
 * the way Claudian reads them.
 *
 * Two steps, and the first is the one a plain field read gets wrong. Claudian
 * builds the conversation from the record with `sessionId` defaulting to the
 * record's own `id` when the key is absent — but an explicit `null` stays null
 * (`SessionMetadataLoader.createShell`). Only then does it apply
 * `getClaudeConversationSessionIds`: a fork that has not sent yet resumes from
 * its source, and anything else is every previous id plus the current one
 * (`providerSessionId ?? sessionId`).
 *
 * `hasCurrent` is upstream's gate in front of all of that: the R2 path returns
 * "preserve" unless `providerSessionId ?? sessionId ?? forkSource.sessionId`
 * is set (`resolveSessionIdForConversation`).
 *
 * Ids are returned unvalidated; the caller decides what an unusable one means.
 * The admission scan's `sessionIdOf` reads one id per record and does none of
 * this, which is right for admission and wrong here.
 */
export function claudeBoundSessionIds(
  text: string,
  conversationId: string,
):
  | { readonly status: "unreadable" }
  | { readonly status: "not-claude" }
  | { readonly status: "ok"; readonly ids: readonly unknown[]; readonly hasCurrent: boolean } {
  const record = parseObject(text);
  if (record === null) return { status: "unreadable" };
  const providerId = record.providerId ?? "claude";
  if (providerId !== "claude") return { status: "not-claude" };

  const ownId = typeof record.id === "string" ? record.id : conversationId;
  const sessionId = "sessionId" in record ? record.sessionId : ownId;
  const state = isObject(record.providerState) ? record.providerState : {};

  const forkSource = isObject(state.forkSource) ? state.forkSource : undefined;
  const hasCurrent = !!(state.providerSessionId ?? sessionId ?? forkSource?.sessionId);
  if (forkSource && !state.providerSessionId && !sessionId) {
    return { status: "ok", ids: forkSource.sessionId ? [forkSource.sessionId] : [], hasCurrent };
  }
  const previous = Array.isArray(state.previousProviderSessionIds) ? state.previousProviderSessionIds : [];
  const ids = [...previous, state.providerSessionId ?? sessionId].filter((id) => !!id);
  return { status: "ok", ids: [...new Set(ids)], hasCurrent };
}

/** Claudian's own rule for an id it will put in a path (`isPathSafeId`). */
export function isPathSafeId(value: string): boolean {
  if (value.length === 0 || value.length > 128) return false;
  if (value.includes("..") || value.includes("/") || value.includes("\\")) return false;
  return /^[a-zA-Z0-9_-]+$/.test(value);
}

/**
 * What a person would notice changing in a record, as one opaque value.
 *
 * Bytes are the wrong comparison for "another device changed this after you
 * deleted it": Claudian rewrites records with nobody touching them — it
 * archives idle ones, strips image data on save, and since 2.3.6 writes
 * compact JSON where it used to indent. Saying "changed" for any of those
 * would be a notice the user learns to ignore. These fields move when the
 * conversation does: a new title, a new turn, a new session.
 *
 * The session ids go in as one sorted set, not slot by slot. Claudian moves
 * them between slots with nobody touching the conversation — a change of its
 * Claude environment resets every record, nulling `sessionId` and moving the
 * current id into `previousProviderSessionIds` — and the set is what does not
 * move when that happens.
 *
 * Null when the record cannot be parsed; two nulls are not a change.
 */
export function recordDigest(text: string, hash: (value: string) => string): string | null {
  const record = parseObject(text);
  if (record === null) return null;
  const state = isObject(record.providerState) ? record.providerState : {};
  const previous = Array.isArray(state.previousProviderSessionIds) ? state.previousProviderSessionIds : [];
  const sessions = [record.sessionId, state.providerSessionId, state.threadId, ...previous]
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  return hash(
    JSON.stringify([record.title ?? null, record.lastActivityAt ?? null, [...new Set(sessions)].sort()]),
  );
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
