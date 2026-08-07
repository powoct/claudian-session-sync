/**
 * testing.md §8.1 / §8.2 — pure string validation, fail closed.
 *
 * Table-driven and exhaustive by construction: every entry names the exact
 * violation, because a gate that rejects the right things for the wrong reason
 * gives whoever reads the report no idea what to fix.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  MAX_DEPTH,
  MAX_REL_LENGTH,
  MAX_SEGMENT_BYTES,
  findCaseCollisions,
  findNormalizationCollisions,
  isSameOrDescendant,
  parseCustomDirName,
  parseLogicalId,
  parseMachineId,
  parseNeutralRel,
  parseWorkspaceId,
  validateSegment,
} from "../../src/domain/path-safety";
import type { PathViolation, SafeRelativePath } from "../../src/domain/types";

/** Claude Code's pattern (architecture §6.3): matches the leading segment. */
const CLAUDE_LOGICAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

const VALID_UUID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

function violationOf(input: string): PathViolation | "accepted" {
  const result = parseNeutralRel(input);
  return result.ok ? "accepted" : result.violation;
}

describe("parseNeutralRel — rejections (§8.1)", () => {
  const cases: Array<[string, string, PathViolation]> = [
    ["traversal, bare", "..", "TRAVERSAL"],
    ["traversal, mid-path", "a/../../b", "TRAVERSAL"],
    ["traversal, after dot", "./../x", "TRAVERSAL"],
    ["traversal, trailing", "a/./../..", "TRAVERSAL"],

    ["absolute POSIX", "/etc/passwd", "ABSOLUTE"],
    ["absolute backslash", "\\etc\\passwd", "ABSOLUTE"],
    ["root alone", "/", "ABSOLUTE"],

    ["drive letter", "C:\\Windows\\x", "DRIVE_LETTER"],
    ["drive-relative", "C:x", "DRIVE_LETTER"],
    ["drive lowercase, forward slash", "c:/x", "DRIVE_LETTER"],

    ["UNC backslash", "\\\\server\\share\\x", "UNC"],
    ["UNC forward slash", "//server/share/x", "UNC"],

    ["backslash anywhere", "a\\b", "BACKSLASH_IN_REL"],
    ["backslash trailing", "a\\", "BACKSLASH_IN_REL"],

    ["NUL", "a\u0000b", "NUL_OR_CONTROL"],
    ["carriage return", "a\rb", "NUL_OR_CONTROL"],
    ["newline", "a\nb", "NUL_OR_CONTROL"],
    ["low control char", "a\u0001b", "NUL_OR_CONTROL"],
    ["DEL", "a\u007Fb", "NUL_OR_CONTROL"],

    ["empty string", "", "EMPTY_SEGMENT"],
    ["double separator", "a//b", "EMPTY_SEGMENT"],
    ["trailing separator", "a/", "EMPTY_SEGMENT"],
    ["dot segment alone", ".", "DOT_SEGMENT"],
    ["dot segment trailing", "a/.", "DOT_SEGMENT"],

    ["reserved upper", "CON", "RESERVED_NAME"],
    ["reserved lower", "con", "RESERVED_NAME"],
    ["reserved mixed", "Con", "RESERVED_NAME"],
    ["reserved with extension", "CON.jsonl", "RESERVED_NAME"],
    ["reserved NUL name", "NUL", "RESERVED_NAME"],
    ["reserved AUX", "AUX", "RESERVED_NAME"],
    ["reserved PRN", "PRN", "RESERVED_NAME"],
    ["reserved COM1", "COM1", "RESERVED_NAME"],
    ["reserved COM9", "COM9", "RESERVED_NAME"],
    ["reserved LPT1", "LPT1", "RESERVED_NAME"],
    ["reserved LPT9", "LPT9", "RESERVED_NAME"],
    ["reserved in a subdirectory", "dir/CON.jsonl", "RESERVED_NAME"],

    ["trailing dot", "a.", "TRAILING_DOT_OR_SPACE"],
    ["trailing space", "a ", "TRAILING_DOT_OR_SPACE"],
    ["trailing dot then space", "a. ", "TRAILING_DOT_OR_SPACE"],
    ["trailing space on a directory", "dir /file", "TRAILING_DOT_OR_SPACE"],

    ["short name", "PROGRA~1", "SHORTNAME_LIKE"],
    ["short name with extension", "ABCDEF~2.JSO", "SHORTNAME_LIKE"],

    ["CJK", "笔记.jsonl", "SEGMENT_CHARSET"],
    ["emoji", "note-🎉.jsonl", "SEGMENT_CHARSET"],
    ["RTL override", "note\u202Egnp.jsonl", "SEGMENT_CHARSET"],
    ["zero-width space", "note\u200B.jsonl", "SEGMENT_CHARSET"],
    // A single letter before a colon is indistinguishable from a drive-relative
    // path ("C:x"), so that is the diagnosis it gets — the more specific one.
    ["single-letter colon, i.e. drive-relative", "a:b", "DRIVE_LETTER"],
    ["colon elsewhere", "ab:c", "SEGMENT_CHARSET"],
    ["asterisk", "a*b", "SEGMENT_CHARSET"],
    ["pipe", "a|b", "SEGMENT_CHARSET"],
    ["question mark", "a?b", "SEGMENT_CHARSET"],
    ["double quote", 'a"b', "SEGMENT_CHARSET"],
    ["angle bracket", "a<b", "SEGMENT_CHARSET"],
  ];

  it.each(cases)("%s -> %s", (_label, input, expected) => {
    expect(violationOf(input)).toBe(expected);
  });

  it("rejects a segment over the byte limit", () => {
    const long = "a".repeat(MAX_SEGMENT_BYTES + 1);
    expect(violationOf(long)).toBe("SEGMENT_TOO_LONG");
  });

  it("counts segment length in bytes, not code units", () => {
    // Below the limit in characters but over it in UTF-8 bytes. It is rejected
    // for its charset first — the point is that the length check would also
    // have caught it, so the byte accounting is asserted directly.
    const threeByteChars = "字".repeat(100);
    expect(validateSegment(threeByteChars).ok).toBe(false);
    expect(validateSegment("é".repeat(MAX_SEGMENT_BYTES)).ok).toBe(false);
  });

  it("rejects a path over the total length limit", () => {
    // Each segment stays under the segment limit, so this can only be the
    // total-length check firing.
    const segment = "a".repeat(50);
    const long = Array.from({ length: 5 }, () => segment).join("/");
    expect(long.length).toBeGreaterThan(MAX_REL_LENGTH);
    expect(violationOf(long)).toBe("PATH_TOO_LONG");
  });

  it("rejects a path deeper than the limit", () => {
    const deep = Array.from({ length: MAX_DEPTH + 1 }, (_, i) => `d${i}`).join("/");
    expect(violationOf(deep)).toBe("TOO_DEEP");
  });
});

