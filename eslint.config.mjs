// Flat config. The rules below are gate G-10 (testing.md §12.1) — they are not
// style preferences, they are the machine-enforced version of the layering rules
// in architecture.md §4.1. Run with `--max-warnings=0`; nothing here is advisory.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/** Node built-ins the domain layer must never reach for, in every spelling. */
const NODE_MODULES_BANNED_IN_DOMAIN = [
  "fs",
  "node:fs",
  "fs/promises",
  "node:fs/promises",
  "path",
  "node:path",
  "path/posix",
  "path/win32",
  "node:path/posix",
  "node:path/win32",
  "os",
  "node:os",
  "child_process",
  "node:child_process",
  // node:module would otherwise re-open the door via createRequire(...)("fs").
  "module",
  "node:module",
];

// Same set as a regex, for the esquery selectors that match a literal source
// string. esquery delimits a selector's regex with slashes, so a literal slash
// inside one is a *parse error*, not a match — every slash below is therefore
// written as a unicode escape (backslash + u002F). A broken selector here fails
// silently until some file actually matches the selector's `files` glob, which
// is why tests/build/eslint-rules.test.ts lints virtual src/domain files.
const BANNED_IN_DOMAIN_RE =
  "^(node:)?(fs|fs\\u002Fpromises|path|path\\u002Fposix|path\\u002Fwin32|os|child_process|module)$|^obsidian$";

export default tseslint.config(
  {
    // Build output, dependencies and gate artifacts are never linted.
    ignores: [
      "node_modules/**",
      "dist/**",
      "coverage/**",
      "reports/**",
      "artifacts/**",
      "main.js",
      "tmp/**",
      "venv/**",
      // throwaway project written by tests/build/coverage-gate.test.ts
      "coverage-gate-fixture/**",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    // Project-wide language setup.
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-console": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      // G-10, part 3: nothing anywhere may reach the filesystem through a bare
      // `require()`. Every fs access goes through FsGateway (architecture §4.1 #3).
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.name='require'][arguments.0.value=/^(node:)?(fs|fs\\u002Fpromises|os|child_process)$/]",
          message:
            "Direct require() of a Node filesystem/OS module is banned. Go through infra/fs-gateway.ts (architecture §4.1 #3).",
        },
      ],
    },
  },

  {
    // Browser/DOM globals only exist where the Obsidian API is in play.
    files: ["src/ui/**/*.ts", "src/main.ts"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },

  {
    // G-10, parts 1 and 2 — the domain layer stays pure.
    // architecture.md §4.1 rules 1 and 2; testing.md §3 requirements 1 and 3.
    files: ["src/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            ...NODE_MODULES_BANNED_IN_DOMAIN.map((name) => ({
              name,
              message:
                "domain/ must stay pure: no Node built-ins. path-safety.ts does its own split('/') (architecture §4.1 #1).",
            })),
            {
              name: "obsidian",
              message:
                "domain/ must stay testable without Obsidian (architecture §4.1 #1).",
            },
          ],
          patterns: [
            {
              // `**` on both sides: `**/infra/*` would miss ../infra/sub/deep.
              group: ["obsidian/**", "**/infra/**", "**/orchestration/**", "**/providers/**", "**/ui/**"],
              message:
                "domain/ is the innermost layer: it may not import outward (architecture §4.1).",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "Identifier[name='RuntimeEnv']",
          message:
            "domain/ may hold SystemInfo (plain data) and nowMs, never RuntimeEnv itself (architecture §4.1 #2, testing.md §3 req 3).",
        },
        {
          selector: `CallExpression[callee.name='require'][arguments.0.value=/${BANNED_IN_DOMAIN_RE}/]`,
          message:
            "domain/ must stay pure: no Node built-ins, in any spelling (architecture §4.1 #1).",
        },
        {
          // no-restricted-imports does not see `await import("node:fs")`.
          selector: `ImportExpression[source.value=/${BANNED_IN_DOMAIN_RE}/]`,
          message:
            "domain/ must stay pure: a dynamic import is still an import (architecture §4.1 #1).",
        },
      ],
      // Environment access is injected, never reached for (architecture §4.1 #2).
      "no-restricted-globals": [
        "error",
        { name: "process", message: "domain/ takes SystemInfo as data; it never reads the environment." },
        { name: "require", message: "domain/ must stay pure (architecture §4.1 #1)." },
        { name: "__dirname", message: "domain/ knows nothing about the filesystem (architecture §4.1 #1)." },
        { name: "__filename", message: "domain/ knows nothing about the filesystem (architecture §4.1 #1)." },
      ],
    },
  },

  {
    // Gate scripts and build tooling are plain Node ESM, not part of the plugin.
    files: ["scripts/**/*.mjs", "*.mjs"],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
    },
  },

  {
    // Tests need the freedom to build deliberately malformed input.
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-function-type": "off",
    },
  },
);
