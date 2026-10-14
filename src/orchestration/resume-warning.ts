/**
 * Claude conversations Claudian lists here whose history has not arrived (ADR-81, H10).
 *
 * Sending in a Claude conversation resumes its current session, and the CLI
 * answers "no conversation found" when that transcript is not on this
 * machine. Claudian then decides on its own (`ClaudeConversationHistoryService`,
 * the R2 path): every session the conversation names missing here ⇒ the
 * conversation is **deleted**; some present ⇒ it is **reset**, dropping the
 * missing ones, so the history that arrives a minute later is no longer the
 * conversation's. Either way the user did nothing but press send too early.
 *
 * The window is real and this plugin opens it: a record travels with the
 * vault, the transcript with the sync folder, and nothing orders the two —
 * a new machine's first sync, a sync folder still hydrating, a transcript held
 * back by the size limit or a stability wait. So after every pass this looks
 * for the one state that can only end badly if the user acts on it: the
 * transcript is in the sync folder (on its way) and not on this machine.
 *
 * Only what Claudian would show here: this machine's device folder and the
 * shared layer, the device copy winning, as Claudian picks — the key is read
 * the way Claudian derives it, and without it only the shared layer is looked
 * at. Not `.claude/sessions`, which Claudian 2.3.6 stopped reading. Only
 * Claude records: Codex and Grok reset and never delete, and an archived Codex
 * rollout is not under `sessions/`, so looking there would warn about every
 * conversation archived here (ADR-79).
 *
 * Read-only, and a warning only. It cannot stop a send — there is nothing in
 * Claudian to hook — so the most it can do is say it before the user does.
 */
import type { FsGateway } from "../infra/fs-gateway";
import { currentClaudeSessionId, isPathSafeId } from "../domain/deleted-here";

/** Upstream's own shape for an installation key (`InstallationKey.ts`). */
const DEVICE_KEY = /^device-[a-f0-9]{64}$/;
const META_SUFFIX = ".meta.json";
/** Claudian 2.3.2 and older hide a record with this beside it, in the same folder. */
const TOMBSTONE_SUFFIX = ".deleted.json";

export interface HistoryNotHere {
  readonly conversationId: string;
  /** The session a send would resume; also its transcript's name in the sync folder. */
  readonly sessionId: string;
}

export interface HistoryNotHereDeps {
  readonly fs: Pick<FsGateway, "lstat" | "readDir" | "readFile">;
  readonly joinPath: (...parts: string[]) => string;
  /** `<vault>/.claudian/sessions` — Claudian's, whatever the records provider's root is. */
  readonly storeDir: string;
  /** This machine's Claudian installation key, or null when it cannot be read. */
  readonly deviceKey: string | null;
  /** Where this plugin's Claude Code provider keeps this vault's transcripts. */
  readonly projectDir: string;
  /** `<sync folder>/<workspace>/claude-code`. */
  readonly replicaDir: string;
}

/**
 * Every listed Claude conversation whose current transcript is in the sync
 * folder and not here, sorted by conversation id.
 *
 * Nothing when either side cannot be listed: a warning built on a folder that
 * did not answer would be a guess, and this one tells the user to wait.
 */
export async function findHistoryNotHere(deps: HistoryNotHereDeps): Promise<HistoryNotHere[]> {
  const inFolder = await namesIn(deps, deps.replicaDir);
  if (inFolder === null || inFolder.size === 0) return [];
  // A projects folder that is not there holds no transcript: the send fails
  // just the same. One that is there and cannot be listed tells nothing.
  const here = await namesIn(deps, deps.projectDir);
  if (here === null) return [];

  const found: HistoryNotHere[] = [];
  for (const [conversationId, recordPath] of await visibleRecords(deps)) {
    const bytes = await deps.fs.readFile(recordPath).catch(() => null);
    if (bytes === null) continue;
    const sessionId = currentClaudeSessionId(new TextDecoder().decode(bytes), conversationId);
    // An id Claudian cannot put in a path is one it never resumes from disk,
    // and one this would otherwise turn into a file name.
    if (typeof sessionId !== "string" || !isPathSafeId(sessionId)) continue;
    const transcript = `${sessionId}.jsonl`;
    if (inFolder.has(transcript) && !here.has(transcript)) found.push({ conversationId, sessionId });
  }
  return found.sort((a, b) => (a.conversationId < b.conversationId ? -1 : a.conversationId > b.conversationId ? 1 : 0));
}

/**
 * Conversation id → the record Claudian would load for it here.
 *
 * Device folder first, then the shared layer for what the device folder does
 * not have. A record with a deletion marker beside it is skipped in its own
 * folder only — an older Claudian then falls through to the other layer, and
 * so does this.
 */
async function visibleRecords(deps: HistoryNotHereDeps): Promise<Map<string, string>> {
  const visible = new Map<string, string>();
  const folders =
    deps.deviceKey !== null && DEVICE_KEY.test(deps.deviceKey)
      ? [deps.joinPath(deps.storeDir, "devices", deps.deviceKey), deps.storeDir]
      : [deps.storeDir];
  for (const folder of folders) {
    const entries = await deps.fs.readDir(folder).catch(() => []);
    const files = new Set(entries.filter((entry) => entry.isFile).map((entry) => entry.name));
    for (const name of [...files].sort()) {
      if (!name.endsWith(META_SUFFIX)) continue;
      const conversationId = name.slice(0, -META_SUFFIX.length);
      if (visible.has(conversationId) || files.has(`${conversationId}${TOMBSTONE_SUFFIX}`)) continue;
      visible.set(conversationId, deps.joinPath(folder, name));
    }
  }
  return visible;
}

/** File names in a directory; empty when it does not exist, null when it would not say. */
async function namesIn(deps: HistoryNotHereDeps, dir: string): Promise<Set<string> | null> {
  const stat = await deps.fs.lstat(dir).catch(() => undefined);
  if (stat === undefined) return null;
  if (stat === null) return new Set();
  const entries = await deps.fs.readDir(dir).catch(() => null);
  if (entries === null) return null;
  return new Set(entries.filter((entry) => entry.isFile).map((entry) => entry.name));
}
