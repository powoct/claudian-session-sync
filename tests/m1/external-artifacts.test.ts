/**
 * architecture §8.2 layers 2 and 3 — explaining a rejected file.
 *
 * The thing worth testing here is restraint. This classifier decides nothing:
 * whatever it returns, the file is left exactly where it is. So the failure it
 * has to avoid is not "missed a conflict copy" but "confidently named the wrong
 * thing" — telling a user that a file is a copy of a session they still have,
 * when it is nothing of the sort, is how someone deletes a real conversation.
 */
import { describe, expect, it } from "vitest";
import {
  classifyExternalArtifact,
  describeExternalArtifact,
} from "../../src/domain/external-artifacts";

const SID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const SESSION = `${SID}.jsonl`;

describe("patterns that identify themselves", () => {
  it("names a Syncthing conflict copy with no help from its neighbours", () => {
    const artifact = classifyExternalArtifact(
      `${SID}.sync-conflict-20260807-120000-ABCDEF.jsonl`,
    );
    expect(artifact).toEqual({
      kind: "syncthing-conflict-copy",
      confidence: "high",
      copyOf: SESSION,
    });
  });

  it("names an English Dropbox conflict copy", () => {
    const artifact = classifyExternalArtifact(`${SID} (Air's conflicted copy 2026-08-07).jsonl`);
    expect(artifact.kind).toBe("dropbox-conflict-copy");
    expect(artifact.confidence).toBe("high");
    expect(artifact.copyOf).toBe(SESSION);
  });

  it("recognises a localised Dropbox copy by its date, but only as a guess", () => {
    // The 2026-08-10 acceptance run produced Chinese ones. Reading every
    // locale is not on offer; saying "probably a conflict copy" is.
    const artifact = classifyExternalArtifact(`${SID} (Air 的冲突副本 2026-08-07).jsonl`);
    expect(artifact.kind).toBe("dropbox-conflict-copy");
    expect(artifact.confidence).toBe("medium");
  });
});

describe("patterns that need a neighbour to mean anything (layer 3)", () => {
  it("says nothing about a hostname suffix on its own", () => {
    // OneDrive's `-<hostname>` is the pattern that caused the original design
    // mistake: it matches any id containing a hyphen, which is all of them.
    expect(classifyExternalArtifact(`${SID}-ct-mbp.jsonl`)).toEqual({
      kind: "unknown",
      confidence: "low",
      copyOf: null,
    });
  });

  it("names it once the file it would be a copy of is actually there", () => {
    const artifact = classifyExternalArtifact(`${SID}-ct-mbp.jsonl`, [SESSION]);
    expect(artifact).toEqual({ kind: "hostname-suffix", confidence: "low", copyOf: SESSION });
  });

  it("recognises a numbered duplicate next to its original", () => {
    const artifact = classifyExternalArtifact(`${SID} (1).jsonl`, [SESSION]);
    expect(artifact.kind).toBe("copy-suffix");
    expect(artifact.copyOf).toBe(SESSION);
  });

  it.each([`${SID} - Copy.jsonl`, `${SID} - 副本.jsonl`, `${SID} - Copy (2).jsonl`])(
    "recognises the OS copy suffix: %s",
    (name) => {
      expect(classifyExternalArtifact(name, [SESSION]).kind).toBe("copy-suffix");
    },
  );

  it("prefers the strongest explanation when several siblings could fit", () => {
    const name = `${SID}.sync-conflict-20260807-120000-ABCDEF.jsonl`;
    const artifact = classifyExternalArtifact(name, [SESSION, `${SID}.sync-conflict.jsonl`]);
    expect(artifact.kind).toBe("syncthing-conflict-copy");
  });

  it("ignores a sibling that is shorter in the wrong way", () => {
    // `b.jsonl` is not a prefix-with-insertion of `a.jsonl`, so there is no
    // insertion to classify and nothing to claim.
    expect(classifyExternalArtifact("a.jsonl", ["b.jsonl"]).kind).toBe("unknown");
    expect(classifyExternalArtifact("a.jsonl", ["a.jsonl"]).kind).toBe("unknown");
  });

  it("handles extensionless names without inventing a relationship", () => {
    expect(classifyExternalArtifact("README", ["notes"]).kind).toBe("unknown");
    expect(classifyExternalArtifact("notes-ct-mbp", ["notes"]).kind).toBe("hostname-suffix");
  });
});

describe("what the user is told", () => {
  it.each([
    [`${SID}.sync-conflict-20260807-120000-ABCDEF.jsonl`, [], "Syncthing"],
    [`${SID} (Air's conflicted copy 2026-08-07).jsonl`, [], "Dropbox"],
    [`${SID} (Air 的冲突副本 2026-08-07).jsonl`, [], "looks like a conflict copy"],
    [`${SID} (1).jsonl`, [SESSION], "looks like a duplicate"],
    [`${SID}-ct-mbp.jsonl`, [SESSION], "possibly a OneDrive copy"],
    ["notes.txt", [], "not a session file"],
  ])("explains %s as %s", (name, siblings, fragment) => {
    const sentence = describeExternalArtifact(classifyExternalArtifact(name, siblings));
    expect(sentence).toContain(fragment);
  });

  it("always says the file was left alone", () => {
    // Every branch, because the one thing a user must never have to infer is
    // whether the plugin touched a file it did not understand.
    for (const name of [
      `${SID}.sync-conflict-20260807-120000-ABCDEF.jsonl`,
      `${SID} (Air's conflicted copy 2026-08-07).jsonl`,
      `${SID} (1).jsonl`,
      `${SID}-ct-mbp.jsonl`,
      "notes.txt",
    ]) {
      expect(describeExternalArtifact(classifyExternalArtifact(name, [SESSION]))).toContain(
        "never synced",
      );
    }
  });
});
