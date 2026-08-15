/**
 * Compose and parse, held against each other (§9.3.2).
 *
 * The parser is part of the recovery path, not a display helper: recovery may
 * not consult `index.jsonl` (it is best-effort), so everything the restore UI
 * knows about a backup comes from its name and its bytes. A parser that
 * disagreed with the composer would therefore hide backups from the only
 * screen that can offer them back.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  backupFileName,
  backupStamp,
  nextBackupName,
  parseBackupName,
} from "../../src/infra/backup-store";
import { fcAssert } from "../helpers/fast-check";

describe("parseBackupName", () => {
  it("round-trips whatever backupFileName composes", () => {
    fcAssert(
      "backup-name-round-trip",
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9.-]{0,40}$/),
        fc.integer({ min: 0, max: 4_102_444_800_000 }),
        fc.integer({ min: 0, max: 99 }),
        (original, epochMs, seq) => {
          const stamp = backupStamp(epochMs);
          const parsed = parseBackupName(backupFileName(original, stamp, seq));
          expect(parsed?.originalName).toBe(original);
          expect(parsed?.seq).toBe(seq);
          expect(parsed?.stamp).toBe(stamp);
          // Millisecond fidelity: the stamp keeps them, so the parse must too.
          expect(parsed?.takenAtMs).toBe(epochMs);
        },
      ),
    );
  });

  it("round-trips the collision suffix that nextBackupName falls back to", () => {
    // `<name>.<stamp>.<seq>.<suffix>.bak` — the shape a same-millisecond
    // collision produces. Parsing must not mistake the suffix for the seq.
    const taken = new Set<string>();
    const stamp = backupStamp(1_700_000_000_123);
    for (let i = 0; i < 100; i++) taken.add(backupFileName("s.jsonl", stamp, i));
    const name = nextBackupName("s.jsonl", stamp, taken, () => "a1b2");

    expect(name).not.toBeNull();
    expect(parseBackupName(name as string)?.originalName).toBe("s.jsonl");
  });

  it("keeps dots that belong to the original name", () => {
    const parsed = parseBackupName(
      "3f2504e0-4f89-41d3-9a0c-0305e82c3301.jsonl.20260806T110000-123Z.00.bak",
    );
    expect(parsed?.originalName).toBe("3f2504e0-4f89-41d3-9a0c-0305e82c3301.jsonl");
    expect(parsed?.seq).toBe(0);
  });

  it.each([
    ["a live session file", "3f2504e0.jsonl"],
    ["the index", "index.jsonl"],
    ["no stamp", "session.jsonl.bak"],
    ["a malformed stamp", "session.jsonl.NOTASTAMP.00.bak"],
    ["a non-numeric seq", "session.jsonl.20260806T110000-123Z.xx.bak"],
    ["nothing before the stamp", "20260806T110000-123Z.00.bak"],
  ])("refuses %s", (_label, name) => {
    expect(parseBackupName(name)).toBeNull();
  });
});
