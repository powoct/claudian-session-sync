#!/usr/bin/env node
// Gate G-02 (testing.md §12.1): the toolchain is version-frozen.
//
// A floating range means "the same commit builds differently next month", which
// makes every other gate in this repo unreliable — a coverage threshold or a
// lint rule that silently changes behaviour is worse than not having it. So:
// every dependency is an exact version, Node is pinned by .nvmrc, and the
// lockfile is v3 so `npm ci` is reproducible on all three CI platforms.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Violations, parseArgs, readJson } from "./lib/gate.mjs";

const GATE = "check-pinned-deps";
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const REQUIRED_NODE_MAJOR = 20;

/** Named in G-02; their absence would mean a gate quietly stopped running. */
const REQUIRED_DEV_DEPS = [
  "typescript",
  "vitest",
  "@vitest/coverage-v8",
  "esbuild",
  "eslint",
  "fast-check",
];

const { root } = parseArgs();
const v = new Violations();

const pkg = readJson(path.join(root, "package.json"), v, "package.json");
let checked = 0;

if (pkg) {
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const deps = pkg[field];
    if (!deps) continue;
    for (const [name, range] of Object.entries(deps)) {
      checked++;
      if (!EXACT_VERSION.test(range)) {
        v.add(`${field}.${name} = "${range}" is not an exact version (must match /^\\d+\\.\\d+\\.\\d+$/)`);
      }
    }
  }

  // `overrides` and `resolutions` change what npm ci actually installs, and
  // `npm audit fix` writes floating ranges straight into `overrides` — the one
  // place a caret is most likely to appear without anyone typing it.
  for (const field of ["overrides", "resolutions"]) {
    if (pkg[field]) checkNestedRanges(pkg[field], field);
  }

  const devDeps = pkg.devDependencies ?? {};
  for (const name of REQUIRED_DEV_DEPS) {
    if (!(name in devDeps)) v.add(`devDependencies.${name} is missing (required by G-02)`);
  }

  if (!pkg.engines?.node) v.add("engines.node is missing");
}

/** Ranges nest: `overrides: { pkg: { dep: "^1" } }` and the `"."` self key. */
function checkNestedRanges(node, trail) {
  for (const [key, value] of Object.entries(node)) {
    const where = `${trail}.${key}`;
    if (value && typeof value === "object") {
      checkNestedRanges(value, where);
    } else if (typeof value === "string") {
      checked++;
      if (!EXACT_VERSION.test(value) && !value.startsWith("$")) {
        v.add(`${where} = "${value}" is not an exact version (overrides decide what npm ci installs)`);
      }
    }
  }
}

const nvmrcPath = path.join(root, ".nvmrc");
if (!existsSync(nvmrcPath)) {
  v.add(".nvmrc is missing (CI resolves its Node version from it)");
} else {
  const nvmrc = readFileSync(nvmrcPath, "utf8").trim();
  if (!EXACT_VERSION.test(nvmrc)) {
    v.add(`.nvmrc = "${nvmrc}" is not a fully qualified version (want e.g. 20.20.2)`);
  } else if (Number(nvmrc.split(".")[0]) !== REQUIRED_NODE_MAJOR) {
    v.add(`.nvmrc = "${nvmrc}" is not Node ${REQUIRED_NODE_MAJOR}.x`);
  } else if (pkg?.engines?.node) {
    // The two must actually agree. Bumping engines to >=22 while .nvmrc still
    // says 20.x leaves CI installing a Node the package claims not to support,
    // and npm only warns.
    checkNvmrcSatisfiesEngines(nvmrc, pkg.engines.node);
  }
}

/**
 * Deliberately narrow: it understands `>=x.y.z` (optionally OR-ed) and an exact
 * version, and refuses anything else rather than guessing. A gate that silently
 * passes on a spelling it cannot parse is the failure mode being fixed here.
 */
function checkNvmrcSatisfiesEngines(nvmrc, range) {
  const clauses = range.split("||").map((clause) => clause.trim());
  const parsed = clauses.map((clause) => {
    const gte = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(clause);
    if (gte) return { kind: "gte", version: [Number(gte[1]), Number(gte[2] ?? 0), Number(gte[3] ?? 0)] };
    if (EXACT_VERSION.test(clause)) return { kind: "eq", version: clause.split(".").map(Number) };
    return null;
  });

  if (parsed.some((clause) => clause === null)) {
    v.add(
      `engines.node = "${range}" uses a range spelling this gate cannot evaluate ` +
        `(it understands ">=x.y.z" and exact versions). Simplify it, or teach check-pinned-deps the spelling.`,
    );
    return;
  }

  const actual = nvmrc.split(".").map(Number);
  const satisfied = parsed.some((clause) =>
    clause.kind === "eq" ? compare(actual, clause.version) === 0 : compare(actual, clause.version) >= 0,
  );
  if (!satisfied) {
    v.add(`.nvmrc = "${nvmrc}" does not satisfy engines.node = "${range}" — CI would install a Node this package rejects`);
  }
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  }
  return 0;
}

const lockPath = path.join(root, "package-lock.json");
if (!existsSync(lockPath)) {
  v.add("package-lock.json is missing (npm ci cannot run)");
} else {
  const lock = readJson(lockPath, v, "package-lock.json");
  if (lock && lock.lockfileVersion !== 3) {
    v.add(`package-lock.json lockfileVersion = ${lock.lockfileVersion} (want 3)`);
  }
  if (lock && pkg && lock.version !== pkg.version) {
    v.add(`package-lock.json version "${lock.version}" != package.json version "${pkg.version}" (run npm install)`);
  }
}

v.finish(GATE, `${checked} dependencies exact-pinned, .nvmrc and lockfile v3 verified`);
