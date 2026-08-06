#!/usr/bin/env node
// Gate G-11 (testing.md §12.1, §14): no credentials and no real home paths in
// the repository.
//
// This plugin's whole job is to move files that sit next to credential stores,
// so a leaked token or a developer's real username in a committed fixture is
// both an ordinary secret leak and a signal that someone copied real data in
// instead of synthesising it. Fixtures use /Users/testuser and C:\Users\testuser
// (testing.md §14).
//
// Scope: the whole repository minus build output and dependencies — an
// allow-list of directories is exactly the blind spot a key in a workflow file
// or a root-level .env slips through. docs/ is the one exception, and only
// partially: the measured path-escape samples (testing.md §5.1, findings/) must
// quote a real home path verbatim, because the escape rule *is* the evidence.
// Credential patterns still apply there; only the home-path patterns are lifted.
//
// Two fail-closed rules, because "scanned nothing" must never read as "clean":
// a file too large to scan is a violation, and a file skipped as binary is
// counted and reported in the summary.
//
// Note on the literal patterns named in G-02: a bare "sk-" or "Bearer "
// substring matches ordinary English ("task-id", "Bearer of bad news"), so each
// pattern additionally requires a token-shaped tail. Matches are reported with
// only a 4-character prefix, enough to tell a false positive from a real leak
// without copying the secret into a public CI log.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { Violations, parseArgs, rel } from "./lib/gate.mjs";

const GATE = "check-secrets";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "coverage",
  "reports",
  "artifacts",
  "dist",
  "tmp",
  "venv",
  "coverage-gate-fixture",
  "reporter-contract-fixture",
]);
const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** Where a real home path is evidence rather than a leak. */
const HOME_PATH_EXEMPT_PREFIXES = ["docs/"];

// This file necessarily contains the patterns it looks for.
const SELF = "scripts/check-secrets.mjs";

/** Placeholders that are allowed to stand where a username would appear. */
const USER_PLACEHOLDER = String.raw`testuser|<user>|<u>|<USER>|%USERNAME%|\$USER|\$\{USER\}`;

/**
 * The security tests deliberately plant credential-shaped decoys and then assert
 * they never reach a log, a report or a replica (testing.md §8.4, SEC-10/11/13),
 * so those strings must be able to live in the spec and in fixtures. A decoy
 * announces itself in capitals; a real key never does.
 */
const DECOY_MARKERS = ["SENTINEL", "EXAMPLE", "FAKE", "DUMMY", "PLACEHOLDER", "NOTREAL"];

function isDecoy(match) {
  return DECOY_MARKERS.some((marker) => match.includes(marker));
}

const PATTERNS = [
  {
    name: "anthropic-api-key",
    scope: "all",
    re: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{8,}/g,
  },
  {
    name: "openai-style-api-key",
    scope: "all",
    re: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}/g,
  },
  {
    name: "github-token",
    scope: "all",
    re: /(?<![A-Za-z0-9_-])gh[pousr]_[A-Za-z0-9]{16,}/g,
  },
  {
    name: "bearer-token",
    scope: "all",
    // A token, not the English word: at least 20 chars, containing a digit and
    // at least one character that does not occur in ordinary prose. Without
    // this, "Bearer authentication is not used here" fails the gate — and a
    // gate that cries wolf is a gate someone switches off.
    re: /\bBearer\s+(?=[A-Za-z0-9._~+/=-]{20,})(?=[^\s]*\d)[A-Za-z0-9._~+/=-]*[._~+/=-][A-Za-z0-9._~+/=-]*/g,
  },
  {
    name: "real-home-path-posix",
    scope: "code",
    re: new RegExp(String.raw`/(?:Users|home)/(?!(?:${USER_PLACEHOLDER})(?![A-Za-z0-9._-]))[A-Za-z0-9._-]+`, "g"),
  },
  {
    name: "real-home-path-windows",
    scope: "code",
    re: new RegExp(
      String.raw`[A-Za-z]:\\{1,2}Users\\{1,2}(?!(?:${USER_PLACEHOLDER})(?![A-Za-z0-9._-]))[A-Za-z0-9._-]+`,
      "g",
    ),
  },
];

const { root } = parseArgs();
const v = new Violations();
let filesScanned = 0;
let binarySkipped = 0;

scan(root);

function scan(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return; // directory not created yet — not a violation
    throw err;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) scan(full);
      continue;
    }
    // A symlink is not followed: it could point outside the repository.
    if (!entry.isFile()) continue;

    const relative = rel(root, full);
    if (relative === SELF) continue;

    if (statSync(full).size > MAX_FILE_BYTES) {
      v.add(`${relative} is larger than ${MAX_FILE_BYTES} bytes and was not scanned — split it or exclude it deliberately`);
      continue;
    }
    scanFile(full, relative);
  }
}

function scanFile(file, relative) {
  let buffer = readFileSync(file);

  // A UTF-16 file is full of NUL bytes but is perfectly readable text; decoding
  // it is the difference between scanning a Windows-produced dump and silently
  // skipping it.
  if (buffer[0] === 0xff && buffer[1] === 0xfe) buffer = Buffer.from(buffer.toString("utf16le"), "utf8");
  else if (buffer.includes(0)) {
    binarySkipped++;
    return;
  }

  filesScanned++;
  const homePathsAllowed = HOME_PATH_EXEMPT_PREFIXES.some((prefix) => relative.startsWith(prefix));
  const lines = buffer.toString("utf8").split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    for (const { name, scope, re } of PATTERNS) {
      if (scope === "code" && homePathsAllowed) continue;
      re.lastIndex = 0;
      const match = re.exec(line);
      if (match && !isDecoy(match[0])) {
        v.add(
          `${relative}:${index + 1}:${match.index + 1} matched ${name} ` +
            `— starts "${match[0].slice(0, 4)}", ${match[0].length} chars`,
        );
      }
    }
  }
}

const summary =
  `${filesScanned} files scanned, no credentials or real home paths` +
  (binarySkipped > 0 ? ` (${binarySkipped} binary files skipped)` : "");
v.finish(GATE, summary);
