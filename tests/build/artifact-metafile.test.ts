/**
 * Bundle contract, layer (a) — static assertions on esbuild's metafile
 * (testing.md §12.2a). Needs no runtime, so it is the most reliable of the three.
 *
 * What it is really guarding: that nothing outside the Obsidian/Electron/Node
 * allow-list got left external (it would be missing at runtime), that no test
 * code or test-only dependency got dragged into the shipped file, and that the
 * bundle did not quietly swallow node_modules.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
// The build's own declared list, not a copy of it: asserting a re-derived list
// against itself would pass no matter what scripts/build.mjs actually does.
import { EXTERNAL as BUILD_EXTERNAL } from "../../scripts/build.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SRC_DIR = path.join(REPO_ROOT, "src");
const BUNDLE = path.join(REPO_ROOT, "main.js");
const METAFILE = path.join(REPO_ROOT, "dist", "meta.json");

const MAX_BUNDLE_BYTES = 512 * 1024;

const ALLOWED_EXTERNALS = new Set<string>([
  "obsidian",
  "electron",
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

interface Metafile {
  inputs: Record<string, unknown>;
  outputs: Record<
    string,
    { imports?: Array<{ path: string; kind: string; external?: boolean }>; inputs?: Record<string, unknown> }
  >;
}

let metafile: Metafile;
let bundleText: string;

beforeAll(() => {
  if (!existsSync(BUNDLE) || !existsSync(METAFILE)) {
    throw new Error(
      `missing build output (${BUNDLE} / ${METAFILE}). Run \`npm run build\` before \`npm run check:bundle\`.`,
    );
  }
  metafile = JSON.parse(readFileSync(METAFILE, "utf8")) as Metafile;
  bundleText = readFileSync(BUNDLE, "utf8");
});

/** Metafile keys are repo-relative; normalise separators so Windows agrees. */
function inputPaths(): string[] {
  return Object.keys(metafile.inputs).map((input) => input.split("\\").join("/"));
}

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs);
  }
  return newest;
}

describe("bundle metafile contract (§12.2a)", () => {
  it("leaves external only what the Obsidian runtime provides", () => {
    const output = metafile.outputs["main.js"];
    expect(output, "metafile has no main.js output").toBeDefined();

    const externals = (output?.imports ?? []).filter((imp) => imp.external).map((imp) => imp.path);
    const disallowed = externals.filter((name) => !ALLOWED_EXTERNALS.has(name));

    expect(disallowed, `externals outside the allow-list would be missing at runtime`).toEqual([]);
    // The plugin must genuinely link against the host API rather than shipping a copy.
    expect(externals).toContain("obsidian");
  });

  it("declares exactly the allow-list as external in the build config", () => {
    // §12.2a asks for equality with the allow-list. The metafile can only show
    // what the bundle happened to import, so the equality belongs here, against
    // what scripts/build.mjs actually passes to esbuild.
    expect(new Set(BUILD_EXTERNAL)).toEqual(ALLOWED_EXTERNALS);
  });

  it("is not stale relative to src/", () => {
    // check:bundle asserts things about main.js; if main.js predates the source
    // it describes, every one of those assertions is about the wrong artifact.
    const bundleMtime = statSync(BUNDLE).mtimeMs;
    const newestSource = newestMtime(SRC_DIR);

    expect(
      bundleMtime,
      "main.js is older than src/ — run `npm run build` before `npm run check:bundle`",
    ).toBeGreaterThanOrEqual(newestSource);
    expect(statSync(METAFILE).mtimeMs).toBeGreaterThanOrEqual(newestSource);
  });

  it("does not bundle test code or test-only dependencies", () => {
    const inputs = inputPaths();

    expect(inputs.filter((input) => input.startsWith("tests/"))).toEqual([]);
    expect(inputs.filter((input) => /node_modules\/(vitest|fast-check|@vitest)/.test(input))).toEqual([]);
  });

  it("only bundles files from src/", () => {
    const nonSrc = inputPaths().filter((input) => !input.startsWith("src/"));
    expect(nonSrc, "an unexpected input means something was pulled in transitively").toEqual([]);
  });

  it("stays well under the size ceiling", () => {
    const bytes = statSync(BUNDLE).size;
    expect(bytes, `main.js is ${(bytes / 1024).toFixed(1)} KiB`).toBeLessThan(MAX_BUNDLE_BYTES);
  });

  it("ships no sourcemap comment and no debugger statement", () => {
    expect(bundleText).not.toMatch(/\/\/[#@]\s*sourceMappingURL=/);
    expect(bundleText).not.toMatch(/(^|[^\w$.])debugger\s*(?:;|$|[\n}])/m);
  });

  it("is CommonJS, as Obsidian's loader requires", () => {
    expect(bundleText).toMatch(/module\.exports|exports\./);
    // Any top-level ESM syntax at all — Obsidian requires() this file, so an
    // `import`/`export` statement would throw before onload is ever reached.
    expect(bundleText).not.toMatch(/^\s*import\s+[\w{*]/m);
    expect(bundleText).not.toMatch(/^\s*export\s+(default|const|function|class|\{)/m);
  });
});
