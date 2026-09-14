/**
 * ADR-75 — the same records in a different member order.
 *
 * Two halves, and they fail differently. The pure half decides what counts as
 * "the same records", and its failure mode is *forgiving too much*: every case
 * below that expects `divergent` is a pair of genuinely different records that
 * a sloppier comparison would have declared interchangeable, authorising an
 * overwrite between them. The wired half is about the loop the relation exists
 * to end, and its failure mode is the opposite: converging once is the whole
 * point, converging forever is the bug it replaces.
 *
 * The measured case (2026-09-14): ten Codex sessions in which each machine had
 * migrated the same legacy rollout, `FileChangeItem.changes` serialised from a
 * Rust `HashMap` in a per-process random order, and every turn that touched
 * more than one file came out byte-different and record-identical. Both users
 * pressed "keep mine" and the pair ping-ponged for five days.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PassReport } from "../../src/orchestration/pass-report";
import { canonicalLine, compareRecordwise } from "../../src/domain/equivalence";
import { World, WORKSPACE_ID, sha256 } from "../helpers/world";
import { assertRecoverable } from "../helpers/invariants";

const utf8 = (text: string) => new TextEncoder().encode(text);
const verdict = (left: string, right: string) => compareRecordwise(utf8(left), utf8(right));

describe("what counts as the same records", () => {
  it("forgives member order, which is the only thing it forgives", () => {
    expect(
      verdict(
        '{"uuid":"r0","type":"user","changes":{"a.ts":"add","b.ts":"del"}}\n',
        '{"type":"user","changes":{"b.ts":"del","a.ts":"add"},"uuid":"r0"}\n',
      ),
    ).toBe("equivalent");
  });

  it("forgives it at every depth, and in only the lines that differ", () => {
    const shared = '{"uuid":"r0","type":"user","text":"unchanged"}\n';
    expect(
      verdict(
        `${shared}{"a":{"deep":{"x":1,"y":2}},"b":[{"p":1,"q":2}]}\n${shared}`,
        `${shared}{"a":{"deep":{"y":2,"x":1}},"b":[{"q":2,"p":1}]}\n${shared}`,
      ),
    ).toBe("equivalent");
  });

  it("refuses two records that swapped their values rather than their keys", () => {
    // The same bytes rearranged, the same length, and a different conversation.
    expect(verdict('{"a":1,"b":2}\n', '{"a":2,"b":1}\n')).toBe("divergent");
  });

  it("refuses numbers that only a double would confuse", () => {
    // The reason this is hand-rolled. `JSON.parse` folds both of these onto
    // 12345678901234567000, and a canonical form built by re-rendering the
    // parsed value would call them the same record and overwrite one with the
    // other. Scalars are copied out of the source text instead.
    expect(verdict('{"n":12345678901234567890}\n', '{"n":12345678901234567891}\n')).toBe(
      "divergent",
    );
    expect(verdict('{"n":1.0}\n', '{"n":1.1}\n')).toBe("divergent");
  });

  it("refuses a line with duplicate keys rather than picking a winner", () => {
    // Asserted against `canonicalLine` directly, because it is a statement
    // about the canonical form rather than about these two files: a stable
    // sort happens to keep `{"a":1,"a":2}` and `{"a":2,"a":1}` apart anyway.
    // The refusal is what stops the *next* canonicaliser — one built on an
    // object, a Map, or an unstable sort — from folding them together and
    // making the answer depend on which one arrived first.
    expect(() => canonicalLine('{"a":1,"a":2}')).toThrow();
    expect(verdict('{"a":1,"a":2}\n', '{"a":2,"a":1}\n')).toBe("divergent");
  });

  it("refuses reordered arrays, because order is meaning there", () => {
    expect(verdict('{"xs":[1,2]}\n', '{"xs":[2,1]}\n')).toBe("divergent");
  });

  it("refuses two strings that only agree after unescaping", () => {
    // `"\u0041"` and `"A"` are the same string and different bytes. Forgiving
    // that would mean rewriting a record's text, which this never does — and
    // the two are not the same length anyway, so it could not arise; the
    // assertion is that the escape is not quietly resolved.
    expect(verdict('{"s":"\\u0041b"}\n', '{"s":"A\\u0062"}\n')).toBe("divergent");
  });

  it("refuses a newline that moved, before parsing anything", () => {
    // Equal length, and every record after the move starts at a different byte
    // offset. Codex indexes its paginated history by those offsets, so this is
    // a promise made to a file the plugin does not own.
    expect(verdict('{"a":1}\n{"bb":2}\n', '{"a":1}{"bb":2}\n\n')).toBe("divergent");
  });

  it("refuses anything it cannot read as a record", () => {
    expect(verdict('{"a":1}\n', "not json\n")).toBe("divergent");
    expect(verdict('{"a":1}\n', '{"a":1,}\n')).toBe("divergent");
    expect(verdict('["a",1]\n', '[1,"a"]\n')).toBe("divergent");
    expect(verdict('{"a":1}\n', '{"a":1} x\n')).toBe("divergent");
    // Invalid UTF-8 on one side: unreadable is never equivalent.
    expect(compareRecordwise(utf8('{"a":"x"}\n'), new Uint8Array([0x7b, 0xff, 0x0a]))).toBe(
      "divergent",
    );
  });

  it("refuses a file that is a prefix of the other", () => {
    // Equal length is a precondition, not an optimisation: a member-order
    // permutation preserves length exactly. And this is the pair that shows
    // why it has to be checked first — every byte the scan would look at is
    // equal, so without it the extra records are invisible and the shorter
    // file is declared equivalent to the longer one.
    expect(verdict('{"a":1}\n', '{"a":1}\n{"b":2}\n')).toBe("divergent");
    expect(verdict('{"a":1}\n{"b":2}\n', '{"a":1}\n')).toBe("divergent");
  });

  it("says equivalent for bytes that are simply equal", () => {
    expect(verdict('{"a":1}\n', '{"a":1}\n')).toBe("equivalent");
    expect(compareRecordwise(new Uint8Array(0), new Uint8Array(0))).toBe("equivalent");
  });
});

const SID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

let world: World | null = null;
afterEach(async () => {
  await world?.dispose();
  world = null;
});

function newWorld(): World {
  world = World.create();
  return world;
}

const replicaFile = (machine: { replicaRoot: string }) =>
  path.join(machine.replicaRoot, WORKSPACE_ID, "claude-code", `${SID}.jsonl`);

const read = async (target: string) =>
  new Uint8Array(await fsp.readFile(target).catch(() => Buffer.alloc(0)));

async function settle(machine: { pass: () => Promise<PassReport> }) {
  await machine.pass();
  return machine.pass();
}

/**
 * One session, serialised with its members in the given order.
 *
 * Three orders, because the churn case needs a permutation that is neither
 * machine's original — the local CLI re-serialising the file a second time.
 */
