/**
 * ADR-47's pull side, at the strongest level available: the real composition
 * root, the real Codex adapter, the real defaults.
 *
 * The M4 acceptance run (2026-08-15) produced a field observation that
 * contradicts the design: on machine B, a Codex rollout sitting byte-frozen in
 * the sync folder appeared to DEFER until the vault's Claudian record arrived
 * over git, and the operator concluded that admission gates pulls too. It must
 * not — admission is deliberately push-side only, because the pulling machine
 * may never hold a record (Obsidian Sync drops dotfolders) — and the code says
 * it does not. But R2-1 is the standing reminder that "the code says so" is
 * not a verdict about the world, so this pins the property where the field
 * claim was made: a full PluginRuntime pass, not an engine harness.
 *
 * If this test is green and the field behaviour recurs, the DEFER's cause is
 * something else — and the report's "Why" column, not the record store, is
 * where to look for it.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeHarness } from "../helpers/runtime-harness";

const SID = "01a003f8-172e-7421-b159-ee512a76e87d";
const OTHER = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const ROLLOUT = `rollout-2026-08-15T14-49-45-${SID}.jsonl`;

const machines: RuntimeHarness[] = [];
afterEach(async () => {
  while (machines.length) await machines.pop()?.dispose();
});

describe("a codex rollout in the sync folder, with no local record for it", () => {
  it("lands through the full runtime — admission never gates a pull", async () => {
    const b = await RuntimeHarness.create();
    machines.push(b);
    await b.configure();
    await b.runtime.setProvider("codex", { enabled: true });
    await b.runtime.refresh();

    // The vault store exists and holds a record — for a *different*
    // conversation. Exactly machine B's state in the acceptance run: a
    // populated store that simply has not heard of the incoming session yet.
    const store = path.join(b.vaultRoot, ".claudian", "sessions");
    await fsp.mkdir(store, { recursive: true });
    await fsp.writeFile(
      path.join(store, "conv-other.meta.json"),
      JSON.stringify({ id: "conv-other", providerId: "codex", sessionId: OTHER }),
    );

    const status = await b.runtime.refresh();
    const workspaceId = status.workspaceId as string;
    const remote = path.join(b.syncDir, workspaceId, "codex", "2026", "08", "15", ROLLOUT);
    await fsp.mkdir(path.dirname(remote), { recursive: true });
    await fsp.writeFile(remote, '{"type":"session_meta"}\n{"type":"user"}\n');

    await b.settle();

    const landed = path.join(b.homedir, ".codex", "sessions", "2026", "08", "15", ROLLOUT);
    expect(await fsp.readFile(landed, "utf8")).toBe('{"type":"session_meta"}\n{"type":"user"}\n');
  }, 30_000);

  it("lands even when the vault store is entirely absent", async () => {
    // Stronger than B's state: no store at all (healthCheck reports it, the
    // adapter lists nothing) — the replica walk must still carry the pull.
    const b = await RuntimeHarness.create();
    machines.push(b);
    await b.configure();
    await b.runtime.setProvider("codex", { enabled: true });

    const status = await b.runtime.refresh();
    const workspaceId = status.workspaceId as string;
    const remote = path.join(b.syncDir, workspaceId, "codex", "2026", "08", "15", ROLLOUT);
    await fsp.mkdir(path.dirname(remote), { recursive: true });
    await fsp.writeFile(remote, '{"type":"session_meta"}\n');

    await b.settle();

    const landed = path.join(b.homedir, ".codex", "sessions", "2026", "08", "15", ROLLOUT);
    expect(await fsp.readFile(landed, "utf8")).toBe('{"type":"session_meta"}\n');
  }, 30_000);
});
