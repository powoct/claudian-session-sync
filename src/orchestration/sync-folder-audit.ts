/**
 * What the sync folder holds that this vault no longer lists — read-only
 * (ADR-81, H8).
 *
 * Deletion stays on the device that deleted (ADR-10, ADR-78): the sync folder
 * never shrinks, so a conversation deleted everywhere still has its history
 * there, and a new device still receives it. People reasonably want to know
 * how much that is. This answers with three lists and does nothing else — no
 * button on the screen built from it removes anything, and this module has no
 * write in it:
 *
 * 1. **Deleted here** — conversations this device is keeping off itself
 *    (ADR-78 holds), with the history files their records name in the sync
 *    folder and the bytes those take.
 * 2. **No record in this vault** — sessions in the sync folder that no
 *    Claudian record here names, in any layer. That is *not* evidence they can
 *    go: a session gets there without a record when it was deleted, when its
 *    record has not arrived, when its record sits in a device folder this
 *    vault has not received, when it was started from a terminal, or when
 *    Claudian cleared its id. Nothing on disk tells those apart.
 * 3. **Only in `.claude/sessions`** — records in the folder Claudian used
 *    before `.claudian/sessions`, which Claudian 2.3.6 stopped reading. Not
 *    listed in Claudian any more; the CLI still resumes them by id.
 *
 * Why not offer to delete (ADR-78 (c)): readiness keeps a high-water mark of
 * the sync folder's file count, so removing files from it stops every device
 * with "fewer files than before" until they come back — and a device that
 * still holds a session pushes it back. The files are also the only copy for
 * a device that has not received them yet.
 *
 * Whether a file is "on this device" counts a Codex rollout in Codex's
 * archive as on it (ADR-79): archiving moves it there, it does not delete it.
 */
import type { FsGateway } from "../infra/fs-gateway";
import type { ClaudianRecordsFile } from "../infra/home-store";
import type { ProviderAdapter } from "../providers/provider-adapter";
import { claudeBoundSessionIds, claudianRecordOf, currentClaudeSessionId } from "../domain/deleted-here";
import { isSessionUuid } from "../providers/vault-scope";

/**
 * How deep a session's files sit below its provider's folder: Codex's
 * `YYYY/MM/DD/<file>` is the deepest. Anything below is no provider's shape,
 * and the adapter's whitelist would refuse it anyway.
 */
const MAX_DEPTH = 4;
const META_SUFFIX = ".meta.json";
const TOMBSTONE_SUFFIX = ".deleted.json";
const DEVICE_KEY = /^device-[a-f0-9]{64}$/;

export interface AuditDeps {
  readonly fs: Pick<FsGateway, "lstat" | "readDir" | "readFile">;
  readonly joinPath: (...parts: string[]) => string;
  /** `<sync folder>/<workspace>`. */
  readonly replicaRoot: string;
  readonly vaultRealPath: string;
  /**
   * Every provider whose sessions Claudian records name, built over this
   * machine's root for it whether or not it is switched on here — the sync
   * folder holds what any device pushed.
   */
  readonly providers: readonly ProviderAdapter[];
  /** This device's ADR-78 memory, or null when there is none to read. */
  readonly claudianRecords: ClaudianRecordsFile | null;
  /** Records larger than this are not read for a title or for ids. */
  readonly maxRecordBytes: number;
}

/** Where a session is on this device. */
export type Whereabouts = "here" | "archived-here" | "not-here";

export interface AuditSession {
  readonly providerId: string;
  /** The id a Claudian record would name — Codex's thread, everyone else's session. */
  readonly sessionId: string;
  readonly files: ReadonlyArray<{ readonly neutralRel: string; readonly sizeBytes: number }>;
  readonly totalBytes: number;
  /** Newest modification time in the sync folder. */
  readonly newestMs: number;
  readonly here: Whereabouts;
}

export interface AuditHeldConversation {
  readonly conversationId: string;
  readonly kind: "deleted-here" | "removed-by-tombstone";
  readonly sinceMs: number;
  /** From the sync folder's copy, for display only. */
  readonly title: string | null;
  /** Claudian's provider id from the record; null when the record could not be read. */
  readonly recordProvider: string | null;
  readonly sessions: readonly AuditSession[];
  readonly totalBytes: number;
}

