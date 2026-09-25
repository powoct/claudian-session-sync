/**
 * Claudian 2.3.3 stopped writing deletion and assignment markers (#1386).
 *
 * Two optional features were built on them, and neither plugin tells the user.
 * These tests pin the two halves of saying so: that the version is read from
 * the manifest Obsidian actually loads, never guessed; and that the sentence
 * appears exactly when a feature switched on here is affected — silence
 * otherwise, because a warning that fires on a guess is one people learn to
 * skip.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MARKERLESS_FROM,
  compatNotices,
  compatWarnings,
  isMarkerless,
  launchNotice,
} from "../../src/domain/claudian-compat";
import { readClaudianVersion } from "../../src/infra/claudian-version";
import { createNodeFsGateway } from "../../src/infra/node-fs-gateway";
import { sequentialIdGen } from "../../src/infra/clock";
import { makeRealTmpDir, removeTree } from "../helpers/fs-cleanup";

describe("which Claudian deletes without a marker", () => {
  it.each([
    ["2.3.3", true],
    ["2.3.4", true],
    ["2.4.0", true],
    ["2.10.0", true], // numeric, not lexical: "2.10" > "2.3"
    ["3.0.0", true],
    ["2.3.3-beta.1", true], // the change is in the pre-release
    [" 2.3.3 ", true],
    ["2.3.2", false],
    ["2.2.7", false],
    ["1.99.99", false],
  ])("%s → %s", (version, expected) => {
    expect(isMarkerless(version)).toBe(expected);
  });

  it("is silent about anything it cannot read as a version", () => {
    for (const unreadable of [null, "", "latest", "2.3", "v2.3.3", "two"]) {
      expect(isMarkerless(unreadable)).toBe(false);
    }
  });

  it("starts at the release that shipped #1386", () => {
    // `git tag --contains 37f72c0b` in upstream: 2.3.3 is the first.
    expect(MARKERLESS_FROM).toEqual([2, 3, 3]);
  });
});

describe("what is said, and when", () => {
  const on = { recordsProvider: true, sharing: true };

  it("says nothing for an older Claudian, whatever is switched on", () => {
    expect(compatNotices({ claudianVersion: "2.3.2", ...on })).toEqual([]);
  });

  it("says nothing when it could not read the version", () => {
    expect(compatNotices({ claudianVersion: null, ...on })).toEqual([]);
  });

  it("says nothing when neither affected feature is on", () => {
    // The default setup is not affected: a deleted record just stops being
    // admitted. Warning everyone would bury the people it is for.
    expect(
      compatNotices({ claudianVersion: "2.3.3", recordsProvider: false, sharing: false }),
    ).toEqual([]);
  });

  it("names the feature, the version, and what the user will see", () => {
    const warnings = compatWarnings({ claudianVersion: "2.3.3", ...on });

    expect(warnings.recordsProvider).toContain("Claudian 2.3.3");
    expect(warnings.recordsProvider).toContain("comes back after Obsidian restarts");
    expect(warnings.recordsProvider).toContain("turn this off");

    expect(warnings.sharing).toContain("Claudian 2.3.3");
    expect(warnings.sharing).toContain("can come back after a restart");
    expect(warnings.sharing).toContain("deleted or assigned to itself");
  });

  it("warns only about what is switched on", () => {
    const provider = compatWarnings({ claudianVersion: "2.4.0", recordsProvider: true, sharing: false });
    expect(provider.recordsProvider).not.toBeNull();
    expect(provider.sharing).toBeNull();

    const sharing = compatWarnings({ claudianVersion: "2.4.0", recordsProvider: false, sharing: true });
    expect(sharing.recordsProvider).toBeNull();
    expect(sharing.sharing).not.toBeNull();
  });

  it("puts the same sentences in the report as in the settings pane", () => {
    const input = { claudianVersion: "2.3.3", ...on };
    const warnings = compatWarnings(input);
    expect(compatNotices(input)).toEqual([warnings.recordsProvider, warnings.sharing]);
  });

  it("launch notice names what is affected, and nothing when nothing is", () => {
    expect(launchNotice({ recordsProvider: null, sharing: null })).toBeNull();
    expect(launchNotice({ recordsProvider: "x", sharing: null })).toContain(
      "“Claudian conversation records” is not fully compatible",
    );
    expect(launchNotice({ recordsProvider: null, sharing: "x" })).toContain(
      "sharing is not fully compatible",
    );
    expect(launchNotice({ recordsProvider: "x", sharing: "x" })).toContain(
      "“Claudian conversation records” and sharing are not fully compatible",
    );
  });
});

describe("reading the version Obsidian loads", () => {
  let root = "";
  afterEach(() => {
    if (root) removeTree(root);
    root = "";
  });

  const fs = createNodeFsGateway({
    ids: sequentialIdGen(),
    platform: process.platform,
    pid: process.pid,
    sleep: async () => undefined,
  });

  async function plugins(entries: Record<string, unknown>): Promise<string> {
    root = makeRealTmpDir("aiss-claudian-version-");
    const dir = path.join(root, ".obsidian", "plugins");
    for (const [folder, manifest] of Object.entries(entries)) {
      await fsp.mkdir(path.join(dir, folder), { recursive: true });
      await fsp.writeFile(
        path.join(dir, folder, "manifest.json"),
        typeof manifest === "string" ? manifest : JSON.stringify(manifest),
      );
    }
    return dir;
  }

  const read = (pluginsDir: string) =>
    readClaudianVersion({ fs, joinPath: (...parts) => path.join(...parts), pluginsDir });

  it("reads it from the plugin's own folder", async () => {
    const dir = await plugins({ realclaudian: { id: "realclaudian", version: "2.3.3" } });
    expect(await read(dir)).toBe("2.3.3");
  });

  it("finds it under another folder name, by the id inside", async () => {
    // A manual install can use any folder; Obsidian goes by the manifest.
    const dir = await plugins({
      "some-other-plugin": { id: "something-else", version: "9.9.9" },
      "claudian-main": { id: "realclaudian", version: "2.4.1" },
    });
    expect(await read(dir)).toBe("2.4.1");
  });

  it("does not trust a folder name whose manifest says otherwise", async () => {
    const dir = await plugins({ realclaudian: { id: "an-impostor", version: "2.3.3" } });
    expect(await read(dir)).toBeNull();
  });

  it("is null when there is no plugins folder at all", async () => {
    const dir = await plugins({});
    expect(await read(path.join(dir, "absent"))).toBeNull();
  });

  it("is null when the manifest cannot be parsed", async () => {
    expect(await read(await plugins({ realclaudian: "{ not json" }))).toBeNull();
  });

  it("is null when the manifest has no version", async () => {
    const dir = await plugins({ realclaudian: { id: "realclaudian" } });
    expect(await read(dir)).toBeNull();
  });
});
