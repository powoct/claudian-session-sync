/**
 * testing.md §1.3 and architecture §9.3 — backups, and the rotation that
 * invariant I1 governs.
 *
 * Rotation is the only place this plugin destroys bytes deliberately, so it is
 * the only place where a `keep = 3` setting could itself become a data-loss
 * path. These tests are what keep it from being one.
 */
import { describe, expect, it } from "vitest";
import type { LogicalId } from "../../src/domain/types";
import {
  DEFAULT_BACKUP_KEEP,
  MAX_BACKUP_KEEP,
  MIN_BACKUP_KEEP,
  type RotationCandidate,
  backupDirFor,
  backupFailureIsFatal,
  backupFileName,
  backupStamp,
  indexLine,
  nextBackupName,
  planRotation,
  rotationFailureIsFatal,
} from "../../src/infra/backup-store";

describe("backup naming", () => {
  it("produces a stamp with no character Windows forbids", () => {
    const stamp = backupStamp(Date.parse("2026-08-06T11:00:00.123Z"));
    expect(stamp).toBe("20260806T110000-123Z");
    // ":" is illegal on NTFS and is read as an alternate-data-stream separator.
    expect(stamp).not.toContain(":");
    expect(stamp).not.toContain(".");
  });

  it("sorts lexicographically in chronological order", () => {
    // The property worth preserving from ISO-8601: a directory listing is
    // sorted by time without parsing anything.
    const stamps = [
      backupStamp(Date.parse("2026-08-06T11:00:00.123Z")),
      backupStamp(Date.parse("2026-08-06T11:00:00.124Z")),
      backupStamp(Date.parse("2026-08-06T11:00:01.000Z")),
      backupStamp(Date.parse("2026-12-31T23:59:59.999Z")),
      backupStamp(Date.parse("2027-01-01T00:00:00.000Z")),
    ];
    expect([...stamps].sort()).toEqual(stamps);
  });

  it("builds the documented filename", () => {
    expect(backupFileName("9f2c8d41.jsonl", "20260806T110000-123Z", 0)).toBe(
      "9f2c8d41.jsonl.20260806T110000-123Z.00.bak",
    );
  });

  it("pads the sequence so names keep sorting correctly", () => {
    const names = [0, 1, 9, 10].map((seq) => backupFileName("a.jsonl", "S", seq));
    expect([...names].sort()).toEqual(names);
  });

  it("steps the sequence past a same-millisecond collision", () => {
    const taken = new Set([
      backupFileName("a.jsonl", "S", 0),
      backupFileName("a.jsonl", "S", 1),
    ]);
    expect(nextBackupName("a.jsonl", "S", taken, () => "aabbcc")).toBe(backupFileName("a.jsonl", "S", 2));
  });

  it("falls back to a random suffix when every sequence is taken", () => {
    const taken = new Set(
      Array.from({ length: 100 }, (_, seq) => backupFileName("a.jsonl", "S", seq)),
    );
    expect(nextBackupName("a.jsonl", "S", taken, () => "aabbcc")).toBe(
      backupFileName("a.jsonl", "S", 99, "aabbcc"),
    );
  });

  it("reports failure rather than reusing a name", () => {
    // The caller creates with "wx", so a reused name is a failed backup — and a
    // failed backup cancels the overwrite it was protecting.
    const everything = new Set<string>();
    for (let seq = 0; seq < 100; seq++) everything.add(backupFileName("a.jsonl", "S", seq));
    for (let i = 0; i < 8; i++) everything.add(backupFileName("a.jsonl", "S", 99, "fixed"));

    expect(nextBackupName("a.jsonl", "S", everything, () => "fixed")).toBeNull();
  });
});

