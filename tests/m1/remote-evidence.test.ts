/**
 * ADR-84: where the E1 evidence for each side comes from, and what can never
 * count as evidence.
 *
 * The sync folder's copy is answered first from this machine's own ledger —
 * the shared manifest's signature carries whichever machine read it last, and
 * two machines syncing in turn made each other miss on every pass (round 12,
 * B1). The rules a record must meet are the ones the local side always had: a
 * verified signature and a hash, recorded together from one read.
 *
 * Unit tests over `createPassState`, then the two engine paths the review of
 * ADR-84 found writing a record that did not describe the bytes in the sync
 * folder: a NOOP treated as a write, and a read that failed.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyManifest, type ManifestEntry } from "../../src/domain/manifest";
import { emptyObservations, type LedgerEntryRecord } from "../../src/infra/state-store";
import { createPassState } from "../../src/orchestration/state-adapters";
import type { MachineId } from "../../src/domain/types";
import { World, WORKSPACE_ID } from "../helpers/world";

const REL = "claude-code/3f2504e0-4f89-41d3-9a0c-0305e82c3301.jsonl";
const SIG = { size: 70, mtimeMs: 1, ctimeMs: 2, ino: 3, tailHash: "sha256:tail" };
const OTHER_SIG = { ...SIG, ino: 99, ctimeMs: 98 };

function record(over: Partial<LedgerEntryRecord> = {}): LedgerEntryRecord {
  return {
    sig: SIG,
    firstSeenMs: 0,
    lastSeenMs: 0,
    lastFullVerifyMs: 0,
    verifiedSig: SIG,
    contentHash: "sha256:mine",
    verifiedLineCount: 2,
    remoteHadNonZeroSize: true,
    lastAction: "NOOP",
    lastResult: "APPLIED",
    abortStreak: 0,
    skippedForBudgetPasses: 0,
    truncatedTailPasses: 0,
    lastConvergedHash: null,
    lastConvergedSize: null,
    ...over,
  };
}

function manifestEntry(e0 = OTHER_SIG): ManifestEntry {
  return {
    provider: "claude-code",
    workspaceId: WORKSPACE_ID,
    logicalId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    mode: "append-jsonl",
    size: e0.size,
    lineCount: 2,
    contentHash: "sha256:manifest",
    e0,
    lastWriter: "peer",
    updatedAt: "2026-10-15T00:00:00.000Z",
    generation: 1,
  };
}

function state(sides: { local?: LedgerEntryRecord; remote?: LedgerEntryRecord; manifest?: ManifestEntry }) {
  const observations = {
    ...emptyObservations("machine" as MachineId, "fingerprint"),
    local: sides.local ? { [REL]: sides.local } : {},
    remote: sides.remote ? { [REL]: sides.remote } : {},
  };
  const manifest = emptyManifest("2026-10-15T00:00:00.000Z");
  return createPassState({
    observations,
    manifest: sides.manifest ? { ...manifest, entries: { [`${WORKSPACE_ID}/${REL}`]: sides.manifest } } : manifest,
    manifestWritable: true,
    workspaceId: WORKSPACE_ID,
    machineId: "machine",
    nowMs: 10,
    nowIso: "2026-10-15T00:00:10.000Z",
    scrub: {
      maxAgeMs: 86_400_000,
      firstPassAfterStartup: false,
      msSinceLastStartupScrub: 0,
      manifestUnusable: false,
      justBecameReady: false,
      manuallyRequested: false,
      sampled: new Set(),
    },
  });
}

describe("where the evidence for each side comes from", () => {
  it("answers the sync folder's copy from this machine's own record before the shared manifest", () => {
    const facts = state({ remote: record(), manifest: manifestEntry() }).evidence.lookup(REL, "remote");
    expect(facts).toEqual({ e0: SIG, contentHash: "sha256:mine", lineCount: 2 });
  });

  it("falls back to the manifest for the sync folder's copy when this machine has no record", () => {
    expect(state({ manifest: manifestEntry() }).evidence.lookup(REL, "remote")?.contentHash).toBe("sha256:manifest");
  });

  it("never answers this machine's own file from the manifest", () => {
    expect(state({ manifest: manifestEntry(SIG) }).evidence.lookup(REL, "local")).toBeUndefined();
  });

  it.each([
    ["a hash with no verified signature (an older ledger, or a damaged pair)", { verifiedSig: null }],
    ["a verified signature with no hash", { contentHash: "" }],
  ])("is not evidence: %s", (_shape, over) => {
    for (const side of ["local", "remote"] as const) {
      const pass = state({ [side]: record(over as Partial<LedgerEntryRecord>) });
      expect(pass.evidence.lookup(REL, side), side).toBeUndefined();
    }
  });

  it("does not rewrite a manifest entry that holds the same content under another machine's signature", () => {
    const pass = state({ manifest: manifestEntry(OTHER_SIG) });
    pass.evidence.record(REL, "remote", { e0: SIG, contentHash: "sha256:manifest", lineCount: 2 });
    expect(pass.manifestChanged()).toBe(false);
    pass.evidence.record(REL, "remote", { e0: SIG, contentHash: "sha256:new", lineCount: 3 });
    expect(pass.manifestChanged()).toBe(true);
  });
});

const sessionId = (index: number) => `3f2504e0-4f89-41d3-9a0c-${String(index).padStart(12, "0")}`;

let world: World | null = null;
afterEach(async () => {
  await world?.dispose();
  world = null;
});

/** Two machines, each with its own copy of the sync folder, converged on twenty sessions. */
async function converged() {
  world = World.create();
  const w = world;
  const a = w.machine("A");
  const b = w.machine("B");
  await a.initialiseSyncDir();
  for (let i = 0; i < 20; i++) await a.cli.session(sessionId(i)).append(3);
  await a.wiredSettle();
  await w.flush("A", "B", { changedOnly: true });
  await b.wiredSettle();
  for (let round = 0; round < 2; round++) {
    await w.flush("B", "A", { changedOnly: true });
    await a.wiredPass();
    await w.flush("A", "B", { changedOnly: true });
    await b.wiredPass();
  }
  await w.flush("B", "A", { changedOnly: true });
  return { w, a, b };
}

