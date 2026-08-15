/**
 * Claudian's own conversation records (architecture §6.1.1 Tier R, ADR-48).
 *
 * This provider syncs the *other half* of a conversation. Session bytes travel
 * as the CLI providers' files; the entry in Claudian's sidebar — title, which
 * provider, which CLI session id — lives in `<vault>/.claudian/sessions/` and
 * normally travels with the vault's own sync. Obsidian Sync drops hidden
 * folders, and some setups have no vault sync at all, so this provider exists
 * for exactly those users. Anyone whose vault sync already carries
 * `.claudian/` must leave it off: two transports over one directory is how
 * sync tools are handed conflicts to manufacture copies from (the settings
 * text says so out loud).
 *
 * Shape: one directory, three kinds of file per conversation —
 * `<convId>.meta.json`, `<convId>.inputs.json`, `<convId>.deleted.json` — each
 * rewritten wholesale by Claudian, never appended. So every file is its own
 * opaque-file primary (each is independently useful; none can be merged), and
 * the logical id is the basename minus `.json`, which keeps the three files
 * of one conversation distinct without inventing group machinery §6.6 says
 * not to build early.
 *
 * Deletion rides along for free: a `.deleted.json` tombstone is just a file,
 * so it syncs like one — and when it lands, the other machine's Claudian
 * hides the conversation and this plugin's own admission (ADR-47) stops
 * carrying its sessions. That is deletion propagation of the *record* layer;
 * session files still never propagate a deletion (ADR-10).
 *
 * ADR-47's "admission by the vault's records" reads naturally here: this
 * provider's files *are* the records, so the whitelist below is the whole
 * admission story — there is no second store to consult about the store.
 */
import type { LogicalId } from "../../domain/types";
import type { ProviderAdapter, SessionGroup } from "../provider-adapter";

export const CLAUDIAN_PROVIDER_ID = "claudian";

/**
 * `conv-<epochMs>-<random>` + one of the three suffixes, anchored both ends.
 *
 * Measured shape (2026-08-12 samples, 2026-08-13 P3 on both machines): ids are
 * `conv-` + digits + `-` + lowercase alphanumerics; suffixes are exactly these
 * three. Anything else — editor backups, sync-tool conflict copies, files from
 * a future Claudian — is not a record this version understands, and fails
 * closed into "reported, left alone".
 */
export const CLAUDIAN_RECORD_NAME = /^(conv-[0-9]+-[a-z0-9]+\.(?:meta|inputs|deleted))\.json$/;

/** Matched as a leading segment by the generic whitelist machinery. */
export const CLAUDIAN_LOGICAL_ID_PATTERN = /^conv-[0-9]+-[a-z0-9]+\.(?:meta|inputs|deleted)/;

export interface ClaudianAdapterDeps {
  /** `<vault>/.claudian/sessions`, already realpath'd. */
  readonly providerRoot: string;
  readonly joinPath: (...parts: string[]) => string;
  readonly listDir: (path: string) => Promise<Array<{ name: string; isFile: boolean }>>;
  readonly statFile: (path: string) => Promise<{ mtimeMs: number } | null>;
}

export function createClaudianAdapter(deps: ClaudianAdapterDeps): ProviderAdapter {
  return {
    id: CLAUDIAN_PROVIDER_ID,
    tier: "R",
    logicalIdPattern: CLAUDIAN_LOGICAL_ID_PATTERN,
    primaryExtensions: [".json"],
    auxSuffixPattern: null,

    async healthCheck() {
      if ((await deps.statFile(deps.providerRoot)) === null) {
        // What a vault that has never run Claudian looks like — worth a
        // reason, or "syncs nothing" reads as a broken install.
        return { ok: false, reason: "no .claudian/sessions directory in this vault" };
      }
      return { ok: true };
    },

    async listSessions() {
      const groups: SessionGroup[] = [];
      for (const entry of await deps.listDir(deps.providerRoot).catch(() => [])) {
        if (!entry.isFile) continue;
        const match = CLAUDIAN_RECORD_NAME.exec(entry.name);
        if (!match) continue;

        const absPath = deps.joinPath(deps.providerRoot, entry.name);
        const stat = await deps.statFile(absPath);
        if (stat === null) continue;
        groups.push({
          logicalId: match[1] as LogicalId,
          files: [
            {
              role: "primary",
              absPath,
              neutralRel: `${CLAUDIAN_PROVIDER_ID}/${entry.name}`,
              mode: "opaque-file",
            },
          ],
          lastModifiedMs: stat.mtimeMs,
        });
      }
      return groups;
    },

    classifyNeutral(neutralRel) {
      const parts = neutralRel.split("/");
      if (parts.length !== 2 || parts[0] !== CLAUDIAN_PROVIDER_ID) return null;
      const match = CLAUDIAN_RECORD_NAME.exec(parts[1] as string);
      if (!match) return null;
      return { logicalId: match[1] as LogicalId, role: "primary", mode: "opaque-file" };
    },

    async targetPathFor(neutralRel) {
      return deps.joinPath(deps.providerRoot, neutralRel.slice(neutralRel.lastIndexOf("/") + 1));
    },

    async reconcileLocalIndex() {
      // Claudian scans the directory on its own; there is no index to fix.
    },
  };
}
