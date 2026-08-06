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
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

function repoFilesInProgram(): string[] {
  const tsc = path.join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");
  const result = spawnSync(process.execPath, [tsc, "--noEmit", "--listFiles"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return (result.stdout ?? "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith(REPO_ROOT) && !line.includes("node_modules"))
    .map((line) => path.relative(REPO_ROOT, line).split(path.sep).join("/"));
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
  it("reports on src/, tests/ and scripts/", () => {
    const eslintBin = path.join(REPO_ROOT, "node_modules", "eslint", "bin", "eslint.js");
    const result = spawnSync(process.execPath, [eslintBin, ".", "--format", "json"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });

    const linted = (JSON.parse(result.stdout || "[]") as Array<{ filePath: string }>).map((entry) =>
      path.relative(REPO_ROOT, entry.filePath).split(path.sep).join("/"),
    );

    expect(linted).toContain("src/main.ts");
    expect(linted).toContain("eslint.config.mjs");
    expect(linted.some((file) => file.startsWith("scripts/"))).toBe(true);
    expect(linted.some((file) => file.startsWith("tests/"))).toBe(true);
    // The build output must never be linted; it is generated, not authored.
    expect(linted).not.toContain("main.js");
  }, 180_000);
});
