/**
 * ADR-67 — publishing this device's conversations where the others can see them.
 *
 * Claudian 2.2.5 files a new conversation under the device that made it, and a
 * device reads only its own folder, so the record cannot travel however the
 * vault is synced. The flat layer is the one place every device looks, and
 * this is a copy into it — with the three rules that keep it from becoming a
 * second source of truth.
 */
import { promises as fsp } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFsGateway } from "../../src/infra/node-fs-gateway";
import { sequentialIdGen } from "../../src/infra/clock";
import { mirrorOwnConversations } from "../../src/orchestration/conversation-mirror";

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
  return root;
}

const store = (root: string) => path.join(root, ".claudian", "sessions");

async function writeRecord(root: string, device: string, id: string, body: object): Promise<void> {
  const dir = path.join(store(root), "devices", device);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `${id}.meta.json`), `${JSON.stringify(body, null, 2)}\n`);
}

const read = (target: string) => fsp.readFile(target, "utf8").catch(() => null);

async function run(root: string, options: { deviceKey?: string | null; written?: Record<string, string> } = {}) {
  let saved: Record<string, string> = { ...(options.written ?? {}) };
  const fs = createNodeFsGateway({
    ids: sequentialIdGen(),
    platform: process.platform,
    pid: process.pid,
    sleep: async () => undefined,
  });
  const outcome = await mirrorOwnConversations({
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
    written: options.written ?? {},
    record: async (next) => {
      saved = { ...next };
    },
  });
  return { outcome, saved };
}

