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
  // no-restricted-globals only sees the bare global; importing the module
  // creates a local binding it never inspects.
  "process",
  "node:process",
];

// Same set as a regex, for the esquery selectors that match a literal source
// string. esquery delimits a selector's regex with slashes, so a literal slash
// inside one is a *parse error*, not a match — every slash below is therefore
// written as a unicode escape (backslash + u002F). A broken selector here fails
// silently until some file actually matches the selector's `files` glob, which
// is why tests/build/eslint-rules.test.ts lints virtual src/domain files.
const BANNED_IN_DOMAIN_RE =
  "^(node:)?(fs|fs\\u002Fpromises|path|path\\u002Fposix|path\\u002Fwin32|os|child_process|module|process)$|^obsidian$";

/** Any relative specifier that climbs out of src/domain/. */
const ESCAPES_DOMAIN_RE = "^\\.\\.\\u002F";

// Flat config REPLACES a rule's options rather than merging them: the last
// matching config object wins for a given rule id. So each block below has to
// restate everything that applies to it — these lists exist to make that
// composition explicit instead of accidental.

const NO_NETWORK_MESSAGE =
  "This plugin never talks to the network: no cloud API, no OAuth, no telemetry (CLAUDE.md product boundary, architecture §13.1). Sync happens through a local directory.";

const NETWORK_MODULES = [
  "http",
  "node:http",
  "https",
  "node:https",
  "net",
  "node:net",
  "tls",
  "node:tls",
  "dgram",
  "node:dgram",
].map((name) => ({ name, message: NO_NETWORK_MESSAGE }));

const NETWORK_GLOBALS = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource"].map((name) => ({
  name,
  message: NO_NETWORK_MESSAGE,
}));

const OBSIDIAN_ONLY_IN_UI = {
  name: "obsidian",
  message:
    "Only src/ui/ and src/main.ts may import obsidian (architecture §4.1). Everything below it must run in a plain Node test.",
};

/**
 * architecture §9.7.1 / §4.1 #3: FsGateway's write methods only accept a branded
 * SafeAbsolutePath, so "forgot to validate this path" is a compile error. A cast
 * launders an unvalidated string straight through that guarantee — and it is the
 * one line of code that would look completely ordinary in review.
 */
const SAFE_PATH_CAST_BAN = {
  selector: "TSAsExpression > TSTypeReference > Identifier[name=/^Safe(Absolute|Relative)Path$/]",
  message:
    "Do not cast to SafeAbsolutePath/SafeRelativePath. Mint it through PathGuard so validation cannot be skipped (architecture §9.7.1).",
};

/**
 * G-10 part 3: nothing anywhere reaches the filesystem through a bare
 * `require()`. Every fs access goes through FsGateway (architecture §4.1 #3).
 */
const REQUIRE_NODE_FS_BAN = {
  selector:
    "CallExpression[callee.name='require'][arguments.0.value=/^(node:)?(fs|fs\\u002Fpromises|os|child_process)$/]",
  message:
    "Direct require() of a Node filesystem/OS module is banned. Go through infra/fs-gateway.ts (architecture §4.1 #3).",
};

