/**
 * testing.md §15.1 Q-08 and architecture §5.5 / §5.6 / §10.3 — the three-way
 * state split.
 *
 * The cases that matter are the ones where a file is absent, stale or written
 * by a newer version. Every one of them must fail safe: degrade to observation,
 * never to "nothing changed".
 */
import { describe, expect, it } from "vitest";
import type { MachineId, WorkspaceId } from "../../src/domain/types";
import {
  LEDGER_GC_AGE_MS,
  MAX_SUPERSEDED,
  type MachineFile,
  type MachineIdentity,
  checkWorkspaceIdentity,
  detectIdentityDrift,
  emptyObservations,
  findIdentityConflictCopies,
  findNonPortableValues,
  gcObservations,
  parseMachineFile,
  parseObservations,
  rotateMachineId,
} from "../../src/infra/state-store";

const MACHINE_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301" as MachineId;
const OTHER_ID = "11111111-2222-4333-8444-555555555555" as MachineId;
const WORKSPACE_ID = "3f1a9c2e-6b47-4d18-9a03-5e7c8d21b4f6" as WorkspaceId;
const FINGERPRINT = "sha256:abcdef";

const sig = () => ({ size: 10, mtimeMs: 1, ctimeMs: 2, ino: 3, tailHash: "aa" });

const entry = (overrides: Record<string, unknown> = {}) => ({
  sig: sig(),
  firstSeenMs: 1000,
  lastSeenMs: 1000,
  lastFullVerifyMs: 0,
  contentHash: "sha256:xyz",
  lastAction: "NOOP",
  lastResult: "APPLIED",
  abortStreak: 0,
  skippedForBudgetPasses: 0,
  truncatedTailPasses: 0,
  ...overrides,
});

const observations = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  machineId: MACHINE_ID,
  syncDirFingerprint: FINGERPRINT,
  remote: { "ws/claude-code/a.jsonl": entry() },
  local: {},
  cursor: { write: null, scrub: null },
  ...overrides,
});

const expected = { machineId: MACHINE_ID, syncDirFingerprint: FINGERPRINT };

describe("observations ledger — loading", () => {
  it("loads a well-formed file", () => {
    const result = parseObservations(observations(), expected);
    expect(result.status).toBe("loaded");
  });

  it.each([
    ["not an object", "nonsense"],
    ["null", null],
    ["an array", []],
    ["missing schemaVersion", { machineId: MACHINE_ID, syncDirFingerprint: FINGERPRINT }],
  ])("refuses %s", (_label, raw) => {
    expect(parseObservations(raw, expected).status).toBe("unusable");
  });

  it("refuses a newer schema without rewriting it", () => {
    // An old client rebuilding a newer format would destroy whatever the newer
    // one recorded, so this is unusable rather than "migrate".
    const result = parseObservations(observations({ schemaVersion: 99 }), expected);
    expect(result).toMatchObject({ status: "unusable", reason: "newer-schema" });
  });

  it("voids the whole file when the sync directory fingerprint differs", () => {
    // The ledger then describes a different sync directory: every firstSeenMs
    // in it is a claim about files this pass has never seen.
    const result = parseObservations(observations({ syncDirFingerprint: "sha256:other" }), expected);
    expect(result).toMatchObject({ status: "unusable", reason: "sync-dir-fingerprint-mismatch" });
  });

  it("voids the whole file when it belongs to another machine", () => {
    const result = parseObservations(observations({ machineId: OTHER_ID }), expected);
    expect(result).toMatchObject({ status: "unusable", reason: "machine-id-mismatch" });
  });

  it("drops a corrupt entry but keeps the file", () => {
    // Whole-file checks are about provenance; one bad record only costs one
    // deferred file, while keeping it would feed a half-undefined signature
    // into a stability comparison.
    const raw = observations({
      remote: { good: entry(), bad: { sig: { size: "ten" }, firstSeenMs: 1 }, alsoBad: null },
    });
    const result = parseObservations(raw, expected);

    expect(result.status).toBe("loaded");
    if (result.status !== "loaded") return;
    expect(Object.keys(result.value.remote)).toEqual(["good"]);
  });

  it("supplies an empty ledger, which is what a lost one degrades to", () => {
    const empty = emptyObservations(MACHINE_ID, FINGERPRINT);
    // Nothing is stable with no observations, so the pass becomes read-only for
    // one round. The cost of losing this file is a slow pass, never a wrong
    // decision.
    expect(empty.remote).toEqual({});
    expect(empty.local).toEqual({});
    expect(empty.cursor).toEqual({ write: null, scrub: null });
  });
});

