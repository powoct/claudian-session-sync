/**
 * Gate G-09 proves itself (testing.md §12.6).
 *
 * The point of the coverage configuration is not the number — it is that
 * deleting a test must *lower* coverage rather than raise it. That only holds
 * when uncovered source files are still reported. testing.md §12.6 expresses
 * this as `all: true`; vitest 4 removed that flag and folded the behaviour into
 * `coverage.include`, so the guarantee now rests on an option whose name no
 * longer says what it does. Hence this test: a throwaway project with one
 * untested source file must fail the thresholds, and pass once it is tested.
 *
 * Without it, a future vitest upgrade could turn every threshold in this repo
 * into decoration and nothing would go red.
 *
 * The fixture sits at the repository root (gitignored, lint-ignored) rather than
 * in a system temp directory so `import "vitest/config"` resolves by walking up
 * to node_modules — and specifically *not* inside node_modules, which vitest
 * excludes from coverage by default, which would make this test vacuously pass.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { removeTree } from "../helpers/fs-cleanup";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const VITEST_CLI = path.join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
const FIXTURE_ROOT = path.join(REPO_ROOT, "coverage-gate-fixture");

const SOURCE_FILE = `export function classify(size: number): string {
  if (size < 0) return "invalid";
  if (size === 0) return "empty";
  if (size < 1024) return "small";
  return "large";
}
`;

const FIXTURE_CONFIG = `import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      thresholds: {
        autoUpdate: false,
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});
`;

afterAll(() => {
  removeTree(FIXTURE_ROOT);
});

/** Builds the throwaway project; `withTest` decides whether src/ is exercised. */
function writeFixture(withTest: boolean): void {
  removeTree(FIXTURE_ROOT);
  mkdirSync(path.join(FIXTURE_ROOT, "src"), { recursive: true });
  mkdirSync(path.join(FIXTURE_ROOT, "tests"), { recursive: true });

  writeFileSync(path.join(FIXTURE_ROOT, "src", "classify.ts"), SOURCE_FILE, "utf8");
  writeFileSync(path.join(FIXTURE_ROOT, "vitest.config.ts"), FIXTURE_CONFIG, "utf8");

  const testBody = withTest
    ? `import { describe, expect, it } from "vitest";
import { classify } from "../src/classify";

describe("classify", () => {
  it("covers every branch", () => {
    expect(classify(-1)).toBe("invalid");
    expect(classify(0)).toBe("empty");
    expect(classify(10)).toBe("small");
    expect(classify(4096)).toBe("large");
  });
});
`
    : `import { expect, it } from "vitest";

it("passes without touching src/", () => {
  expect(1 + 1).toBe(2);
});
`;
  writeFileSync(path.join(FIXTURE_ROOT, "tests", "sample.test.ts"), testBody, "utf8");
}

function runFixtureSuite(): { status: number; output: string } {
  const result = spawnSync(process.execPath, [VITEST_CLI, "run", "--coverage"], {
    cwd: FIXTURE_ROOT,
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
  });
  return { status: result.status ?? -1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

describe("coverage thresholds are actually enforced (G-09)", () => {
  it("fails when a source file is never exercised", () => {
    writeFixture(false);
    const { status, output } = runFixtureSuite();

    expect(status, "an untested src/ file must sink the run").not.toBe(0);
    expect(output).toMatch(/coverage.*threshold/i);
  }, 180_000); // a nested vitest boot on a cold Windows runner is not fast

  it("passes once that same file is covered", () => {
    writeFixture(true);
    const { status, output } = runFixtureSuite();

    expect(status, output).toBe(0);
  }, 180_000); // a nested vitest boot on a cold Windows runner is not fast
});
