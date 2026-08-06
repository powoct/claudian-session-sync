import { defineConfig } from "vitest/config";

// `npm run check:bundle` — the three-layer bundle contract of testing.md §12.2.
// Requires `npm run build` to have run first; the tests fail loudly if main.js or
// dist/meta.json is missing rather than silently passing.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/build/artifact-*.test.ts"],
    // The bundle is loaded through a Module._load hook; parallel workers would
    // fight over that global.
    fileParallelism: false,
    reporters: ["default"],
    coverage: { enabled: false },
  },
});
