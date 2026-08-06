import { defineConfig } from "vitest/config";

// Default suite: L0 / L1 / L2 and the security group (testing.md §2), plus the
// M0 toolchain self-tests. Everything that needs the *built* bundle lives in
// tests/build/artifact-*.test.ts and runs from vitest.build.config.ts after
// `npm run build` — see testing.md §13 for the CI ordering.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "tests/build/artifact-*.test.ts"],
    reporters: ["default", "json"],
    outputFile: { json: "reports/vitest.json" },
    // `.only` fails the run here as well as in CI. check:no-skip catches .only
    // via the siblings it turns into skips, but a `describe.only` wrapping a
    // whole file leaves no skipped case behind and would slip past it.
    allowOnly: false,
    // Real tmpdirs and real rename semantics mean tests must not race each other
    // inside one file (testing.md §2.2).
    sequence: { concurrent: false },
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "coverage",
      reportOnFailure: true,
      // ① testing.md §12.6 asks for `all: true`. Vitest 4 removed that flag and
      // folded its meaning into `include`: naming globs here reports every
      // matching file, covered or not. Same guarantee — deleting a test file
      // lowers coverage instead of raising it. tests/build/coverage-gate.test.ts
      // pins that behaviour so a future upgrade cannot quietly undo it.
      include: ["src/**/*.ts"],
      // main.ts is pure assembly; it is covered by the bundle smoke test instead.
      exclude: ["src/**/*.d.ts", "src/main.ts"],
      thresholds: {
        autoUpdate: false, // ② see testing.md §12.6
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
        "src/domain/**": { lines: 90, functions: 90, branches: 85, statements: 90 },
        "src/infra/**": { lines: 80, functions: 80, branches: 70, statements: 80 },
        "src/providers/**": { lines: 70, functions: 70, branches: 60, statements: 70 },
      },
    },
  },
});
