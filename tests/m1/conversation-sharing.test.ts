/**
 * ADR-69/71 — sharing this device's conversations by *moving* the record, and
 * keeping it moved.
 *
 * The copy-based version (ADR-67) made two live authorities for one
 * conversation and could resurrect a deleted one; an independent review took
 * it apart and it was right. Moving leaves one record, in the layer every
 * device reads and writes.
 *
 * ADR-71 is the second half: upstream fixes each conversation's write layer
 * once per Obsidian session, so after our move its map is stale and the next
 * save recreates the device copy. The rows below are therefore about
 * *reconciliation*, and the load-bearing distinction in every one of them is
 * whether the shared copy still holds the bytes THIS machine published.
 */
import { promises as fsp, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFsGateway } from "../../src/infra/node-fs-gateway";
import { sequentialIdGen } from "../../src/infra/clock";
import { shareOwnConversations } from "../../src/orchestration/conversation-sharing";

const DEVICE = `device-${"ab12cd34".repeat(8)}`;
const OTHER = `device-${"99887766".repeat(8)}`;
const CONV = "conv-1788190814061-hrrhmqcp6";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true });
});

async function vault(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "aiss-mirror-"));
  roots.push(root);
  // `realpathSync.native`, the same call production makes (main.ts), because
  // the two disagree in exactly the places CI runs. Skipping it passed on
  // Linux and failed on both others: macOS mkdtemp returns `/var/folders/…`,
  // a symlink to `/private/var/…`, and Windows returns a tmpdir under an 8.3
  // short-named profile folder, which the non-native realpath leaves alone.
  // Either way the containment walk refused every write and the feature
  // silently did nothing — the guard working, and the fixture lying.
  return realpathSync.native(root);
}

const store = (root: string) => path.join(root, ".claudian", "sessions");

async function writeRecord(root: string, device: string, id: string, body: object): Promise<void> {
  const dir = path.join(store(root), "devices", device);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `${id}.meta.json`), `${JSON.stringify(body, null, 2)}\n`);
}

const read = (target: string) => fsp.readFile(target, "utf8").catch(() => null);

interface RunOptions {
  readonly deviceKey?: string | null;
  /** Seeds the published base, as a successful earlier pass would have. */
  readonly published?: Record<string, { publishedHash: string; publishedSize: number }>;
  readonly forced?: ReadonlySet<string>;
  readonly mayWrite?: () => Promise<boolean>;
  /** Returns null to model a backup that could not be taken. */
  readonly backup?: () => Promise<string | null>;
}

const NOW = 1_788_500_000_000;
const sha = (text: string) => createHash("sha256").update(Buffer.from(text)).digest("hex");

/** The base a real pass would have recorded after publishing these bytes. */
async function baseFrom(root: string, id: string) {
  const bytes = await fsp.readFile(sharedRecord(root, id));
  return {
    [id]: { publishedHash: sha(bytes.toString()), publishedSize: bytes.length },
  };
}

async function run(root: string, options: RunOptions = {}) {
  const fs = createNodeFsGateway({
    ids: sequentialIdGen(),
    platform: process.platform,
    pid: process.pid,
    sleep: async () => undefined,
  });
  return shareOwnConversations({
    fs,
    guard: {
      fs,
      platform: process.platform,
      caseSensitive: true,
      joinPath: (...parts: string[]) => path.join(...parts),
      dirnameOf: (target: string) => path.dirname(target),
      splitPath: (target: string) => target.split(path.sep),
    },
    joinPath: (...parts: string[]) => path.join(...parts),
    hashBytes: (bytes) => createHash("sha256").update(bytes).digest("hex"),
    vaultRealPath: root,
    deviceKey: options.deviceKey === undefined ? DEVICE : options.deviceKey,
    nowMs: NOW,
    published: {
      schemaVersion: 1,
      deviceKey: DEVICE,
      records: Object.fromEntries(
        Object.entries(options.published ?? {}).map(([id, entry]) => [
          id,
          { ...entry, lastSeenMs: NOW },
        ]),
      ),
    },
    backup: options.backup ?? (async () => path.join(root, "backup-taken")),
    mayWrite: options.mayWrite ?? (async () => true),
    ...(options.forced ? { forced: options.forced } : {}),
  });
}