describe("backup layout (§9.3.2)", () => {
  const SID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

  it("separates each workspace, provider and session", () => {
    expect(
      backupDirFor({ workspaceId: "ws", providerId: "claude-code", remote: false, logicalId: SID }),
    ).toEqual(["ws", "claude-code", SID]);
  });

  it("keeps overwritten remote versions in their own subtree", () => {
    // This is what makes PUSH_OVERWRITE survivable: the version being replaced
    // may have come from another machine and disappears from the sync directory
    // the moment it is overwritten, so a local copy has to exist first.
    expect(
      backupDirFor({ workspaceId: "ws", providerId: "claude-code", remote: true, logicalId: SID }),
    ).toEqual(["ws", "claude-code", "remote", SID]);
  });

  it("puts two sessions' copies of one file name in different places", () => {
    // The reason the session segment exists at all. Grok's members are a fixed
    // vocabulary repeated in every session, so `chat_history.jsonl.<stamp>.bak`
    // stopped identifying anything — and both a restore's target and
    // retention's "can a survivor reproduce this" question were answered from
    // that name.
    const other = "01a02f27-c1aa-7aa1-9580-e4188952ef3b";
    expect(
      backupDirFor({ workspaceId: "ws", providerId: "grok", remote: false, logicalId: SID }),
    ).not.toEqual(
      backupDirFor({ workspaceId: "ws", providerId: "grok", remote: false, logicalId: other }),
    );
  });
});

describe("rotation is governed by I1 (§9.3.3)", () => {
  const candidate = (name: string, createdAtMs: number, recoverable = true): RotationCandidate => ({
    name,
    createdAtMs,
    recoverableFromSurvivor: recoverable,
  });

  it("keeps the newest N and deletes the rest", () => {
    const plan = planRotation(
      [candidate("a", 5), candidate("b", 4), candidate("c", 3), candidate("d", 2), candidate("e", 1)],
      3,
    );
    expect([...plan.deleteNames].sort()).toEqual(["d", "e"]);
    expect(plan.deferred).toBe(false);
  });

  it("deletes nothing when there is nothing surplus", () => {
    expect(planRotation([candidate("a", 2), candidate("b", 1)], 3).deleteNames).toEqual([]);
  });

  it("refuses to delete a version nothing else can reproduce", () => {
    // The case that makes `keep = 3` a data-loss path if ignored: the surplus
    // backup holds a branch no surviving file contains.
    const plan = planRotation(
      [candidate("a", 5), candidate("b", 4), candidate("c", 3), candidate("orphan-branch", 2, false)],
      3,
    );
    expect(plan.deleteNames).toEqual([]);
    expect(plan.deferred).toBe(true);
  });

  it("deletes what it can and keeps what it must, in one pass", () => {
    const plan = planRotation(
      [
        candidate("a", 6),
        candidate("b", 5),
        candidate("c", 4),
        candidate("recoverable", 3, true),
        candidate("orphan", 2, false),
      ],
      3,
    );
    expect(plan.deleteNames).toEqual(["recoverable"]);
    expect(plan.deferred).toBe(true);
  });

  it("clamps keep into the accepted range rather than honouring zero", () => {
    // keep = 0 would mean "no backups", which is the invariant switched off.
    // The settings panel refuses it; this is the second line.
    const five = Array.from({ length: 5 }, (_, i) => candidate(`n${i}`, i));
    expect(planRotation(five, 0).keptCount).toBe(MIN_BACKUP_KEEP);
    expect(planRotation(five, 999).deleteNames).toEqual([]);
    expect(MAX_BACKUP_KEEP).toBeGreaterThan(DEFAULT_BACKUP_KEEP);
  });

  it("orders by creation time, not by the order it was handed", () => {
    const plan = planRotation([candidate("old", 1), candidate("new", 9), candidate("mid", 5)], 1);
    expect([...plan.deleteNames].sort()).toEqual(["mid", "old"]);
  });
});

describe("failure semantics (§9.3.3)", () => {
  it("treats a failed backup as fatal to the overwrite", () => {
    // Better not to sync than to have no way back.
    expect(backupFailureIsFatal()).toBe(true);
  });

  it("treats a failed rotation as survivable", () => {
    // The way back already exists; the only cost is extra disk.
    expect(rotationFailureIsFatal()).toBe(false);
  });
});

describe("index line", () => {
  it("records only what the content-safety whitelist allows", () => {
    const line = indexLine({
      name: "a.jsonl.20260806T110000-123Z.00.bak",
      logicalId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" as LogicalId,
      createdAtMs: 1,
      sizeBytes: 100,
      lineCount: 3,
      hashPrefix: "deadbeef",
      action: "PULL_OVERWRITE",
    });
    const parsed = JSON.parse(line);

    // A hash prefix, never the full digest (§11.1).
    expect(parsed.hashPrefix).toHaveLength(8);
    // And no field that could carry file content.
    for (const forbidden of ["content", "bytes", "sample", "head", "tail", "lines"]) {
      expect(parsed).not.toHaveProperty(forbidden);
    }
  });
});