/** The domain layer's syntax bans, named so the path-safety exemption can drop exactly one entry. */
const DOMAIN_SYNTAX_RULES = [
  {
    selector: "Identifier[name='RuntimeEnv']",
    message:
      "domain/ may hold SystemInfo (plain data) and nowMs, never RuntimeEnv itself (architecture §4.1 #2, testing.md §3 req 3).",
  },
  {
    selector: `CallExpression[callee.name='require'][arguments.0.value=/${BANNED_IN_DOMAIN_RE}/]`,
    message: "domain/ must stay pure: no Node built-ins, in any spelling (architecture §4.1 #1).",
  },
  {
    // no-restricted-imports does not see `await import("node:fs")`.
    selector: `ImportExpression[source.value=/${BANNED_IN_DOMAIN_RE}/]`,
    message: "domain/ must stay pure: a dynamic import is still an import (architecture §4.1 #1).",
  },
  {
    // ...nor `await import("../infra/fs-gateway")`, the same layering violation
    // the patterns group catches statically.
    selector: `ImportExpression[source.value=/${ESCAPES_DOMAIN_RE}/]`,
    message:
      "domain/ may not import anything outside src/domain/, dynamically or otherwise (architecture §4.1).",
  },
  {
    // no-restricted-properties misses `new Date()` with no arguments.
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message: "domain/ receives nowMs as a parameter; the clock is injected (testing.md §3 req 4).",
  },
];

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
      // throwaway projects written by tests/build/*.test.ts
      "coverage-gate-fixture/**",
      "reporter-contract-fixture/**",
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
      "no-restricted-syntax": ["error", REQUIRE_NODE_FS_BAN],
    },
  },

  {
    // Browser/DOM globals only exist where the Obsidian API is in play.
    files: ["src/ui/**/*.{ts,tsx,mts,cts}", "src/main.ts"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },

  {
    // Whole plugin: the network is off limits, and branded path types may not
    // be forged.
    files: ["src/**/*.{ts,tsx,mts,cts}"],
    rules: {
      "no-restricted-imports": ["error", { paths: NETWORK_MODULES }],
      "no-restricted-globals": ["error", ...NETWORK_GLOBALS],
      // Restated, not inherited — this block replaces the base rule.
      "no-restricted-syntax": ["error", REQUIRE_NODE_FS_BAN, SAFE_PATH_CAST_BAN],
    },
  },

  {
    // Only the presentation layer and the entry point may see Obsidian
    // (architecture §4.1). An `obsidian` import in orchestration/, infra/ or
    // providers/ compiles fine and then makes the whole L2 suite unrunnable,
    // because those layers have to be testable without the host app.
    // (src/domain/ gets this via its own, stricter block below.)
    files: [
      "src/infra/**/*.{ts,tsx,mts,cts}",
      "src/providers/**/*.{ts,tsx,mts,cts}",
      "src/orchestration/**/*.{ts,tsx,mts,cts}",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [...NETWORK_MODULES, OBSIDIAN_ONLY_IN_UI],
          patterns: [{ group: ["obsidian/**"], message: OBSIDIAN_ONLY_IN_UI.message }],
        },
      ],
    },
  },

  {
    // G-10, parts 1 and 2 — the domain layer stays pure.
    // architecture.md §4.1 rules 1 and 2; testing.md §3 requirements 1 and 3.
    //
    // The extension list is not decoration: an override keyed on `*.ts` alone
    // leaves a `.mts` / `.cts` / `.js` file in domain/ linted by the base config
    // only, i.e. with none of these rules.
    files: ["src/domain/**/*.{ts,tsx,mts,cts,js,mjs,cjs}"],
    // A precise `// eslint-disable-next-line no-restricted-imports` would
    // otherwise switch the layering gate off with nothing in CI noticing.
    // These rules are architecture, not lint preference — they are not waivable
    // file by file.
    linterOptions: { noInlineConfig: true },
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
            // Restated, not inherited: this block replaces the src/** one.
            ...NETWORK_MODULES,
            {
              name: "obsidian",
              message:
                "domain/ must stay testable without Obsidian (architecture §4.1 #1).",
            },
          ],
          patterns: [
            {
              // Allow-list by inversion. Naming the outward layers explicitly
              // (infra, ui, providers, ...) only bans the directories that exist
              // today: a new src/util/ would be an unguarded channel, and a
              // helper there may itself import node:fs and re-export it.
              // Anything that climbs out of src/domain/ is banned instead.
              group: ["../*", "../**"],
              message:
                "domain/ is the innermost layer: it may not import anything outside src/domain/ (architecture §4.1). Take the value as a parameter instead.",
            },
            {
              group: ["obsidian/**"],
              message:
                "domain/ must stay testable without Obsidian (architecture §4.1 #1).",
            },
          ],
        },
      ],
      "no-restricted-syntax": ["error", ...DOMAIN_SYNTAX_RULES, SAFE_PATH_CAST_BAN],
      // Environment access is injected, never reached for (architecture §4.1 #2).
      "no-restricted-globals": [
        "error",
        ...NETWORK_GLOBALS,
        { name: "process", message: "domain/ takes SystemInfo as data; it never reads the environment." },
        { name: "require", message: "domain/ must stay pure (architecture §4.1 #1)." },
        { name: "__dirname", message: "domain/ knows nothing about the filesystem (architecture §4.1 #1)." },
        { name: "__filename", message: "domain/ knows nothing about the filesystem (architecture §4.1 #1)." },
      ],
      // Time and randomness are injected too (testing.md §3 req 4): every clock
      // read goes through Clock, every id through IdGen. A domain function that
      // calls Date.now() cannot be replayed, and the stability ledger's whole
      // premise is reproducible decisions.
      "no-restricted-properties": [
        "error",
        {
          object: "Date",
          property: "now",
          message: "domain/ receives nowMs as a parameter; the clock is injected (testing.md §3 req 4).",
        },
        {
          object: "Math",
          property: "random",
          message: "domain/ must be deterministic; randomness comes from IdGen (testing.md §3 req 4).",
        },
      ],
    },
  },

  {
    // The two modules whose job is to mint branded paths. They perform the cast
    // exactly once, right after validating — that is what makes every other
    // module's ban meaningful. Placed after the domain block on purpose: this
    // drops exactly one rule entry rather than switching no-restricted-syntax
    // off, which would silently take RuntimeEnv, dynamic imports and Date.now
    // with it.
    files: ["src/domain/path-safety.{ts,mts}"],
    rules: { "no-restricted-syntax": ["error", ...DOMAIN_SYNTAX_RULES] },
  },

  {
    files: ["src/infra/path-guard.{ts,mts}"],
    rules: { "no-restricted-syntax": ["error", REQUIRE_NODE_FS_BAN] },
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
    files: ["tests/**/*.{ts,tsx,mts,cts}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-function-type": "off",
      // G-08: a property test that calls fc.assert directly throws away the
      // counterexample artifact the nightly job exists to produce
      // (testing.md §12.5). fcAssert is the only entry point.
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.object.name='fc'][callee.property.name='assert']",
          message:
            "Use fcAssert() from tests/helpers/fast-check.ts: fc.assert leaves no replayable artifact behind when nightly fails (testing.md §12.5, G-08).",
        },
      ],
    },
  },
);
