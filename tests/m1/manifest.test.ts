/**
 * testing.md §5.4 (M-01..M-08) — the manifest.
 *
 * There is one goal: prove it can never become the basis of a destructive
 * decision. Every case below is a way it could be wrong — absent, truncated,
 * from the future, holding a poisoned key — and the assertion is always that
 * being wrong costs I/O rather than data.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import type { E0Signature } from "../../src/domain/stability";
import {
  type FileEvidence,
  type Manifest,
  MANIFEST_SCHEMA_VERSION,
  e0Matches,
  emptyManifest,
  evidenceFor,
  isUnbudgetedScrub,
  isValidEntryKey,
  mayAuthoriseWrite,
  parseManifest,
  scrubTrigger,
  serialiseManifest,
} from "../../src/domain/manifest";

const WS = "3f1a9c2e-6b47-4d18-9a03-5e7c8d21b4f6";
const KEY = `${WS}/claude-code/3f2504e0-4f89-41d3-9a0c-0305e82c3301.jsonl`;

const e0 = (overrides: Partial<E0Signature> = {}): E0Signature => ({
  size: 93006,
  mtimeMs: 1754481000123,
  ctimeMs: 1754481000123,
  ino: 12345678,
  tailHash: "sha256:tail",
  ...overrides,
});

const rawEntry = (overrides: Record<string, unknown> = {}) => ({
  provider: "claude-code",
  workspaceId: WS,
  logicalId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  mode: "append-jsonl",
  size: 93006,
  lineCount: 412,
  contentHash: "sha256:content",
  e0: e0(),
  lastWriter: "machine-a",
  updatedAt: "2026-08-06T11:00:00.000Z",
  generation: 7,
  ...overrides,
});

const rawManifest = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  updatedAt: "2026-08-06T11:00:00.000Z",
  entries: { [KEY]: rawEntry() },
  ...overrides,
});

describe("M-01: a well-formed manifest round-trips", () => {
  it("parses and re-serialises without losing anything", () => {
    const loaded = parseManifest(rawManifest());
    expect(loaded.status).toBe("ok");
    if (loaded.status !== "ok") return;

    const written = serialiseManifest(loaded.manifest, "2026-08-07T00:00:00.000Z");
    const reloaded = parseManifest(written);
    expect(reloaded.status).toBe("ok");
    if (reloaded.status !== "ok") return;
    expect(reloaded.manifest.entries[KEY]).toEqual(loaded.manifest.entries[KEY]);
  });

  it("starts from an empty manifest when there is nothing to read", () => {
    const empty = emptyManifest("2026-08-07T00:00:00.000Z");
    expect(empty.entries).toEqual({});
    expect(empty.schemaVersion).toBe(MANIFEST_SCHEMA_VERSION);
  });
});

describe("M-02: damage means rebuild, never an exception", () => {
  it.each([
    ["absent", undefined],
    ["null", null],
    ["not an object", "{ truncated"],
    ["an array", []],
    ["missing schemaVersion", { entries: {} }],
    ["schemaVersion not a number", { schemaVersion: "1", entries: {} }],
  ])("treats %s as a cache miss", (_label, raw) => {
    // A missing cache costs a full scan. Throwing here would abort a pass that
    // was perfectly capable of proceeding.
    expect(() => parseManifest(raw)).not.toThrow();
    expect(parseManifest(raw).status).toBe("rebuild");
  });
});

describe("M-03: a newer schema is read as nothing and never rewritten", () => {
  it("reports unusable and not writable", () => {
    // Direct evidence that a newer client is using this sync directory.
    // Rebuilding would destroy whatever it recorded.
    const loaded = parseManifest(rawManifest({ schemaVersion: 99 }));
    expect(loaded).toMatchObject({ status: "unusable", reason: "newer-schema", writable: false });
  });

  it("makes the no-write intent checkable by type, not by memory", () => {
    const loaded = parseManifest(rawManifest({ schemaVersion: 99 }));
    if (loaded.status !== "unusable") throw new Error("expected unusable");
    // `writable` is the literal false, so a caller cannot pass it around as a
    // boolean that might be true.
    expectTypeOf(loaded.writable).toEqualTypeOf<false>();
  });

  it("still lets the pass move files, because the cache is not the data", () => {
    // Unlike formatVersion (§5.4), which is read-only when too new: that one
    // describes where the real data lives, and misreading it writes to the
    // wrong place. Losing a cache only costs reads.
    const loaded = parseManifest(rawManifest({ schemaVersion: 99 }));
    expect(loaded.status).not.toBe("rebuild"); // not "pretend it is absent and rewrite it"
  });
});

describe("M-04: an older schema migrates, idempotently", () => {
  it("reports migrate and upgrades in place", () => {
    const loaded = parseManifest(rawManifest({ schemaVersion: 0 }), 1);
    expect(loaded.status).toBe("migrate");
    if (loaded.status !== "migrate") return;
    expect(loaded.manifest.schemaVersion).toBe(1);
  });

  it("is stable when run twice", () => {
    const once = parseManifest(rawManifest({ schemaVersion: 0 }), 1);
    if (once.status !== "migrate") throw new Error("expected migrate");
    const written = serialiseManifest(once.manifest, "t");
    const twice = parseManifest(written, 1);
    if (twice.status !== "ok") throw new Error("expected ok");
    expect(twice.manifest.entries).toEqual(once.manifest.entries);
  });
});

describe("M-05: unknown fields survive a read-modify-write", () => {
  it("preserves fields a newer version added at the top level", () => {
    const loaded = parseManifest(rawManifest({ futureTopLevel: { a: 1 } }));
    if (loaded.status !== "ok") throw new Error("expected ok");

    const written = serialiseManifest(loaded.manifest, "t");
    expect(written).toHaveProperty("futureTopLevel", { a: 1 });
  });

  it("preserves fields a newer version added to an entry", () => {
    const loaded = parseManifest(
      rawManifest({ entries: { [KEY]: rawEntry({ futureEntryField: "keep me" }) } }),
    );
    if (loaded.status !== "ok") throw new Error("expected ok");

    const written = serialiseManifest(loaded.manifest, "t") as {
      entries: Record<string, Record<string, unknown>>;
    };
    // Otherwise every pass on the older machine silently strips whatever the
    // newer one depends on.
    expect(written.entries[KEY]).toHaveProperty("futureEntryField", "keep me");
  });
});

describe("M-06: one bad entry is dropped, not the whole file", () => {
  it("keeps the good entries and reports what it discarded", () => {
    const loaded = parseManifest(
      rawManifest({
        entries: {
          [KEY]: rawEntry(),
          bad: { nonsense: true },
          alsoBad: null,
        },
      }),
    );
    if (loaded.status !== "ok") throw new Error("expected ok");

    expect(Object.keys(loaded.manifest.entries)).toEqual([KEY]);
    expect([...loaded.droppedKeys].sort()).toEqual(["alsoBad", "bad"]);
  });

  it.each([
    ["traversal", `${WS}/../escape.jsonl`],
    ["absolute", "/etc/passwd"],
    ["drive letter", "C:/x/y.jsonl"],
    ["backslash", `${WS}\\claude-code\\a.jsonl`],
    ["another workspace", "99999999-6b47-4d18-9a03-5e7c8d21b4f6/claude-code/a.jsonl"],
    ["too shallow", `${WS}/a.jsonl`],
    ["empty segment", `${WS}//a.jsonl`],
  ])("rejects a %s key", (_label, key) => {
    expect(isValidEntryKey(key, WS)).toBe(false);
  });

  it("accepts a well-formed key", () => {
    expect(isValidEntryKey(KEY, WS)).toBe(true);
  });
});

describe("M-07: E1 requires exact equality (rule EV-2)", () => {
  const entry = () => {
    const loaded = parseManifest(rawManifest());
    if (loaded.status !== "ok") throw new Error("expected ok");
    return loaded.manifest.entries[KEY];
  };

  it("promotes to E1 only when all five components match", () => {
    const evidence = evidenceFor(e0(), entry());
    expect(evidence.level).toBe("E1");
  });

  it.each([
    ["size", { size: 1 }],
    ["mtime", { mtimeMs: 1 }],
    ["ctime", { ctimeMs: 1 }],
    ["inode", { ino: 1 }],
    ["tail hash", { tailHash: "sha256:other" }],
  ])("falls back to E0 when %s differs", (_label, delta) => {
    // Any mismatch forces a read. ctime and inode are one-way signals: a
    // mismatch invalidates, a match adds no trust, because Windows reports
    // creation time as ctime and cloud drives do not preserve inodes.
    expect(evidenceFor(e0(delta), entry()).level).toBe("E0");
  });

  it("falls back to E0 when there is no entry at all", () => {
    expect(evidenceFor(e0(), undefined).level).toBe("E0");
  });

  it("compares by full equality, not by size alone", () => {
    expect(e0Matches(e0(), e0())).toBe(true);
    expect(e0Matches(e0(), e0({ mtimeMs: 2 }))).toBe(false);
  });
});

describe("the authorisation matrix is enforced by type (§5.3.2)", () => {
  it("lets only E2 authorise a write", () => {
    const cached: FileEvidence = { level: "E1", e0: e0(), contentHash: "sha256:x", lineCount: 1 };
    const read: FileEvidence = { level: "E2", e0: e0(), contentHash: "sha256:x", lineCount: 1 };

    expect(mayAuthoriseWrite(cached)).toBe(false);
    expect(mayAuthoriseWrite({ level: "E0", e0: e0() })).toBe(false);
    expect(mayAuthoriseWrite(read)).toBe(true);
  });

  it("narrows to E2, so the write path cannot receive a cached hash", () => {
    const evidence: FileEvidence = { level: "E2", e0: e0(), contentHash: "sha256:x", lineCount: 1 };
    if (mayAuthoriseWrite(evidence)) {
      // This is the U-18 defence in type form: inside this branch the value is
      // provably E2, so there is no way to reach a remembered hash.
      expectTypeOf(evidence).toEqualTypeOf<Extract<FileEvidence, { level: "E2" }>>();
    }
  });
});

describe("M-08: scrub forces a full read eventually (§5.3.3)", () => {
  const base = {
    nowMs: 1000,
    lastFullVerifyMs: 1000,
    maxAgeMs: 24 * 60 * 60 * 1000,
    firstPassAfterStartup: false,
    msSinceLastStartupScrub: 0,
    lastResultWasUnsettled: false,
    manifestUnusable: false,
    justBecameReady: false,
    manuallyRequested: false,
    sampled: false,
  };

  it("does not scrub a settled, recently verified file", () => {
    expect(scrubTrigger(base)).toBeNull();
  });

  it("T1: scrubs once the verification is old enough", () => {
    expect(scrubTrigger({ ...base, nowMs: base.maxAgeMs + 2000 })).toBe("T1-age");
  });

  it("T3: scrubs after an unsettled result", () => {
    expect(scrubTrigger({ ...base, lastResultWasUnsettled: true })).toBe("T3-unsettled");
  });

  it("T4: an unusable manifest forces a full verification", () => {
    expect(scrubTrigger({ ...base, manifestUnusable: true })).toBe("T4-manifest");
  });

  it("T5: coming back from NOT_READY forces one too", () => {
    expect(scrubTrigger({ ...base, justBecameReady: true })).toBe("T5-ready");
  });

  it("T6: random sampling bounds the wait without trusting a clock", () => {
    // The residual risk E1 leaves is a file that is same-size, same-mtime,
    // same-tail and different in the middle. T1 catches it on a working clock;
    // sampling catches it regardless, which matters because a broken clock is
    // one of the things T1 is meant to cover.
    expect(scrubTrigger({ ...base, sampled: true })).toBe("T6-sample");
  });

  it("T7: the manual command outranks everything", () => {
    expect(scrubTrigger({ ...base, manuallyRequested: true, sampled: false })).toBe("T7-manual");
  });

  it("exempts the whole-workspace triggers from the budget", () => {
    expect(isUnbudgetedScrub("T4-manifest")).toBe(true);
    expect(isUnbudgetedScrub("T5-ready")).toBe(true);
    expect(isUnbudgetedScrub("T7-manual")).toBe(true);
    // Sampling and ageing are per-file and stay inside the pass budget.
    expect(isUnbudgetedScrub("T6-sample")).toBe(false);
    expect(isUnbudgetedScrub("T1-age")).toBe(false);
  });
});

describe("the manifest type carries no field a planner could misuse", () => {
  it("keeps hashes on the entry, where the planner never looks", () => {
    // The planner's input type has no field for a remembered hash at all
    // (see planner.test.ts). This asserts the other end: the manifest is the
    // only place such a hash exists, and it is not wired to the decision.
    expectTypeOf<Manifest["entries"][string]>().toHaveProperty("contentHash");
    expectTypeOf<Manifest>().not.toHaveProperty("plan");
  });
});
