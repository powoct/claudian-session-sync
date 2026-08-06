/**
 * The check:* gates prove themselves (testing.md §12.1, §15).
 *
 * Same reasoning as the lint-rule tests: a gate script that has only ever
 * printed OK is indistinguishable from a gate script with an inverted condition.
 * Each gate below is run twice — once against a fixture that should pass and
 * once against a fixture that should fail — plus once against this repository,
 * so a scaffold change that breaks a gate shows up as a failing test rather than
 * as a red CI job three commits later.
 *
 * Fixture secrets are assembled at runtime from fragments so this file does not
 * itself trip check:secrets.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPTS = path.join(REPO_ROOT, "scripts");

const tempRoots: string[] = [];

afterAll(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

function makeRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "aiss-gate-"));
  tempRoots.push(dir);
  return dir;
}

function write(root: string, relativePath: string, contents: string | object): void {
  const full = path.join(root, relativePath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, typeof contents === "string" ? contents : JSON.stringify(contents, null, 2), "utf8");
}

interface GateResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runGate(script: string, args: string[] = []): GateResult {
  const result = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** A package.json/lock/.nvmrc trio that satisfies check-pinned-deps. */
function writeGoodPinnedFixture(root: string): void {
  write(root, "package.json", {
    name: "fixture",
    version: "1.2.3",
    engines: { node: ">=20.19.0" },
    devDependencies: {
      typescript: "5.9.3",
      vitest: "4.1.10",
      "@vitest/coverage-v8": "4.1.10",
      esbuild: "0.28.1",
      eslint: "10.8.0",
      "fast-check": "4.9.0",
    },
  });
  write(root, ".nvmrc", "20.20.2\n");
  write(root, "package-lock.json", { name: "fixture", version: "1.2.3", lockfileVersion: 3 });
}

