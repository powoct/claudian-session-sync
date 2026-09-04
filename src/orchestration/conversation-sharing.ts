/**
 * Sharing this device's conversations, by moving the record rather than
 * copying it (ADR-69), and keeping it moved (ADR-71).
 *
 * Claudian 2.2.5 files each new conversation's record under the device that
 * made it, and a device reads only its own folder — the key is a hash of a
 * `localStorage` seed, so no two installs share one. The record therefore
 * cannot travel by any transport, and a conversation started on one machine is
 * missing from the other machine's list however the vault is synced.
 *
 * The first attempt published a *copy* into the flat layer. An independent
 * review took it apart, and it was right: the flat layer is not a read-only
 * projection, it is upstream's ordinary read/write authority
 * (`ConversationPersistenceStore.assertMetadataWriteAuthority` returns early
 * when no fence exists). So a copy makes two live authorities for one
 * conversation, at two paths, that never converge.
 *
 * ## Why moving once was not enough (ADR-71)
 *
 * The move was designed as a migration: do it, and the record lives in the
 * shared layer from then on. Measured on 2026-09-04, it does not stay there.
 *
 * Upstream resolves *which layer to write* from an in-memory map
 * (`ConversationRepository.metadataTargets`) that is derived **once per
 * Obsidian session**, from a single deferred scan at layout-ready. Nothing
 * watches `.claudian/sessions/`, and a cached conversation's metadata file is
 * never re-read. That staleness is upstream's documented design, not an
 * oversight — correctness there lives in the on-disk assignment fence, which
 * every write re-reads — so it is not going to change, and this code treats it
 * as a fixed property of the environment rather than a bug to wait out. Our move runs inside a pass in that same process, so it always
 * lands *after* the map was fixed — the map is stale by construction, not by
 * race. The next metadata write (a chat turn, a rename, a pin, a usage update)
 * recreates `devices/<key>/<id>.meta.json` from a strictly newer in-memory
 * object, upstream's read order prefers device over flat, and the shared copy
 * is frozen from that moment. The reporting machine had six such pairs; the
 * worst had a shared copy of 97 KB against a device copy of 217 KB, so the
 * other machines were three days behind.
 *
 * So this is not a migration that runs once. It is a **reconciliation that runs
 * every pass**, and the question it must answer is the one this codebase
 * already answers for opaque files (§7.2b, ADR-48): *may this machine
 * fast-forward the shared copy, or have the two genuinely diverged?*
 *
 * ## The published base
 *
 * The answer is a converged base, recorded machine-locally: `publishedHash` is
 * the bytes **this machine itself wrote** into the flat layer. Then
 *
 *   - the shared copy still holds exactly those bytes ⇒ nobody else has touched
 *     it, and our device copy is a strict continuation ⇒ **fold it forward**;
 *   - the shared copy has moved off the base ⇒ a peer wrote it, and we hold.
 *
 * The base is **never** seeded from a record merely found in the flat layer.
 * That row looks harmless and is the trap: adopting a peer's bytes as our base
 * would let the next device rewrite — serialised from an in-memory object that
 * predates the peer's edit, because upstream never re-reads — overwrite the
 * peer's rename while believing it was fast-forwarding.
 *
 * Losing the state file costs convergence, never bytes: a record with no base
 * is held back and reported, which is the same answer a record it has never
 * seen would get.
 *
 * ## The delete that came back
 *
 * The same staleness breaks deletion, and this one loses user intent rather
 * than merely freezing it. Deleting a moved conversation calls `markDeleted`
 * with the stale target, so the tombstone lands in the **device** layer, and
 * `cleanupDeletedConversation` removes the device metadata. The flat record
 * survives with no flat tombstone — and upstream's next scan, finding the
 * device side deleted, falls through to it. The conversation comes back.
 *
 * That is the resurrection the copy-based design was killed for, arriving
 * through a different door, and it is ours: it exists only because our move
 * staled the map. So a device tombstone whose flat record is still exactly the
 * bytes we published carries the tombstone into the flat layer — the write
 * upstream itself would have made. Off the base, it is reported, not guessed.
 *
 * ## What it still does not do
 *
 * Turning the switch off stops further moves; it does not bring back what has
 * already been shared. And a fork this machine cannot resolve on its own is
 * held, listed, and left to a person — never resolved in bulk.
 */
import type { FsGateway } from "../infra/fs-gateway";
import type { SharedRecordEntry, SharedRecordsFile } from "../infra/home-store";
import { type PathGuardDeps, resolveUnderRoot } from "../infra/path-guard";
import type { SafeAbsolutePath } from "../domain/types";

