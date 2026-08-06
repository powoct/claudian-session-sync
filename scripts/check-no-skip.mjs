#!/usr/bin/env node
// Gate G-07 (testing.md §12.1, §12.4): no M1 blocker test may be skipped.
//
// Scanning the source for `.skip` is unreliable — a `describe.each` can skip a
// case at runtime with nothing to grep for. So this reads what actually ran:
// vitest's JSON report. Any pending/todo/skipped case under tests/m1/ fails the
// gate.
//
// `.only` is NOT fully covered here, contrary to what is easy to assume: it is
// caught only when it leaves skipped siblings behind, and a `describe.only`
// wrapping a whole file leaves none. `allowOnly: false` in vitest.config.mts is
// what actually blocks `.only`; this gate is the second line.
//
// The count floor (--min) exists because "no M1 case was skipped" and "the M1
// suite stopped being collected at all" produce identical output otherwise —
// renaming a directory or narrowing an include glob would read as success.
//
// Scope (testing.md §12.4): tests/m1/** is bound by this gate; tests/m2/**,
// tests/posix/** (platform-conditional) and tests/pending/** are not.

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { Violations, parseArgs, readJson } from "./lib/gate.mjs";

const GATE = "check-no-skip";
const GUARDED_PATH = "/tests/m1/";
const SKIPPED_STATUSES = new Set(["pending", "todo", "skipped", "disabled"]);

const args = parseArgs();
const reportPath = args.report ?? path.join(args.root, "reports", "vitest.json");
const minCases = args.min ?? 0;
const v = new Violations();

if (!existsSync(reportPath)) {
  // Fail closed: a missing report means the suite never ran, which is exactly
  // the state this gate exists to catch.
  v.add(`no vitest report at ${reportPath} — run \`npm test\` first (the gate reads what actually executed)`);
  v.finish(GATE, "");
  process.exit(process.exitCode ?? 1);
}

// A report left over from an earlier run describes code that no longer exists;
// the gate would then vouch for tests that were never executed.
const testsDir = path.join(args.root, "tests");
if (existsSync(testsDir)) {
  const reportMtime = statSync(reportPath).mtimeMs;
  const newestTest = newestMtime(testsDir);
  if (newestTest > reportMtime) {
    v.add(
      `${reportPath} is older than tests/ — it describes a previous run. Re-run \`npm test\` before this gate.`,
    );
  }
}

function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs);
  }
  return newest;
}

const report = readJson(reportPath, v, "vitest report");
let guardedFiles = 0;
let guardedCases = 0;

if (report) {
  const suites = Array.isArray(report.testResults) ? report.testResults : [];
  for (const suite of suites) {
    // Windows reports backslash paths; compare in one spelling.
    const file = String(suite.name ?? "").split(path.win32.sep).join("/");
    if (!file.includes(GUARDED_PATH)) continue;
    guardedFiles++;

    const cases = Array.isArray(suite.assertionResults) ? suite.assertionResults : [];
    for (const testCase of cases) {
      guardedCases++;
      if (SKIPPED_STATUSES.has(testCase.status)) {
        const title = testCase.fullName || testCase.title || "<unnamed>";
        v.add(`${file}: "${title}" is ${testCase.status} (M1 blocker tests must run)`);
      }
    }
  }
}

if (guardedCases < minCases) {
  v.add(
    `only ${guardedCases} M1 blocker cases ran, expected at least ${minCases} — ` +
      "a file was renamed, moved out of tests/m1/, or dropped from the include glob",
  );
}

if (v.count === 0 && guardedFiles === 0) {
  // True during M0: the directory does not exist yet. Say so out loud rather
  // than printing a green line that means nothing.
  process.stdout.write(
    `OK   ${GATE}: no tests/m1/ files in the report yet (M0 scaffold). ` +
      "This must be non-zero, and CI must pass --min, before M1 exit — see testing.md §12.4.\n",
  );
  process.exit(0);
}

v.finish(GATE, `${guardedCases} M1 blocker cases across ${guardedFiles} files, none skipped`);
