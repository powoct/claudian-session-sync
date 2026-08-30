/**
 * architecture §11.2 / testing.md §8.4 — the report cannot carry a conversation.
 *
 * This is a gate, not a description. Runtime redaction only catches the places
 * somebody remembered to redact, and the report is serialised into logs, into
 * the dry-run view, and eventually into whatever a user pastes into an issue.
 * The defence is that there is nowhere to put the content in the first place,
 * and the only way that stays true is if adding a field is what turns this red.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import type {
  ActionEntry,
  DecisionEvidence,
  PassReport,
  UnknownFileEntry,
  ViolationEntry,
} from "../../src/orchestration/pass-report";
import { World, WORKSPACE_ID } from "../helpers/world";

const SID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

let world: World | null = null;
afterEach(async () => {
  await world?.dispose();
  world = null;
});

/**
 * Every key any part of a report is allowed to use.
 *
 * Deliberately a list to be maintained by hand: a new field must be added here
 * consciously, which is the moment to ask whether it can hold a conversation.
 */
const ALLOWED_KEYS = new Set([
  // PassReport
  "startedAtMs",
  "finishedAtMs",
  "outcome",
  "dryRun",
  "abortReason",
  "actions",
  "violations",
  "notices",
  "unknownFiles",
  "unprovenOmissions",
  // UnprovenOmissionEntry — `providerId` is shared with ActionEntry below.
  // `name` is a bare member name from the provider's own fixed vocabulary
  // (`signals.json`, `compaction/`), never a path and never derived from
  // anything the user typed; `sessions` is a count. A provider that named a
  // file after a conversation title would break that, which is the reason this
  // list is maintained by hand.
  "name",
  "sessions",
  // ActionEntry
  "providerId",
  "logicalIdPrefix",
  "neutralRel",
  "action",
  "result",
  "reason",
  "flags",
  "conflictKnown",
  "evidence",
  "backupPath",
  "conflictId",
  "errorCode",
  "noReplaceUnavailable",
  // DecisionEvidence
  "level",
  "localLines",
  "remoteLines",
  "relation",
  "stability",
  "localHashPrefix",
  "remoteHashPrefix",
  // ViolationEntry
  "rootSymbol",
  "relativePath",
  "violation",
  "detail",
  // UnknownFileEntry — a name and a classification of that name. `copyOf` is
  // a bare filename taken from the same directory listing, so it is the same
  // class of value as `neutralRel`: an identifier, never a byte of content.
  "kind",
  "confidence",
  "copyOf",
]);

