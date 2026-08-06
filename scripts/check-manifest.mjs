#!/usr/bin/env node
// Gate G-06 (testing.md §12.3): the Obsidian manifest contract.
//
// These fields are the only thing standing between a release and an install that
// silently misbehaves: a manifest whose version disagrees with package.json ships
// under the wrong tag, a missing isDesktopOnly lets the plugin load on mobile
// where `fs` does not exist, and a versions.json that does not name the release
// makes BRAT install the wrong build.
//
// On `main === "main.js"`: Obsidian's manifest has no `main` field (the entry
// point is always main.js), so this is asserted on package.json, and on the
// manifest too when a `main` key is present.

import path from "node:path";
import { Violations, isSemver, parseArgs, readJson } from "./lib/gate.mjs";

const GATE = "check-manifest";
const ID_PATTERN = /^[a-z0-9-]+$/;

const { root } = parseArgs();
const v = new Violations();

const manifest = readJson(path.join(root, "manifest.json"), v, "manifest.json");
const pkg = readJson(path.join(root, "package.json"), v, "package.json");
const versions = readJson(path.join(root, "versions.json"), v, "versions.json");

if (manifest) {
  if (manifest.isDesktopOnly !== true) {
    v.add(`manifest.isDesktopOnly = ${JSON.stringify(manifest.isDesktopOnly)} (must be true: the plugin uses Node fs/os/path)`);
  }
  if (!ID_PATTERN.test(manifest.id ?? "")) {
    v.add(`manifest.id = ${JSON.stringify(manifest.id)} does not match ${ID_PATTERN}`);
  }
  if (!isSemver(manifest.version)) {
    v.add(`manifest.version = ${JSON.stringify(manifest.version)} is not valid semver`);
  }
  if (!isSemver(manifest.minAppVersion)) {
    v.add(`manifest.minAppVersion = ${JSON.stringify(manifest.minAppVersion)} is not valid semver`);
  }
  for (const field of ["name", "description", "author"]) {
    if (typeof manifest[field] !== "string" || manifest[field].trim() === "") {
      v.add(`manifest.${field} must be a non-empty string`);
    }
  }
  if ("main" in manifest && manifest.main !== "main.js") {
    v.add(`manifest.main = ${JSON.stringify(manifest.main)} (want "main.js")`);
  }
}

if (pkg) {
  if (pkg.main !== "main.js") {
    v.add(`package.json main = ${JSON.stringify(pkg.main)} (want "main.js")`);
  }
  if (manifest) {
    if (manifest.id !== pkg.name) {
      v.add(`manifest.id ${JSON.stringify(manifest.id)} != package.json name ${JSON.stringify(pkg.name)}`);
    }
    if (manifest.version !== pkg.version) {
      v.add(`manifest.version ${JSON.stringify(manifest.version)} != package.json version ${JSON.stringify(pkg.version)}`);
    }
  }
}

if (versions && manifest) {
  const mapped = versions[manifest.version];
  if (mapped === undefined) {
    v.add(`versions.json has no entry for ${JSON.stringify(manifest.version)} (BRAT resolves the download from it)`);
  } else if (mapped !== manifest.minAppVersion) {
    v.add(
      `versions.json["${manifest.version}"] = ${JSON.stringify(mapped)} != manifest.minAppVersion ${JSON.stringify(manifest.minAppVersion)}`,
    );
  }
  for (const [version, minApp] of Object.entries(versions)) {
    if (!isSemver(version)) v.add(`versions.json key ${JSON.stringify(version)} is not valid semver`);
    if (!isSemver(minApp)) v.add(`versions.json["${version}"] = ${JSON.stringify(minApp)} is not valid semver`);
  }
}

v.finish(GATE, `manifest/package/versions agree on ${manifest?.version ?? "?"}`);
