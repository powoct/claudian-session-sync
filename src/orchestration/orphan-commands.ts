/**
 * Half-copied sessions, and getting rid of them (architecture §6.6).
 *
 * A group is applied aux-first with the primary last, so a failure between the
 * two leaves this machine holding a session's history with no commit point.
 * §6.6 chose not to roll that back — undoing a write in an already-failing
 * state is a second destructive write — and promised a command instead, with
 * one rule attached: **never delete automatically**.
 *
 * The whole difficulty is that an orphan and a session the CLI is creating
 * right now look identical from the outside. Both are a directory with some
 * members and no primary. So nothing here decides on shape alone; a candidate
 * has to survive four questions, and the last two are what keep this from
 * being a way to lose a conversation:
 *
 *   1. does the provider recognise these files at all;
 *   2. is the group missing its primary;
 *   3. is the sync folder also missing it — because if the folder has it, the
 *      next pass finishes the job and there is nothing to clean;
 *   4. is anything in that session still moving — a session being written is a
 *      session being created, not a leftover.
 *
 * Removal backs up first, for the same reason every overwrite does (I1): these
 * are bytes, and the user is about to be able to destroy them with a button.
 */
import type { FsGateway } from "../infra/fs-gateway";
import type { ProviderAdapter, SessionGroup } from "../providers/provider-adapter";
import type { LogicalId } from "../domain/types";
import type { BackupRequest } from "../infra/backup-writer";
import type { MintOutcome } from "./sync-engine";

export interface OrphanCommandDeps {
  readonly fs: FsGateway;
  readonly joinPath: (...parts: string[]) => string;
  readonly workspaceId: string;
  readonly replicaRoot: string;
  readonly providers: ReadonlyArray<{ readonly adapter: ProviderAdapter; readonly root: string }>;
  readonly mintWritePath: (target: string) => Promise<MintOutcome>;
  readonly backup: (request: BackupRequest) => Promise<{ readonly path: string | null }>;
  readonly nowMs: () => number;
}

export interface OrphanFile {
  readonly neutralRel: string;
  readonly absPath: string;
  readonly sizeBytes: number;
  readonly modifiedMs: number;
}

export interface OrphanGroup {
  readonly providerId: string;
  readonly logicalId: string;
  readonly logicalIdPrefix: string;
  readonly files: readonly OrphanFile[];
  readonly totalBytes: number;
  /** Newest mtime across the group — how long ago anything here changed. */
  readonly lastTouchedMs: number;
}

export type RemoveOutcome =
  | { readonly ok: true; readonly removed: number; readonly backedUp: number }
  | {
      readonly ok: false;
      readonly reason:
        | "not-listed"
        | "changed-since-listed"
        | "backup-failed"
        | "path-rejected"
        | "sync-in-progress";
    };

/**
 * Sessions this machine holds without their commit point.
 *
 * Asked of each adapter rather than found by walking directories: what counts
 * as a member is the provider's whitelist (§8.2), and a walk in generic code
 * would sooner or later offer to delete a file the CLI wrote that this plugin
 * has no business touching. Providers whose session is a single file have no
 * such state and answer nothing.
 */
export async function listOrphans(deps: OrphanCommandDeps): Promise<OrphanGroup[]> {
  const found: OrphanGroup[] = [];

  for (const provider of deps.providers) {
    const health = await provider.adapter.healthCheck();
    if (!health.ok) continue;

    const incomplete = await provider.adapter.listIncompleteSessions?.().catch(() => []);
    for (const group of incomplete ?? []) {
      const orphan = await describeOrphan(deps, provider.adapter, group);
      if (orphan) found.push(orphan);
    }
  }
  // Biggest first: the number is what a user weighs when deciding.
  return found.sort((a, b) => b.totalBytes - a.totalBytes);
}