export interface AuditLegacyRecord {
  readonly conversationId: string;
  /** `.claude/sessions` or `.claude/sessions/devices/<key>`. */
  readonly folder: string;
  readonly title: string | null;
  readonly recordProvider: string | null;
  /** The id the CLI resumes it by, when the record names a usable one. */
  readonly sessionId: string | null;
}

export interface SyncFolderAudit {
  /** `.claudian/sessions` exists in this vault. Without it every session is "no record". */
  readonly storeFound: boolean;
  readonly held: readonly AuditHeldConversation[];
  /** Held records whose copy the sync folder no longer has — nothing to measure. */
  readonly heldNotInFolder: number;
  readonly unrecorded: readonly AuditSession[];
  readonly legacyOnly: readonly AuditLegacyRecord[];
  /** Folders of the sync folder that would not list, as `<provider>/<path>/`. */
  readonly unreadDirs: readonly string[];
}

export async function auditSyncFolder(deps: AuditDeps): Promise<SyncFolderAudit> {
  const unreadDirs: string[] = [];
  const perProvider: Array<{ adapter: ProviderAdapter; sessions: Map<string, Draft> }> = [];
  for (const adapter of deps.providers) {
    if (!adapter.records) continue;
    perProvider.push({ adapter, sessions: await sessionsInFolder(deps, adapter, unreadDirs) });
  }

  const shown = new Set<string>();
  const { held, heldNotInFolder } = await heldConversations(deps, perProvider, shown);

  const unrecorded: AuditSession[] = [];
  for (const { adapter, sessions } of perProvider) {
    const recorded = await adapter.records?.recordedSessionIds().catch(() => new Set<string>());
    for (const [sessionId, draft] of sessions) {
      if (recorded?.has(sessionId) || shown.has(`${adapter.id}\0${sessionId}`)) continue;
      unrecorded.push(await finish(deps, adapter, draft));
    }
  }
  unrecorded.sort((a, b) => b.totalBytes - a.totalBytes || compare(a.sessionId, b.sessionId));

  const store = deps.joinPath(deps.vaultRealPath, ".claudian", "sessions");
  const storeFound = (await deps.fs.lstat(store).catch(() => null))?.isDirectory === true;
  return {
    storeFound,
    held,
    heldNotInFolder,
    unrecorded,
    legacyOnly: await legacyOnlyRecords(deps),
    unreadDirs,
  };
}

/** A session as found in the sync folder, before asking where it is here. */
interface Draft {
  readonly providerId: string;
  readonly sessionId: string;
  readonly files: Array<{ neutralRel: string; sizeBytes: number }>;
  readonly primaries: string[];
  totalBytes: number;
  newestMs: number;
}

/**
 * The provider's folder of the sync folder, walked to the depth sessions sit
 * at, every name put through the adapter's own whitelist — what the engine
 * would recognise, and nothing it would call foreign.
 */
async function sessionsInFolder(
  deps: AuditDeps,
  adapter: ProviderAdapter,
  unreadDirs: string[],
): Promise<Map<string, Draft>> {
  const sessions = new Map<string, Draft>();
  const naming = adapter.records;
  if (!naming) return sessions;
  await walk(deps.joinPath(deps.replicaRoot, adapter.id), [adapter.id], 0);
  return sessions;

  async function walk(dir: string, rel: readonly string[], depth: number): Promise<void> {
    const entries = await deps.fs.readDir(dir).catch((error: { code?: string }) => {
      // The provider's folder not being there is "nothing pushed yet".
      if (!(depth === 0 && error?.code === "ENOENT")) unreadDirs.push(`${rel.join("/")}/`);
      return [];
    });
    for (const entry of [...entries].sort((a, b) => compare(a.name, b.name))) {
      const parts = [...rel, entry.name];
      if (entry.isDirectory) {
        if (depth + 1 < MAX_DEPTH) await walk(deps.joinPath(dir, entry.name), parts, depth + 1);
        continue;
      }
      if (!entry.isFile) continue;
      const neutralRel = parts.join("/");
      const classified = adapter.classifyNeutral(neutralRel);
      const sessionId = classified ? naming?.sessionIdOf(neutralRel) : null;
      if (!classified || !sessionId) continue;
      const stat = await deps.fs.lstat(deps.joinPath(dir, entry.name)).catch(() => null);
      if (stat === null || !stat.isFile) continue;
      const draft = sessions.get(sessionId) ?? {
        providerId: adapter.id,
        sessionId,
        files: [],
        primaries: [],
        totalBytes: 0,
        newestMs: 0,
      };
      draft.files.push({ neutralRel, sizeBytes: stat.size });
      draft.totalBytes += stat.size;
      draft.newestMs = Math.max(draft.newestMs, stat.mtimeMs);
      if (classified.role === "primary" && !classified.replicaOnly) draft.primaries.push(neutralRel);
      sessions.set(sessionId, draft);
    }
  }
}

