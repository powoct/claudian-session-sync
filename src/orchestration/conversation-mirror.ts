/**
 * Making this device's conversations visible on the others (ADR-67).
 *
 * Claudian 2.2.5 files each new conversation's record under the device that
 * created it, and a device only ever reads its *own* folder — the key is a
 * hash of a `localStorage` seed, so no two installs ever share one. The record
 * therefore cannot travel: sync the vault however you like, and a conversation
 * started on the Mac is still absent from the Windows machine's sidebar. This
 * plugin can carry the session bytes, so `claude --resume <id>` works, but the
 * entry the user actually looks for does not exist there.
 *
 * The flat layer is the one channel that does cross. Upstream's precedence is
 * `own device → flat → legacy`, and the flat layer is exactly where records
 * that belong to no single device live. So this writes a copy there, and does
 * nothing cleverer than that.
 *
 * Three rules keep it from becoming a second source of truth:
 *
 * - **Only this device's own records are mirrored.** Never another device's
 *   folder, never a foreign key. A machine publishes what it owns.
 * - **A flat record this plugin did not write is never touched.** That covers
 *   a genuine pre-2.2.5 record, and it covers a mirror the other machine has
 *   since edited.
 * - **`.assigned.json` is never written and never copied.** It is a fence
 *   whose whole effect is to hide a conversation on every machine whose key
 *   does not match, and `selectSessionMetadataCandidate` checks it before it
 *   looks at any metadata path — so a copied fence would blackhole the very
 *   conversations this feature exists to surface.
 *
 * What it does not do, stated plainly because the README has to say it too:
 * the owning machine keeps reading its own copy, so metadata the other machine
 * changes — a rename, a pin — does not come back. The conversation itself is
 * not affected; that lives in the CLI's session file and syncs normally.
 */
import type { FsGateway } from "../infra/fs-gateway";
import { type PathGuardDeps, resolveUnderRoot } from "../infra/path-guard";

/** Upstream's own shape for an installation key (`InstallationKey.ts`). */
export const DEVICE_KEY = /^device-[a-f0-9]{64}$/;

const META_SUFFIX = ".meta.json";
const TOMBSTONE_SUFFIX = ".deleted.json";

export interface MirrorDeps {
  readonly fs: FsGateway;
  /**
   * The store is a directory another program writes into, so every path this
   * writes goes through the same walk the sync folder's does — not the weaker
   * `mintStatePath`, which is for paths the plugin itself constructs under its
   * own home. A `.meta.json` that turns out to be a symlink is refused here
   * rather than followed out of the vault.
   */
  readonly guard: PathGuardDeps;
  readonly joinPath: (...parts: string[]) => string;
  readonly hashBytes: (bytes: Uint8Array) => string;
  readonly vaultRealPath: string;
  /**
   * This machine's Claudian installation key, or null when it cannot be read.
   *
   * Null is not an error: Claudian may not be installed, or may never have run
   * in this vault. Nothing is mirrored, which is the fail-closed direction.
   */
  readonly deviceKey: string | null;
  /** conversationId → hash of the mirror this machine last wrote. */
  readonly written: Readonly<Record<string, string>>;
  readonly record: (written: Readonly<Record<string, string>>) => Promise<void>;
}

export interface MirrorOutcome {
  readonly created: number;
  readonly refreshed: number;
  readonly removed: number;
  /** Flat records left alone because this plugin did not write them. */
  readonly skippedForeign: number;
}

export async function mirrorOwnConversations(deps: MirrorDeps): Promise<MirrorOutcome> {
  const outcome = { created: 0, refreshed: 0, removed: 0, skippedForeign: 0 };
  if (deps.deviceKey === null || !DEVICE_KEY.test(deps.deviceKey)) return outcome;

  const store = deps.joinPath(deps.vaultRealPath, ".claudian", "sessions");
  const mine = deps.joinPath(store, "devices", deps.deviceKey);
  const entries = await deps.fs.readDir(mine).catch(() => []);

  const written: Record<string, string> = { ...deps.written };
  const tombstoned = new Set(
    entries
      .filter((entry) => entry.isFile && entry.name.endsWith(TOMBSTONE_SUFFIX))
      .map((entry) => entry.name.slice(0, -TOMBSTONE_SUFFIX.length)),
  );

  for (const entry of entries) {
    if (!entry.isFile || !entry.name.endsWith(META_SUFFIX)) continue;
    const id = entry.name.slice(0, -META_SUFFIX.length);
    const flat = deps.joinPath(store, entry.name);

    // Deleted on this device: take the mirror back down, but only while it is
    // still the bytes this machine wrote. Removing somebody's edited copy
    // would be deletion propagation by the back door (ADR-10).
    if (tombstoned.has(id)) {
      const current = await readOrNull(deps, flat);
      if (current !== null && written[id] === deps.hashBytes(current)) {
        const minted = await resolveUnderRoot(deps.guard, store, entry.name);
        if (minted.ok) {
          await deps.fs.removeFile(minted.value);
          outcome.removed += 1;
        }
      }
      delete written[id];
      continue;
    }

    const source = await readOrNull(deps, deps.joinPath(mine, entry.name));
    if (source === null) continue;
    const sourceHash = deps.hashBytes(source);

    const minted = await resolveUnderRoot(deps.guard, store, entry.name);
    if (!minted.ok) continue;

    const current = await readOrNull(deps, flat);
    if (current === null) {
      await deps.fs.writeFileAtomic(minted.value, source);
      written[id] = sourceHash;
      outcome.created += 1;
      continue;
    }

    const currentHash = deps.hashBytes(current);
    if (currentHash === sourceHash) {
      // Already identical. Recorded anyway, so a mirror written before this
      // machine started keeping notes is still recognised as its own.
      written[id] = sourceHash;
      continue;
    }
    if (written[id] !== currentHash) {
      // Not ours: either a real pre-2.2.5 record, or the other machine has
      // edited the mirror. Either way this is now somebody else's file.
      outcome.skippedForeign += 1;
      continue;
    }
    await deps.fs.writeFileAtomic(minted.value, source);
    written[id] = sourceHash;
    outcome.refreshed += 1;
  }

  await deps.record(written);
  return outcome;
}

async function readOrNull(deps: MirrorDeps, target: string): Promise<Uint8Array | null> {
  return deps.fs.readFile(target).catch(() => null);
}
