/**
 * Gate G-08 proves itself (testing.md §12.5).
 *
 * The nightly property job is only worth running if a failure leaves something
 * behind that can be replayed. This drives the wrapper through a property that
 * is guaranteed to fail and asserts the artifact exists, is complete, and is
 * pasteable — and that a passing property leaves no litter behind.
 */
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_NUM_RUNS, fcAssert, fcNumRuns, fcSeed } from "../helpers/fast-check";
import { removeTree } from "../helpers/fs-cleanup";

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) removeTree(dir);
});

function makeArtifactsDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "aiss-fc-"));
  tempDirs.push(dir);
  return dir;
}

describe("fast-check counterexample artifacts (G-08)", () => {
  it("writes a replayable artifact when a property fails", () => {
    const artifactsDir = makeArtifactsDir();

    expect(() =>
      fcAssert("demo-integers-are-negative", fc.property(fc.integer(), (n) => n < 0), {
        numRuns: 50,
        seed: 4242,
        artifactsDir,
      }),
    ).toThrow();

    const files = readdirSync(artifactsDir);
    expect(files).toEqual(["fc-demo-integers-are-negative-4242.json"]);

    const artifact = JSON.parse(readFileSync(path.join(artifactsDir, files[0] as string), "utf8"));
    expect(artifact.property).toBe("demo-integers-are-negative");
    expect(artifact.seed).toBe(4242);
    expect(typeof artifact.counterexamplePath).toBe("string");
    expect(artifact.numRuns).toBeGreaterThan(0);
    // fast-check shrinks; 0 is the smallest non-negative integer.
    expect(artifact.counterexample).toEqual([0]);
    expect(artifact.regressionSnippet).toContain("tests/m1/regression/");
    expect(artifact.regressionSnippet).toContain("seed: 4242");
    expect(artifact.regressionSnippet).toContain(JSON.stringify(artifact.counterexamplePath));
  });

  it("writes nothing when the property holds", () => {
    const artifactsDir = makeArtifactsDir();

    fcAssert("demo-abs-is-non-negative", fc.property(fc.integer(), (n) => Math.abs(n) >= 0), {
      numRuns: 25,
      seed: 7,
      artifactsDir,
    });

    expect(readdirSync(artifactsDir)).toEqual([]);
  });

  it("honours FC_NUM_RUNS and FC_SEED, which is all the nightly job configures", () => {
    // The nightly workflow sets these two env vars and nothing else
    // (testing.md §13). If the wrapper ignored them, nightly would silently run
    // the same 100 cases as a PR check and nobody would be able to tell.
    const artifactsDir = makeArtifactsDir();
    const previousRuns = process.env.FC_NUM_RUNS;
    const previousSeed = process.env.FC_SEED;
    process.env.FC_NUM_RUNS = "37";
    process.env.FC_SEED = "31337";

    try {
      expect(fcNumRuns()).toBe(37);
      expect(fcSeed()).toBe(31337);

      expect(() =>
        fcAssert("demo-env-plumbing", fc.property(fc.integer(), (n) => n < 0), { artifactsDir }),
      ).toThrow();

      const [file] = readdirSync(artifactsDir);
      expect(file, "the seed from FC_SEED must reach the artifact name").toBe(
        "fc-demo-env-plumbing-31337.json",
      );
      const artifact = JSON.parse(readFileSync(path.join(artifactsDir, file as string), "utf8"));
      expect(artifact.numRuns).toBeLessThanOrEqual(37);
    } finally {
      if (previousRuns === undefined) delete process.env.FC_NUM_RUNS;
      else process.env.FC_NUM_RUNS = previousRuns;
      if (previousSeed === undefined) delete process.env.FC_SEED;
      else process.env.FC_SEED = previousSeed;
    }
  });

  it("falls back to a bounded default when the env is unset", () => {
    const previousRuns = process.env.FC_NUM_RUNS;
    delete process.env.FC_NUM_RUNS;
    try {
      expect(fcNumRuns()).toBe(DEFAULT_NUM_RUNS);
      expect(fcSeed()).toBeUndefined();
    } finally {
      if (previousRuns !== undefined) process.env.FC_NUM_RUNS = previousRuns;
    }
  });

  it("keeps the artifact filename filesystem-safe", () => {
    const artifactsDir = makeArtifactsDir();

    expect(() =>
      fcAssert("I1 / ordered byte stream: recoverable?", fc.property(fc.constant(1), () => false), {
        numRuns: 1,
        seed: 9,
        artifactsDir,
      }),
    ).toThrow();

    const [file] = readdirSync(artifactsDir);
    expect(file).toBe("fc-I1-ordered-byte-stream-recoverable-9.json");
  });
});
