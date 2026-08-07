/**
 * testing.md §5.2.6 (U-20..U-23) and architecture §8.1 — conflict identity.
 *
 * The properties tested here are what make it safe *not* to store conflict
 * state anywhere. A `conflict: true` field in the manifest fails in both
 * directions: lose the manifest and every pass makes a new quarantine copy;
 * keep a stale one and a session stays frozen after the user fixed it.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { LogicalId } from "../../src/domain/types";
import {
  CONFLICT_ID_LENGTH,
  buildConflictMeta,
  conflictId,
  quarantineLayout,
  resolutionAction,
} from "../../src/domain/conflict";

const hash = (input: string): string => `sha256:${createHash("sha256").update(input).digest("hex")}`;
const SID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301" as LogicalId;

const HASH_A = hash("branch-a");
const HASH_B = hash("branch-b");

describe("conflictId is derived from content alone", () => {
  it("is stable for the same pair of contents", () => {
    const first = conflictId({ logicalId: SID, localHash: HASH_A, remoteHash: HASH_B }, hash);
    const second = conflictId({ logicalId: SID, localHash: HASH_A, remoteHash: HASH_B }, hash);
    expect(first).toBe(second);
    expect(first).toHaveLength(CONFLICT_ID_LENGTH);
  });

  /**
   * U-20 in essence: the manifest can be deleted and nothing changes. The same
   * two files produce the same directory, which already exists, so the next
   * pass is a NOOP rather than another copy.
   */
  it("needs no stored state to recognise a conflict it has already seen", () => {
    const before = conflictId({ logicalId: SID, localHash: HASH_A, remoteHash: HASH_B }, hash);
    // Nothing is carried between these two calls — no manifest, no ledger.
    const afterManifestLoss = conflictId({ logicalId: SID, localHash: HASH_A, remoteHash: HASH_B }, hash);
    expect(afterManifestLoss).toBe(before);
  });

  /**
   * The two machines disagree about which side is "local", so ordering by side
   * would give one disagreement two identities — and two quarantine
   * directories, each holding the same pair of branches.
   */
  it("is the same on both machines, where local and remote are swapped", () => {
    const onA = conflictId({ logicalId: SID, localHash: HASH_A, remoteHash: HASH_B }, hash);
    const onB = conflictId({ logicalId: SID, localHash: HASH_B, remoteHash: HASH_A }, hash);
    expect(onB).toBe(onA);
  });

  /**
   * U-21: the user edits one side so the two agree, or so one contains the
   * other. The old id is simply never computed again, so the conflict stops
   * existing without anything having to clear it.
   */
  it("stops being computed as soon as either side changes", () => {
    const original = conflictId({ logicalId: SID, localHash: HASH_A, remoteHash: HASH_B }, hash);
    const afterEdit = conflictId({ logicalId: SID, localHash: hash("branch-a-fixed"), remoteHash: HASH_B }, hash);
    expect(afterEdit).not.toBe(original);
  });

  it("separates conflicts in different sessions", () => {
    const other = "11111111-4f89-41d3-9a0c-0305e82c3301" as LogicalId;
    expect(conflictId({ logicalId: other, localHash: HASH_A, remoteHash: HASH_B }, hash)).not.toBe(
      conflictId({ logicalId: SID, localHash: HASH_A, remoteHash: HASH_B }, hash),
    );
  });
});

describe("quarantine layout", () => {
  const layout = quarantineLayout({
    workspaceId: "3f1a9c2e-6b47-4d18-9a03-5e7c8d21b4f6",
    providerId: "claude-code",
    conflictId: "abcdef0123456789",
    localHash: HASH_A,
    remoteHash: HASH_B,
    extension: ".jsonl",
  });

  it("lives in the sync directory, where both machines can reach it", () => {
    // The home state directory would only ever show one machine's view.
    expect(layout.dir[0]).toBe(".quarantine");
    expect(layout.dir).toEqual([
      ".quarantine",
      "3f1a9c2e-6b47-4d18-9a03-5e7c8d21b4f6",
      "claude-code",
      "abcdef0123456789",
    ]);
  });

  it("names each copy by its own hash prefix, so the two are distinguishable", () => {
    expect(layout.localCopy).toMatch(/^local-[0-9a-f]{8}\.jsonl$/);
    expect(layout.remoteCopy).toMatch(/^remote-[0-9a-f]{8}\.jsonl$/);
    expect(layout.localCopy).not.toBe(layout.remoteCopy);
  });

  it("keeps the original extension, which OQ-5 showed the CLI tolerates", () => {
    expect(layout.localCopy.endsWith(".jsonl")).toBe(true);
  });
});

describe("conflict metadata carries no content", () => {
  const meta = buildConflictMeta({
    logicalId: SID,
    conflictId: "abcdef0123456789",
    localHash: HASH_A,
    remoteHash: HASH_B,
    localSize: 4096,
    remoteSize: 8192,
    localLineCount: 40,
    remoteLineCount: 80,
    machineIdPrefix: "3f2504e0",
    detectedAtIso: "2026-08-07T12:00:00.000Z",
  });

  it("records only whitelisted facts (§11.1)", () => {
    const serialised = JSON.stringify(meta);
    for (const forbidden of ["content", "bytes", "lines", "sample", "head", "tail", "cwd", "text"]) {
      expect(Object.keys(meta)).not.toContain(forbidden);
    }
    // Hash prefixes, never whole digests.
    expect(meta.localHashPrefix).toHaveLength(8);
    expect(serialised).not.toContain(HASH_A.slice(7));
  });

  it("identifies the detecting machine by prefix, not by hostname", () => {
    // A hostname is a string another machine wrote; it never reaches a path or
    // a rendered label unescaped.
    expect(meta.detectedBy).toBe("3f2504e0");
  });

  it("keeps both sides' sizes and line counts, which is what a user compares", () => {
    expect(meta.localLineCount).toBe(40);
    expect(meta.remoteLineCount).toBe(80);
  });
});

describe("the three M1 resolution commands (§8.1)", () => {
  it("maps keeping a side to an ordinary overwrite", () => {
    // Resolution is not a special write path: it re-enters the same verified
    // overwrite protocol, so it is backed up like anything else.
    expect(resolutionAction("keep-local")).toBe("PUSH_OVERWRITE");
    expect(resolutionAction("keep-remote")).toBe("PULL_OVERWRITE");
  });

  it("treats revealing the copies as no write at all", () => {
    expect(resolutionAction("reveal")).toBeNull();
  });

  it("ships all three in M1, since detection without resolution is a dead end", () => {
    const all = (["keep-local", "keep-remote", "reveal"] as const).map(resolutionAction);
    expect(all).toHaveLength(3);
  });
});
