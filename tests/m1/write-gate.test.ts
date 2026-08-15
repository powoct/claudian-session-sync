/**
 * §9.4 + §9.6 — a click writes under the same two gates a pass does.
 *
 * Resolution and restore write into the same files a pass writes, and until
 * this they took both answers on trust: no lock at all, so a scheduled pass
 * (or a second Obsidian window, or the other machine) could be applying to the
 * same file at the same moment; and a *cached* readiness, recomputed only by
 * passes, so a sync folder unmounted since the last one still read READY.
 *
 * The second is the one that writes to the wrong place: NR-9 (gone) and NR-2
 * (recreated with a new rootId) are exactly the states the marker file exists
 * to make detectable, and a click was skipping the check that reads it.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeHarness } from "../helpers/runtime-harness";

const SID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

const machines: RuntimeHarness[] = [];
afterEach(async () => {
  while (machines.length) await machines.pop()?.dispose();
});

async function withBackup() {
  const a = await RuntimeHarness.create();
  machines.push(a);
  await a.appendSession(SID, 4);
  await a.configure();
  await a.settle();

  const b = await RuntimeHarness.createPeer(a);
  machines.push(b);
  await b.settle();
  await b.appendSession(SID, 3);
  await b.settle();
  await a.settle(); // a pulls, backing up what it held
  // B is the machine that pushed over an existing replica version, so B is
  // where the remote-side backups are; A only ever pulled.
  return { a, b };
}

describe("the lock", () => {
  it("refuses a restore while a pass holds it", async () => {
    const { a } = await withBackup();
    const entry = (await a.runtime.backups()).find((candidate) => !candidate.remote);

    // Someone else's claim on this workspace — the shape another window or
    // the other machine leaves behind. The pass path already refuses it; the
    // click path did not even look.
    const lockPath = path.join(
      a.homedir,
      ".claudian-session-sync",
      "locks",
      `${(await a.runtime.refresh()).workspaceId}.lock`,
    );
    await fsp.mkdir(path.dirname(lockPath), { recursive: true });
    await fsp.writeFile(
      lockPath,
      JSON.stringify({
        schemaVersion: 1,
        machineId: "cccccccc-3333-4333-8333-cccccccccccc",
        pid: 999_999,
        epoch: 1,
        acquiredAtMs: Date.now(),
        heartbeatMs: Date.now(),
      }),
    );

    const outcome = await a.runtime.restore(
      entry?.path as string,
      entry?.hashPrefix as string,
      entry?.liveHashPrefix ?? null,
    );

    expect(outcome).toEqual({ ok: false, reason: "sync-in-progress" });
  }, 30_000);

  it("releases it again, so the next click is not locked out by the last", async () => {
    const { a } = await withBackup();
    const entry = (await a.runtime.backups()).find((candidate) => !candidate.remote);

    const first = await a.runtime.restore(
      entry?.path as string,
      entry?.hashPrefix as string,
      entry?.liveHashPrefix ?? null,
    );
    expect(first.ok).toBe(true);

    // A lock left held would make every later click fail with the reason that
    // means "someone is writing" while nobody is.
    const second = await a.runtime.backups();
    const next = second.find((candidate) => !candidate.remote);
    const outcome = await a.runtime.restore(
      next?.path as string,
      next?.hashPrefix as string,
      next?.liveHashPrefix ?? null,
    );
    expect(outcome.ok || outcome.reason !== "sync-in-progress").toBe(true);
  }, 30_000);
});

describe("readiness, re-observed at the moment of the click", () => {
  it("refuses to write into a sync folder that is no longer there", async () => {
    // NR-9. The cached status still says READY — only a pass recomputes it —
    // so without a fresh probe this writes a tree into a path that is not
    // mounted, and the other machine never sees any of it.
    const { b } = await withBackup();
    const remoteEntry = (await b.runtime.backups()).find((candidate) => candidate.remote);
    expect(remoteEntry, "the fixture must have produced a remote-side backup").toBeTruthy();
    expect((await b.runtime.refresh()).readiness).toBe("READY");

    await fsp.rm(b.syncDir, { recursive: true, force: true });

    const outcome = await b.runtime.restore(
      remoteEntry?.path as string,
      remoteEntry?.hashPrefix as string,
      remoteEntry?.liveHashPrefix ?? null,
    );

    expect(outcome).toEqual({ ok: false, reason: "remote-not-ready" });
    expect(await fsp.readdir(b.syncDir).catch(() => null)).toBeNull();
  }, 30_000);

  it("refuses when the folder was recreated with a different identity", async () => {
    // NR-2: the sync tool deleted and recreated the directory, so the marker
    // file names a root this machine has never synced with. Writing into it
    // would silently start a second, parallel history.
    const { b } = await withBackup();
    const remoteEntry = (await b.runtime.backups()).find((candidate) => candidate.remote);
    expect(remoteEntry).toBeTruthy();
    const root = path.join(b.syncDir, ".aiss", "root.json");
    const parsed = JSON.parse(await fsp.readFile(root, "utf8")) as Record<string, unknown>;
    await fsp.writeFile(root, JSON.stringify({ ...parsed, rootId: "99999999-9999-4999-8999-999999999999" }));

    const outcome = await b.runtime.restore(
      remoteEntry?.path as string,
      remoteEntry?.hashPrefix as string,
      remoteEntry?.liveHashPrefix ?? null,
    );

    expect(outcome).toEqual({ ok: false, reason: "remote-not-ready" });
  }, 30_000);

  it("still allows a local-side restore when the sync folder is unusable", async () => {
    // The gate is about writing *there*. A version of this machine's own file
    // has nothing to do with the sync folder's state, and refusing it would
    // make an unrelated outage look like data being held hostage.
    const { a } = await withBackup();
    const local = (await a.runtime.backups()).find((candidate) => !candidate.remote);
    await fsp.rm(path.join(a.syncDir, ".aiss"), { recursive: true, force: true });

    const outcome = await a.runtime.restore(
      local?.path as string,
      local?.hashPrefix as string,
      local?.liveHashPrefix ?? null,
    );

    expect(outcome.ok).toBe(true);
  }, 30_000);
});