describe("observations ledger — GC", () => {
  it("drops entries unseen for the retention window", () => {
    const now = 100 * LEDGER_GC_AGE_MS;
    const file = parseObservations(
      observations({
        remote: { fresh: entry({ lastSeenMs: now - 1000 }), stale: entry({ lastSeenMs: now - LEDGER_GC_AGE_MS - 1 }) },
      }),
      expected,
    );
    if (file.status !== "loaded") throw new Error("expected loaded");

    expect(Object.keys(gcObservations(file.value, now).remote)).toEqual(["fresh"]);
  });

  it("keeps an entry seen exactly at the boundary", () => {
    const now = 100 * LEDGER_GC_AGE_MS;
    const file = parseObservations(
      observations({ remote: { edge: entry({ lastSeenMs: now - LEDGER_GC_AGE_MS }) } }),
      expected,
    );
    if (file.status !== "loaded") throw new Error("expected loaded");
    expect(Object.keys(gcObservations(file.value, now).remote)).toEqual(["edge"]);
  });
});

describe("machine identity (§10.3)", () => {
  const identity: MachineIdentity = { hostname: "ct-mbp", platform: "darwin", homedir: "/Users/testuser" };

  it("sees no drift when nothing moved", () => {
    expect(detectIdentityDrift(identity, identity)).toBeNull();
  });

  it("ignores hostname case and surrounding space", () => {
    expect(detectIdentityDrift(identity, { ...identity, hostname: "  CT-MBP " })).toBeNull();
  });

  it("ignores a moved home directory, which is still this machine", () => {
    expect(detectIdentityDrift(identity, { ...identity, homedir: "/Users/testuser/moved-vault-home" })).toBeNull();
  });

  it("detects a renamed host", () => {
    expect(detectIdentityDrift(identity, { ...identity, hostname: "ct-mbp-2" })).toBe("hostname-drift");
  });

  it("detects a cloned home landing on another platform", () => {
    expect(detectIdentityDrift(identity, { ...identity, platform: "win32" })).toBe("platform-drift");
  });

  it("retires the old id, newest first", () => {
    const file = {
      schemaVersion: 1,
      machineId: MACHINE_ID,
      machineLabel: "ct-mbp",
      createdAt: "2026-01-01T00:00:00.000Z",
      identity,
      superseded: [],
    };
    const rotated = rotateMachineId(
      file,
      { machineId: OTHER_ID, identity: { ...identity, hostname: "renamed" }, nowIso: "2026-08-07T00:00:00.000Z" },
      "hostname-drift",
    );

    expect(rotated.machineId).toBe(OTHER_ID);
    expect(rotated.superseded[0]).toMatchObject({ machineId: MACHINE_ID, reason: "hostname-drift" });
  });

  it("keeps the retired list bounded", () => {
    // It is an audit aid, not a record anything depends on — rotating is always
    // safe because machineId may never take part in a decision.
    let file: MachineFile = {
      schemaVersion: 1,
      machineId: MACHINE_ID,
      machineLabel: "m",
      createdAt: "",
      identity,
      superseded: [],
    };
    for (let i = 0; i < MAX_SUPERSEDED + 5; i++) {
      file = rotateMachineId(file, { machineId: OTHER_ID, identity, nowIso: "x" }, "hostname-drift");
    }
    expect(file.superseded).toHaveLength(MAX_SUPERSEDED);
  });

  it("refuses a machine file whose id is not a lowercase UUID", () => {
    const result = parseMachineFile({
      schemaVersion: 1,
      machineId: MACHINE_ID.toUpperCase(),
      identity,
    });
    expect(result).toMatchObject({ status: "unusable", reason: "invalid-machine-id" });
  });

  it("refuses a machine file from a newer version", () => {
    expect(parseMachineFile({ schemaVersion: 99, machineId: MACHINE_ID, identity })).toMatchObject({
      status: "unusable",
      reason: "newer-schema",
    });
  });
});