/** Upstream's own shape for an installation key (`InstallationKey.ts`). */
export const DEVICE_KEY = /^device-[a-f0-9]{64}$/;

const META_SUFFIX = ".meta.json";
const TOMBSTONE_SUFFIX = ".deleted.json";
const FENCE_SUFFIX = ".assigned.json";

const STORE_SEGMENTS = [".claudian", "sessions"] as const;
const DEVICES_DIR = "devices";

/** Entries unseen for this long are dropped, matching the ledger's own GC. */
const GC_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface ShareDeps {
  readonly fs: FsGateway;
  /**
   * The store is a directory another program writes into, so every path this
   * reads or writes goes through the same containment walk the sync folder's
   * does — every segment, not just the leaf.
   */
  readonly guard: PathGuardDeps;
  readonly joinPath: (...parts: string[]) => string;
  readonly hashBytes: (bytes: Uint8Array) => string;
  readonly vaultRealPath: string;
  /** This machine's Claudian installation key, or null when it cannot be read. */
  readonly deviceKey: string | null;
  readonly nowMs: number;
  /** What this machine has published, and the sink for what it publishes now. */
  readonly published: SharedRecordsFile;
  /**
   * Preserves the version an overwrite would destroy (I1). A null path cancels
   * the overwrite — the same contract the engine's own writes have.
   */
  readonly backup: (input: {
    readonly sourcePath: string;
    readonly conversationId: string;
    readonly action: string;
  }) => Promise<string | null>;
  /**
   * False once the pass may no longer write — the lock was lost, or the run was
   * cancelled. Re-checked immediately before every write and every removal.
   */
  readonly mayWrite: () => Promise<boolean>;
  /**
   * Conversations the user has explicitly told this machine to publish, in
   * spite of a fork. Empty on an ordinary pass: a fork is never resolved
   * without a person, and never in bulk.
   */
  readonly forced?: ReadonlySet<string>;
  /**
   * Restricts the whole pass to these conversations.
   *
   * A user resolving one fork asked about *that* conversation. Without this,
   * the click would also move every other device-layer record into the shared
   * layer as a side effect — a decision they did not make, on records they
   * were never shown (found by the 2026-09-04 acceptance run).
   */
  readonly only?: ReadonlySet<string>;
  /**
   * Look, and change nothing.
   *
   * The repair screen has to *show* what is stuck without acting on it, and
   * that is not a nicety: the sharing switch is machine-local consent, and
   * opening a screen is not consent. Before this existed, listing the forks
   * ran the full reconciliation — so a user with the switch off who opened the
   * screen out of curiosity had every record on this device published.
   *
   * **Required, deliberately.** The re-check's reviewer made the point that
   * this fix holds only because every caller remembers to pass it, and that a
   * future call site which forgot would silently reopen the same hole. So
   * forgetting is now a compile error: there is no safe default to fall back
   * on, because both intents are equally legitimate.
   */
  readonly inspectOnly: boolean;
}

/**
 * What pressing "publish" did.
 *
 * Three-way on purpose: a pass holding the lock and a record that moved under
 * the click are different situations with different next steps, and a single
 * "nothing happened" makes the user press the button again for the one case
 * where pressing again cannot help.
 */
export type PublishOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "sync-in-progress" | "changed-again" | "unavailable" };

/** One conversation whose two copies have diverged, for the repair screen. */
export interface SharingHold {
  readonly conversationId: string;
  readonly reason: string;
  readonly devicePath: string;
  readonly deviceSize: number;
  readonly deviceMtimeMs: number;
  readonly sharedPath: string | null;
  readonly sharedSize: number | null;
  readonly sharedMtimeMs: number | null;
  /** True when the user could resolve this by publishing this device's copy. */
  readonly resolvable: boolean;
}

export interface ShareOutcome {
  readonly moved: number;
  /** Interrupted moves this pass finished. */
  readonly completed: number;
  /** Shared copies fast-forwarded to this device's newer record. */
  readonly folded: number;
  /** Device copies withdrawn because a peer now owns the shared record. */
  readonly retired: number;
  /** Deletions carried into the shared layer, repairing a stale-target delete. */
  readonly tombstoned: number;
  /** Left alone, with the reason, for the pass report. */
  readonly heldBack: readonly string[];
  readonly holds: readonly SharingHold[];
  /** The state to persist. Null when nothing was learned and nothing changed. */
  readonly published: SharedRecordsFile | null;
}

