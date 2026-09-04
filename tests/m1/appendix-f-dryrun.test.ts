/**
 * Does appendix F's own sequence reach the states it asserts?
 *
 * A kit that cannot reach its own gate wastes a real machine's time and comes
 * back as "could not reproduce" — which is what nearly happened to E1. So the
 * six steps are replayed here against the real reconciliation before anyone is
 * asked to type them.
 */
import { promises as fsp, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createNodeFsGateway } from "../../src/infra/node-fs-gateway";
import { sequentialIdGen } from "../../src/infra/clock";
import {
  type ShareDeps,
  shareOwnConversations,
} from "../../src/orchestration/conversation-sharing";
import type { SharedRecordsFile } from "../../src/infra/home-store";

const DEVICE = `device-${"ab12cd34".repeat(8)}`;
const X = "conv-1788500000000-xxxxxxxxx";
const Y = "conv-1788500000001-yyyyyyyyy";
const sha = (t: string) => createHash("sha256").update(Buffer.from(t)).digest("hex");

const fs = createNodeFsGateway({
  ids: sequentialIdGen(),
  platform: process.platform,
  pid: process.pid,
  sleep: async () => undefined,
});
const guard = {
  fs,
  platform: process.platform,
  caseSensitive: true,
  joinPath: (...p: string[]) => path.join(...p),
  dirnameOf: (t: string) => path.dirname(t),
  splitPath: (t: string) => t.split(path.sep),
};

describe("appendix F reaches its own gates", () => {
  it("walks the six steps and lands on F1, F2 and F3", async () => {
    const root = realpathSync.native(await fsp.mkdtemp(path.join(os.tmpdir(), "aiss-F-")));
    const store = path.join(root, ".claudian", "sessions");
    const dev = path.join(store, "devices", DEVICE);
    await fsp.mkdir(dev, { recursive: true });
    const devFile = (id: string) => path.join(dev, `${id}.meta.json`);
    const flatFile = (id: string) => path.join(store, `${id}.meta.json`);
    const backups: string[] = [];
    let published: SharedRecordsFile = { schemaVersion: 1, deviceKey: DEVICE, records: {} };

    const run = async (over: Partial<ShareDeps> = {}) => {
      const base: ShareDeps = {
        fs,
        guard,
        joinPath: (...p: string[]) => path.join(...p),
        hashBytes: (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex"),
        vaultRealPath: root,
        deviceKey: DEVICE,
        nowMs: 1_788_500_000_000,
        published,
        backup: async (input) => {
          const kept = path.join(root, `bak-${backups.length}`);
          await fsp.copyFile(input.sourcePath, kept);
          backups.push(kept);
          return kept;
        },
        mayWrite: async () => true,
      };
      const outcome = await shareOwnConversations({ ...base, ...over });
      if (outcome.published) published = outcome.published;
      return outcome;
    };
    const read = (t: string) => fsp.readFile(t, "utf8").catch(() => null);

    // ① switch ON: X is created and moves, recording a base.
    await fsp.writeFile(devFile(X), `${JSON.stringify({ id: X, providerId: "claude" }, null, 2)}\n`);
    expect((await run()).moved).toBe(1);
    expect(await read(devFile(X))).toBeNull();
    expect(published.records[X]?.publishedHash).toBe(sha((await read(flatFile(X)))!));

    // ② one more turn recreates the device copy; then flat gets the marker.
    await fsp.writeFile(devFile(X), `${JSON.stringify({ id: X, providerId: "claude", usage: 1 }, null, 2)}\n`);
    const forked = JSON.parse((await read(flatFile(X)))!);
    forked.aissAcceptanceMarker = "F";
    await fsp.writeFile(flatFile(X), `${JSON.stringify(forked, null, 2)}\n`);

    // ③ switch OFF, and Y is created as the bystander.
    await fsp.writeFile(devFile(Y), `${JSON.stringify({ id: Y, providerId: "claude" }, null, 2)}\n`);

    const flatBefore = (await fsp.readdir(store)).filter((n) => n.endsWith(".meta.json")).length;
    const ledgerBefore = JSON.stringify(published);

    // ④ F1 — opening the screen must change nothing.
    const looked = await run({ inspectOnly: true });
    expect(looked.holds.map((h) => h.conversationId), "the screen still lists X").toEqual([X]);
    expect(await read(devFile(Y)), "Y must not move").not.toBeNull();
    expect(await read(flatFile(Y)), "Y must not appear in flat").toBeNull();
    expect((await fsp.readdir(store)).filter((n) => n.endsWith(".meta.json")).length).toBe(flatBefore);
    expect((await read(flatFile(X)))!).toContain("aissAcceptanceMarker");
    expect(JSON.stringify(published), "the ledger is untouched").toBe(ledgerBefore);
    expect(backups, "an inspection takes no backups").toHaveLength(0);

    // ⑤ F2 + F3 — clicking X publishes X and nothing else.
    const one = new Set([X]);
    const clicked = await run({ forced: one, only: one });
    expect(clicked.folded).toBe(1);
    expect((await read(flatFile(X)))!, "X was replaced by this device's copy").not.toContain(
      "aissAcceptanceMarker",
    );
    expect(await read(flatFile(Y)), "F2: the bystander stayed put").toBeNull();
    expect(await read(devFile(Y))).not.toBeNull();
    expect(backups, "F3: the replaced version was kept").toHaveLength(1);
    expect(await fsp.readFile(backups[0]!, "utf8")).toContain("aissAcceptanceMarker");

    await fsp.rm(root, { recursive: true, force: true });
  });
});
