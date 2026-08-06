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

beforeAll(async () => {
  eslint = new ESLint({ cwd: REPO_ROOT });
  // `new ESLint()` is lazy: loading eslint.config.mjs pulls in typescript-eslint
  // and TypeScript itself, and that cost would otherwise land inside whichever
  // `it` happens to run first, against vitest's 5s per-test default. Pay it here,
  // where the hook timeout applies instead.
  await eslint.lintText("export {};\n", {
    filePath: path.join(REPO_ROOT, "src", "warmup.ts"),
    warnIgnored: false,
  });
}, 60_000);

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

  // The layering rule is an allow-list, not a list of today's sibling
  // directories: a new src/util/ created during M1 must not become an
  // unguarded channel to fs by way of a helper that re-exports it.
  it("rejects a sibling directory that does not exist yet", async () => {
    const code = `import { readFileSync } from "../util/node-fs";\nexport const x = readFileSync;\n`;
    expect(await lintAs("src/domain/probe.ts", code)).toContain("no-restricted-imports");
  });

  it("rejects a dynamic import that climbs out of domain/", async () => {
    const code = `export const load = () => import("../infra/fs-gateway");\n`;
    expect(await lintAs("src/domain/probe.ts", code)).toContain("no-restricted-syntax");
  });

  it("rejects importing process as a module, not just reading the global", async () => {
    const code = `import { env } from "node:process";\nexport const home = env.HOME ?? "";\n`;
    expect(await lintAs("src/domain/probe.ts", code)).toContain("no-restricted-imports");
  });

  it("applies to .mts files in domain/, not only .ts", async () => {
    const code = `import { readFileSync } from "node:fs";\nexport const x = readFileSync;\n`;
    expect(await lintAs("src/domain/probe.mts", code)).toContain("no-restricted-imports");
  });

  it("cannot be waived with an inline eslint-disable comment", async () => {
    const code =
      `// eslint-disable-next-line no-restricted-imports\n` +
      `import { readFileSync } from "node:fs";\nexport const x = readFileSync;\n`;
    expect(
      await lintAs("src/domain/probe.ts", code),
      "these rules are architecture, not preference — noInlineConfig must hold",
    ).toContain("no-restricted-imports");
  });

  it("still allows a relative import inside domain/", async () => {
    const code = `import type { SystemInfo } from "./types";\nexport type X = SystemInfo;\n`;
    expect(await lintAs("src/domain/probe.ts", code)).toEqual([]);
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

describe("layer boundaries above domain/", () => {
  const obsidianImport = `import { Notice } from "obsidian";\nexport const x = Notice;\n`;

  for (const layer of ["infra", "providers", "orchestration"]) {
    it(`keeps obsidian out of src/${layer}/`, async () => {
      expect(await lintAs(`src/${layer}/probe.ts`, obsidianImport)).toContain("no-restricted-imports");
    });
  }

  it("lets src/ui/ import obsidian, which is its whole job", async () => {
    expect(await lintAs("src/ui/settings-tab.ts", obsidianImport)).toEqual([]);
  });

  it("keeps the network out of the plugin entirely", async () => {
    const code = `import https from "node:https";\nexport const x = https;\n`;
    expect(await lintAs("src/infra/probe.ts", code)).toContain("no-restricted-imports");
    expect(await lintAs("src/ui/probe.ts", `export const go = () => fetch("https://x.invalid");\n`)).toContain(
      "no-restricted-globals",
    );
  });
});

describe("branded paths cannot be forged (architecture §9.7.1)", () => {
  const cast = `declare const raw: string;\nexport const p = raw as SafeAbsolutePath;\n`;

  it("rejects casting a bare string to SafeAbsolutePath", async () => {
    expect(await lintAs("src/infra/backup-store.ts", cast)).toContain("no-restricted-syntax");
  });

  it("rejects the double-cast spelling too", async () => {
    const code = `declare const raw: string;\nexport const p = raw as unknown as SafeAbsolutePath;\n`;
    expect(await lintAs("src/orchestration/sync-engine.ts", code)).toContain("no-restricted-syntax");
  });

  it("allows it in path-guard, which is where validation happens", async () => {
    expect(await lintAs("src/infra/path-guard.ts", cast)).toEqual([]);
  });

  it("keeps every other domain rule alive in path-safety while allowing the cast", async () => {
    expect(await lintAs("src/domain/path-safety.ts", cast)).toEqual([]);
    expect(
      await lintAs("src/domain/path-safety.ts", `export function f(env: RuntimeEnv) {\n  void env;\n}\n`),
      "exempting the cast must not switch off the rest of the domain rules",
    ).toContain("no-restricted-syntax");
  });
});

describe("the domain layer cannot read the ambient clock (testing.md §3 req 4)", () => {
  it("rejects Date.now()", async () => {
    expect(await lintAs("src/domain/probe.ts", `export const t = Date.now();\n`)).toContain(
      "no-restricted-properties",
    );
  });

  it("rejects new Date()", async () => {
    expect(await lintAs("src/domain/probe.ts", `export const t = new Date();\n`)).toContain(
      "no-restricted-syntax",
    );
  });

  it("rejects Math.random()", async () => {
    expect(await lintAs("src/domain/probe.ts", `export const r = Math.random();\n`)).toContain(
      "no-restricted-properties",
    );
  });

  it("allows an injected timestamp", async () => {
    const code = `export function decide(nowMs: number): number {\n  return nowMs + 1;\n}\n`;
    expect(await lintAs("src/domain/probe.ts", code)).toEqual([]);
  });

  it("still allows infra/ to read the clock, which is where Clock lives", async () => {
    expect(await lintAs("src/infra/clock.ts", `export const now = () => Date.now();\n`)).toEqual([]);
  });
});

describe("property tests must go through fcAssert (G-08)", () => {
  it("rejects a direct fc.assert call", async () => {
    const code =
      `import fc from "fast-check";\n` +
      `export const run = () => fc.assert(fc.property(fc.integer(), (n) => n === n));\n`;
    expect(await lintAs("tests/m1/property/probe.test.ts", code)).toContain("no-restricted-syntax");
  });

  it("allows fcAssert", async () => {
    const code =
      `import fc from "fast-check";\nimport { fcAssert } from "../../helpers/fast-check";\n` +
      `export const run = () => fcAssert("p", fc.property(fc.integer(), (n) => n === n));\n`;
    expect(await lintAs("tests/m1/property/probe.test.ts", code)).toEqual([]);
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