function empty(published: SharedRecordsFile | null = null): ShareOutcome {
  return {
    moved: 0,
    completed: 0,
    folded: 0,
    retired: 0,
    tombstoned: 0,
    heldBack: [],
    holds: [],
    published,
  };
}

export async function shareOwnConversations(deps: ShareDeps): Promise<ShareOutcome> {
  if (deps.deviceKey === null || !DEVICE_KEY.test(deps.deviceKey)) return empty();
  // An inspection needs no write permission, and demanding it would blank the
  // repair screen whenever a pass happened to hold the lock.
  if (!deps.inspectOnly && !(await deps.mayWrite())) return empty();
  const inScope = (id: string) => deps.only === undefined || deps.only.has(id);
  const mayWrite = async () => !deps.inspectOnly && (await deps.mayWrite());

  const store = deps.joinPath(deps.vaultRealPath, ...STORE_SEGMENTS);

  // Every segment of the device path walked for links, not just the leaf. The
  // review reproduced the leaf-only version: symlinking `devices` — one level
  // above the folder the old check looked at — reads records from outside the
  // vault and publishes them into it.
  const mineRel = [...STORE_SEGMENTS, DEVICES_DIR, deps.deviceKey].join("/");
  const mine = await resolveUnderRoot(deps.guard, deps.vaultRealPath, mineRel);
  if (!mine.ok) return empty();
  const mineStat = await deps.fs.lstat(mine.value);
  if (mineStat === null || !mineStat.isDirectory) return empty();

  // Fail closed on a store that cannot be listed. Reading an unreadable
  // directory as an empty one would make every fence and every tombstone
  // invisible and send each record straight down the publish row — the exact
  // shape of a resurrection. A directory we may not read is not an empty one.
  const storeEntries = await deps.fs.readDir(store).then(
    (entries) => entries,
    () => null,
  );
  if (storeEntries === null) return empty();
  const flat = index(storeEntries);

  const own = await deps.fs.readDir(mine.value).then(
    (entries) => entries,
    () => null,
  );
  if (own === null) return empty();

  const state = new Map(Object.entries(deps.published.records));
  const heldBack: string[] = [];
  const holds: SharingHold[] = [];
  let moved = 0;
  let completed = 0;
  let folded = 0;
  let retired = 0;
  let tombstoned = 0;

  const hold = (id: string, reason: string, detail?: Partial<SharingHold>) => {
    heldBack.push(`${id}: ${reason}`);
    if (detail?.devicePath !== undefined) holds.push({ ...(detail as SharingHold) });
  };

  // ── Deletions first ──────────────────────────────────────────────────────
  // A stale-target delete removes the device metadata, so these conversations
  // have no `.meta.json` left to iterate; they are found by their tombstone.
  for (const entry of own) {
    if (!entry.isFile || !entry.name.endsWith(TOMBSTONE_SUFFIX)) continue;
    const id = entry.name.slice(0, -TOMBSTONE_SUFFIX.length);
    if (!inScope(id)) continue;
    if (!flat.has(`${id}${META_SUFFIX}`)) continue; // nothing to resurrect
    if (flat.has(entry.name)) continue; // already tombstoned in the shared layer

    const base = state.get(id);
    const sharedPath = await resolveUnderRoot(deps.guard, store, `${id}${META_SUFFIX}`);
    if (!sharedPath.ok) continue;
    const shared = await readIfPlainFile(deps, sharedPath.value);
    if (shared === null) continue;

    if (base === undefined || deps.hashBytes(shared.bytes) !== base.publishedHash) {
      // Someone else's record, or one a peer has edited since we published.
      // Deleting it is not ours to do, and ADR-10 is the rule that says so.
      hold(
        id,
        "deleted here, but the shared copy is not the one this machine published — " +
          "it will come back on the next restart",
      );
      continue;
    }

    // The write upstream would have made, had our move not staled its map.
    // It destroys nothing: the shared record stays underneath the marker.
    const tombPath = await resolveUnderRoot(deps.guard, store, entry.name);
    const source = deps.joinPath(mine.value, entry.name);
    const bytes = await deps.fs.readFile(source).catch(() => null);
    if (!tombPath.ok || bytes === null) continue;
    // An inspection skips the row rather than ending the scan: a row this pass
    // would have acted on is not stuck, so it is not something to show anyone,
    // and abandoning here would hide every fork found after it.
    if (!(await mayWrite())) {
      if (deps.inspectOnly) continue;
      return finish();
    }
    await deps.fs.writeFileAtomic(tombPath.value, bytes);
    state.delete(id);
    tombstoned += 1;
  }

  // ── Records ──────────────────────────────────────────────────────────────
  for (const entry of own) {
    if (!entry.isFile || !entry.name.endsWith(META_SUFFIX)) continue;
    const id = entry.name.slice(0, -META_SUFFIX.length);
    if (!inScope(id)) continue;

    // A fence names the device a conversation belongs to, and upstream checks
    // it before it resolves any metadata path. Moving a fenced record would be
    // meddling in a claim this machine did not make.
    if (flat.has(`${id}${FENCE_SUFFIX}`)) {
      hold(id, "assigned to a device");
      continue;
    }
    if (flat.has(`${id}${TOMBSTONE_SUFFIX}`)) {
      hold(id, "deleted in the shared layer");
      continue;
    }

    const sourceRel = `${mineRel}/${entry.name}`;
    const source = await resolveUnderRoot(deps.guard, deps.vaultRealPath, sourceRel, {
      requireRegularFile: true,
      rejectHardLinks: true,
    });
    if (!source.ok) {
      hold(id, "not a regular file");
      continue;
    }
    const device = await readIfPlainFile(deps, source.value);
    if (device === null) {
      hold(id, "could not be read");
      continue;
    }
    if (device.bytes.length === 0) {
      // Zero bytes is a record mid-write, never a record. Publishing it would
      // put an unparseable file in the layer every device reads.
      hold(id, "is empty right now");
      continue;
    }

    const target = await resolveUnderRoot(deps.guard, store, entry.name);
    if (!target.ok) {
      hold(id, "path refused");
      continue;
    }
    const base = state.get(id);
    const deviceHash = deps.hashBytes(device.bytes);

    // ── flat absent: the original move ───────────────────────────────────
    if (!flat.has(entry.name)) {
      if (deps.inspectOnly) continue; // nothing stuck here to show a person
      if (!(await mayWrite())) return finish();
      // No-replace, not atomic-replace: "the shared name is free" is this
      // row's premise, and a premise must fail at the syscall rather than be
      // assumed. Losing the race is a normal replan, not a licence to clobber.
      const written = await deps.fs
        .writeFileNoReplace(target.value, device.bytes)
        .catch(() => ({ ok: false, reason: "io-error" }) as const);
      if (!written.ok) {
        // Losing this race is a normal replan, not a licence to clobber: the
        // record that got there first is one this machine has never seen.
        hold(
          id,
          written.reason === "target-exists"
            ? "another writer created the shared record first"
            : "the shared record could not be written",
        );
        continue;
      }
      if (!written.noReplaceEnforced) {
        // Reported, never swallowed: it is the difference between "nothing
        // could have been overwritten" and "the last look was the only guard".
        heldBack.push(`${id}: published, but this filesystem cannot promise nothing was replaced`);
      }
      state.set(id, entryFor(deviceHash, device.bytes.length, deps.nowMs));
      if (await removeVerified(deps, source.value, deviceHash)) moved += 1;
      continue;
    }

    const shared = await readIfPlainFile(deps, target.value);
    if (shared === null) {
      hold(id, "the shared record could not be read");
      continue;
    }
    const sharedHash = deps.hashBytes(shared.bytes);

    // ── byte-equal: finish an interrupted move ───────────────────────────
    // Base-independent on purpose — this is what makes crash recovery free.
    if (sharedHash === deviceHash) {
      state.set(id, entryFor(sharedHash, shared.bytes.length, deps.nowMs));
      if (await removeVerified(deps, source.value, deviceHash)) completed += 1;
      continue;
    }

    const forced = deps.forced?.has(id) === true;

    // ── the shared copy is still ours: fold this device's record forward ──
    if (forced || (base !== undefined && sharedHash === base.publishedHash)) {
      if (!(await mayWrite())) {
        if (deps.inspectOnly) continue;
        return finish();
      }
      const kept = await deps.backup({
        sourcePath: target.value,
        conversationId: id,
        action: forced ? "SHARE_FOLD_FORCED" : "SHARE_FOLD",
      });
      // A backup that did not happen cancels the overwrite. Same contract the
      // engine's own writes have: I1 before the write, or no write.
      if (kept === null) {
        hold(id, "the shared record could not be backed up, so it was left alone");
        continue;
      }
      // Last look before the destructive write: the vault transport may have
      // landed a peer's version while we were hashing and backing up.
      const still = await readIfPlainFile(deps, target.value);
      if (still === null || deps.hashBytes(still.bytes) !== sharedHash) {
        hold(id, "the shared record changed while it was being replaced");
        continue;
      }
      if (!(await mayWrite())) return finish();
      await deps.fs.writeFileAtomic(target.value, device.bytes);
      state.set(id, entryFor(deviceHash, device.bytes.length, deps.nowMs));
      if (await removeVerified(deps, source.value, deviceHash)) folded += 1;
      continue;
    }

    // ── a peer has taken over: withdraw this device's copy ────────────────
    // The device copy is exactly what we published, so it carries nothing the
    // shared record does not already have, while its mere existence is what
    // makes upstream ignore the shared one. Removing it is the only rule that
    // *ends* the loop: the next Obsidian session adopts the record as
    // `unscoped`, and this machine writes the shared copy forever after.
    if (base !== undefined && deviceHash === base.publishedHash) {
      if (!(await mayWrite())) {
        if (deps.inspectOnly) continue;
        return finish();
      }
      const kept = await deps.backup({
        sourcePath: source.value,
        conversationId: id,
        action: "SHARE_RETIRE",
      });
      if (kept === null) {
        hold(id, "this device's copy could not be backed up, so it was left alone");
        continue;
      }
      if (await removeVerified(deps, source.value, deviceHash)) {
        state.delete(id);
        retired += 1;
      }
      continue;
    }

    // ── both moved, or no base: a person decides ─────────────────────────
    state.set(id, {
      ...(base ?? entryFor("", 0, deps.nowMs)),
      lastSeenMs: deps.nowMs,
    });
    if (base === undefined) state.delete(id);
    hold(
      id,
      base === undefined
        ? "a different record is already shared, and this machine has no record of publishing it"
        : "both this device's copy and the shared one have changed",
      {
        conversationId: id,
        reason:
          base === undefined
            ? "a different record is already shared"
            : "both copies changed since this machine published",
        devicePath: source.value,
        deviceSize: device.bytes.length,
        deviceMtimeMs: device.mtimeMs,
        sharedPath: target.value,
        sharedSize: shared.bytes.length,
        sharedMtimeMs: shared.mtimeMs,
        resolvable: true,
      },
    );
  }

  function finish(): ShareOutcome {
    const records: Record<string, SharedRecordEntry> = {};
    for (const [id, value] of state) {
      if (deps.nowMs - value.lastSeenMs > GC_AGE_MS) continue;
      records[id] = value;
    }
    return {
      moved,
      completed,
      folded,
      retired,
      tombstoned,
      heldBack,
      holds,
      // An inspection wrote nothing, so it learned nothing it may remember.
      // Persisting a base it did not create is precisely the "seeded from a
      // record we merely found" trap this whole design refuses.
      published: deps.inspectOnly
        ? null
        : {
            schemaVersion: deps.published.schemaVersion,
            deviceKey: deps.published.deviceKey,
            records,
          },
    };
  }

  return finish();
}