describe("§11.2: no field can hold file content", () => {
  /**
   * Written out one call at a time on purpose.
   *
   * The obvious version — a loop over a list of banned names — compiles
   * clean whether or not the property exists: with a union argument
   * `not.toHaveProperty` stops discriminating, and the gate silently passes
   * forever. It was written that way first, and adding a `content` field to
   * `ActionEntry` did not turn it red. These are compile-time assertions, so
   * `npm run typecheck` is what enforces them; vitest only reports that the
   * file ran.
   */
  it("bans the names on every level of the report", () => {
    // PassReport
    expectTypeOf<PassReport>().not.toHaveProperty("content");
    expectTypeOf<PassReport>().not.toHaveProperty("bytes");
    expectTypeOf<PassReport>().not.toHaveProperty("lines");
    expectTypeOf<PassReport>().not.toHaveProperty("sample");
    expectTypeOf<PassReport>().not.toHaveProperty("head");
    expectTypeOf<PassReport>().not.toHaveProperty("tail");
    expectTypeOf<PassReport>().not.toHaveProperty("text");
    expectTypeOf<PassReport>().not.toHaveProperty("body");
    expectTypeOf<PassReport>().not.toHaveProperty("preview");
    expectTypeOf<PassReport>().not.toHaveProperty("excerpt");
    expectTypeOf<PassReport>().not.toHaveProperty("snippet");
    expectTypeOf<PassReport>().not.toHaveProperty("raw");
    expectTypeOf<PassReport>().not.toHaveProperty("data");
    // ActionEntry
    expectTypeOf<ActionEntry>().not.toHaveProperty("content");
    expectTypeOf<ActionEntry>().not.toHaveProperty("bytes");
    expectTypeOf<ActionEntry>().not.toHaveProperty("lines");
    expectTypeOf<ActionEntry>().not.toHaveProperty("sample");
    expectTypeOf<ActionEntry>().not.toHaveProperty("head");
    expectTypeOf<ActionEntry>().not.toHaveProperty("tail");
    expectTypeOf<ActionEntry>().not.toHaveProperty("text");
    expectTypeOf<ActionEntry>().not.toHaveProperty("body");
    expectTypeOf<ActionEntry>().not.toHaveProperty("preview");
    expectTypeOf<ActionEntry>().not.toHaveProperty("excerpt");
    expectTypeOf<ActionEntry>().not.toHaveProperty("snippet");
    expectTypeOf<ActionEntry>().not.toHaveProperty("raw");
    expectTypeOf<ActionEntry>().not.toHaveProperty("data");
    // DecisionEvidence
    expectTypeOf<DecisionEvidence>().not.toHaveProperty("content");
    expectTypeOf<DecisionEvidence>().not.toHaveProperty("bytes");
    expectTypeOf<DecisionEvidence>().not.toHaveProperty("lines");
    expectTypeOf<DecisionEvidence>().not.toHaveProperty("sample");
    expectTypeOf<DecisionEvidence>().not.toHaveProperty("head");
    expectTypeOf<DecisionEvidence>().not.toHaveProperty("tail");
    expectTypeOf<DecisionEvidence>().not.toHaveProperty("text");
    expectTypeOf<DecisionEvidence>().not.toHaveProperty("body");
    expectTypeOf<DecisionEvidence>().not.toHaveProperty("preview");
    expectTypeOf<DecisionEvidence>().not.toHaveProperty("excerpt");
    expectTypeOf<DecisionEvidence>().not.toHaveProperty("snippet");
    expectTypeOf<DecisionEvidence>().not.toHaveProperty("raw");
    expectTypeOf<DecisionEvidence>().not.toHaveProperty("data");
    // UnknownFileEntry
    expectTypeOf<UnknownFileEntry>().not.toHaveProperty("content");
    expectTypeOf<UnknownFileEntry>().not.toHaveProperty("bytes");
    expectTypeOf<UnknownFileEntry>().not.toHaveProperty("lines");
    expectTypeOf<UnknownFileEntry>().not.toHaveProperty("sample");
    expectTypeOf<UnknownFileEntry>().not.toHaveProperty("head");
    expectTypeOf<UnknownFileEntry>().not.toHaveProperty("tail");
    expectTypeOf<UnknownFileEntry>().not.toHaveProperty("text");
    expectTypeOf<UnknownFileEntry>().not.toHaveProperty("body");
    expectTypeOf<UnknownFileEntry>().not.toHaveProperty("preview");
    expectTypeOf<UnknownFileEntry>().not.toHaveProperty("excerpt");
    expectTypeOf<UnknownFileEntry>().not.toHaveProperty("snippet");
    expectTypeOf<UnknownFileEntry>().not.toHaveProperty("raw");
    expectTypeOf<UnknownFileEntry>().not.toHaveProperty("data");
    // ViolationEntry
    expectTypeOf<ViolationEntry>().not.toHaveProperty("content");
    expectTypeOf<ViolationEntry>().not.toHaveProperty("bytes");
    expectTypeOf<ViolationEntry>().not.toHaveProperty("lines");
    expectTypeOf<ViolationEntry>().not.toHaveProperty("sample");
    expectTypeOf<ViolationEntry>().not.toHaveProperty("head");
    expectTypeOf<ViolationEntry>().not.toHaveProperty("tail");
    expectTypeOf<ViolationEntry>().not.toHaveProperty("text");
    expectTypeOf<ViolationEntry>().not.toHaveProperty("body");
    expectTypeOf<ViolationEntry>().not.toHaveProperty("preview");
    expectTypeOf<ViolationEntry>().not.toHaveProperty("excerpt");
    expectTypeOf<ViolationEntry>().not.toHaveProperty("snippet");
    expectTypeOf<ViolationEntry>().not.toHaveProperty("raw");
    expectTypeOf<ViolationEntry>().not.toHaveProperty("data");
  });

  it("keeps hashes as prefixes and counts as numbers", () => {
    // What *is* allowed: enough to audit a decision, never enough to read one.
    expectTypeOf<DecisionEvidence["localHashPrefix"]>().toEqualTypeOf<string | null>();
    expectTypeOf<DecisionEvidence["localLines"]>().toEqualTypeOf<number | null>();
    expectTypeOf<ActionEntry["logicalIdPrefix"]>().toEqualTypeOf<string>();
  });
});

describe("a real report from an eventful pass", () => {
  it("uses no key outside the allowlist and leaks no session text", async () => {
    world = World.create();
    const w = world;
    const a = w.machine("A");
    const b = w.machine("B");

    // A pass with something in every bucket: a push, a pull, an overwrite with
    // a backup, and a conflict with a quarantine id.
    const sentinel = "AISS-SENTINEL-9f3c1d";
    await a.cli.session(SID).append(5);
    await a.pass();
    await a.pass();
    await w.flush("A", "B");
    await b.pass();
    await b.pass();

    await a.cli.session(SID).appendRaw(`{"uuid":"a","text":"${sentinel}-A"}\n`);
    await b.cli.session(SID).appendRaw(`{"uuid":"b","text":"${sentinel}-B"}\n`);
    await b.pass();
    await b.pass();
    await w.flush("B", "A");
    await a.pass();
    const report = await a.pass();

    expect(report.actions.length, "the pass must have done something").toBeGreaterThan(0);
    expect(report.actions.some((x) => x.action === "CONFLICT")).toBe(true);

    for (const key of keysOf(report)) {
      expect(ALLOWED_KEYS, `unexpected report key: ${key}`).toContain(key);
    }
    // And the same claim from the other direction: the bytes are not in there.
    expect(JSON.stringify(report)).not.toContain(sentinel);

    // The quarantine copies do hold the content — that is their job — so the
    // check above would be worth little if nothing had been quarantined.
    const quarantine = path.join(a.replicaRoot, ".quarantine", WORKSPACE_ID, "claude-code");
    expect((await fsp.readdir(quarantine)).length).toBeGreaterThan(0);
  });
});

function keysOf(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) keysOf(item, into);
    return into;
  }
  if (typeof value !== "object" || value === null) return into;
  for (const [key, nested] of Object.entries(value)) {
    into.add(key);
    keysOf(nested, into);
  }
  return into;
}
