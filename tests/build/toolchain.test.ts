/**
 * The toolchain is pointed at the right files.
 *
 * `tsc --noEmit` and `eslint .` both report success when they are handed
 * nothing to check, and a mistyped glob produces exactly that: during M0,
 * widening tsconfig's include to "src/**\/*.{ts,mts}" left typecheck inspecting
 * three config files and passing in 0.4 s, because tsconfig globs — unlike
 * ESLint's — have no brace expansion. Nothing else in the suite noticed.
 *
 * So these tests assert the programs are non-empty and contain the files that
 * matter. testing.md §3 requirement 5 makes typecheck part of the security
 * gate; a typecheck over an empty program is not a gate.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

function repoFilesInProgram(): string[] {
  const tsc = path.join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");
  const result = spawnSync(process.execPath, [tsc, "--noEmit", "--listFiles"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  // tsc prints forward slashes even on Windows, while REPO_ROOT carries the
  // platform separator — comparing them directly yields an empty list, which
  // looks exactly like "tsc checked nothing".
  const root = REPO_ROOT.split("\\").join("/");
  return (result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.split("\\").join("/"))
    .filter((line) => line.startsWith(root) && !line.includes("node_modules"))
    .map((line) => line.slice(root.length).replace(/^\//, ""));
}

describe("typecheck covers the code it is meant to guard", () => {
  it("includes src/ and tests/, not just the config files", () => {
    const files = repoFilesInProgram();

    expect(files, "tsc is checking an empty program — the include globs are wrong").toContain(
      "src/main.ts",
    );
    expect(files).toContain("tests/helpers/obsidian-stub.ts");
    expect(files).toContain("tests/build/toolchain.test.ts");
    expect(files.length).toBeGreaterThan(5);
  }, 180_000);
});

describe("lint covers the code it is meant to guard", () => {
  /**
   * Asked of ESLint's config resolution, not of a full lint run.
   *
   * The question is "would this file be linted", and `isPathIgnored` answers
   * exactly that in milliseconds. Actually linting the repo answers it too,
   * and used to — but once type-aware rules were switched on that meant
   * building a TypeScript program inside a test worker while the rest of the
   * suite ran, which is slow enough to be flaky and heavy enough to be killed.
   * The old form also swallowed that: `JSON.parse(stdout || "[]")` turns "the
   * linter died" into "the linter reported nothing", and the two need
   * different fixes.
   */
  it("reports on src/, tests/, scripts/ — and never on build output", async () => {
    const eslint = new ESLint({ cwd: REPO_ROOT });
    const linted = async (rel: string) =>
      !(await eslint.isPathIgnored(path.join(REPO_ROOT, rel)));

    expect(await linted("src/main.ts")).toBe(true);
    expect(await linted("src/domain/planner.ts")).toBe(true);
    expect(await linted("eslint.config.mjs")).toBe(true);
    expect(await linted("scripts/build.mjs")).toBe(true);
    expect(await linted("tests/helpers/world.ts")).toBe(true);

    // Generated, not authored. Linting it would report on esbuild's output and
    // teach nobody anything.
    expect(await linted("main.js")).toBe(false);
    expect(await linted("coverage/index.html")).toBe(false);
  }, 60_000);
});