async function describeOrphan(
  deps: OrphanCommandDeps,
  adapter: ProviderAdapter,
  group: SessionGroup,
): Promise<OrphanGroup | null> {
  const members = group.files.filter((file) => file.mode !== "derived");
  if (members.length === 0) return null;
  // An adapter that found a primary has nothing missing. Grok's listing drops
  // a directory with no `summary.json` outright, so this also covers the
  // providers whose every file is a primary — for them the answer is always no.
  if (members.some((file) => file.role === "primary")) return null;

  // If the sync folder has the commit point, the next pass finishes this
  // session rather than leaving it, and offering to delete it would race a
  // repair that is already going to happen.
  //
  // Asked by listing the replica and putting each name back through the
  // adapter, rather than by reconstructing what the primary would be called:
  // that name is provider knowledge, and guessing it here would put Grok's
  // `summary.json` into a command that is supposed to work for anything.
  const sample = group.files[0];
  if (!sample) return null;
  const dirRel = sample.neutralRel.slice(0, sample.neutralRel.lastIndexOf("/"));
  const remoteDir = deps.joinPath(deps.replicaRoot, deps.workspaceId, ...dirRel.split("/"));
  for (const item of await deps.fs.readDir(remoteDir).catch(() => [])) {
    if (!item.isFile) continue;
    if (adapter.classifyNeutral(`${dirRel}/${item.name}`)?.role === "primary") return null;
  }

  const files: OrphanFile[] = [];
  let totalBytes = 0;
  let lastTouchedMs = 0;
  for (const file of members) {
    const stat = await deps.fs.lstat(file.absPath);
    if (stat === null || !stat.isFile) continue;
    files.push({
      neutralRel: file.neutralRel,
      absPath: file.absPath,
      sizeBytes: stat.size,
      modifiedMs: stat.mtimeMs,
    });
    totalBytes += stat.size;
    lastTouchedMs = Math.max(lastTouchedMs, stat.mtimeMs);
  }
  if (files.length === 0) return null;

  // A session that is still moving is a session being created, not a leftover
  // (§9.1's witnesses answer the same question for the pass). Ten minutes is
  // not a guarantee, which is why it is not the only condition — it is the
  // last one, after "the provider recognises it", "it has no commit point",
  // and "the sync folder has not got one either".
  if (deps.nowMs() - lastTouchedMs < QUIET_ENOUGH_MS) return null;

  return {
    providerId: adapter.id,
    logicalId: group.logicalId,
    logicalIdPrefix: String(group.logicalId).slice(0, 8),
    files,
    totalBytes,
    lastTouchedMs,
  };
}

/** Ten minutes. Long enough that a turn cannot be mistaken for a leftover. */
const QUIET_ENOUGH_MS = 10 * 60 * 1000;

/**
 * Deletes one half-copied session, after keeping a copy of it.
 *
 * `expected` is what the row said, and it is checked rather than trusted: the
 * list is drawn at one moment and the button pressed at another, and in
 * between the CLI may have finished writing the very session this is about to
 * remove. Backing up first is not belt and braces — it is the same rule every
 * overwrite follows (I1), and this is the one command whose whole purpose is
 * to destroy bytes.
 */
export async function removeOrphan(
  deps: OrphanCommandDeps,
  providerId: string,
  logicalId: string,
  expected: ReadonlyArray<{ readonly neutralRel: string; readonly sizeBytes: number }>,
): Promise<RemoveOutcome> {
  const current = (await listOrphans(deps)).find(
    (group) => group.providerId === providerId && group.logicalId === logicalId,
  );
  if (!current) return { ok: false, reason: "not-listed" };

  const sameShape =
    current.files.length === expected.length &&
    expected.every((want) =>
      current.files.some(
        (have) => have.neutralRel === want.neutralRel && have.sizeBytes === want.sizeBytes,
      ),
    );
  if (!sameShape) return { ok: false, reason: "changed-since-listed" };

  let backedUp = 0;
  for (const file of current.files) {
    // Caught, not assumed: the gateway stages through an exclusive open, and a
    // permissions problem on the backups folder throws rather than returning a
    // result. Letting that escape would leave the caller with an exception
    // where the contract promises a refusal — and this is the command where a
    // refusal is the whole safety property.
    const kept = await backupOrNull(deps, {
      sourcePath: file.absPath,
      workspaceId: deps.workspaceId,
      providerId,
      logicalId: logicalId as LogicalId,
      // Local side: these files are in the CLI's own directory, not the
      // sync folder.
      remote: false,
      action: "REMOVE_ORPHAN",
    });
    if (kept === null) return { ok: false, reason: "backup-failed" };
    backedUp += 1;
  }

  let removed = 0;
  for (const file of current.files) {
    const minted = await deps.mintWritePath(file.absPath);
    if (!minted.ok) return { ok: false, reason: "path-rejected" };
    await deps.fs.removeFile(minted.value);
    removed += 1;
  }
  return { ok: true, removed, backedUp };
}

async function backupOrNull(
  deps: OrphanCommandDeps,
  request: BackupRequest,
): Promise<{ readonly path: string | null } | null> {
  const kept = await deps.backup(request).catch(() => null);
  return kept === null || kept.path === null ? null : kept;
}