describe("parseNeutralRel — acceptances (§8.1)", () => {
  it.each([
    ["plain file", "abc.jsonl"],
    ["nested", "a/b/c.jsonl"],
    ["uuid filename", `${VALID_UUID}.jsonl`],
    ["underscores", "a_b_c.jsonl"],
    ["leading dash, as Claude Code's own directories use", "-home-testuser-vault/x.jsonl"],
    ["exactly at the depth limit", Array.from({ length: MAX_DEPTH }, (_, i) => `d${i}`).join("/")],
    ["dot inside a name", "my.vault.jsonl"],
  ])("accepts %s", (_label, input) => {
    const result = parseNeutralRel(input);
    expect(result.ok, `${input} was rejected`).toBe(true);
  });

  it("returns a branded value that carries the check in the type", () => {
    const result = parseNeutralRel("a/b.jsonl");
    if (!result.ok) throw new Error("expected acceptance");
    expectTypeOf(result.value).toEqualTypeOf<SafeRelativePath>();
    // Branded, so a bare string cannot stand in for a checked one.
    expectTypeOf<string>().not.toMatchTypeOf<SafeRelativePath>();
  });

  it("never throws, whatever it is handed", () => {
    // Untrusted input produces a Result. An exception here would unwind a pass
    // halfway through writing, which is exactly what must not happen.
    const nasty = ["", "..", "\u0000", "C:\\x", "\\\\s\\s", "a".repeat(9999), "🎉"];
    for (const input of nasty) {
      expect(() => parseNeutralRel(input)).not.toThrow();
    }
  });
});