/** Asks where the session is on this device, by its files' own local paths. */
async function finish(deps: AuditDeps, adapter: ProviderAdapter, draft: Draft): Promise<AuditSession> {
  let here: Whereabouts = "not-here";
  for (const rel of draft.primaries) {
    const target = await adapter.targetPathFor(rel).catch(() => null);
    if (target !== null && (await isFile(deps, target))) {
      here = "here";
      break;
    }
    const archived = adapter.archivedPathFor?.(rel) ?? null;
    if (archived !== null && (await isFile(deps, archived))) here = "archived-here";
  }
  return {
    providerId: draft.providerId,
    sessionId: draft.sessionId,
    files: draft.files,
    totalBytes: draft.totalBytes,
    newestMs: draft.newestMs,
    here,
  };
}

/**
 * List ①: what this device keeps off itself, measured by the sync folder's
 * copy of each record. Sessions shown here are marked in `shown`, so list ②
 * does not count them a second time.
 *
 * Not listed: a record moved into a device folder, which is still a listed
 * conversation whose history is in use; and a consumed deletion marker, which
 * is no conversation at all.
 */
async function heldConversations(
  deps: AuditDeps,
  perProvider: ReadonlyArray<{ adapter: ProviderAdapter; sessions: Map<string, Draft> }>,
  shown: Set<string>,
): Promise<{ held: AuditHeldConversation[]; heldNotInFolder: number }> {
  const held: AuditHeldConversation[] = [];
  let heldNotInFolder = 0;
  for (const [rel, entry] of Object.entries(deps.claudianRecords?.records ?? {})) {
    const hold = entry.hold;
    const record = claudianRecordOf(rel);
    if (!hold || !record || record.kind !== "meta") continue;
    if (hold.kind !== "deleted-here" && hold.kind !== "removed-by-tombstone") continue;

    const copy = deps.joinPath(deps.replicaRoot, ...rel.split("/"));
    const stat = await deps.fs.lstat(copy).catch(() => null);
    if (stat === null || !stat.isFile) {
      heldNotInFolder += 1;
      continue;
    }
    const text = stat.size <= deps.maxRecordBytes ? await readText(deps, copy) : null;
    const parsed = text === null ? null : parseObject(text);
    const recordProvider = parsed === null ? null : typeof parsed.providerId === "string" ? parsed.providerId : "claude";
    const owner = perProvider.find((p) => p.adapter.records?.claudianProviderId === recordProvider);

    const sessions: AuditSession[] = [];
    if (text !== null && parsed !== null && owner) {
      for (const sessionId of namedSessionIds(text, parsed, record.conversationId)) {
        const draft = owner.sessions.get(sessionId);
        if (!draft) continue;
        shown.add(`${owner.adapter.id}\0${sessionId}`);
        sessions.push(await finish(deps, owner.adapter, draft));
      }
    }
    held.push({
      conversationId: record.conversationId,
      kind: hold.kind,
      sinceMs: hold.sinceMs,
      title: titleOf(parsed),
      recordProvider,
      sessions,
      totalBytes: sessions.reduce((sum, session) => sum + session.totalBytes, 0),
    });
  }
  held.sort((a, b) => b.totalBytes - a.totalBytes || compare(a.conversationId, b.conversationId));
  return { held, heldNotInFolder };
}

/**
 * Every session a record names as its own history.
 *
 * Claude's the way Claudian reads them (every previous id and the current
 * one, `createShell`'s defaults applied); anyone else's from the fields that
 * carry an id. Not a fork's source: that is the other conversation's history.
 */