const deviceRecord = (root: string, device: string, id: string) =>
  path.join(store(root), "devices", device, `${id}.meta.json`);
const sharedRecord = (root: string, id: string) => path.join(store(root), `${id}.meta.json`);

describe("ADR-69: sharing by moving the record", () => {
  it("moves this device's record into the layer every device reads", async () => {
    const root = await vault();
    await writeRecord(root, DEVICE, CONV, { id: CONV, providerId: "claude", title: "one" });

    const outcome = await run(root);
    expect(outcome.moved).toBe(1);
    expect(await read(sharedRecord(root, CONV))).toContain('"title": "one"');
    // The point of moving rather than copying: there is one of it.
    expect(await read(deviceRecord(root, DEVICE, CONV)), "the device copy survived").toBeNull();
  });

  it("never touches another device's folder", async () => {
    const root = await vault();
    await writeRecord(root, OTHER, CONV, { id: CONV, providerId: "claude", title: "theirs" });

    const outcome = await run(root);
    expect(outcome.moved).toBe(0);
    expect(await read(sharedRecord(root, CONV))).toBeNull();
    expect(await read(deviceRecord(root, OTHER, CONV))).toContain("theirs");
  });

  it("does nothing when the device key cannot be read", async () => {
    const root = await vault();
    await writeRecord(root, DEVICE, CONV, { id: CONV, providerId: "claude", title: "one" });
    const outcome = await run(root, { deviceKey: null });
    // Still exhaustive on purpose: the strictness caught this outcome widening
    // under ADR-71 and is the reason each new counter got a deliberate look.
    expect(outcome).toEqual({
      moved: 0,
      completed: 0,
      folded: 0,
      retired: 0,
      tombstoned: 0,
      heldBack: [],
      holds: [],
      published: null,
    });
    expect(await read(deviceRecord(root, DEVICE, CONV)), "the device copy survived").toContain(
      "one",
    );
  });

  it("refuses a device key that is not one", async () => {
    const root = await vault();
    await writeRecord(root, DEVICE, CONV, { id: CONV, providerId: "claude", title: "one" });
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "aiss-outside-"));
    roots.push(outside);
    await fsp.writeFile(
      path.join(outside, "smuggled.meta.json"),
      `${JSON.stringify({ id: "smuggled" })}\n`,
    );
    const traversal = path
      .relative(path.join(store(root), "devices"), outside)
      .split(path.sep)
      .join("/");

    for (const bogus of [traversal, "device-nothex", "", "..", "devices"]) {
      const outcome = await run(root, { deviceKey: bogus });
      expect(outcome.moved, `accepted ${JSON.stringify(bogus)}`).toBe(0);
    }
    expect(await read(path.join(store(root), "smuggled.meta.json"))).toBeNull();
  });

  it("refuses a device folder that is a symlink", async () => {
    // The review reproduced this against the copy-based version: a device
    // directory whose *name* is valid but which points outside the vault reads
    // records from there and publishes them in.
    const root = await vault();
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "aiss-outside-"));
    roots.push(outside);
    await fsp.writeFile(
      path.join(outside, `${CONV}.meta.json`),
      `${JSON.stringify({ id: CONV, providerId: "claude", title: "not from this vault" })}\n`,
    );
    await fsp.mkdir(path.join(store(root), "devices"), { recursive: true });
    await fsp.symlink(outside, path.join(store(root), "devices", DEVICE));

    const outcome = await run(root);
    expect(outcome.moved).toBe(0);
    expect(await read(sharedRecord(root, CONV))).toBeNull();
  });

  it("leaves a different record that is already shared, with no base, and says so", async () => {
    const root = await vault();
    await writeRecord(root, DEVICE, CONV, { id: CONV, providerId: "claude", title: "mine" });
    await fsp.writeFile(
      sharedRecord(root, CONV),
      `${JSON.stringify({ id: CONV, providerId: "claude", title: "someone else's" }, null, 2)}\n`,
    );

    const outcome = await run(root);
    expect(outcome.moved + outcome.folded).toBe(0);
    expect(outcome.heldBack.join(" ")).toContain("already shared");
    expect(await read(sharedRecord(root, CONV))).toContain("someone else's");
    expect(
      await read(deviceRecord(root, DEVICE, CONV)),
      "the device copy must survive a hold",
    ).toContain("mine");
    // And it is offered to a person rather than decided here.
    expect(outcome.holds).toHaveLength(1);
    expect(outcome.holds[0]?.resolvable).toBe(true);
  });

  it("folds this device's newer record forward when the shared copy is still ours", async () => {
    // The reported bug: upstream recreates the device copy after our move, so
    // every later pass saw "different" and froze the shared copy forever.
    const root = await vault();
    await fsp.mkdir(store(root), { recursive: true });
    await fsp.writeFile(
      sharedRecord(root, CONV),
      `${JSON.stringify({ id: CONV, providerId: "claude", title: "as published" }, null, 2)}\n`,
    );
    const published = await baseFrom(root, CONV);
    await writeRecord(root, DEVICE, CONV, { id: CONV, providerId: "claude", title: "three turns later" });

    const outcome = await run(root, { published });
    expect(outcome.folded).toBe(1);
    expect(await read(sharedRecord(root, CONV))).toContain("three turns later");
    expect(await read(deviceRecord(root, DEVICE, CONV)), "the device copy stayed").toBeNull();
    // The base advances to what we just wrote, so the next fold is authorised
    // by bytes we put there rather than by bytes we merely found.
    const bytes = await fsp.readFile(sharedRecord(root, CONV));
    expect(outcome.published?.records[CONV]?.publishedHash).toBe(sha(bytes.toString()));
  });

  it("never folds over a peer's edit — the base must match, not merely exist", async () => {
    const root = await vault();
    await fsp.mkdir(store(root), { recursive: true });
    await fsp.writeFile(
      sharedRecord(root, CONV),
      `${JSON.stringify({ id: CONV, providerId: "claude", title: "as published" }, null, 2)}\n`,
    );
    const published = await baseFrom(root, CONV);
    // A peer renames it after we published.
    await fsp.writeFile(
      sharedRecord(root, CONV),
      `${JSON.stringify({ id: CONV, providerId: "claude", title: "renamed on the laptop" }, null, 2)}\n`,
    );
    await writeRecord(root, DEVICE, CONV, { id: CONV, providerId: "claude", title: "typed here" });

    const outcome = await run(root, { published });
    expect(outcome.folded).toBe(0);
    expect(await read(sharedRecord(root, CONV)), "the peer's rename survived").toContain(
      "renamed on the laptop",
    );
    expect(outcome.heldBack.join(" ")).toContain("both");
  });

  it("withdraws this device's copy once a peer maintains the shared record", async () => {
    // The device copy is exactly what we published, so it carries nothing the
    // shared record lacks — while its existence is what makes upstream ignore
    // the shared one. Removing it is what ends the loop.
    const root = await vault();
    await writeRecord(root, DEVICE, CONV, { id: CONV, providerId: "claude", title: "as published" });
    const deviceBytes = await fsp.readFile(deviceRecord(root, DEVICE, CONV));
    await fsp.writeFile(
      sharedRecord(root, CONV),
      `${JSON.stringify({ id: CONV, providerId: "claude", title: "the peer moved on" }, null, 2)}\n`,
    );

    const outcome = await run(root, {
      published: { [CONV]: { publishedHash: sha(deviceBytes.toString()), publishedSize: deviceBytes.length } },
    });
    expect(outcome.retired).toBe(1);
    expect(await read(deviceRecord(root, DEVICE, CONV))).toBeNull();
    expect(await read(sharedRecord(root, CONV)), "the peer's record is untouched").toContain(
      "the peer moved on",
    );
    expect(outcome.published?.records[CONV], "the base is dropped with the copy").toBeUndefined();
  });

  it("publishes over a fork only when a person says so, one conversation at a time", async () => {
    const root = await vault();
    await writeRecord(root, DEVICE, CONV, { id: CONV, providerId: "claude", title: "mine" });
    await fsp.writeFile(
      sharedRecord(root, CONV),
      `${JSON.stringify({ id: CONV, providerId: "claude", title: "theirs" }, null, 2)}\n`,
    );

    expect((await run(root)).folded, "not without being asked").toBe(0);
    const outcome = await run(root, { forced: new Set([CONV]) });
    expect(outcome.folded).toBe(1);
    expect(await read(sharedRecord(root, CONV))).toContain("mine");
  });

  it("cancels the fold when the version it would destroy cannot be backed up", async () => {
    const root = await vault();
    await fsp.mkdir(store(root), { recursive: true });
    await fsp.writeFile(
      sharedRecord(root, CONV),
      `${JSON.stringify({ id: CONV, providerId: "claude", title: "as published" }, null, 2)}\n`,
    );
    const published = await baseFrom(root, CONV);
    await writeRecord(root, DEVICE, CONV, { id: CONV, providerId: "claude", title: "newer" });

    const outcome = await run(root, { published, backup: async () => null });
    expect(outcome.folded, "I1 before the write, or no write").toBe(0);
    expect(await read(sharedRecord(root, CONV))).toContain("as published");
    expect(await read(deviceRecord(root, DEVICE, CONV))).toContain("newer");
  });

  it("writes nothing once the pass may no longer write", async () => {
    const root = await vault();
    await writeRecord(root, DEVICE, CONV, { id: CONV, providerId: "claude", title: "mine" });

    const outcome = await run(root, { mayWrite: async () => false });
    expect(outcome.moved).toBe(0);
    expect(await read(sharedRecord(root, CONV))).toBeNull();
    expect(await read(deviceRecord(root, DEVICE, CONV))).toContain("mine");
  });

  it("does not remove the device copy if it changed while being published", async () => {
    // The window between reading a record and removing it is exactly when the
    // user is typing — and typing is what recreated the file in the first
    // place, so this is ordinary, not theoretical. A blind remove there
    // destroys a version that exists nowhere else.
    const root = await vault();
    await writeRecord(root, DEVICE, CONV, { id: CONV, providerId: "claude", title: "at read time" });

    const real = createNodeFsGateway({
      ids: sequentialIdGen(),
      platform: process.platform,
      pid: process.pid,
      sleep: async () => undefined,
    });
    // The user's next turn lands between the shared write and the removal.
    const racing = {
      ...real,
      writeFileNoReplace: async (target: never, bytes: never) => {
        const outcome = await real.writeFileNoReplace(target, bytes);
        await fsp.writeFile(
          deviceRecord(root, DEVICE, CONV),
          `${JSON.stringify({ id: CONV, providerId: "claude", title: "typed a moment later" }, null, 2)}\n`,
        );
        return outcome;
      },
    } as typeof real;

    const outcome = await shareOwnConversations({
      fs: racing,
      guard: {
        fs: racing,
        platform: process.platform,
        caseSensitive: true,
        joinPath: (...parts: string[]) => path.join(...parts),
        dirnameOf: (target: string) => path.dirname(target),
        splitPath: (target: string) => target.split(path.sep),
      },
      joinPath: (...parts: string[]) => path.join(...parts),
      hashBytes: (bytes) => createHash("sha256").update(bytes).digest("hex"),
      vaultRealPath: root,
      deviceKey: DEVICE,
      nowMs: NOW,
      published: { schemaVersion: 1, deviceKey: DEVICE, records: {} },
      backup: async () => path.join(root, "backup-taken"),
      mayWrite: async () => true,
    });

    expect(outcome.moved, "the move did not complete").toBe(0);
    expect(
      await read(deviceRecord(root, DEVICE, CONV)),
      "the turn typed during the write must survive",
    ).toContain("typed a moment later");
  });

  it("carries a delete into the shared layer instead of letting it resurrect", async () => {
    // Upstream's stale target puts the tombstone in the device layer and
    // removes the device metadata, leaving the shared record to be adopted on
    // the next scan — the conversation comes back.
    const root = await vault();
    await fsp.mkdir(store(root), { recursive: true });
    await fsp.writeFile(
      sharedRecord(root, CONV),
      `${JSON.stringify({ id: CONV, providerId: "claude", title: "as published" }, null, 2)}\n`,
    );
    const published = await baseFrom(root, CONV);
    const dir = path.join(store(root), "devices", DEVICE);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `${CONV}.deleted.json`), `{"deletedAt":1}\n`);

    const outcome = await run(root, { published });
    expect(outcome.tombstoned).toBe(1);
    expect(await read(path.join(store(root), `${CONV}.deleted.json`))).toContain("deletedAt");
    // The record itself is left underneath the marker: this destroys nothing.
    expect(await read(sharedRecord(root, CONV))).toContain("as published");
  });

  it("does not carry a delete across when the shared record is not the one we published", async () => {
    const root = await vault();
    await fsp.mkdir(store(root), { recursive: true });
    await fsp.writeFile(
      sharedRecord(root, CONV),
      `${JSON.stringify({ id: CONV, providerId: "claude", title: "a peer's record" }, null, 2)}\n`,
    );
    const dir = path.join(store(root), "devices", DEVICE);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `${CONV}.deleted.json`), `{"deletedAt":1}\n`);

    const outcome = await run(root);
    expect(outcome.tombstoned, "deleting a peer's record is not ours to do").toBe(0);
    expect(await read(path.join(store(root), `${CONV}.deleted.json`))).toBeNull();
    expect(outcome.heldBack.join(" ")).toContain("come back");
  });

  it("finishes a move that was interrupted after the write", async () => {
    // Shared first, device removed second — so a crash in between leaves both,
    // byte-identical. That is a move to finish, not a conflict.
    const root = await vault();
    await writeRecord(root, DEVICE, CONV, { id: CONV, providerId: "claude", title: "one" });
    const bytes = await fsp.readFile(deviceRecord(root, DEVICE, CONV));
    await fsp.writeFile(sharedRecord(root, CONV), bytes);

    const outcome = await run(root);
    expect(outcome.completed).toBe(1);
    expect(await read(deviceRecord(root, DEVICE, CONV))).toBeNull();
    expect(await read(sharedRecord(root, CONV))).toContain('"title": "one"');
  });

  it("does not re-create a conversation deleted in the shared layer", async () => {
    // The resurrection the copy-based version was guilty of, from the other
    // direction: a tombstone in the shared layer is a veto on publishing.
    const root = await vault();
    await writeRecord(root, DEVICE, CONV, { id: CONV, providerId: "claude", title: "one" });
    await fsp.writeFile(
      path.join(store(root), `${CONV}.deleted.json`),
      `${JSON.stringify({ schemaVersion: 1, conversationId: CONV, deletedAt: 0 })}\n`,
    );

    const outcome = await run(root);
    expect(outcome.moved).toBe(0);
    expect(outcome.heldBack.join(" ")).toContain("deleted");
    expect(await read(sharedRecord(root, CONV))).toBeNull();
  });

  it("leaves a fenced conversation alone", async () => {
    // `.assigned.json` is a claim another device made, and upstream checks it
    // before it resolves any metadata path. Moving the record would be
    // meddling in a claim this machine did not make.
    const root = await vault();
    await writeRecord(root, DEVICE, CONV, { id: CONV, providerId: "claude", title: "one" });
    await fsp.writeFile(
      path.join(store(root), `${CONV}.assigned.json`),
      `${JSON.stringify({ schemaVersion: 1, conversationId: CONV, deviceKey: OTHER })}\n`,
    );

    const outcome = await run(root);
    expect(outcome.moved).toBe(0);
    expect(outcome.heldBack.join(" ")).toContain("assigned");
    expect(await read(deviceRecord(root, DEVICE, CONV))).toContain("one");
  });

  it("never writes an assignment fence of its own", async () => {
    const root = await vault();
    await writeRecord(root, DEVICE, CONV, { id: CONV, providerId: "claude", title: "one" });
    await run(root);
    const names = await fsp.readdir(store(root));
    expect(names.filter((n) => n.endsWith(".assigned.json"))).toEqual([]);
  });
});
