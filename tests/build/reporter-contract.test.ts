/**
 * Pins the vitest JSON report shape that gate G-07 depends on.
 *
 * check-no-skip reads `testResults[].name` and `assertionResults[].status` and
 * matches the literal statuses "skipped" / "todo" / "pending". Every other test
 * of that gate feeds it JSON this repository wrote itself, which proves the
 * gate's logic and nothing about whether vitest still emits that shape. A field
 * rename or a status-string change in a future vitest would leave the gate
 * permanently green with all its other tests passing — the exact failure mode
 * G-07 exists to prevent, relocated one level down.
 *
 * So: run a real vitest over a real skipped test and assert on what lands on
 * disk. Also confirms `name` is an absolute path containing "/tests/m1/", which
 * is how the gate scopes itself.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTree } from "../helpers/fs-cleanup";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const VITEST_CLI = path.join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
const FIXTURE_ROOT = path.join(REPO_ROOT, "reporter-contract-fixture");
const REPORT = path.join(FIXTURE_ROOT, "reports", "vitest.json");

const FIXTURE_TEST = `import { describe, expect, it } from "vitest";

describe("suite", () => {
  it("runs", () => {
    expect(1).toBe(1);
  });
  it.skip("is skipped", () => {
    expect(1).toBe(2);
  });
  it.todo("is a todo");
});
`;

const FIXTURE_CONFIG = `import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    reporters: ["json"],
    outputFile: { json: "reports/vitest.json" },
  },
});
`;

interface JsonReport {
  testResults: Array<{
    name: string;
    assertionResults: Array<{ status: string; fullName?: string; title?: string }>;
  }>;
}

let report: JsonReport;

beforeAll(() => {
  removeTree(FIXTURE_ROOT);
  mkdirSync(path.join(FIXTURE_ROOT, "tests", "m1"), { recursive: true });
  writeFileSync(path.join(FIXTURE_ROOT, "tests", "m1", "sample.test.ts"), FIXTURE_TEST, "utf8");
  writeFileSync(path.join(FIXTURE_ROOT, "vitest.config.mts"), FIXTURE_CONFIG, "utf8");

  const result = spawnSync(process.execPath, [VITEST_CLI, "run"], {
    cwd: FIXTURE_ROOT,
    encoding: "utf8",
  });
  if (!result.stdout && result.status !== 0 && result.status !== 1) {
    throw new Error(`fixture vitest run failed: ${result.stderr}`);
  }
  report = JSON.parse(readFileSync(REPORT, "utf8")) as JsonReport;
}, 180_000);

afterAll(() => {
  removeTree(FIXTURE_ROOT);
});

describe("vitest JSON report contract (G-07 depends on this)", () => {
  it("keys suites by absolute file path", () => {
    const suite = report.testResults[0];

    expect(suite).toBeDefined();
    expect(path.isAbsolute(suite?.name ?? "")).toBe(true);
    expect((suite?.name ?? "").split(path.sep).join("/")).toContain("/tests/m1/");
  });

  it("reports skip and todo with the status strings the gate matches", () => {
    const statuses = (report.testResults[0]?.assertionResults ?? []).map((a) => a.status);

    expect(statuses).toContain("passed");
    expect(statuses, "check-no-skip keys off this literal").toContain("skipped");
    expect(statuses, "check-no-skip keys off this literal").toContain("todo");
  });

  it("names each case, so a violation can be traced back", () => {
    for (const assertion of report.testResults[0]?.assertionResults ?? []) {
      expect(assertion.fullName || assertion.title).toBeTruthy();
    }
  });

  it("is caught end to end by check-no-skip", () => {
    const result = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "check-no-skip.mjs"), "--report", REPORT], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is skipped");
    expect(result.stderr).toContain("is a todo");
  });
});