function entryFor(hash: string, size: number, nowMs: number): SharedRecordEntry {
  return { publishedHash: hash, publishedSize: size, lastSeenMs: nowMs };
}

function index(entries: ReadonlyArray<{ name: string; isFile: boolean }>): Set<string> {
  return new Set(entries.filter((entry) => entry.isFile).map((entry) => entry.name));
}

async function readIfPlainFile(
  deps: ShareDeps,
  target: SafeAbsolutePath,
): Promise<{ bytes: Uint8Array; mtimeMs: number } | null> {
  const stat = await deps.fs.lstat(target);
  // `nlink > 1` is refused too: a hard link means the same bytes are reachable
  // from somewhere this walk never checked.
  if (stat === null || !stat.isFile || stat.isSymbolicLink || stat.nlink > 1) return null;
  const bytes = await deps.fs.readFile(target).catch(() => null);
  return bytes === null ? null : { bytes, mtimeMs: stat.mtimeMs };
}

/**
 * Removes the device copy only if it is still the file that was read.
 *
 * The window between reading a record and removing it is exactly when the user
 * is typing — and it is the same activity that recreated the file in the first
 * place, so this is an ordinary occurrence rather than a theoretical race. A
 * blind remove there destroys a version that exists nowhere else.
 */
async function removeVerified(
  deps: ShareDeps,
  source: SafeAbsolutePath,
  expected: string,
): Promise<boolean> {
  if (deps.inspectOnly || !(await deps.mayWrite())) return false;
  const still = await readIfPlainFile(deps, source);
  if (still === null || deps.hashBytes(still.bytes) !== expected) return false;
  await deps.fs.removeFile(source);
  return true;
}
