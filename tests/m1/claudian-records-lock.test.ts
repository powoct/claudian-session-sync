/**
 * ADR-78's memory is read and written inside the pass lock.
 *
 * The first version loaded it before the lock was taken and saved it after
 * the lock was released, so a "bring back" written in between — under the
 * same lock, by the command — was saved over by the pass's older copy, and
 * the conversation the user asked for did not come back (review, 2026-10-14,
 * reproduced). The contract is an order of four events, so that is what is
 * pinned.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createClaudianRecordsState, emptyClaudianRecords } from "../../src/orchestration/claudian-records";
import type { ClaudianRecordsSession, PassLock } from "../../src/orchestration/sync-engine";
import { World } from "../helpers/world";

let world: World | null = null;
afterEach(async () => {
  await world?.dispose();
  world = null;
});

function recorder() {
  const events: string[] = [];
  const lock: PassLock = {
    acquire: async () => {
      events.push("acquire");
      return { ok: true };
    },
    mayWrite: async () => true,
    release: async () => {
      events.push("release");
    },
  };
  const session = (): ClaudianRecordsSession => ({
    state: createClaudianRecordsState(emptyClaudianRecords()),
    markerless: true,
    claudeTranscriptPath: null,
    movedToDevice: async () => false,
    storeIdentity: async () => null,
    memoryUnreadable: false,
    notice: null,
    commit: async () => {
      events.push("commit");
    },
  });
  return {
    events,
    lock,
    claudianRecords: {
      open: async () => {
        events.push("open");
        return session();
      },
    },
  };
}

describe("the memory and the lock", () => {
  it("is opened after the lock is taken and committed before it is let go", async () => {
    world = World.create();
    const { events, lock, claudianRecords } = recorder();
    await world.machine("A").pass({ lock, claudianRecords });
    expect(events).toEqual(["acquire", "open", "commit", "release"]);
  });

  it("is not opened at all by a pass that could not take the lock", async () => {
    world = World.create();
    const { events, lock, claudianRecords } = recorder();
    await world.machine("A").pass({
      lock: { ...lock, acquire: async () => ({ ok: false, reason: "busy" }) },
      claudianRecords,
    });
    expect(events).not.toContain("open");
    expect(events).not.toContain("commit");
  });
});
