/**
 * ADR-78's decision, as a table.
 *
 * Every row pins one rule of `decideAbsentHere` and what it must never do.
 * The probes are counted as well as answered, because two of the rules are
 * about *not* asking: an unwitnessed record must not cost a parse of
 * megabytes of JSON, and a record already explained by a tombstone or a move
 * must not be read at all.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type AbsentHereInput,
  type ClaudeHistory,
  type TranscriptWhere,
  claudeBoundSessionIds,
  claudianRecordOf,
  decideAbsentHere,
  judgeClaudeHistory,
  recordDigest,
} from "../../src/domain/deleted-here";

const CONV = "conv-1786422687897-15ktes7p9";
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const S3 = "33333333-3333-4333-8333-333333333333";

describe("which files are Claudian records", () => {
  it("reads the conversation and the kind", () => {
    expect(claudianRecordOf(`claudian/${CONV}.meta.json`)).toEqual({ conversationId: CONV, kind: "meta" });
    expect(claudianRecordOf(`claudian/${CONV}.inputs.json`)?.kind).toBe("inputs");
    expect(claudianRecordOf(`claudian/${CONV}.deleted.json`)?.kind).toBe("deleted");
  });

  it("refuses anything else", () => {
    for (const rel of [
      `claude-code/${CONV}.meta.json`,
      `claudian/${CONV}.assigned.json`,
      `claudian/devices/x/${CONV}.meta.json`,
      `claudian/conv-fake-1.meta.json`,
      `claudian/${CONV}.meta.json.bak`,
    ]) {
      expect(claudianRecordOf(rel)).toBeNull();
    }
  });
});

describe("decideAbsentHere", () => {
  const base: AbsentHereInput = {
    kind: "meta",
    markerless: true,
    storeHealthy: true,
    witnessed: true,
    releaseRequested: false,
    tombstoneBeside: false,
    restoredForMissingHistory: false,
    memoryUnreadable: false,
  };

  function probes(answers: { moved?: boolean; history?: ClaudeHistory } = {}) {
    const asked: string[] = [];
    return {
      asked,
      probes: {
        movedToDevice: async () => {
          asked.push("moved");
          return answers.moved ?? false;
        },
        claudeHistory: async () => {
          asked.push("history");
          return answers.history ?? "some-present";
        },
      },
    };
  }

  async function decide(input: Partial<AbsentHereInput>, answers?: { moved?: boolean; history?: ClaudeHistory }) {
    const p = probes(answers);
    return { verdict: await decideAbsentHere({ ...base, ...input }, p.probes), asked: p.asked };
  }

  it("keeps a record this device held, and no longer holds, off it", async () => {
    expect((await decide({})).verdict).toEqual({ verdict: "hold", kind: "deleted-here" });
  });

  it("still lands a record this device never held — that is a record not here yet", async () => {
    const { verdict, asked } = await decide({ witnessed: false });
    expect(verdict).toEqual({ verdict: "restore", reason: "remote-only" });
    // And it never paid for the parse that only a witnessed record needs.
    expect(asked).toEqual([]);
  });

  it("restores everything when the store itself is missing", async () => {
    // No `.claudian/sessions` is a vault without Claudian, or one whose sync
    // has not delivered the folder — never a conversation someone deleted.
    expect((await decide({ storeHealthy: false })).verdict).toEqual({ verdict: "restore", reason: "remote-only" });
  });

  it("does the same on a Claudian that still writes markers", async () => {
    // The rule is about what this device saw, not which version made it.
    expect((await decide({ markerless: false })).verdict).toEqual({ verdict: "hold", kind: "deleted-here" });
  });

  it("brings a held record back when the user asks", async () => {
    expect((await decide({ releaseRequested: true })).verdict).toEqual({
      verdict: "restore",
      reason: "brought-back",
    });
  });

  it("labels a record that moved into a device folder as moved, not deleted", async () => {
    const { verdict, asked } = await decide({}, { moved: true });
    expect(verdict).toEqual({ verdict: "hold", kind: "moved-to-device" });
    expect(asked).toEqual(["moved"]);
  });

  it("restores a Claude record Claudian could have removed by itself", async () => {
    const { verdict, asked } = await decide({}, { history: "all-absent" });
    expect(verdict).toEqual({ verdict: "restore", reason: "remote-only-history-not-here" });
    expect(asked).toEqual(["moved", "history"]);
  });

  it("restores for missing history only once per version of the record", async () => {
    // The second removal of bytes this device already restored is the user's:
    // otherwise a conversation whose history never reaches this device could
    // never be deleted here (review, 2026-10-14).
    const { verdict, asked } = await decide({ restoredForMissingHistory: true }, { history: "all-absent" });
    expect(verdict).toEqual({ verdict: "hold", kind: "deleted-here" });
    expect(asked).toEqual(["moved"]);
  });

  it("lands nothing it cannot place while the memory is unreadable, and still holds what it can", async () => {
    const wait = { verdict: "wait", reason: "memory-unreadable" };
    expect((await decide({ memoryUnreadable: true, witnessed: false })).verdict).toEqual(wait);
    expect((await decide({ memoryUnreadable: true, storeHealthy: false })).verdict).toEqual(wait);
    expect((await decide({ memoryUnreadable: true }, { history: "all-absent" })).verdict).toEqual(wait);
    expect((await decide({ memoryUnreadable: true })).verdict).toEqual({ verdict: "hold", kind: "deleted-here" });
    expect((await decide({ memoryUnreadable: true, kind: "inputs" })).verdict).toEqual({
      verdict: "retired",
      reason: "retired-sidecar",
    });
  });

  it.each<ClaudeHistory>(["some-present", "nowhere", "unknown", "not-applicable"])(
    "holds when the history answer is %s",
    async (history) => {
      expect((await decide({}, { history })).verdict).toEqual({ verdict: "hold", kind: "deleted-here" });
    },
  );

  describe("deletion markers (Claudian 2.3.2 and older)", () => {
    it("holds a held record its tombstone removed, silently labelled", async () => {
      const { verdict, asked } = await decide({ tombstoneBeside: true });
      expect(verdict).toEqual({ verdict: "hold", kind: "removed-by-tombstone" });
      expect(asked).toEqual([]);
    });

    it("never lands a record beside its tombstone on a device that never held it", async () => {
      expect((await decide({ tombstoneBeside: true, witnessed: false })).verdict).toEqual({
        verdict: "retired",
        reason: "tombstoned-in-replica",
      });
    });

    it("does so even where the store is missing", async () => {
      expect((await decide({ tombstoneBeside: true, witnessed: false, storeHealthy: false })).verdict).toEqual({
        verdict: "retired",
        reason: "tombstoned-in-replica",
      });
    });

    it("still brings one back on request — the record only", async () => {
      expect((await decide({ tombstoneBeside: true, releaseRequested: true })).verdict).toEqual({
        verdict: "restore",
        reason: "brought-back",
      });
    });

    it("lands a tombstone this device never held — how an older peer's delete arrives", async () => {
      // Critic 1: without this, a delete made on a Claudian 2.3.2 device
      // never reaches a 2.3.3 one, because the marker is the only carrier.
      expect((await decide({ kind: "deleted", witnessed: false })).verdict).toEqual({
        verdict: "restore",
        reason: "remote-only",
      });
    });

    it("keeps a tombstone this device held, and Claudian consumed, off it", async () => {
      const { verdict, asked } = await decide({ kind: "deleted" });
      expect(verdict).toEqual({ verdict: "hold", kind: "tombstone-consumed" });
      expect(asked).toEqual([]);
    });

    it("never brings a tombstone back", async () => {
      // Landing one deletes its conversation again at the next launch.
      expect((await decide({ kind: "deleted", releaseRequested: true })).verdict).toEqual({
        verdict: "hold",
        kind: "tombstone-consumed",
      });
    });
  });

  describe("the retired inputs sidecar", () => {
    it("is never landed on a markerless Claudian, whatever this device saw", async () => {
      for (const witnessed of [true, false]) {
        expect((await decide({ kind: "inputs", witnessed })).verdict).toEqual({
          verdict: "retired",
          reason: "retired-sidecar",
        });
      }
    });

    it("is left to today's rule on an older or unknown one", async () => {
      expect((await decide({ kind: "inputs", markerless: false })).verdict).toEqual({
        verdict: "restore",
        reason: "remote-only",
      });
    });
  });
});

describe("the session ids Claudian checks before deleting by itself", () => {
  const ids = (body: unknown) => {
    const bound = claudeBoundSessionIds(JSON.stringify(body), CONV);
    return bound.status === "ok" ? bound.ids : bound.status;
  };

  it("takes the record's own id when the sessionId key is absent", () => {
    // `createShell`: `meta.sessionId !== undefined ? meta.sessionId : meta.id`.
    expect(ids({ id: CONV, providerId: "claude" })).toEqual([CONV]);
  });

  it("keeps an explicit null as null", () => {
    expect(ids({ id: CONV, providerId: "claude", sessionId: null })).toEqual([]);
  });

  it("defaults the provider to claude", () => {
    expect(ids({ id: CONV, sessionId: S1 })).toEqual([S1]);
  });

  it("is every previous id plus the current one, current = providerSessionId ?? sessionId", () => {
    expect(
      ids({
        id: CONV,
        providerId: "claude",
        sessionId: S1,
        providerState: { providerSessionId: S2, previousProviderSessionIds: [S3, S2] },
      }),
    ).toEqual([S3, S2]);
  });

  it("resumes an unsent fork from its source", () => {
    expect(
      ids({ id: CONV, providerId: "claude", sessionId: null, providerState: { forkSource: { sessionId: S3 } } }),
    ).toEqual([S3]);
  });

  it("does not treat a fork whose sessionId defaulted to the record id as pending", () => {
    // The default runs first, so a fork record without the key has a session.
    expect(ids({ id: CONV, providerId: "claude", providerState: { forkSource: { sessionId: S3 } } })).toEqual([
      CONV,
    ]);
  });

  it("says when a record is not Claude's, or not readable", () => {
    expect(ids({ id: CONV, providerId: "codex", sessionId: S1 })).toBe("not-claude");
    expect(ids({ id: CONV, providerId: "deepseek", sessionId: S1 })).toBe("not-claude");
    expect(claudeBoundSessionIds("{ torn", CONV).status).toBe("unreadable");
    expect(claudeBoundSessionIds("[1]", CONV).status).toBe("unreadable");
  });
});

describe("could Claudian have removed it by itself", () => {
  const record = (body: object) => JSON.stringify({ id: CONV, providerId: "claude", ...body });

  /** Not present and not unknown means in the sync folder, unless listed as nowhere. */
  function transcripts(present: readonly string[], unknown: readonly string[] = [], nowhere: readonly string[] = []) {
    const asked: string[] = [];
    return {
      asked,
      probe: async (id: string): Promise<TranscriptWhere> => {
        asked.push(id);
        if (unknown.includes(id)) return "unknown";
        if (nowhere.includes(id)) return "nowhere";
        return present.includes(id) ? "present" : "arriving";
      },
    };
  }

  it("is all-absent only when every bound transcript is missing here", async () => {
    const body = record({ sessionId: S1, providerState: { previousProviderSessionIds: [S2] } });
    expect(await judgeClaudeHistory(body, CONV, transcripts([]).probe)).toBe("all-absent");
    // One segment here is enough: Claudian resets such a record, it does not
    // delete it — so a missing record with one segment here was the user.
    expect(await judgeClaudeHistory(body, CONV, transcripts([S2]).probe)).toBe("some-present");
    expect(await judgeClaudeHistory(body, CONV, transcripts([S1]).probe)).toBe("some-present");
  });

  it("needs the history to be on its way: missing everywhere is not Claudian's doing", async () => {
    // Claude Code purges transcripts after thirty days, and old conversations
    // are the ones users clean up. A restore there brings back every delete,
    // with a promise of history that is not coming (review, 2026-10-14).
    const body = record({ sessionId: S1, providerState: { previousProviderSessionIds: [S2] } });
    expect(await judgeClaudeHistory(body, CONV, transcripts([], [], [S1, S2]).probe)).toBe("nowhere");
    // One segment in the sync folder is enough to be on its way.
    expect(await judgeClaudeHistory(body, CONV, transcripts([], [], [S1]).probe)).toBe("all-absent");
  });

  it("does not guess where the projects folder cannot be read", async () => {
    expect(await judgeClaudeHistory(record({ sessionId: S1 }), CONV, transcripts([], [S1]).probe)).toBe("unknown");
  });

  it("treats an id Claudian cannot put in a path as one it keeps", async () => {
    // `isPathSafeId` fails → `unknown` upstream → preserved, never deleted.
    for (const bad of ["x".repeat(129), "../escape", "a/b", "a\\b", "has space"]) {
      const t = transcripts([]);
      expect(await judgeClaudeHistory(record({ sessionId: bad }), CONV, t.probe)).toBe("some-present");
      expect(t.asked).toEqual([]);
    }
    expect(await judgeClaudeHistory(record({ sessionId: 42 }), CONV, transcripts([]).probe)).toBe("some-present");
  });

  it("is not applicable to records that cannot have been auto-deleted", async () => {
    expect(await judgeClaudeHistory(record({ sessionId: null }), CONV, transcripts([]).probe)).toBe("not-applicable");
    // The reset shape Claudian writes when its Claude environment changes: no
    // current session, so upstream's R2 returns "preserve" before it looks at
    // the old ids — whatever is missing (review, 2026-10-14).
    const reset = record({ sessionId: null, providerState: { previousProviderSessionIds: [S1, S2] } });
    expect(await judgeClaudeHistory(reset, CONV, transcripts([]).probe)).toBe("not-applicable");
    const codex = JSON.stringify({ id: CONV, providerId: "codex", sessionId: S1 });
    expect(await judgeClaudeHistory(codex, CONV, transcripts([]).probe)).toBe("not-applicable");
  });

  it("does not know about a record it cannot read", async () => {
    expect(await judgeClaudeHistory("{", CONV, transcripts([]).probe)).toBe("unknown");
  });
});