describe("ADR-67: publishing this device's conversations", () => {
  it("copies this device's record into the layer every device reads", async () => {
    const root = await vault();
    await writeRecord(root, DEVICE, CONV, { id: CONV, providerId: "claude", title: "one" });

    const { outcome } = await run(root);
    expect(outcome.created).toBe(1);
    expect(await read(path.join(store(root), `${CONV}.meta.json`))).toContain('"title": "one"');
  });

  it("never publishes another device's record", async () => {
    // A machine publishes what it owns. Reaching into a folder whose key is
    // not ours would be claiming a conversation on behalf of the machine that
    // made it, and there is no way to ask that machine whether it agrees.
    const root = await vault();
    await writeRecord(root, OTHER, CONV, { id: CONV, providerId: "claude", title: "theirs" });

    const { outcome } = await run(root);
    expect(outcome.created).toBe(0);
    expect(await read(path.join(store(root), `${CONV}.meta.json`))).toBeNull();
  });

  it("does nothing at all when the device key cannot be read", async () => {
    // Claudian may not be installed, or may never have run in this vault.
    // Nothing is written, which is the fail-closed direction.
    const root = await vault();
    await writeRecord(root, DEVICE, CONV, { id: CONV, providerId: "claude", title: "one" });

    const { outcome } = await run(root, { deviceKey: null });
    expect(outcome).toEqual({ created: 0, refreshed: 0, removed: 0, skippedForeign: 0 });
  });

  it("refuses a device key that is not one", async () => {
    // The key becomes a path segment. Upstream's own guard is
    // `/^device-[a-f0-9]{64}$/` (InstallationKey.ts) and this holds the same
    // line: a value read out of localStorage is a value somebody can edit.
    const root = await vault();
    await writeRecord(root, DEVICE, CONV, { id: CONV, providerId: "claude", title: "one" });

    // Aimed at something real: a directory outside the vault holding a file
    // that looks like a record. Without the check the key is joined straight
    // onto `devices/`, so a traversal reads from there and publishes it into
    // this vault's store.
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "aiss-outside-"));
    roots.push(outside);
    await fsp.writeFile(
      path.join(outside, "smuggled.meta.json"),
      `${JSON.stringify({ id: "smuggled", providerId: "claude", title: "not from this vault" })}\n`,
    );
    const traversal = path.relative(path.join(store(root), "devices"), outside).split(path.sep).join("/");

    for (const bogus of [traversal, "device-nothex", "", "..", "devices"]) {
      const { outcome } = await run(root, { deviceKey: bogus });
      expect(outcome, `accepted ${JSON.stringify(bogus)}`).toEqual({
        created: 0,
        refreshed: 0,
        removed: 0,
        skippedForeign: 0,
      });
    }
    expect(await read(path.join(store(root), "smuggled.meta.json"))).toBeNull();
    expect(await read(path.join(store(root), `${CONV}.meta.json`))).toBeNull();
  });

  it("leaves a flat record it did not write completely alone", async () => {
    // A genuine pre-2.2.5 record. Overwriting it would replace a conversation
    // Claudian owns with a copy of a different one that happens to share an id.
    const root = await vault();
    await writeRecord(root, DEVICE, CONV, { id: CONV, providerId: "claude", title: "mine" });
    await fsp.writeFile(
      path.join(store(root), `${CONV}.meta.json`),
      `${JSON.stringify({ id: CONV, providerId: "claude", title: "legacy" }, null, 2)}\n`,
    );

    const { outcome } = await run(root);
    expect(outcome.skippedForeign).toBe(1);
    expect(await read(path.join(store(root), `${CONV}.meta.json`))).toContain('"title": "legacy"');
  });

  it("refreshes a mirror it still owns", async () => {
    const root = await vault();
    await writeRecord(root, DEVICE, CONV, { id: CONV, providerId: "claude", title: "before" });
    const first = await run(root);

    await writeRecord(root, DEVICE, CONV, { id: CONV, providerId: "claude", title: "after" });
    const { outcome } = await run(root, { written: first.saved });

    expect(outcome.refreshed).toBe(1);
    expect(await read(path.join(store(root), `${CONV}.meta.json`))).toContain('"title": "after"');
  });

  it("stops refreshing once the other machine has edited the copy", async () => {
    // The whole reason the hash is kept. Without it the choice is between
    // never fixing a stale title and silently overwriting somebody's rename,
    // and this project does not do the second (OQ-14).
    const root = await vault();
    await writeRecord(root, DEVICE, CONV, { id: CONV, providerId: "claude", title: "before" });
    const first = await run(root);

    await fsp.writeFile(
      path.join(store(root), `${CONV}.meta.json`),
      `${JSON.stringify({ id: CONV, providerId: "claude", title: "renamed over there" }, null, 2)}\n`,
    );
    await writeRecord(root, DEVICE, CONV, { id: CONV, providerId: "claude", title: "after" });

    const { outcome } = await run(root, { written: first.saved });
    expect(outcome.refreshed).toBe(0);
    expect(outcome.skippedForeign).toBe(1);
    expect(await read(path.join(store(root), `${CONV}.meta.json`))).toContain("renamed over there");
  });

  it("takes its own mirror down when the conversation is deleted here", async () => {
    const root = await vault();
    await writeRecord(root, DEVICE, CONV, { id: CONV, providerId: "claude", title: "one" });
    const first = await run(root);

    await fsp.writeFile(
      path.join(store(root), "devices", DEVICE, `${CONV}.deleted.json`),
      `${JSON.stringify({ schemaVersion: 1, conversationId: CONV, deletedAt: 0 })}\n`,
    );
    const { outcome } = await run(root, { written: first.saved });

    expect(outcome.removed).toBe(1);
    expect(await read(path.join(store(root), `${CONV}.meta.json`))).toBeNull();
  });

  it("leaves an edited copy in place even when deleted here", async () => {
    // Removing bytes the other machine wrote would be deletion propagation by
    // the back door, which ADR-10 keeps out of this plugin.
    const root = await vault();
    await writeRecord(root, DEVICE, CONV, { id: CONV, providerId: "claude", title: "one" });
    const first = await run(root);
    await fsp.writeFile(
      path.join(store(root), `${CONV}.meta.json`),
      `${JSON.stringify({ id: CONV, providerId: "claude", title: "theirs now" }, null, 2)}\n`,
    );
    await fsp.writeFile(
      path.join(store(root), "devices", DEVICE, `${CONV}.deleted.json`),
      `${JSON.stringify({ schemaVersion: 1, conversationId: CONV, deletedAt: 0 })}\n`,
    );

    const { outcome } = await run(root, { written: first.saved });
    expect(outcome.removed).toBe(0);
    expect(await read(path.join(store(root), `${CONV}.meta.json`))).toContain("theirs now");
  });

  it("never writes an assignment fence", async () => {
    // `.assigned.json` hides a conversation on every machine whose key does
    // not match, and the check runs before any metadata path is looked at —
    // so publishing one would blackhole exactly what this feature surfaces.
    const root = await vault();
    await writeRecord(root, DEVICE, CONV, { id: CONV, providerId: "claude", title: "one" });
    await run(root);

    const names = await fsp.readdir(store(root));
    expect(names.filter((n) => n.endsWith(".assigned.json"))).toEqual([]);
  });
});
