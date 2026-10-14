/**
 * Claude conversations Claudian lists here whose history has not arrived (ADR-81, H10).
 *
 * Sending in a Claude conversation resumes its current session, and the CLI
 * answers "no conversation found" when that transcript is not on this
 * machine. Claudian then decides on its own (`ClaudeConversationHistoryService`,
 * the R2 path): every session the conversation names missing here ⇒ the
 * conversation is **deleted**; some present ⇒ it is **reset**, dropping the
 * missing ones, so the history that arrives a minute later is no longer the
 * conversation's. Either way the user did nothing but press send too early —
 * and the change is written to the layer the record was loaded from, so for
 * a shared conversation it reaches every device with the vault.
 *
 * The window is real and this plugin opens it: a record travels with the
 * vault, the transcript with the sync folder, and nothing orders the two — a
 * new machine's first sync, a transcript held back by the size limit or a
 * stability wait. So after every pass this looks for the one state that can
 * only end badly if the user acts on it: the transcript is in the sync folder
 * (on its way) and not on this machine.
 *
 * Only what Claudian 2.3.6 and later would list here: this machine's device
 * folder and the shared layer, the device copy winning, with Claudian's own
 * acceptance rules — a file name it would not index, or a record whose `id`
 * is not its file name, is not listed. Without a readable key, only the
 * shared layer. Not `.claude/sessions`, which 2.3.6 stopped reading. Only
 * Claude records: Codex and Grok reset and never delete, and an archived
 * Codex rollout is not under `sessions/`, so looking there would warn about
 * every conversation archived here (ADR-79).
 *
 * What it cannot see: the transcript is looked for under this plugin's Claude
 * Code root, and a `CLAUDE_CONFIG_DIR` set for Claudian alone can put the
 * CLI's elsewhere (an ADR-81 residual, as it is ADR-78's for H3).
 *
 * Read-only, and a warning only. It cannot stop a send — there is nothing in
 * Claudian to hook — so the most it can do is say it before the user does.
 */
import type { FsGateway } from "../infra/fs-gateway";
import { claudeResume, isPathSafeId } from "../domain/deleted-here";

/** Upstream's own shape for an installation key (`InstallationKey.ts`). */
const DEVICE_KEY = /^device-[a-f0-9]{64}$/;
const META_SUFFIX = ".meta.json";
/** Claudian 2.3.2 and older hide a record with this beside it, in the same folder. */
const TOMBSTONE_SUFFIX = ".deleted.json";
/** Upstream's `isValidSessionMetadataId`: the names Claudian indexes at all. */
const SAFE_METADATA_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface HistoryNotHere {
  readonly conversationId: string;
  /** The session a send would resume; also its transcript's name in the sync folder. */
  readonly sessionId: string;
  /** Loaded from the shared layer, so Claudian's delete or reset reaches every device. */
  readonly shared: boolean;
  /** Claudian's own recency (`lastActivityAt`, falling back as it does); 0 when none. */
  readonly lastActivityMs: number;
  /** For the pop-up only, read now: never into a report, a log or a file. */
  readonly title: string | null;
}

export interface HistoryNotHereResult {
  /** Newest first, as Claudian's list orders them. */
  readonly entries: readonly HistoryNotHere[];
  /**
   * Conversations listed here whose record could not be read this time — a
   * write caught half-done, or too large to read. Not "fine": nothing is known
   * about them, and the caller keeps whatever it last knew.
   */
  readonly unsure: ReadonlySet<string>;
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
  /** Records larger than this are not read; their conversation is unsure. */
  readonly maxRecordBytes: number;
}

/**
 * Every listed Claude conversation whose current transcript is in the sync
 * folder and not here — or null when a folder this depends on did not answer.
 *
 * Null rather than empty, because "nothing at risk" is an answer the caller
 * acts on: it forgets which conversations it has warned about. A warning
 * built on a folder that did not list would be a guess, and so would an
 * all-clear.
 */
