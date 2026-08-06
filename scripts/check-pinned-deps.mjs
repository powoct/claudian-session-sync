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

  const devDeps = pkg.devDependencies ?? {};
  for (const name of REQUIRED_DEV_DEPS) {
    if (!(name in devDeps)) v.add(`devDependencies.${name} is missing (required by G-02)`);
  }

  const enginesNode = pkg.engines?.node;
  if (!enginesNode) {
    v.add("engines.node is missing");
  } else if (!/\b20\b/.test(enginesNode) && !/>=\s*\d+/.test(enginesNode)) {
    v.add(`engines.node = "${enginesNode}" does not admit Node ${REQUIRED_NODE_MAJOR}.x`);
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
  }
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
