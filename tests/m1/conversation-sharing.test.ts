/**
 * ADR-69 — sharing this device's conversations by *moving* the record.
 *
 * The copy-based version (ADR-67) made two live authorities for one
 * conversation and could resurrect a deleted one; an independent review took
 * it apart and it was right. Moving leaves one record, in the layer every
 * device reads and writes.
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

async function run(root: string, options: { deviceKey?: string | null } = {}) {
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
    expect(outcome).toEqual({ moved: 0, completed: 0, heldBack: [] });
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

  it("leaves a different record that is already shared, and says so", async () => {
    const root = await vault();
    await writeRecord(root, DEVICE, CONV, { id: CONV, providerId: "claude", title: "mine" });
    await fsp.writeFile(
      sharedRecord(root, CONV),
      `${JSON.stringify({ id: CONV, providerId: "claude", title: "someone else's" }, null, 2)}\n`,
    );

    const outcome = await run(root);
    expect(outcome.moved).toBe(0);
    expect(outcome.heldBack.join(" ")).toContain("already shared");
    expect(await read(sharedRecord(root, CONV))).toContain("someone else's");
    expect(await read(deviceRecord(root, DEVICE, CONV)), "the device copy was removed").toContain(
      "mine",
    );
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
