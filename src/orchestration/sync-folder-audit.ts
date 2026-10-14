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
 *    Claudian record here names, in any layer and in any of the fields
 *    Claudian reads a conversation's history from. That is *not* evidence
 *    they can go: a session gets there without a record when it was deleted,
 *    when its record has not arrived, when its record sits in a device folder
 *    this vault has not received, or when it was started from a terminal.
 *    Nothing on disk tells those apart.
 * 3. **Only in `.claude/sessions`** — records in the folder Claudian used
 *    before `.claudian/sessions`, which Claudian 2.3.6 stopped reading. Not
 *    listed in Claudian any more; the CLI still resumes them by id.
 *
 * Why not offer to delete (ADR-78 (c)): readiness keeps a high-water mark of
 * the sync folder's file count. Removing a few files pauses nothing, and a
 * device that still holds those sessions pushes them back; removing more
 * than a few stops every device that had seen them with "fewer files than
 * before", and a stopped device writes nothing — so they stay stopped until
 * the files are restored by hand. The files are also the only copy for a
 * device that has not received them yet.
 *
 * Whether a file is "on this device" counts a Codex rollout in Codex's
 * archive as on it (ADR-79): archiving moves it there, it does not delete it.
 * It is asked only for providers switched on here: this plugin does not look
 * in the folder of a CLI it was not asked to sync.
 */
import type { FsGateway } from "../infra/fs-gateway";
import type { ClaudianRecordsFile } from "../infra/home-store";
import type { ProviderAdapter } from "../providers/provider-adapter";
import { claudeBoundSessionIds, claudeResume, claudianRecordOf } from "../domain/deleted-here";
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
   * Every provider whose sessions Claudian records name — the sync folder
   * holds what any device pushed — built over this machine's root for it,
   * and whether it is switched on here.
   */
  readonly providers: ReadonlyArray<{ readonly adapter: ProviderAdapter; readonly enabled: boolean }>;
  /**
   * This device's ADR-78 memory. It only grows while the records provider is
   * on, so "nothing deleted here" needs saying why: `records-provider-off`
   * (deletions here are not tracked), `unreadable`, or `tracked`.
   */
  readonly deletedHere: {
    readonly status: "tracked" | "records-provider-off" | "unreadable";
    readonly file: ClaudianRecordsFile | null;
  };
  /** Whether the installed Claudian still lists `.claude/sessions`; null when unknown. */
  readonly legacyStillListed: boolean | null;
  /** Records larger than this are not read for a title or for ids. */
  readonly maxRecordBytes: number;
}

/** Where a session is on this device; "unchecked" for a provider switched off here. */
export type Whereabouts = "here" | "archived-here" | "not-here" | "unchecked";

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
  /** `.claudian/sessions` exists in this vault. */
  readonly storeFound: boolean;
  /**
   * Record folders that would not list and records that could not be read
   * (or were too large to), in `.claudian/sessions` and `.claude/sessions`.
   * Either way list ② may hold sessions those records name.
   */
  readonly recordsUnread: number;
  /** Why list ① may be empty when conversations were deleted here. */
  readonly deletedHere: "tracked" | "records-provider-off" | "unreadable";
  readonly held: readonly AuditHeldConversation[];
  /** Held records whose copy the sync folder no longer has — nothing to measure. */
  readonly heldNotInFolder: number;
  readonly unrecorded: readonly AuditSession[];
  readonly legacyOnly: readonly AuditLegacyRecord[];
  readonly legacyStillListed: boolean | null;
  /** Folders of the sync folder that would not list, as `<provider>/<path>/`. */
  readonly unreadDirs: readonly string[];
}

export async function auditSyncFolder(deps: AuditDeps): Promise<SyncFolderAudit> {
  const unreadDirs: string[] = [];
  const perProvider: ProviderSessions[] = [];
  for (const { adapter, enabled } of deps.providers) {
    if (!adapter.records) continue;
    perProvider.push({ adapter, enabled, sessions: await sessionsInFolder(deps, adapter, unreadDirs) });
  }

  const shown = new Set<string>();
  const { held, heldNotInFolder } = await heldConversations(deps, perProvider, shown);

  const scan = await scanRecords(deps);
  const unrecorded: AuditSession[] = [];
  for (const provider of perProvider) {
    const recorded = scan.named.get(provider.adapter.records?.claudianProviderId ?? "") ?? new Set<string>();
    for (const [sessionId, draft] of provider.sessions) {
      if (recorded.has(sessionId.toLowerCase()) || shown.has(`${provider.adapter.id}\0${sessionId}`)) continue;
      unrecorded.push(await finish(deps, provider, draft));
    }
  }
  unrecorded.sort((a, b) => b.totalBytes - a.totalBytes || compare(a.sessionId, b.sessionId));

  const store = deps.joinPath(deps.vaultRealPath, ".claudian", "sessions");
  const storeFound = (await deps.fs.lstat(store).catch(() => null))?.isDirectory === true;
  return {
    storeFound,
    recordsUnread: scan.unread,
    deletedHere: deps.deletedHere.status,
    held,
    heldNotInFolder,
    unrecorded,
    legacyOnly: legacyOnlyRecords(scan.records),
    legacyStillListed: deps.legacyStillListed,
    unreadDirs,
  };
}

