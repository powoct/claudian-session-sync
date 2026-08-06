#!/usr/bin/env node
// Gate Q-01 (testing.md §15.1): CLAUDE.md must not restate technical decisions.
//
// CLAUDE.md is injected into every agent context at the highest priority, so a
// stale rule there outranks the architecture document that supersedes it. Two
// assertions: it points at the normative spec, and none of the rules that were
// explicitly retired (architecture.md appendix A) have crept back in.

import { readFileSync } from "node:fs";
import path from "node:path";
import { Violations, parseArgs } from "./lib/gate.mjs";

const GATE = "check-docs";

const SPEC_POINTER = "docs/zh-CN/architecture.md";

/** Retired rules — architecture.md appendix A records why each one is wrong. */
const RETIRED_RULES = [
  { text: "行数多的赢", supersededBy: "architecture.md §7.2 #4/#5 (prefix-safe merge)" },
  { text: "按 mtime 处理", supersededBy: "architecture.md §7.2b (opaque-file decision table)" },
  { text: "mtime 距今", supersededBy: "architecture.md §9.1 (stability ledger)" },
];

const { root } = parseArgs();
const v = new Violations();
const file = path.join(root, "CLAUDE.md");

let text = null;
try {
  text = readFileSync(file, "utf8");
} catch (err) {
  v.add(`cannot read CLAUDE.md (${err.code ?? err.message})`);
}

if (text !== null) {
  if (!text.includes(SPEC_POINTER)) {
    v.add(`CLAUDE.md does not point at the normative spec ("${SPEC_POINTER}" not found)`);
  }
  for (const { text: needle, supersededBy } of RETIRED_RULES) {
    const index = text.indexOf(needle);
    if (index !== -1) {
      const line = text.slice(0, index).split("\n").length;
      v.add(`CLAUDE.md:${line} contains retired rule "${needle}" — superseded by ${supersededBy}`);
    }
  }
}

v.finish(GATE, "CLAUDE.md points at the spec and restates no retired rules");
