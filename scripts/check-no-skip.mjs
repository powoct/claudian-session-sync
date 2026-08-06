#!/usr/bin/env node
// Gate G-07 (testing.md §12.1, §12.4): no M1 blocker test may be skipped.
//
// Scanning the source for `.skip` is unreliable — a `describe.each` can skip a
// case at runtime with nothing to grep for, and a stray `.only` skips everything
// else without the word appearing anywhere. So this reads what actually ran:
// vitest's JSON report. Any pending/todo/skipped case under tests/m1/ fails the
// gate, and `.only` fails it too, because it turns its siblings into skips.
//
// Scope (testing.md §12.4): tests/m1/** is bound by this gate; tests/m2/**,
// tests/posix/** (platform-conditional) and tests/pending/** are not.

import { existsSync } from "node:fs";
import path from "node:path";
import { Violations, parseArgs, readJson } from "./lib/gate.mjs";

const GATE = "check-no-skip";
const GUARDED_PATH = "/tests/m1/";
const SKIPPED_STATUSES = new Set(["pending", "todo", "skipped", "disabled"]);

const args = parseArgs();
const reportPath = args.report ?? path.join(args.root, "reports", "vitest.json");
const v = new Violations();

if (!existsSync(reportPath)) {
  // Fail closed: a missing report means the suite never ran, which is exactly
  // the state this gate exists to catch.
  v.add(`no vitest report at ${reportPath} — run \`npm test\` first (the gate reads what actually executed)`);
  v.finish(GATE, "");
  process.exit(process.exitCode ?? 1);
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

if (v.count === 0 && guardedFiles === 0) {
  // True during M0: the directory does not exist yet. Say so out loud rather
  // than printing a green line that means nothing.
  process.stdout.write(
    `OK   ${GATE}: no tests/m1/ files in the report yet (M0 scaffold). ` +
      "This must be non-zero before M1 exit — see testing.md §12.4.\n",
  );
  process.exit(0);
}

v.finish(GATE, `${guardedCases} M1 blocker cases across ${guardedFiles} files, none skipped`);