interface ProviderSessions {
  readonly adapter: ProviderAdapter;
  readonly enabled: boolean;
  readonly sessions: Map<string, Draft>;
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

/**
 * Asks where the session is on this device, by its files' own local paths —
 * for a provider switched on here. One that is off is not looked for: this
 * plugin reads the folders of the CLIs it was asked to sync, and no others.
 */
async function finish(deps: AuditDeps, provider: ProviderSessions, draft: Draft): Promise<AuditSession> {
  let here: Whereabouts = provider.enabled ? "not-here" : "unchecked";
  for (const rel of provider.enabled ? draft.primaries : []) {
    const target = await provider.adapter.targetPathFor(rel).catch(() => null);
    if (target !== null && (await isFile(deps, target))) {
      here = "here";
      break;
    }
    const archived = provider.adapter.archivedPathFor?.(rel) ?? null;
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
  perProvider: readonly ProviderSessions[],
  shown: Set<string>,
): Promise<{ held: AuditHeldConversation[]; heldNotInFolder: number }> {
  const held: AuditHeldConversation[] = [];
  let heldNotInFolder = 0;
  const records = deps.deletedHere.file?.records ?? {};
  for (const [rel, entry] of Object.entries(records)) {
    const hold = entry.hold;
    const record = claudianRecordOf(rel);
    if (!hold || !record || record.kind !== "meta") continue;
    if (hold.kind !== "deleted-here" && hold.kind !== "removed-by-tombstone") continue;

    const copy = deps.joinPath(deps.replicaRoot, ...rel.split("/"));
    const stat = await deps.fs.lstat(copy).catch(() => undefined);
    // Only "not there" is "no longer in the sync folder"; a copy that would
    // not answer is listed, as one whose record could not be read.
    if (stat === null) {
      heldNotInFolder += 1;
      continue;
    }
    const readable = stat !== undefined && stat.isFile && stat.size <= deps.maxRecordBytes;
    const text = readable ? await readText(deps, copy) : null;
    const parsed = text === null ? null : parseObject(text);
    const recordProvider = parsed === null ? null : providerOf(parsed);
    const owner = perProvider.find((p) => p.adapter.records?.claudianProviderId === recordProvider);

    const sessions: AuditSession[] = [];
    if (parsed !== null && owner) {
      for (const sessionId of ownSessionIds(parsed, record.conversationId)) {
        const draft = owner.sessions.get(sessionId);
        if (!draft) continue;
        shown.add(`${owner.adapter.id}\0${sessionId}`);
        sessions.push(await finish(deps, owner, draft));
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
 * The sessions a record names as its own history.
 *
 * Claude's the way Claudian reads them — every previous id and the current
 * one, `createShell`'s defaults applied — except a fork that has not sent
 * yet, whose only id is its source's: that is the other conversation's
 * history, and it is listed under that one. Anyone else's from the fields
 * that carry an id.
 */
function ownSessionIds(record: Record<string, unknown>, conversationId: string): string[] {
  const bound = claudeBoundSessionIds(record, conversationId);
  if (bound.status === "ok") {
    if (claudeResume(record, conversationId)?.forked === true) return [];
    return bound.ids.filter((id): id is string => typeof id === "string");
  }
  return idFields(record);
}

/** Every id a non-Claude record carries: its session, thread, provider session and earlier ones. */
function idFields(record: Record<string, unknown>): string[] {
  const state = isObject(record.providerState) ? record.providerState : {};
  const previous = Array.isArray(state.previousProviderSessionIds) ? state.previousProviderSessionIds : [];
  const ids = [record.sessionId, state.threadId, state.providerSessionId, ...previous];
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))];
}

interface ScannedRecord {
  readonly conversationId: string;
  readonly layer: "current" | "legacy";
  /** `.claudian/sessions`, `.claude/sessions/devices/<key>`, … */
  readonly folder: string;
  /** Null when it could not be read, or was too large to. */
  readonly record: Record<string, unknown> | null;
}

/**
 * Every record in this vault, read once: `.claudian/sessions` and
 * `.claude/sessions`, each with every device's folder — another device's
 * conversation is still a conversation, and its history is not "no record".
 *
 * `named` is, per Claudian provider id, every session any record names in
 * any field Claudian reads a conversation's history from: for Claude, the
 * current id under both spellings, every previous one and a pending fork's
 * source. Lower-cased: Claudian compares them that way. A record with a
 * deletion marker beside it is skipped in its own folder, as `readVaultScope`
 * skips it.
 */
async function scanRecords(
  deps: AuditDeps,
): Promise<{ records: ScannedRecord[]; named: Map<string, Set<string>>; unread: number }> {
  const records: ScannedRecord[] = [];
  const named = new Map<string, Set<string>>();
  let unread = 0;
  for (const [layer, segments] of [
    ["current", [".claudian", "sessions"]],
    ["legacy", [".claude", "sessions"]],
  ] as const) {
    const root = deps.joinPath(deps.vaultRealPath, ...segments);
    const rootRel = segments.join("/");
    const folders: Array<{ dir: string; rel: string }> = [{ dir: root, rel: rootRel }];
    const devices = await listDir(deps, deps.joinPath(root, "devices"));
    if (devices === null) unread += 1;
    for (const entry of devices ?? []) {
      if (entry.isDirectory && DEVICE_KEY.test(entry.name)) {
        folders.push({ dir: deps.joinPath(root, "devices", entry.name), rel: `${rootRel}/devices/${entry.name}` });
      }
    }
    for (const folder of folders) {
      const entries = await listDir(deps, folder.dir);
      if (entries === null) {
        unread += 1;
        continue;
      }
      const files = new Set(entries.filter((entry) => entry.isFile).map((entry) => entry.name));
      for (const name of [...files].sort()) {
        if (!name.endsWith(META_SUFFIX)) continue;
        const conversationId = name.slice(0, -META_SUFFIX.length);
        if (files.has(`${conversationId}${TOMBSTONE_SUFFIX}`)) continue;
        const target = deps.joinPath(folder.dir, name);
        const stat = await deps.fs.lstat(target).catch(() => undefined);
        if (stat === null) continue;
        const text = stat?.isFile && stat.size <= deps.maxRecordBytes ? await readText(deps, target) : null;
        const record = text === null ? null : parseObject(text);
        if (record === null) unread += 1;
        records.push({ conversationId, layer, folder: folder.rel, record });
        if (record === null) continue;
        const provider = providerOf(record);
        const ids = named.get(provider) ?? new Set<string>();
        for (const id of namedSessionIds(record, conversationId)) ids.add(id.toLowerCase());
        named.set(provider, ids);
      }
    }
  }
  return { records, named, unread };
}

/** Every session a record names, for "is this session recorded at all". */
function namedSessionIds(record: Record<string, unknown>, conversationId: string): string[] {
  const ids = idFields(record);
  const bound = claudeBoundSessionIds(record, conversationId);
  if (bound.status === "ok") ids.push(...bound.ids.filter((id): id is string => typeof id === "string"));
  const state = isObject(record.providerState) ? record.providerState : {};
  const fork = isObject(state.forkSource) ? state.forkSource.sessionId : undefined;
  if (typeof fork === "string") ids.push(fork);
  return ids;
}

/**
 * List ③: records in `.claude/sessions` whose conversation has no record in
 * `.claudian/sessions` — in any layer, any device's folder included, so a
 * conversation another device still lists is not called lost here. The
 * first found per conversation, the shared folder before device folders.
 */
function legacyOnlyRecords(records: readonly ScannedRecord[]): AuditLegacyRecord[] {
  const current = new Set(records.filter((r) => r.layer === "current").map((r) => r.conversationId));
  const found = new Map<string, AuditLegacyRecord>();
  for (const scanned of records) {
    if (scanned.layer !== "legacy" || current.has(scanned.conversationId) || found.has(scanned.conversationId)) continue;
    const { record, conversationId } = scanned;
    found.set(conversationId, {
      conversationId,
      folder: scanned.folder,
      title: titleOf(record),
      recordProvider: record === null ? null : providerOf(record),
      sessionId: record === null ? null : resumableId(record, conversationId),
    });
  }
  return [...found.values()].sort((a, b) => compare(a.conversationId, b.conversationId));
}

/**
 * The id a terminal resumes this record's conversation by — the one a send
 * in Claudian would resume — when it names one of the shape every supported
 * CLI uses. Not a pending fork's source, which is another conversation; and
 * a Claude record with no `sessionId` key defaults to its own conversation
 * id, which no CLI resumes.
 */
function resumableId(record: Record<string, unknown>, conversationId: string): string | null {
  const resume = claudeResume(record, conversationId);
  if (resume !== null) return !resume.forked && isSessionUuid(resume.resumes) ? resume.resumes : null;
  const state = isObject(record.providerState) ? record.providerState : {};
  return [state.threadId, record.sessionId, state.providerSessionId].find(isSessionUuid) ?? null;
}

/** Claudian's provider id for a record; a record without one is Claude's, as `createShell` has it. */
function providerOf(record: Record<string, unknown>): string {
  return typeof record.providerId === "string" ? record.providerId : "claude";
}

/** Entries, [] when the folder is not there, null when it would not list. */
async function listDir(deps: AuditDeps, dir: string): Promise<Awaited<ReturnType<FsGateway["readDir"]>> | null> {
  const stat = await deps.fs.lstat(dir).catch(() => undefined);
  if (stat === null) return [];
  if (stat === undefined || !stat.isDirectory) return null;
  return deps.fs.readDir(dir).catch(() => null);
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
