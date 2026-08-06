import { defineConfig } from "vitest/config";

// `npm run test:nightly` — property tests only, with a large run budget
// (testing.md §12.5 / §13). FC_NUM_RUNS and FC_SEED are read by
// tests/helpers/fast-check.ts.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/property/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
    reporters: ["default"],
    // 5000 runs per property; the default 5s per-test timeout is far too tight.
    testTimeout: 300_000,
    hookTimeout: 60_000,
    coverage: { enabled: false },
  },
});
