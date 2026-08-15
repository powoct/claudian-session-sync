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

describe("a provider whose primary the engine cannot merge or copy", () => {
  it("skips a derived primary with a reason, instead of copying it", async () => {
    // `derived` means "rebuilt locally, never copied" (§7.2b #5), and
    // REBUILD_LOCAL has no implementation — no shipped provider produces one.
    // Copying it instead would move machine-local paths between machines,
    // which is the §7.3 failure mode wearing a different extension. (Opaque
    // primaries stopped being refused when ADR-48 gave them their own table.)
    const { machine, root, adapter } = setup();
    await machine.initialiseSyncDir();
    const derived = {
      ...adapter,
      classifyNeutral: (rel: string) => {
        const classified = adapter.classifyNeutral(rel);
        return classified === null ? null : { ...classified, mode: "derived" as const };
      },
    };
    await plantRemote(machine, NESTED_REL);

    await machine.pass({ extraAdapters: [derived] });
    const report = await machine.pass({ extraAdapters: [derived] });

    const skipped = report.actions.find((a) => a.neutralRel === NESTED_REL);
    expect(skipped?.result).toBe("SKIPPED_POLICY");
    expect(skipped?.reason).toContain("unsupported-mode");
    expect(report.notices.join(" ")).toContain("does not sync");
    expect(await fsp.readdir(root).catch(() => [])).toEqual([]);
  });
});

describe("admission versus membership", () => {
  it("keeps syncing a session the adapter no longer lists, via its replica presence", async () => {
    // The distinction the record-scoped model rests on. *Admission* — what may
    // enter the sync folder — is the adapter's listing, scoped to this vault's
    // records. *Membership* — what keeps converging once admitted — must not
    // be: the machine that pulled a session has no record for it (its vault
    // may never carry one), and if membership depended on the listing, that
    // machine's extensions would silently never push back.
    const { machine, root, adapter } = setup();
    await machine.initialiseSyncDir();

    // In the replica: the session as the other machine pushed it.
    const target = await plantRemote(machine, NESTED_REL);
    // Locally: the same bytes plus one appended turn — and an adapter that
    // does not list it, as a record-less machine's would not.
    const local = path.join(root, "2026", "08", "06", ROLLOUT);
    await fsp.mkdir(path.dirname(local), { recursive: true });
    await fsp.writeFile(local, '{"type":"session_meta"}\n{"type":"user"}\n{"type":"turn"}\n');
    const silent = { ...adapter, listSessions: async () => [] };

    await machine.pass({ extraAdapters: [silent] });
    const report = await machine.pass({ extraAdapters: [silent] });

    const action = report.actions.find((a) => a.neutralRel === NESTED_REL);
    expect(action?.action).toBe("PUSH_OVERWRITE");
    expect(action?.result).toBe("APPLIED");
    expect(await fsp.readFile(target, "utf8")).toBe(
      '{"type":"session_meta"}\n{"type":"user"}\n{"type":"turn"}\n',
    );
  });
});

describe("a provider this build does not ship", () => {
  it("has its replica subtree left entirely alone", async () => {
    // OpenCode is structurally excluded (§6.1.1) and Grok/Pi wait for M3, but
    // a replica written by some future build may hold their subtrees today.
    // The listing walks registered adapters' subtrees only, so these files
    // must produce no actions and no writes — this test is green now and
    // turns red the day someone registers a third adapter whose
    // classifyNeutral is loose enough to claim a foreign subtree.
    const { machine, root, adapter } = setup();
    await machine.initialiseSyncDir();
    await plantRemote(machine, "opencode/ses_0199.json");
    await plantRemote(machine, `grok/2026/08/06/${ROLLOUT}`);
    await plantRemote(machine, `pi/2026-08-06T12-43-59_${SID}.jsonl`);

    await machine.pass({ extraAdapters: [adapter] });
    const report = await machine.pass({ extraAdapters: [adapter] });

    expect(report.actions).toEqual([]);
    expect(report.unknownFiles).toEqual([]);
    expect(await machine.cli.list()).toEqual([]);
    expect(await fsp.readdir(root).catch(() => [])).toEqual([]);
  });
});
