/**
 * testing.md §5.1 — Claude Code's project-directory escape rule.
 *
 * Table-driven off the measured samples. The rule decides which directory a
 * user's conversation history gets written into, so every expectation here is
 * real CLI output rather than a reading of the rule.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import { escapeProjectPath, unescapeProjectDirName } from "../../src/providers/claude-code/path-escape";
import { InvalidInputError } from "../../src/domain/types";

interface EscapeCase {
  input: string;
  expected: string;
  platform: "linux" | "darwin" | "win32";
  verified: boolean;
  source: string;
  note?: string;
}

const FIXTURE = path.join(
  fileURLToPath(new URL("../fixtures/path-escape-cases.json", import.meta.url)),
);
const CASES: EscapeCase[] = JSON.parse(readFileSync(FIXTURE, "utf8")).cases;

/**
 * M1 exit requires this to be 0 (testing.md §5.1). The mechanism stays for
 * future CLI versions and new providers: an unmeasured expectation may be
 * recorded, but it may never silently count as evidence.
 */
const EXPECTED_UNVERIFIED = 0;

describe("escapeProjectPath — measured samples", () => {
  it.each(CASES.filter((entry) => entry.verified))(
    "$platform: $input",
    ({ input, expected }) => {
      expect(escapeProjectPath(input)).toBe(expected);
    },
  );

  it("has no unverified samples left", () => {
    const unverified = CASES.filter((entry) => !entry.verified);
    expect(
      unverified.map((entry) => entry.input),
      "an unverified expectation is a guess about where user data gets written",
    ).toHaveLength(EXPECTED_UNVERIFIED);
  });

  it("covers all three platforms", () => {
    const platforms = new Set(CASES.map((entry) => entry.platform));
    expect([...platforms].sort()).toEqual(["darwin", "linux", "win32"]);
  });
});

describe("escapeProjectPath — the rule itself", () => {
  it("keeps only [A-Za-z0-9-]", () => {
    expect(escapeProjectPath("/a1-B2_c3.d4 e5")).toBe("-a1-B2-c3-d4-e5");
  });

  it("maps each non-ASCII character to exactly one dash", () => {
    expect(escapeProjectPath("/中文")).toBe("---");
    expect(escapeProjectPath("/中文目录")).toBe("-----");
  });

  it("preserves case", () => {
    expect(escapeProjectPath("/UPPER-lower")).toBe("-UPPER-lower");
  });

  it("collapses nothing — every character maps to exactly one character", () => {
    const input = "/a//b...c";
    expect(escapeProjectPath(input)).toHaveLength(input.length);
  });

  it("treats a Windows drive prefix as two characters, giving C--", () => {
    expect(escapeProjectPath("C:\\x")).toBe("C--x");
    expect(escapeProjectPath("C:/x")).toBe("C--x");
  });
});

describe("escapeProjectPath — rejections", () => {
  it("rejects its own output, rather than being idempotent", () => {
    // The whole point: feeding an escaped name back in is a real bug, and an
    // idempotent implementation would let it produce a plausible directory name
    // and go unnoticed until someone's history landed in the wrong place.
    expect(() => escapeProjectPath(escapeProjectPath("/Users/testuser/vault"))).toThrow(
      InvalidInputError,
    );
  });

  it.each([
    ["relative", "vault/notes"],
    ["bare name", "vault"],
    ["empty", ""],
    ["dot-relative", "./vault"],
    ["drive-relative", "C:vault"],
    ["escaped POSIX name", "-Users-testuser-vault"],
    ["escaped Windows name", "C--Users-testuser-vault"],
  ])("rejects a non-absolute input (%s)", (_label, input) => {
    expect(() => escapeProjectPath(input)).toThrow(InvalidInputError);
  });

  it.each([
    ["backslash UNC", "\\\\server\\share\\vault"],
    ["forward-slash UNC", "//server/share/vault"],
  ])("rejects UNC, which was never measured (%s)", (_label, input) => {
    expect(() => escapeProjectPath(input)).toThrow(InvalidInputError);
  });
});

describe("unescapeProjectDirName is diagnostic only", () => {
  it("never claims certainty", () => {
    const result = unescapeProjectDirName("-Users-testuser-vault");
    expect(result.certain).toBe(false);
    expect(result.candidates.length).toBeGreaterThan(0);
  });

  it("offers a Windows reading for a drive-prefixed name", () => {
    expect(unescapeProjectDirName("C--Users-testuser-vault").candidates).toContain(
      "C:\\Users\\testuser\\vault",
    );
  });

  it("cannot be handed to something that lands a file", () => {
    // Type-level guard (testing.md §5.1): the result has no `value: string` to
    // reach for, so there is no way to accidentally use a guess as a real path.
    expectTypeOf(unescapeProjectDirName).returns.not.toEqualTypeOf<string>();
    expectTypeOf(unescapeProjectDirName).returns.toHaveProperty("certain");
    expectTypeOf<ReturnType<typeof unescapeProjectDirName>["certain"]>().toEqualTypeOf<false>();
  });

  it("round-trips only by luck, which is why it is not used for landing", () => {
    const original = "/Users/testuser/my.vault";
    const [guess] = unescapeProjectDirName(escapeProjectPath(original)).candidates;
    expect(guess).not.toBe(original);
  });
});
