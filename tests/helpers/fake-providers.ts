/**
 * A second provider, shaped like the one M2 actually has to carry.
 *
 * Every M1 test runs with one adapter whose layout is flat and whose file name
 * is its logical id, so an assumption that only holds for Claude Code is
 * invisible: the engine can attribute a file to the wrong provider, or fail to
 * see a nested one at all, and every test still passes. This adapter is
 * deliberately the opposite on both counts — nested under `YYYY/MM/DD/` and a
 * file name that merely *contains* the id — which is Codex's measured shape
 * (architecture §6.4).
 *
 * It is a fake in the sense that it does not talk to a CLI. The parts that
 * matter — classification, path mapping, the whitelist — are the real ones a
 * provider must get right, so a test using it is testing the engine's contract
 * rather than a mock's convenience.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import type { ProviderAdapter, SessionGroup } from "../../src/providers/provider-adapter";
import type { LogicalId } from "../../src/domain/types";

/** `rollout-<timestamp>-<uuid>.jsonl` — the id is the tail, not the whole name. */
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ROLLOUT_NAME = new RegExp(`^rollout-[0-9TZ:.\\-]+-(${UUID})\\.jsonl$`);
const DATE_SEGMENT = /^\d{2,4}$/;

export interface NestedAdapterDeps {
  readonly id: string;
  /** Where this provider keeps its own tree, e.g. `<home>/.codex/sessions`. */
  readonly root: string;
}

export function createNestedFakeAdapter(deps: NestedAdapterDeps): ProviderAdapter {
  return {
    id: deps.id,
    // C, not A: this is a stand-in with no lifecycle evidence behind it, and
    // the tier field is where that distinction is supposed to live (§6.1).
    tier: "C",
    logicalIdPattern: new RegExp(`^rollout-[0-9TZ:.\\-]+-${UUID}`),
    primaryExtensions: [".jsonl"],
    auxSuffixPattern: null,

    async healthCheck() {
      return { ok: true };
    },

    async listSessions() {
      const groups: SessionGroup[] = [];
      await walk(deps.root, [], groups);
      return groups;
    },

    classifyNeutral(neutralRel) {
      const parts = neutralRel.split("/");
      // `<provider>/YYYY/MM/DD/<file>` and nothing else.
      if (parts.length !== 5 || parts[0] !== deps.id) return null;
      if (!parts.slice(1, 4).every((segment) => DATE_SEGMENT.test(segment))) return null;
      const match = ROLLOUT_NAME.exec(parts[4] as string);
      if (!match) return null;
      return { logicalId: match[1] as LogicalId, role: "primary", mode: "append-jsonl" };
    },

    async targetPathFor(neutralRel) {
      // The date directories are part of the layout, so they travel — unlike
      // Claude Code's, whose directory name is machine-specific and is rebuilt.
      const parts = neutralRel.split("/").slice(1);
      return path.join(deps.root, ...parts);
    },

    async reconcileLocalIndex() {
      // Codex was measured to discover by directory scan (OQ-2): no index.
    },
  };

  async function walk(dir: string, rel: string[], out: SessionGroup[]): Promise<void> {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const here = [...rel, entry.name];
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), here, out);
        continue;
      }
      const match = ROLLOUT_NAME.exec(entry.name);
      if (!match) continue;
      const stat = await fsp.stat(path.join(dir, entry.name)).catch(() => null);
      if (stat === null) continue;
      out.push({
        logicalId: match[1] as LogicalId,
        files: [
          {
            role: "primary",
            absPath: path.join(dir, entry.name),
            neutralRel: [deps.id, ...here].join("/"),
            mode: "append-jsonl",
          },
        ],
        lastModifiedMs: stat.mtimeMs,
      });
    }
  }
}