/** A same-length copy whose last record differs — U-18's shape. */
function divergentTwin(text: string): string {
  const twin = text.replace(/"text":"line 2"\}\n$/, '"text":"lime 2"}\n');
  expect(twin).not.toBe(text);
  expect(twin.length).toBe(text.length);
  return twin;
}

async function swapIn(target: string, text: string): Promise<void> {
  await fsp.writeFile(`${target}.swap`, text);
  await fsp.rename(`${target}.swap`, target);
}

describe("evidence about the sync folder's copy is only ever what was read from it", () => {
  it("is not this machine's own bytes after a NOOP, so a same-size replacement landing just then is still found", async () => {
    // A NOOP is reported as APPLIED, and was recorded like a push: the sync
    // folder's copy against a fresh stat and *this machine's* hash. A
    // replacement landing between the read and that stat then looked
    // verified — and with ADR-84 reading the ledger first, it stayed so.
    const { w, a, b } = await converged();
    const rel = `claude-code/${sessionId(7)}.jsonl`;
    const aReplica = path.join(a.replicaRoot, WORKSPACE_ID, rel);
    const bReplica = path.join(b.replicaRoot, WORKSPACE_ID, rel);
    const twin = divergentTwin(await fsp.readFile(aReplica, "utf8"));

    await a.wiredPass({
      verifyAll: true,
      barrier: async (point, ctx) => {
        if (point !== "P5:guarded" || ctx.neutralRel !== rel) return;
        await swapIn(aReplica, twin);
        await swapIn(bReplica, twin);
      },
    });

    const later: string[] = [];
    for (let i = 0; i < 3; i++) {
      await w.flush("B", "A", { changedOnly: true });
      const row = (await a.wiredPass()).report.actions.find((x) => x.neutralRel === rel);
      later.push(`${row?.action}/${row?.reason}`);
      await w.flush("A", "B", { changedOnly: true });
      await b.wiredPass();
    }
    expect(later).toContain("CONFLICT/divergent-content");
  }, 120_000);

  it("is not recorded from a read that failed, and the next pass reads it again", async () => {
    const { a, b } = await converged();
    const rel = `claude-code/${sessionId(5)}.jsonl`;
    const aReplica = path.join(a.replicaRoot, WORKSPACE_ID, rel);
    const twin = divergentTwin(await fsp.readFile(aReplica, "utf8"));
    await swapIn(aReplica, twin);
    await swapIn(path.join(b.replicaRoot, WORKSPACE_ID, rel), twin);
    await a.wiredPass(); // First sight of the moved copy: it settles.

    a.readFailures.add(aReplica); // Held by the sync client for this one read.
    const failed = await a.wiredPass();
    expect(failed.report.actions.find((x) => x.neutralRel === rel)).toMatchObject({
      action: "DEFER",
      reason: "read-failed",
    });

    // Never answered from the cache before it is read again.
    const later: string[] = [];
    for (let i = 0; i < 3; i++) {
      const row = (await a.wiredPass()).report.actions.find((x) => x.neutralRel === rel);
      later.push(`${row?.action}/${row?.reason}`);
    }
    expect(later).toContain("CONFLICT/divergent-content");
    expect(later.slice(0, later.indexOf("CONFLICT/divergent-content"))).not.toContain("NOOP/e1-cache-hit");
  }, 120_000);

  it("falls back to the manifest when this machine's record of the copy is gone", async () => {
    // What A pushed, A wrote into the manifest with its own signature: with
    // the ledger's half wiped, that is still an answer, not fifty reads.
    world = World.create();
    const a = world.machine("A");
    await a.initialiseSyncDir();
    for (let i = 0; i < 50; i++) await a.cli.session(sessionId(i)).append(3);
    await a.wiredSettle();
    await a.wiredPass();
    const file = path.join(a.homeRoot, "state", WORKSPACE_ID, "observations.json");
    const observations = JSON.parse(await fsp.readFile(file, "utf8")) as {
      remote: Record<string, { verifiedSig: unknown; contentHash: string }>;
    };
    for (const entry of Object.values(observations.remote)) {
      entry.verifiedSig = null;
      entry.contentHash = "";
    }
    await fsp.writeFile(file, JSON.stringify(observations));

    a.resetIo();
    const outcome = await a.wiredPass();

    const levels = outcome.report.actions.map((x) => x.evidence.level);
    expect(levels.filter((level) => level === "E1/E1").length).toBeGreaterThanOrEqual(48);
    expect(a.sessionReads().length).toBeLessThanOrEqual(2);
  }, 120_000);
});
