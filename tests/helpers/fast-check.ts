/**
 * fast-check wrapper that persists a counterexample artifact on failure
 * (gate G-08, testing.md §12.5).
 *
 * A nightly property run that only says "property X failed" is nearly useless
 * hours later: the seed and the shrunk counterexample live in a log that rotates
 * away. Every failure here writes a JSON artifact that CI uploads, including a
 * `regressionSnippet` that can be pasted straight into tests/m1/regression/.
 *
 * Run size comes from FC_NUM_RUNS and the seed from FC_SEED (testing.md §13), so
 * one test file serves as both a fast PR check and a deep nightly run.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";

export const DEFAULT_NUM_RUNS = 100;

// Read at call time, not at import time: a module-level snapshot cannot be
// tested without reloading the module, and "the nightly job's env var is
// ignored" is precisely the failure that would go unnoticed for months.
export function fcNumRuns(): number {
  return Number.parseInt(process.env.FC_NUM_RUNS ?? "", 10) || DEFAULT_NUM_RUNS;
}

export function fcSeed(): number | undefined {
  const raw = process.env.FC_SEED;
  if (!raw || raw.trim() === "") return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function fcArtifactsDir(): string {
  return process.env.FC_ARTIFACTS_DIR ?? "artifacts";
}

export interface FcAssertOptions {
  numRuns?: number;
  seed?: number;
  path?: string;
  endOnFailure?: boolean;
  artifactsDir?: string;
}

/**
 * Drop-in replacement for `fc.assert` that writes an artifact before rethrowing.
 * `name` identifies the property in the artifact filename — keep it stable.
 */
export function fcAssert<Ts>(
  name: string,
  property: fc.IProperty<Ts>,
  options: FcAssertOptions = {},
): void {
  const { artifactsDir = fcArtifactsDir(), seed, path: counterexamplePath, endOnFailure, numRuns } = options;
  const envSeed = fcSeed();

  const parameters: fc.Parameters<Ts> = {
    numRuns: numRuns ?? fcNumRuns(),
    ...(seed !== undefined ? { seed } : envSeed !== undefined ? { seed: envSeed } : {}),
    ...(counterexamplePath !== undefined ? { path: counterexamplePath } : {}),
    ...(endOnFailure !== undefined ? { endOnFailure } : {}),
  };

  const details = fc.check(property, parameters);
  if (!details.failed) return;

  writeCounterexampleArtifact(name, details, artifactsDir);
  throw new Error(fc.defaultReportMessage(details) ?? `property "${name}" failed`);
}

/** Returns the artifact path so tests can assert on it. */
export function writeCounterexampleArtifact<Ts>(
  name: string,
  details: fc.RunDetails<Ts>,
  artifactsDir: string = fcArtifactsDir(),
): string {
  const safeName = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "property";
  const seed = details.seed;
  const counterexamplePath = details.counterexamplePath ?? "";
  // `errorInstance` only exists on the property-failure member of the RunDetails
  // union; too-many-skips and interrupted runs do not carry one.
  const errorInstance = (details as Partial<fc.RunDetailsFailureProperty<Ts>>).errorInstance;

  const artifact = {
    property: name,
    seed,
    counterexamplePath,
    numRuns: details.numRuns,
    counterexample: safeSerialize(details.counterexample),
    error: describeError(errorInstance),
    regressionSnippet: buildRegressionSnippet(name, safeName, seed, counterexamplePath),
  };

  mkdirSync(artifactsDir, { recursive: true });
  const file = path.join(artifactsDir, `fc-${safeName}-${seed}.json`);
  writeFileSync(file, JSON.stringify(artifact, null, 2) + "\n", "utf8");
  return file;
}

function buildRegressionSnippet(
  name: string,
  safeName: string,
  seed: number,
  counterexamplePath: string,
): string {
  return [
    `// tests/m1/regression/${safeName}.test.ts`,
    `// Replays the exact failing run of "${name}". Paste in the property it came`,
    "// from, then keep this file as a fixed regression once the bug is fixed.",
    'import { it } from "vitest";',
    'import { fcAssert } from "../../helpers/fast-check";',
    "",
    `it("regression: ${name} (seed ${seed})", () => {`,
    `  fcAssert("${name}", /* the property from the failing test */ null as never, {`,
    `    seed: ${seed},`,
    `    path: ${JSON.stringify(counterexamplePath)},`,
    "    endOnFailure: true,",
    "  });",
    "});",
  ].join("\n");
}

/** An interrupted or all-skipped run carries no error instance at all. */
function describeError(errorInstance: unknown): string {
  if (errorInstance instanceof Error) return errorInstance.message;
  if (errorInstance === undefined || errorInstance === null) return "";
  return String(errorInstance);
}

/** Counterexamples can hold values JSON cannot express; never let that mask the failure. */
function safeSerialize(value: unknown): unknown {
  try {
    return JSON.parse(
      JSON.stringify(value, (_key, inner: unknown) => (typeof inner === "bigint" ? `${inner}n` : inner)),
    );
  } catch {
    return String(value);
  }
}