function variant(order: 0 | 1 | 2, records = 6): string {
  let text = "";
  for (let i = 0; i < records; i++) {
    const members = [`"uuid":"r${i}"`, `"type":"user"`, `"text":"line ${i}"`];
    const rotated = [...members.slice(order), ...members.slice(0, order)];
    text += `{${rotated.join(",")}}\n`;
  }
  return text;
}

/** Every write a pass actually performed. */
const writesIn = (report: PassReport) =>
  report.actions.filter((entry) => entry.action.includes("PUSH") || entry.action.includes("PULL"))
    .filter((entry) => entry.result === "APPLIED");

describe("ADR-75 wired: two machines that migrated the same session", () => {
  it("converges in one write each, and then stops", async () => {
    const w = newWorld();
    const a = w.machine("A");
    const b = w.machine("B");

    // Neither file came from the other: each machine migrated the same legacy
    // session itself, so the member order is each process's own.
    await a.cli.session(SID).appendRaw(variant(0));
    await b.cli.session(SID).appendRaw(variant(1));
    const mine = await b.cli.session(SID).hash();
    expect(await a.cli.session(SID).hash()).not.toBe(mine);

    const before = await w.snapshot();
    const reports: PassReport[] = [];

    reports.push(await settle(a));
    await w.flush("A", "B");
    const adopting = await settle(b);
    reports.push(adopting);

    expect(adopting.actions.map((x) => x.action)).toContain("PULL_OVERWRITE");
    expect(adopting.actions.map((x) => x.reason)).toContain("equivalent-serialisation");

    // Six more passes, alternating, with the transport running both ways —
    // the shape the ping-pong took. The shared copy is an absorbing state, so
    // nothing further is written.
    for (let round = 0; round < 3; round++) {
      await w.flush("B", "A");
      reports.push(await settle(a));
      await w.flush("A", "B");
      reports.push(await settle(b));
    }

    const written = reports.flatMap(writesIn).map((entry) => `${entry.action}`);
    expect(written, "one push and one adoption, then silence").toEqual([
      "PUSH_NEW",
      "PULL_OVERWRITE",
    ]);

    // All four copies agree, and on the version that was in the sync folder.
    const theirs = await a.cli.session(SID).hash();
    for (const where of [
      await a.cli.session(SID).hash(),
      await b.cli.session(SID).hash(),
      sha256(await read(replicaFile(a))),
      sha256(await read(replicaFile(b))),
    ]) {
      expect(where).toBe(theirs);
    }

    // And the loudest channel the plugin has stays quiet. The "your history
    // was replaced with the other machine's version, quit and resume before
    // typing" notice is true and necessary for a real pull; here the records
    // are the same ones and nothing the user can perceive changed, so raising
    // it would train them to ignore it.
    expect(adopting.notices.join(" ")).not.toContain("history was replaced");

    // I1: the variant B gave up is not a prefix of anything live, so the only
    // way this passes is that its bytes are in B's backups.
    assertRecoverable(before, await w.snapshot());
    const archived = [...(await w.snapshot()).archive.values()].map((version) => version.hash);
    expect(archived, "the discarded serialisation is recoverable").toContain(mine);
  }, 30_000);

  it("adopts once, and leaves a re-serialised file alone after that", async () => {
    // The churn stop. A CLI that rewrites the session on every launch would
    // otherwise hand the plugin a fresh permutation each pass, and every one
    // of them would be adopted: a write into a live session file and a backup
    // slot spent, forever, to change nothing.
    const w = newWorld();
    const a = w.machine("A");
    const b = w.machine("B");

    await a.cli.session(SID).appendRaw(variant(0));
    await b.cli.session(SID).appendRaw(variant(1));
    await settle(a);
    await w.flush("A", "B");
    await settle(b);

    // B's CLI re-serialises the file it just adopted, in a third order.
    await fsp.writeFile(b.cli.session(SID).filePath, variant(2));
    const rewritten = await b.cli.session(SID).hash();
    const backupsBefore = [...(await w.snapshot()).archive.keys()].length;

    const report = await settle(b);

    expect(report.actions.map((x) => x.action)).toContain("NOOP");
    expect(report.actions.map((x) => x.reason)).toContain("equivalent-left-as-is");
    expect(await b.cli.session(SID).hash(), "the CLI's rewrite was left in place").toBe(rewritten);
    expect([...(await w.snapshot()).archive.keys()].length).toBe(backupsBefore);
  }, 30_000);

  it("still forks when the records themselves differ", async () => {
    // The stop is a veto on one rule, not a way out of conflicts: two machines
    // that genuinely wrote different turns still quarantine.
    const w = newWorld();
    const a = w.machine("A");
    const b = w.machine("B");

    await a.cli.session(SID).appendRaw(variant(0));
    await b.cli.session(SID).appendRaw(variant(0).replace('"line 3"', '"line X"'));
    await settle(a);
    await w.flush("A", "B");

    const report = await settle(b);
    expect(report.actions.map((x) => x.action)).toContain("CONFLICT");
  }, 30_000);
});
