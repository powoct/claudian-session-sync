/**
 * Gate G-08 proves itself (testing.md §12.5).
 *
 * The nightly property job is only worth running if a failure leaves something
 * behind that can be replayed. This drives the wrapper through a property that
 * is guaranteed to fail and asserts the artifact exists, is complete, and is
 * pasteable — and that a passing property leaves no litter behind.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { fcAssert } from "../helpers/fast-check";

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
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
