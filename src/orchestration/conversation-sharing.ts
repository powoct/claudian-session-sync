/**
 * Sharing this device's conversations, by moving the record rather than
 * copying it (ADR-69, replacing ADR-67).
 *
 * Claudian 2.2.5 files each new conversation's record under the device that
 * made it, and a device reads only its own folder — the key is a hash of a
 * `localStorage` seed, so no two installs share one. The record therefore
 * cannot travel by any transport, and a conversation started on one machine is
 * missing from the other machine's list however the vault is synced.
 *
 * The first attempt at this published a *copy* into the flat layer. An
 * independent review took it apart, and it was right: the flat layer is not a
 * read-only projection, it is upstream's ordinary read/write authority
 * (`ConversationPersistenceStore.assertMetadataWriteAuthority` returns early
 * when no fence exists). So a copy makes two live authorities for one
 * conversation, at two paths, that never converge — and the engine cannot even
 * see them as related, because they are different files. Worse, upstream's
 * delete removes the device metadata and leaves only a tombstone, so a mirror
 * keyed off `.meta.json` was never taken down and the deleted conversation
 * came back through the flat copy.
 *
 * Moving it dissolves all of that. There is one record, in the layer every
 * device reads:
 *
 *   - `adoptMetadataConversations` marks a flat-sourced record `unscoped`, so
 *     every machine lists it;
 *   - writes go to `requireMetadataTarget`, so every machine writes the same
 *     file;
 *   - a delete is `deleteCurrentMetadata(id, 'unscoped')` plus a tombstone in
 *     the same layer — the real thing, with nothing of ours to resurrect.
 *
 * The move is two-phase and resumable without bookkeeping. Write flat, then
 * remove the device copy; if a later pass finds both and they are byte-equal,
 * that is an interrupted move and it finishes it. If it finds a flat record
 * that *differs*, it stops and reports: that is either a real pre-2.2.5 record
 * or a conversation the other machine has since edited, and neither is ours to
 * overwrite.
 *
 * What it does not do, and the settings text says so: turning the switch off
 * stops further moves, it does not bring back what has already been shared.
 * Moving a record back would be a second destructive write, and by then the
 * other machine may be using it.
 */
import type { FsGateway } from "../infra/fs-gateway";
import { type PathGuardDeps, resolveUnderRoot } from "../infra/path-guard";

/** Upstream's own shape for an installation key (`InstallationKey.ts`). */
export const DEVICE_KEY = /^device-[a-f0-9]{64}$/;

const META_SUFFIX = ".meta.json";
const TOMBSTONE_SUFFIX = ".deleted.json";
const FENCE_SUFFIX = ".assigned.json";

export interface ShareDeps {
  readonly fs: FsGateway;
  /**
   * The store is a directory another program writes into, so every path this
   * writes goes through the same containment walk the sync folder's does.
   */
  readonly guard: PathGuardDeps;
  readonly joinPath: (...parts: string[]) => string;
  readonly hashBytes: (bytes: Uint8Array) => string;
  readonly vaultRealPath: string;
  /** This machine's Claudian installation key, or null when it cannot be read. */
  readonly deviceKey: string | null;
}

export interface ShareOutcome {
  readonly moved: number;
  /** Interrupted moves this pass finished. */
  readonly completed: number;
  /** Left alone, with the reason, for the pass report. */
  readonly heldBack: readonly string[];
}

export async function shareOwnConversations(deps: ShareDeps): Promise<ShareOutcome> {
  const heldBack: string[] = [];
  let moved = 0;
  let completed = 0;
  if (deps.deviceKey === null || !DEVICE_KEY.test(deps.deviceKey)) {
    return { moved, completed, heldBack };
  }

  const store = deps.joinPath(deps.vaultRealPath, ".claudian", "sessions");
  const mine = deps.joinPath(store, "devices", deps.deviceKey);
  // Every level of the source path, checked for links before anything under it
  // is read. The review reproduced the alternative: a device directory that is
  // a symlink reads records from outside the vault and publishes them into it.
  if (!(await isPlainDirectory(deps, mine))) return { moved, completed, heldBack };

  const flat = index(await deps.fs.readDir(store).catch(() => []));
  const own = await deps.fs.readDir(mine).catch(() => []);

  for (const entry of own) {
    if (!entry.isFile || !entry.name.endsWith(META_SUFFIX)) continue;
    const id = entry.name.slice(0, -META_SUFFIX.length);

    // A fence names the device a conversation belongs to, and upstream checks
    // it before it resolves any metadata path. Moving a fenced record would be
    // meddling in a claim this machine did not make.
    if (flat.has(`${id}${FENCE_SUFFIX}`)) {
      heldBack.push(`${id}: assigned to a device`);
      continue;
    }
    // Deleted in the shared layer. Re-creating it there is the resurrection
    // the copy-based design was guilty of.
    if (flat.has(`${id}${TOMBSTONE_SUFFIX}`)) {
      heldBack.push(`${id}: deleted in the shared layer`);
      continue;
    }

    const source = deps.joinPath(mine, entry.name);
    if (!(await isPlainFile(deps, source))) {
      heldBack.push(`${id}: not a regular file`);
      continue;
    }
    const bytes = await deps.fs.readFile(source).catch(() => null);
    if (bytes === null) continue;

    const target = await resolveUnderRoot(deps.guard, store, entry.name);
    if (!target.ok) {
      heldBack.push(`${id}: path refused`);
      continue;
    }

    if (flat.has(entry.name)) {
      const there = await deps.fs.readFile(target.value).catch(() => null);
      if (there === null) continue;
      if (deps.hashBytes(there) !== deps.hashBytes(bytes)) {
        // Not an interrupted move: a real pre-2.2.5 record, or one the other
        // machine has edited since. Either way it is not ours to overwrite.
        heldBack.push(`${id}: a different record is already shared`);
        continue;
      }
      await deps.fs.removeFile(source as never);
      completed += 1;
      continue;
    }

    // Shared copy first, device copy removed second. A crash between them
    // leaves both, which the branch above recognises and finishes; the
    // opposite order would lose the record outright.
    await deps.fs.writeFileAtomic(target.value, bytes);
    await deps.fs.removeFile(source as never);
    moved += 1;
  }

  return { moved, completed, heldBack };
}

function index(entries: ReadonlyArray<{ name: string; isFile: boolean }>): Set<string> {
  return new Set(entries.filter((entry) => entry.isFile).map((entry) => entry.name));
}

async function isPlainDirectory(deps: ShareDeps, target: string): Promise<boolean> {
  // `lstat`, so a symlink is seen as a symlink rather than followed — the
  // distinction the review's reproduction turned on.
  const stat = await deps.fs.lstat(target);
  return stat !== null && stat.isDirectory && !stat.isSymbolicLink;
}

async function isPlainFile(deps: ShareDeps, target: string): Promise<boolean> {
  const stat = await deps.fs.lstat(target);
  // `nlink > 1` is refused too: a hard link means the same bytes are reachable
  // from somewhere this walk never checked.
  return stat !== null && stat.isFile && !stat.isSymbolicLink && stat.nlink <= 1;
}