function namedSessionIds(text: string, record: Record<string, unknown>, conversationId: string): string[] {
  const bound = claudeBoundSessionIds(text, conversationId);
  if (bound.status === "ok") return bound.ids.filter((id): id is string => typeof id === "string");
  const state = isObject(record.providerState) ? record.providerState : {};
  const previous = Array.isArray(state.previousProviderSessionIds) ? state.previousProviderSessionIds : [];
  const ids = [record.sessionId, state.threadId, state.providerSessionId, ...previous];
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))];
}

/**
 * List ③: records in `.claude/sessions` whose conversation has no record in
 * `.claudian/sessions` — in any layer, any device's folder included, so a
 * conversation another device still lists is not called lost here.
 *
 * A record with a deletion marker beside it is skipped in its own folder, as
 * an older Claudian skipped it.
 */
async function legacyOnlyRecords(deps: AuditDeps): Promise<AuditLegacyRecord[]> {
  const current = await recordsIn(deps, [".claudian", "sessions"]);
  const legacy = await recordsIn(deps, [".claude", "sessions"]);
  const found: AuditLegacyRecord[] = [];
  for (const [conversationId, location] of legacy) {
    if (current.has(conversationId)) continue;
    const stat = await deps.fs.lstat(location.path).catch(() => null);
    const text = stat?.isFile && stat.size <= deps.maxRecordBytes ? await readText(deps, location.path) : null;
    const parsed = text === null ? null : parseObject(text);
    const recordProvider = parsed === null ? null : typeof parsed.providerId === "string" ? parsed.providerId : "claude";
    found.push({
      conversationId,
      folder: location.folder,
      title: titleOf(parsed),
      recordProvider,
      sessionId: text === null || parsed === null ? null : resumableId(text, parsed, conversationId),
    });
  }
  return found.sort((a, b) => compare(a.conversationId, b.conversationId));
}

/**
 * The id a terminal resumes this record's conversation by, when it names one
 * of the shape every supported CLI uses. A Claude record with no `sessionId`
 * key defaults to its own conversation id, which no CLI resumes.
 */
function resumableId(text: string, record: Record<string, unknown>, conversationId: string): string | null {
  const state = isObject(record.providerState) ? record.providerState : {};
  const candidates = [currentClaudeSessionId(text, conversationId), state.threadId, record.sessionId, state.providerSessionId];
  return candidates.find(isSessionUuid) ?? null;
}

/** Conversation id → its first record found, shared layer before device folders. */
async function recordsIn(
  deps: AuditDeps,
  segments: readonly string[],
): Promise<Map<string, { readonly path: string; readonly folder: string }>> {
  const found = new Map<string, { readonly path: string; readonly folder: string }>();
  const root = deps.joinPath(deps.vaultRealPath, ...segments);
  const rootRel = segments.join("/");
  const folders: Array<{ dir: string; rel: string }> = [{ dir: root, rel: rootRel }];
  const devices = deps.joinPath(root, "devices");
  for (const entry of await deps.fs.readDir(devices).catch(() => [])) {
    if (entry.isDirectory && DEVICE_KEY.test(entry.name)) {
      folders.push({ dir: deps.joinPath(devices, entry.name), rel: `${rootRel}/devices/${entry.name}` });
    }
  }
  for (const folder of folders) {
    const entries = await deps.fs.readDir(folder.dir).catch(() => []);
    const files = new Set(entries.filter((entry) => entry.isFile).map((entry) => entry.name));
    for (const name of [...files].sort()) {
      if (!name.endsWith(META_SUFFIX)) continue;
      const conversationId = name.slice(0, -META_SUFFIX.length);
      if (found.has(conversationId) || files.has(`${conversationId}${TOMBSTONE_SUFFIX}`)) continue;
      found.set(conversationId, { path: deps.joinPath(folder.dir, name), folder: folder.rel });
    }
  }
  return found;
}

async function isFile(deps: AuditDeps, target: string): Promise<boolean> {
  return (await deps.fs.lstat(target).catch(() => null))?.isFile === true;
}

async function readText(deps: AuditDeps, target: string): Promise<string | null> {
  const bytes = await deps.fs.readFile(target).catch(() => null);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}

function titleOf(record: Record<string, unknown> | null): string | null {
  const title = record?.title;
  return typeof title === "string" && title.length > 0 ? title : null;
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

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