describe("workspace identity preflight (§5.2.3)", () => {
  const valid = { schemaVersion: 1, workspaceId: WORKSPACE_ID, label: "vault", createdAt: "" };

  it("W-0: accepts a matching identity", () => {
    expect(checkWorkspaceIdentity({ raw: valid, boundWorkspaceId: WORKSPACE_ID, conflictCopyNames: [] }).status).toBe(
      "ok",
    );
  });

  it("W-1: aborts when the file is missing but this machine is bound", () => {
    // Most likely the vault sync has not arrived. Minting a new id here would
    // create a second subtree the other machine can never find — the exact
    // failure two-step initialisation exists to prevent.
    expect(
      checkWorkspaceIdentity({ raw: undefined, boundWorkspaceId: WORKSPACE_ID, conflictCopyNames: [] }).status,
    ).toBe("WORKSPACE_IDENTITY_MISSING");
  });

  it("W-2: aborts when the id changed under us", () => {
    const other = { ...valid, workspaceId: "99999999-4f89-41d3-9a0c-0305e82c3301" };
    expect(
      checkWorkspaceIdentity({ raw: other, boundWorkspaceId: WORKSPACE_ID, conflictCopyNames: [] }).status,
    ).toBe("WORKSPACE_IDENTITY_CHANGED");
  });

  it("W-4: aborts when a conflict copy makes the identity ambiguous", () => {
    expect(
      checkWorkspaceIdentity({
        raw: valid,
        boundWorkspaceId: WORKSPACE_ID,
        conflictCopyNames: ["workspace.sync-conflict-20260807-120000-ABCDEF.json"],
      }).status,
    ).toBe("WORKSPACE_IDENTITY_AMBIGUOUS");
  });

  it.each([
    ["not an object", "text"],
    ["uppercase id", { schemaVersion: 1, workspaceId: WORKSPACE_ID.toUpperCase() }],
    ["newer schema", { schemaVersion: 99, workspaceId: WORKSPACE_ID }],
    ["missing id", { schemaVersion: 1 }],
  ])("W-5: aborts on %s, without rewriting the file", (_label, raw) => {
    expect(checkWorkspaceIdentity({ raw, boundWorkspaceId: WORKSPACE_ID, conflictCopyNames: [] }).status).toBe(
      "WORKSPACE_IDENTITY_INVALID",
    );
  });

  it("treats an absent file on an unbound machine as ordinary", () => {
    // Nothing is wrong: this machine has simply not joined a workspace yet.
    expect(checkWorkspaceIdentity({ raw: undefined, boundWorkspaceId: null, conflictCopyNames: [] }).status).toBe(
      "ok",
    );
  });

  it("recognises the conflict copies external sync tools produce", () => {
    const names = [
      "workspace.json",
      "workspace.sync-conflict-20260807-120000-ABCDEF.json",
      "workspace (ct-mbp's conflicted copy 2026-08-07).json",
      "workspace (1).json",
      "unrelated.json",
    ];
    expect(findIdentityConflictCopies(names)).toHaveLength(3);
  });
});

describe("portable settings must survive being copied (§5.6 rule 1)", () => {
  it("passes settings that hold only preferences", () => {
    expect(
      findNonPortableValues({
        schemaVersion: 1,
        workspaceIdFile: ".ai-session-sync/workspace.json",
        auto: { onStartup: true, intervalMinutes: 5 },
        backup: { keep: 3 },
      }),
    ).toEqual([]);
  });

  it("catches a POSIX absolute path", () => {
    expect(findNonPortableValues({ syncDir: "/Users/testuser/Dropbox" })).toContain("posix-absolute-path");
  });

  it("catches a Windows absolute path", () => {
    expect(findNonPortableValues({ syncDir: "C:\\Users\\testuser\\Dropbox" })).toContain(
      "windows-absolute-path",
    );
  });

  it("catches a home-relative path", () => {
    expect(findNonPortableValues({ backupDir: "~/backups" })).toContain("home-reference");
  });
});