export async function findHistoryNotHere(deps: HistoryNotHereDeps): Promise<HistoryNotHereResult | null> {
  const inFolder = await namesIn(deps, deps.replicaDir);
  // A sync folder with no Claude Code folder yet has nothing on its way; one
  // that is gone for a moment would say the same, so neither is an answer.
  if (inFolder === null || inFolder === "absent") return null;
  // A projects folder that is not there holds no transcript: the send fails
  // just the same. One that is there and cannot be listed tells nothing.
  const projectNames = await namesIn(deps, deps.projectDir);
  if (projectNames === null) return null;
  const here = projectNames === "absent" ? new Set<string>() : projectNames;
  const missing = new Set([...inFolder].filter((name) => name.endsWith(".jsonl") && !here.has(name)));
  if (missing.size === 0) return { entries: [], unsure: new Set() };

  const visible = await visibleRecords(deps);
  if (visible === null) return null;
  const entries: HistoryNotHere[] = [];
  const unsure = new Set<string>();
  for (const [conversationId, { path, shared }] of visible) {
    const stat = await deps.fs.lstat(path).catch(() => undefined);
    // Gone between the listing and now: Claudian's own copy went with it.
    if (stat === null) continue;
    if (stat === undefined || !stat.isFile || stat.size > deps.maxRecordBytes) {
      unsure.add(conversationId);
      continue;
    }
    const bytes = await deps.fs.readFile(path).catch(() => null);
    const record = bytes === null ? null : parseObject(new TextDecoder().decode(bytes));
    if (bytes === null || record === null) {
      unsure.add(conversationId);
      continue;
    }
    // Claudian refuses a record whose id is not its file name, and does not
    // fall back to the other layer for it: not listed, so nothing to send in.
    if (record.id !== conversationId) continue;
    const resume = claudeResume(record, conversationId);
    if (resume === null || typeof resume.resumes !== "string") continue;
    // A failed resume of any other id is preserved, not acted on.
    if (typeof resume.comparedWith !== "string" || resume.comparedWith.toLowerCase() !== resume.resumes.toLowerCase()) {
      continue;
    }
    // An id Claudian cannot put in a path is one it never resumes from disk,
    // and one this would otherwise turn into a file name.
    if (!isPathSafeId(resume.resumes)) continue;
    if (!missing.has(`${resume.resumes}.jsonl`)) continue;
    entries.push({
      conversationId,
      sessionId: resume.resumes,
      shared,
      lastActivityMs: lastActivityOf(record),
      title: typeof record.title === "string" && record.title.length > 0 ? record.title : null,
    });
  }
  entries.sort(
    (a, b) =>
      b.lastActivityMs - a.lastActivityMs ||
      (a.conversationId < b.conversationId ? 1 : a.conversationId > b.conversationId ? -1 : 0),
  );
  return { entries, unsure };
}

/**
 * Conversation id → the record Claudian would load for it here, or null when
 * a folder it reads would not list — Claudian lists nothing then either.
 *
 * Device folder first, then the shared layer for what the device folder does
 * not have. A record with a deletion marker beside it is skipped in its own
 * folder only: Claudian 2.3.3 and later remove such a record at their next
 * launch, and an older one skips it, falling through to the other layer.
 */
async function visibleRecords(
  deps: HistoryNotHereDeps,
): Promise<Map<string, { readonly path: string; readonly shared: boolean }> | null> {
  const visible = new Map<string, { readonly path: string; readonly shared: boolean }>();
  const folders =
    deps.deviceKey !== null && DEVICE_KEY.test(deps.deviceKey)
      ? [
          { dir: deps.joinPath(deps.storeDir, "devices", deps.deviceKey), shared: false },
          { dir: deps.storeDir, shared: true },
        ]
      : [{ dir: deps.storeDir, shared: true }];
  for (const folder of folders) {
    const files = await namesIn(deps, folder.dir);
    if (files === null) return null;
    if (files === "absent") continue;
    for (const name of [...files].sort()) {
      if (!name.endsWith(META_SUFFIX)) continue;
      const conversationId = name.slice(0, -META_SUFFIX.length);
      if (!isListableId(conversationId)) continue;
      if (visible.has(conversationId) || files.has(`${conversationId}${TOMBSTONE_SUFFIX}`)) continue;
      visible.set(conversationId, { path: deps.joinPath(folder.dir, name), shared: folder.shared });
    }
  }
  return visible;
}

function isListableId(id: string): boolean {
  return SAFE_METADATA_ID.test(id) && id !== "." && id !== ".." && !/%(?:2f|5c)/i.test(id);
}

/** Claudian's `lastActivityAt`, with its fallbacks, in order. */
function lastActivityOf(record: Record<string, unknown>): number {
  for (const value of [record.lastActivityAt, record.lastResponseAt, record.updatedAt, record.createdAt]) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

/** File names in a directory; "absent" when it does not exist, null when it would not say. */
async function namesIn(deps: HistoryNotHereDeps, dir: string): Promise<Set<string> | "absent" | null> {
  const stat = await deps.fs.lstat(dir).catch(() => undefined);
  if (stat === undefined) return null;
  if (stat === null) return "absent";
  if (!stat.isDirectory) return null;
  const entries = await deps.fs.readDir(dir).catch(() => null);
  if (entries === null) return null;
  return new Set(entries.filter((entry) => entry.isFile).map((entry) => entry.name));
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
