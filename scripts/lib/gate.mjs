// Shared plumbing for the check:* gate scripts (testing.md §12.1).
//
// Every gate script follows the same contract so CI output stays readable and so
// the gates can be self-tested against synthetic fixture trees:
//
//   node scripts/check-<name>.mjs [--root <dir>]
//     exit 0  -> "OK   check-<name>: <summary>"
//     exit 1  -> "FAIL check-<name>" followed by one indented line per violation
//
// `--root` exists so tests/build/gate-scripts.test.ts can point a gate at a
// throwaway directory instead of the repository it is meant to guard. Without it
// a gate can only ever be proven to pass, never proven to catch anything.

import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import path from "node:path";

export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Parses `--root <dir>` (and `--report <file>` for check-no-skip). */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = { root: REPO_ROOT };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--root") {
      const value = argv[++i];
      if (!value) usageError("--root needs a directory");
      out.root = path.resolve(value);
    } else if (arg === "--report") {
      const value = argv[++i];
      if (!value) usageError("--report needs a file path");
      out.report = path.resolve(value);
    } else {
      usageError(`unknown argument: ${arg}`);
    }
  }
  return out;
}

function usageError(message) {
  process.stderr.write(`usage error: ${message}\n`);
  process.exit(2);
}

/** Collects violations; a gate reports them all at once rather than one per run. */
export class Violations {
  #items = [];

  add(message) {
    this.#items.push(message);
  }

  get count() {
    return this.#items.length;
  }

  /** Prints the verdict and sets the exit code. Returns true when the gate passed. */
  finish(gate, okSummary) {
    if (this.#items.length === 0) {
      process.stdout.write(`OK   ${gate}: ${okSummary}\n`);
      return true;
    }
    process.stderr.write(`FAIL ${gate}\n`);
    for (const item of this.#items) process.stderr.write(`  - ${item}\n`);
    process.exitCode = 1;
    return false;
  }
}

/** Reads JSON, turning "missing" and "malformed" into gate violations, not crashes. */
export function readJson(file, violations, label) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    violations.add(`${label}: cannot read ${file} (${err.code ?? err.message})`);
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    violations.add(`${label}: ${file} is not valid JSON (${err.message})`);
    return null;
  }
}

/** Repo-relative, forward-slash path — stable in CI output across platforms. */
export function rel(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function isSemver(value) {
  return typeof value === "string" && SEMVER.test(value);
}
