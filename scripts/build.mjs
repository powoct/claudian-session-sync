#!/usr/bin/env node
// esbuild bundle for the Obsidian plugin (testing.md §12.2).
//
// Two outputs, both contractual:
//   main.js        the plugin Obsidian loads (CJS, `obsidian` left external)
//   dist/meta.json esbuild's metafile, which tests/build/artifact-metafile.test.ts
//                  asserts against — external set, inputs, size
//
// `--dev` builds a watching, inline-sourcemapped bundle for local work. The
// production build carries no sourcemap, because §12.2a asserts the shipped file
// has no sourcemap comment.

import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const dev = process.argv.includes("--dev");

/**
 * Exactly the allow-list of §12.2a: the Obsidian runtime, Electron, and Node
 * built-ins in both spellings. Anything else must end up inside the bundle.
 * Exported so tests/build/artifact-metafile.test.ts can assert set equality
 * against it rather than re-deriving the list and testing itself.
 */
export const EXTERNAL = [
  "obsidian",
  "electron",
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
];

const options = {
  absWorkingDir: REPO_ROOT,
  entryPoints: ["src/main.ts"],
  outfile: "main.js",
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "es2022",
  external: EXTERNAL,
  metafile: true,
  treeShaking: true,
  minify: false,
  sourcemap: dev ? "inline" : false,
  logLevel: "info",
  define: { "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production") },
};

// Importing this module must not trigger a build — the metafile test imports it
// for EXTERNAL alone.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  if (dev) {
    const context = await esbuild.context(options);
    await context.watch();
    process.stdout.write("watching src/ (dev build, inline sourcemap)\n");
  } else {
    const result = await esbuild.build(options);
    mkdirSync(path.join(REPO_ROOT, "dist"), { recursive: true });
    writeFileSync(
      path.join(REPO_ROOT, "dist", "meta.json"),
      JSON.stringify(result.metafile, null, 2) + "\n",
    );
    const bytes = statSync(path.join(REPO_ROOT, "main.js")).size;
    process.stdout.write(`built main.js (${(bytes / 1024).toFixed(1)} KiB) + dist/meta.json\n`);
  }
}