describe("check-pinned-deps (G-02)", () => {
  it("passes on this repository", () => {
    expect(runGate("check-pinned-deps.mjs").status).toBe(0);
  });

  it("passes a fully pinned fixture", () => {
    const root = makeRoot();
    writeGoodPinnedFixture(root);
    expect(runGate("check-pinned-deps.mjs", ["--root", root]).status).toBe(0);
  });

  it("catches a caret range", () => {
    const root = makeRoot();
    writeGoodPinnedFixture(root);
    write(root, "package.json", {
      name: "fixture",
      version: "1.2.3",
      engines: { node: ">=20.19.0" },
      devDependencies: {
        typescript: "^5.9.3",
        vitest: "4.1.10",
        "@vitest/coverage-v8": "4.1.10",
        esbuild: "0.28.1",
        eslint: "10.8.0",
        "fast-check": "4.9.0",
      },
    });
    const result = runGate("check-pinned-deps.mjs", ["--root", root]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("typescript");
  });

  it("catches a wrong Node major in .nvmrc", () => {
    const root = makeRoot();
    writeGoodPinnedFixture(root);
    write(root, ".nvmrc", "18.19.1\n");
    expect(runGate("check-pinned-deps.mjs", ["--root", root]).status).toBe(1);
  });

  it("catches an old lockfile version", () => {
    const root = makeRoot();
    writeGoodPinnedFixture(root);
    write(root, "package-lock.json", { name: "fixture", version: "1.2.3", lockfileVersion: 2 });
    expect(runGate("check-pinned-deps.mjs", ["--root", root]).status).toBe(1);
  });

  it("catches a missing required devDependency", () => {
    const root = makeRoot();
    writeGoodPinnedFixture(root);
    write(root, "package.json", {
      name: "fixture",
      version: "1.2.3",
      engines: { node: ">=20.19.0" },
      devDependencies: { typescript: "5.9.3" },
    });
    const result = runGate("check-pinned-deps.mjs", ["--root", root]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("fast-check");
  });
});

describe("check-secrets (G-11)", () => {
  const githubToken = `gh${"p"}_${"A1b2C3d4E5f6G7h8I9j0"}`;
  const bearer = `Bear${"er"} ${"aaaaaaaaaaaaaaaaaaaa"}`;
  const realHomePosix = `/Us${"ers"}/somedev/notes`;
  const realHomeWindows = `C:\\Us${"ers"}\\somedev\\notes`;

  it("passes on this repository", () => {
    expect(runGate("check-secrets.mjs").status).toBe(0);
  });

  it("passes a clean fixture that uses the testuser placeholder", () => {
    const root = makeRoot();
    write(root, "tests/fixtures/sample.ts", `export const vault = "/Users/testuser/vault";\n`);
    write(root, "src/main.ts", `export const win = "C:\\\\Users\\\\testuser\\\\vault";\n`);
    expect(runGate("check-secrets.mjs", ["--root", root]).status).toBe(0);
  });

  it("catches a GitHub token in a fixture", () => {
    const root = makeRoot();
    write(root, "tests/fixtures/leak.ts", `export const token = "${githubToken}";\n`);
    const result = runGate("check-secrets.mjs", ["--root", root]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("github-token");
    expect(result.stderr, "the gate must not echo the secret it found").not.toContain(githubToken);
  });

  it("catches a bearer token", () => {
    const root = makeRoot();
    write(root, "tests/fixtures/leak.ts", `export const header = "${bearer}";\n`);
    expect(runGate("check-secrets.mjs", ["--root", root]).status).toBe(1);
  });

  it("catches a real POSIX home path", () => {
    const root = makeRoot();
    write(root, "tests/fixtures/leak.ts", `export const p = "${realHomePosix}";\n`);
    const result = runGate("check-secrets.mjs", ["--root", root]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("real-home-path-posix");
  });

  it("catches a real Windows home path", () => {
    const root = makeRoot();
    write(root, "tests/fixtures/leak.ts", `export const p = "${realHomeWindows.replace(/\\/g, "\\\\")}";\n`);
    const result = runGate("check-secrets.mjs", ["--root", root]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("real-home-path-windows");
  });

  it("scans fixtures whose extension is unusual or absent", () => {
    const root = makeRoot();
    write(root, "tests/fixtures/session-dump", `${githubToken}\n`);
    const result = runGate("check-secrets.mjs", ["--root", root]);
    expect(result.status, "an extension allow-list would miss this file entirely").toBe(1);
    expect(result.stderr).toContain("github-token");
  });

  it("skips binary files instead of choking on them", () => {
    const root = makeRoot();
    write(root, "tests/fixtures/clean.ts", "export const ok = 1;\n");
    writeFileSync(path.join(root, "tests", "fixtures", "blob.bin"), Buffer.from([0, 1, 2, 0, 255]));
    expect(runGate("check-secrets.mjs", ["--root", root]).status).toBe(0);
  });

  it("does not flag ordinary words that merely contain the literal fragments", () => {
    const root = makeRoot();
    write(
      root,
      "tests/fixtures/prose.ts",
      `// task-list, risk-free, the Bearer of bad news\nexport const note = "sk-";\n`,
    );
    expect(runGate("check-secrets.mjs", ["--root", root]).status).toBe(0);
  });
});

describe("check-docs (Q-01)", () => {
  const retiredRule = "行数多的赢";

  it("passes on this repository", () => {
    expect(runGate("check-docs.mjs").status).toBe(0);
  });

  it("passes a CLAUDE.md that points at the spec", () => {
    const root = makeRoot();
    write(root, "CLAUDE.md", "See docs/zh-CN/architecture.md for the normative spec.\n");
    expect(runGate("check-docs.mjs", ["--root", root]).status).toBe(0);
  });

  it("catches a missing pointer to the spec", () => {
    const root = makeRoot();
    write(root, "CLAUDE.md", "Product boundaries only.\n");
    expect(runGate("check-docs.mjs", ["--root", root]).status).toBe(1);
  });

  it("catches a retired rule creeping back in", () => {
    const root = makeRoot();
    write(root, "CLAUDE.md", `See docs/zh-CN/architecture.md.\n\n合并规则：${retiredRule}。\n`);
    const result = runGate("check-docs.mjs", ["--root", root]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(retiredRule);
  });
});

describe("check-manifest (G-06)", () => {
  function writeGoodManifestFixture(root: string): void {
    write(root, "manifest.json", {
      id: "ai-session-sync",
      name: "AI Session Sync",
      version: "0.0.1",
      minAppVersion: "1.5.0",
      description: "d",
      author: "a",
      isDesktopOnly: true,
    });
    write(root, "package.json", { name: "ai-session-sync", version: "0.0.1", main: "main.js" });
    write(root, "versions.json", { "0.0.1": "1.5.0" });
  }

  it("passes on this repository", () => {
    expect(runGate("check-manifest.mjs").status).toBe(0);
  });

  it("passes a consistent fixture", () => {
    const root = makeRoot();
    writeGoodManifestFixture(root);
    expect(runGate("check-manifest.mjs", ["--root", root]).status).toBe(0);
  });

  it("catches isDesktopOnly false", () => {
    const root = makeRoot();
    writeGoodManifestFixture(root);
    write(root, "manifest.json", {
      id: "ai-session-sync",
      name: "AI Session Sync",
      version: "0.0.1",
      minAppVersion: "1.5.0",
      description: "d",
      author: "a",
      isDesktopOnly: false,
    });
    const result = runGate("check-manifest.mjs", ["--root", root]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("isDesktopOnly");
  });

  it("catches a version drift between manifest and package.json", () => {
    const root = makeRoot();
    writeGoodManifestFixture(root);
    write(root, "package.json", { name: "ai-session-sync", version: "0.0.2", main: "main.js" });
    expect(runGate("check-manifest.mjs", ["--root", root]).status).toBe(1);
  });

  it("catches versions.json not naming the release", () => {
    const root = makeRoot();
    writeGoodManifestFixture(root);
    write(root, "versions.json", { "0.0.9": "1.5.0" });
    const result = runGate("check-manifest.mjs", ["--root", root]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("versions.json");
  });

  it("catches a versions.json minAppVersion that disagrees with the manifest", () => {
    const root = makeRoot();
    writeGoodManifestFixture(root);
    write(root, "versions.json", { "0.0.1": "1.4.0" });
    expect(runGate("check-manifest.mjs", ["--root", root]).status).toBe(1);
  });
});

describe("check-no-skip (G-07)", () => {
  function report(entries: Array<{ file: string; statuses: string[] }>): object {
    return {
      testResults: entries.map((entry) => ({
        name: entry.file,
        assertionResults: entry.statuses.map((status, index) => ({
          status,
          title: `case ${index}`,
          fullName: `suite > case ${index}`,
        })),
      })),
    };
  }

  it("fails closed when no report exists", () => {
    const root = makeRoot();
    const result = runGate("check-no-skip.mjs", ["--report", path.join(root, "nope.json")]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("npm test");
  });

  it("passes when every M1 case ran", () => {
    const root = makeRoot();
    write(root, "r.json", report([{ file: "/repo/tests/m1/planner.test.ts", statuses: ["passed", "passed"] }]));
    expect(runGate("check-no-skip.mjs", ["--report", path.join(root, "r.json")]).status).toBe(0);
  });

  it("catches a skipped M1 case", () => {
    const root = makeRoot();
    write(root, "r.json", report([{ file: "/repo/tests/m1/planner.test.ts", statuses: ["passed", "skipped"] }]));
    const result = runGate("check-no-skip.mjs", ["--report", path.join(root, "r.json")]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("skipped");
  });

  it("catches a todo M1 case", () => {
    const root = makeRoot();
    write(root, "r.json", report([{ file: "/repo/tests/m1/planner.test.ts", statuses: ["todo"] }]));
    expect(runGate("check-no-skip.mjs", ["--report", path.join(root, "r.json")]).status).toBe(1);
  });

  it("catches a skip reported with Windows path separators (Q-32)", () => {
    const root = makeRoot();
    write(root, "r.json", report([{ file: "D:\\repo\\tests\\m1\\planner.test.ts", statuses: ["pending"] }]));
    expect(runGate("check-no-skip.mjs", ["--report", path.join(root, "r.json")]).status).toBe(1);
  });

  it("leaves tests/m2 and tests/pending alone", () => {
    const root = makeRoot();
    write(
      root,
      "r.json",
      report([
        { file: "/repo/tests/m2/codex.test.ts", statuses: ["skipped"] },
        { file: "/repo/tests/pending/escape.test.ts", statuses: ["todo"] },
        { file: "/repo/tests/m1/planner.test.ts", statuses: ["passed"] },
      ]),
    );
    expect(runGate("check-no-skip.mjs", ["--report", path.join(root, "r.json")]).status).toBe(0);
  });
});