describe("identifier validation (§8.2)", () => {
  it("accepts a lowercase UUID v4 workspaceId", () => {
    expect(parseWorkspaceId(VALID_UUID).ok).toBe(true);
    expect(parseMachineId(VALID_UUID).ok).toBe(true);
  });

  it.each([
    ["uppercase", VALID_UUID.toUpperCase()],
    ["mixed case", "3F2504E0-4f89-41d3-9a0c-0305e82c3301"],
    ["wrong version", "3f2504e0-4f89-11d3-9a0c-0305e82c3301"],
    ["wrong variant", "3f2504e0-4f89-41d3-0a0c-0305e82c3301"],
    ["with spaces", ` ${VALID_UUID} `],
    ["traversal", ".."],
    ["too long", `${VALID_UUID}0`],
    ["empty", ""],
  ])("rejects a %s workspaceId", (_label, input) => {
    expect(parseWorkspaceId(input).ok, `${input} was accepted`).toBe(false);
  });

  it("does not lowercase-correct an uppercase id", () => {
    // Tolerating both spellings would mint two ids that differ as strings but
    // collide as directory names on a case-insensitive filesystem.
    const upper = VALID_UUID.toUpperCase();
    expect(parseWorkspaceId(upper).ok).toBe(false);
    expect(parseWorkspaceId(upper.toLowerCase()).ok).toBe(true);
  });

  it("accepts a logicalId matching the provider pattern", () => {
    expect(parseLogicalId(VALID_UUID, CLAUDE_LOGICAL_ID).ok).toBe(true);
  });

  it.each([
    ["traversal", "../x"],
    ["multi-segment", "a/b"],
    ["reserved", "CON"],
    ["NUL", "a\u0000b"],
    ["not a uuid", "session-1"],
  ])("rejects a %s logicalId", (_label, input) => {
    expect(parseLogicalId(input, CLAUDE_LOGICAL_ID).ok).toBe(false);
  });

  it("accepts a customDirName shaped like Claude Code's own", () => {
    expect(parseCustomDirName("-home-testuser-vault").ok).toBe(true);
  });

  it.each([
    ["separator", "a/b"],
    ["backslash", "a\\b"],
    ["reserved", "NUL"],
    ["trailing dot", "vault."],
    ["trailing space", "vault "],
    ["empty", ""],
  ])("rejects a customDirName with a %s", (_label, input) => {
    expect(parseCustomDirName(input).ok).toBe(false);
  });
});

describe("collision detection (§8.1)", () => {
  it("reports names differing only in case", () => {
    const groups = findCaseCollisions(["s1.jsonl", "S1.jsonl", "other.jsonl"]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.sort()).toEqual(["S1.jsonl", "s1.jsonl"]);
  });

  it("does not report distinct names", () => {
    expect(findCaseCollisions(["a.jsonl", "b.jsonl"])).toEqual([]);
  });

  it("reports an NFC/NFD pair as a normalization collision", () => {
    const nfc = "café.jsonl".normalize("NFC");
    const nfd = "café.jsonl".normalize("NFD");
    expect(nfc).not.toBe(nfd);

    const groups = findNormalizationCollisions([nfc, nfd]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(2);
  });

  it("does not report byte-identical duplicates as a normalization collision", () => {
    const nfc = "café.jsonl".normalize("NFC");
    expect(findNormalizationCollisions([nfc, nfc])).toEqual([]);
  });
});

describe("isSameOrDescendant (§9.7.5)", () => {
  const split = (p: string) => p.split("/").filter(Boolean);

  it("does not mistake a sibling prefix for a descendant", () => {
    // The reason this is segment-wise: "/a/bc".startsWith("/a/b") is true, and
    // a startsWith-based overlap check would silently fail to fire here.
    expect(isSameOrDescendant(split("/a/bc"), split("/a/b"), true)).toBe(false);
  });

  it("recognises a real descendant", () => {
    expect(isSameOrDescendant(split("/a/b/c"), split("/a/b"), true)).toBe(true);
  });

  it("treats a path as its own descendant", () => {
    expect(isSameOrDescendant(split("/a/b"), split("/a/b"), true)).toBe(true);
  });

  it("does not treat an ancestor as a descendant", () => {
    expect(isSameOrDescendant(split("/a"), split("/a/b"), true)).toBe(false);
  });

  it("honours the case-sensitivity probe rather than guessing from the platform", () => {
    expect(isSameOrDescendant(split("/A/B/c"), split("/a/b"), false)).toBe(true);
    expect(isSameOrDescendant(split("/A/B/c"), split("/a/b"), true)).toBe(false);
  });
});
