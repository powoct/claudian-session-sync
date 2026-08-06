#!/usr/bin/env node
// Gate G-11 (testing.md §12.1, §14): no credentials and no real home paths in
// the code or in test fixtures.
//
// This plugin's whole job is to move files that sit next to credential stores,
// so a leaked token or a developer's real username in a committed fixture is
// both an ordinary secret leak and a signal that someone copied real data in
// instead of synthesising it. Fixtures use /Users/testuser and C:\Users\testuser
// (testing.md §14).
//
// Note on the literal patterns named in G-02: a bare "sk-" or "Bearer " substring
// matches ordinary English ("task-id", "Bearer of bad news"), so each pattern
// additionally requires a token-shaped tail. Anything key-shaped still trips.
//
// Matches are reported by pattern name and position only — never echoed — so a
// real leak does not get copied into public CI logs by the gate that caught it.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { Violations, parseArgs, rel } from "./lib/gate.mjs";

const GATE = "check-secrets";

const SCAN_DIRS = ["src", "tests", "scripts"];
const SKIP_DIRS = new Set(["node_modules", ".git", "coverage", "reports", "artifacts", "dist"]);
const MAX_FILE_BYTES = 4 * 1024 * 1024;

// This file necessarily contains the patterns it looks for.
const SELF = "scripts/check-secrets.mjs";

/** Placeholders that are allowed to stand where a username would appear. */
const USER_PLACEHOLDER = String.raw`testuser|<user>|<u>|<USER>|%USERNAME%|\$USER|\$\{USER\}`;

const PATTERNS = [
  {
    name: "anthropic-api-key",
    re: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{8,}/g,
  },
  {
    name: "openai-style-api-key",
    re: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}/g,
  },
  {
    name: "github-token",
    re: /(?<![A-Za-z0-9_-])gh[pousr]_[A-Za-z0-9]{16,}/g,
  },
  {
    name: "bearer-token",
    re: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g,
  },
  {
    name: "real-home-path-posix",
    re: new RegExp(String.raw`/(?:Users|home)/(?!(?:${USER_PLACEHOLDER})(?![A-Za-z0-9._-]))[A-Za-z0-9._-]+`, "g"),
  },
  {
    name: "real-home-path-windows",
    re: new RegExp(
      String.raw`[A-Za-z]:\\{1,2}Users\\{1,2}(?!(?:${USER_PLACEHOLDER})(?![A-Za-z0-9._-]))[A-Za-z0-9._-]+`,
      "g",
    ),
  },
];

const { root } = parseArgs();
const v = new Violations();
let filesScanned = 0;

for (const dir of SCAN_DIRS) scan(path.join(root, dir));

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
    if (!entry.isFile()) continue;
    if (rel(root, full) === SELF) continue;
    // Every text file is scanned regardless of extension: an extension
    // allow-list is exactly the blind spot a fixture with an odd name slips
    // through, and fixtures are the likeliest place for copied-in real data.
    if (statSync(full).size > MAX_FILE_BYTES) continue;
    scanFile(full);
  }
}

function scanFile(file) {
  const buffer = readFileSync(file);
  if (buffer.includes(0)) return; // binary; nothing textual to leak

  filesScanned++;
  const lines = buffer.toString("utf8").split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    for (const { name, re } of PATTERNS) {
      re.lastIndex = 0;
      const match = re.exec(line);
      if (match) {
        v.add(
          `${rel(root, file)}:${index + 1}:${match.index + 1} matched ${name} ` +
            `(${match[0].length} chars, not shown)`,
        );
      }
    }
  }
}

v.finish(GATE, `${filesScanned} files scanned, no credentials or real home paths`);
