/**
 * architecture §6.2 — the engine with more than one adapter registered.
 *
 * M1 shipped one provider, so every assumption that only holds for Claude Code
 * was invisible: a flat layout, and a file name that *is* the logical id. Both
 * are false for the next provider in line (Codex shards by date and names files
 * `rollout-<ts>-<uuid>.jsonl`), and the two failures they caused were not
 * cosmetic — one wrote a file into a different provider's directory, the other
 * made remote files invisible so a session simply never arrived.
 *
 * These tests are written against the second adapter's *shape*, not against
 * Codex itself. Codex stays Tier C until its lifecycle is measured on both
 * platforms (§6.1); what is being fixed here is the engine's part.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { World, WORKSPACE_ID } from "../helpers/world";
import { createNestedFakeAdapter } from "../helpers/fake-providers";

const SID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const ROLLOUT = `rollout-2026-08-06T12-43-59-${SID}.jsonl`;
const NESTED_REL = `nested/2026/08/06/${ROLLOUT}`;

let world: World | null = null;
afterEach(async () => {
  await world?.dispose();
  world = null;
});

function setup() {
  world = World.create();
  const machine = world.machine("A");
  // Inside the machine's local root so the harness's path mint accepts it —
  // it stands in for `<home>/.codex/sessions`.
  const root = path.join(machine.localRoot, "nested-provider");
  return { machine, root, adapter: createNestedFakeAdapter({ id: "nested", root }) };
}

async function plantRemote(machine: { replicaRoot: string }, rel: string): Promise<string> {
  const target = path.join(machine.replicaRoot, WORKSPACE_ID, rel);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, '{"type":"session_meta"}\n{"type":"user"}\n');
  return target;
}

describe("a second provider with a nested layout", () => {
  it("is discovered in the replica at all", async () => {
    const { machine, adapter } = setup();
    await machine.initialiseSyncDir();
    await plantRemote(machine, NESTED_REL);

    await machine.pass({ extraAdapters: [adapter] });
    const report = await machine.pass({ extraAdapters: [adapter] });

    // The old listing read one directory level, so a date-sharded file was not
    // merely mishandled — it produced no action of any kind.
    expect(report.actions.map((a) => a.neutralRel)).toContain(NESTED_REL);
  });

  it("lands in its own provider's directory, keeping the date layout", async () => {
    const { machine, root, adapter } = setup();
    await machine.initialiseSyncDir();
    await plantRemote(machine, NESTED_REL);

    await machine.pass({ extraAdapters: [adapter] });
    await machine.pass({ extraAdapters: [adapter] });

    expect(await fsp.readdir(path.join(root, "2026", "08", "06"))).toEqual([ROLLOUT]);
    // And emphatically not in the other provider's directory, which is what
    // attributing every remote-only file to `adapters[0]` used to do.
    expect(await machine.cli.list()).toEqual([]);
  });

  it("is reported under the provider that owns the subtree", async () => {
    const { machine, adapter } = setup();
    await machine.initialiseSyncDir();
    await plantRemote(machine, NESTED_REL);

    await machine.pass({ extraAdapters: [adapter] });
    const report = await machine.pass({ extraAdapters: [adapter] });

    const entry = report.actions.find((a) => a.neutralRel === NESTED_REL);
    expect(entry?.providerId).toBe("nested");
    // The id is the tail of the file name, not the whole stem — the report
    // showing `rollout-2` would mean the engine had re-derived it by itself.
    expect(entry?.logicalIdPrefix).toBe(SID.slice(0, 8));
  });

  it("does not let one provider claim another's subtree", async () => {
    const { machine, root, adapter } = setup();
    await machine.initialiseSyncDir();
    // A Claude-Code-shaped name, but sitting in the nested provider's tree.
    await plantRemote(machine, `nested/2026/08/06/${SID}.jsonl`);
    // ...and a nested path under the flat provider's tree.
    await plantRemote(machine, `claude-code/2026/08/06/${ROLLOUT}`);

    await machine.pass({ extraAdapters: [adapter] });
    const report = await machine.pass({ extraAdapters: [adapter] });

    expect(report.actions).toEqual([]);
    expect(await machine.cli.list()).toEqual([]);
    expect(await fsp.readdir(root).catch(() => [])).toEqual([]);
    expect(report.unknownFiles.map((f) => f.providerId).sort()).toEqual(["claude-code", "nested"]);
  });

  it("pushes a local session from the second provider without disturbing the first", async () => {
    const { machine, root, adapter } = setup();
    await machine.initialiseSyncDir();
    const local = path.join(root, "2026", "08", "06", ROLLOUT);
    await fsp.mkdir(path.dirname(local), { recursive: true });
    await fsp.writeFile(local, '{"type":"session_meta"}\n');
    await machine.cli.session(SID).append(2);

    await machine.pass({ extraAdapters: [adapter] });
    const report = await machine.pass({ extraAdapters: [adapter] });

    const rels = report.actions.filter((a) => a.result === "APPLIED").map((a) => a.neutralRel);
    expect(rels).toContain(NESTED_REL);
    expect(rels).toContain(`claude-code/${SID}.jsonl`);
    expect(
      await fsp.readFile(path.join(machine.replicaRoot, WORKSPACE_ID, NESTED_REL), "utf8"),
    ).toBe('{"type":"session_meta"}\n');
  });
});

describe("a provider whose primary is not append-only jsonl", () => {
  it("is skipped with a reason, not run through the jsonl decision table", async () => {
    // §7.2b exists on paper only. Until it is implemented, an opaque primary
    // must be refused out loud: the append-jsonl table would call any binary
    // tail "truncated" and DEFER forever, then tell the user its last *record*
    // is incomplete — about a file that has no records.
    const { machine, root, adapter } = setup();
    await machine.initialiseSyncDir();
    const opaque = {
      ...adapter,
      classifyNeutral: (rel: string) => {
        const classified = adapter.classifyNeutral(rel);
        return classified === null ? null : { ...classified, mode: "opaque-file" as const };
      },
    };
    await plantRemote(machine, NESTED_REL);

    await machine.pass({ extraAdapters: [opaque] });
    const report = await machine.pass({ extraAdapters: [opaque] });

    const skipped = report.actions.find((a) => a.neutralRel === NESTED_REL);
    expect(skipped?.result).toBe("SKIPPED_POLICY");
    expect(skipped?.reason).toContain("unsupported-mode");
    expect(report.notices.join(" ")).toContain("does not sync");
    expect(await fsp.readdir(root).catch(() => [])).toEqual([]);
  });
});