describe("what counts as another device changing a held record", () => {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const body = {
    id: CONV,
    providerId: "claude",
    title: "Plan the trip",
    lastActivityAt: 100,
    sessionId: S1,
    isArchived: false,
    isPinned: true,
    providerState: { providerSessionId: S1 },
  };
  const digest = (value: object, indent?: number) => recordDigest(JSON.stringify(value, null, indent), hash);

  it("ignores what Claudian rewrites with nobody touching the conversation", () => {
    const original = digest(body);
    expect(digest(body, 2)).toBe(original); // pretty vs compact (2.3.6)
    expect(digest({ ...body, isArchived: true, isPinned: false })).toBe(original); // auto-archive
    expect(digest({ ...body, subagentData: { a: { result: "stripped" } } })).toBe(original); // 2.3.8
  });

  it("ignores Claudian moving the same session ids between slots", () => {
    // clearClaudeResumeState, on every record, when the Claude environment changes.
    const before = digest({ ...body, sessionId: S1, providerState: { providerSessionId: S1, previousProviderSessionIds: [S3] } });
    const reset = digest({ ...body, sessionId: null, providerState: { previousProviderSessionIds: [S3, S1] } });
    expect(reset).toBe(before);
  });

  it("notices a new title, a new turn, or a new session", () => {
    const original = digest(body);
    expect(digest({ ...body, title: "Plan the other trip" })).not.toBe(original);
    expect(digest({ ...body, lastActivityAt: 200 })).not.toBe(original);
    expect(digest({ ...body, providerState: { providerSessionId: S2 } })).not.toBe(original);
    expect(digest({ ...body, providerState: { providerSessionId: S1, previousProviderSessionIds: [S3] } })).not.toBe(
      original,
    );
  });

  it("is null for a record it cannot read", () => {
    expect(recordDigest("{", hash)).toBeNull();
  });
});
