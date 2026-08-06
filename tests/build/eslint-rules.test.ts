/**
 * Gate G-10 proves itself (testing.md §12.1).
 *
 * A lint rule nobody has ever seen fire is a rule you cannot rely on: a typo in
 * a selector, a `files` glob that misses the directory, an override that
 * silently relaxes it — all of those look exactly like "no violations found".
 * These tests feed deliberately illegal code to the real eslint.config.mjs and
 * assert the right rule fires, and equally that legal code in other layers does
 * not fire it.
 *
 * `lintText` is used with a virtual filePath so nothing is written into src/.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({ cwd: REPO_ROOT });
});

/** Lints `code` as if it lived at `relativePath`; returns the rule IDs that fired. */
async function lintAs(relativePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, {
    filePath: path.join(REPO_ROOT, relativePath),
    warnIgnored: false,
  });
  return (result?.messages ?? []).map((message) => message.ruleId ?? `<fatal: ${message.message}>`);
}

describe("domain/ may not import outward (G-10 part 1)", () => {
  const bannedImports = [
    ["node:fs", `import { readFileSync } from "node:fs";\nexport const x = readFileSync;\n`],
    ["fs", `import { readFileSync } from "fs";\nexport const x = readFileSync;\n`],
    ["node:path", `import path from "node:path";\nexport const x = path;\n`],
    ["path", `import path from "path";\nexport const x = path;\n`],
    ["node:os", `import { homedir } from "node:os";\nexport const x = homedir;\n`],
    ["os", `import { homedir } from "os";\nexport const x = homedir;\n`],
    ["obsidian", `import { Notice } from "obsidian";\nexport const x = Notice;\n`],
  ] as const;

  for (const [label, code] of bannedImports) {
    it(`rejects importing ${label}`, async () => {
      expect(await lintAs("src/domain/probe.ts", code)).toContain("no-restricted-imports");
    });
  }

  it("rejects reaching into infra/", async () => {
    const code = `import { FsGateway } from "../infra/fs-gateway";\nexport const x = FsGateway;\n`;
    expect(await lintAs("src/domain/probe.ts", code)).toContain("no-restricted-imports");
  });

  it("rejects reaching into a nested outward path", async () => {
    const code = `import { X } from "../providers/claude-code/path-escape";\nexport const x = X;\n`;
    expect(await lintAs("src/domain/probe.ts", code)).toContain("no-restricted-imports");
  });

  it("rejects re-exporting a banned module", async () => {
    expect(await lintAs("src/domain/probe.ts", `export * from "node:fs";\n`)).toContain(
      "no-restricted-imports",
    );
  });

  // The escape hatches: no-restricted-imports sees none of these.
  it("rejects a dynamic import of a banned module", async () => {
    const code = `export async function read() {\n  return await import("node:fs");\n}\n`;
    expect(await lintAs("src/domain/probe.ts", code)).toContain("no-restricted-syntax");
  });

  it("rejects createRequire, which would smuggle fs back in", async () => {
    const code = `import { createRequire } from "node:module";\nexport const r = createRequire("x");\n`;
    expect(await lintAs("src/domain/probe.ts", code)).toContain("no-restricted-imports");
  });

  it("rejects reading process from the domain layer", async () => {
    const code = `export const home = process.env.HOME ?? "";\n`;
    expect(await lintAs("src/domain/probe.ts", code)).toContain("no-restricted-globals");
  });

  it("still allows infra/ to use process and dynamic imports", async () => {
    const code = `export const home = process.env.HOME ?? "";\nexport const load = () => import("node:fs");\n`;
    expect(await lintAs("src/infra/probe.ts", code)).toEqual([]);
  });

  it("allows a pure domain module", async () => {
    const code = `export function isPrefix(a: string, b: string): boolean {\n  return b.startsWith(a);\n}\n`;
    expect(await lintAs("src/domain/probe.ts", code)).toEqual([]);
  });
});

describe("domain/ may not hold RuntimeEnv (G-10 part 2)", () => {
  it("rejects the identifier in a type position", async () => {
    const code = `import type { RuntimeEnv } from "../types";\nexport type X = RuntimeEnv;\n`;
    expect(await lintAs("src/domain/probe.ts", code)).toContain("no-restricted-syntax");
  });

  it("rejects the identifier in a parameter", async () => {
    const code = `export function plan(env: RuntimeEnv): void {\n  void env;\n}\n`;
    expect(await lintAs("src/domain/probe.ts", code)).toContain("no-restricted-syntax");
  });

  it("allows SystemInfo and nowMs, which the domain layer is meant to take", async () => {
    const code =
      `import type { SystemInfo } from "./types";\n` +
      `export function decide(sys: SystemInfo, nowMs: number): number {\n  return sys.pathMax + nowMs;\n}\n`;
    expect(await lintAs("src/domain/probe.ts", code)).toEqual([]);
  });
});

describe("no direct require of fs anywhere (G-10 part 3)", () => {
  it("rejects require(\"fs\") in infra/", async () => {
    const code = `const fs = require("fs");\nexport const x = fs;\n`;
    expect(await lintAs("src/infra/probe.ts", code)).toContain("no-restricted-syntax");
  });

  it("rejects require(\"node:fs\") in the plugin entry", async () => {
    const code = `const fs = require("node:fs");\nexport const x = fs;\n`;
    expect(await lintAs("src/probe.ts", code)).toContain("no-restricted-syntax");
  });

  it("still allows infra/ to import fs the normal way", async () => {
    const code = `import { readFileSync } from "node:fs";\nexport const x = readFileSync;\n`;
    expect(await lintAs("src/infra/probe.ts", code)).toEqual([]);
  });
});
