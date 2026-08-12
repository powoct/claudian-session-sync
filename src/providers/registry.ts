/**
 * Which providers exist, and where their storage is by default (architecture §6).
 *
 * Two things are deliberate here.
 *
 * **Every provider is off until the user turns it on.** Not because detection
 * is hard, but because "we found a CLI's directory" is not consent to start
 * copying its conversations to another machine.
 *
 * **The default root is a guess and is labelled as one.** CLI layouts change
 * between versions, and the escape rule that turns a vault path into a
 * directory name is measured against one of them (§6.3). So the setting is
 * always overridable, and an override is not an escape hatch for a bug — it is
 * the supported answer to "this version puts it somewhere else".
 */
import type { ProviderAdapter, ProviderTier } from "./provider-adapter";
import { createClaudeCodeAdapter } from "./claude-code/adapter";
import { createCodexAdapter } from "./codex/adapter";

export interface AdapterEnvironment {
  readonly providerRoot: string;
  /** Realpath of the vault — the escape rule's measured input (§6.3). */
  readonly vaultRealPath: string;
  readonly joinPath: (...parts: string[]) => string;
  readonly listDir: (path: string) => Promise<Array<{ name: string; isFile: boolean }>>;
  readonly statFile: (path: string) => Promise<{ mtimeMs: number } | null>;
  /**
   * Reads a small text file, or null if it cannot be read.
   *
   * Only for an adapter's own bookkeeping — Codex needs the vault's
   * conversation records to know which sessions belong here (§6.4, OQ-11).
   * Session bytes never come through this: those are the engine's, and they
   * go through the gateway that counts reads and enforces the size budget.
   */
  readonly readTextFile: (path: string) => Promise<string | null>;
}

export interface ProviderDescriptor {
  readonly id: string;
  readonly label: string;
  readonly tier: ProviderTier;
  /**
   * Shipped before its lifecycle was measured on both platforms (§6.1's
   * "Tier A candidate"). The gate is at release, not at development, so this
   * is what the settings panel says out loud rather than a silent difference.
   */
  readonly experimental?: boolean;
  /** One line under the toggle, for what the user is opting into. */
  readonly scopeNote?: string;
  /** Shown next to the path field, so an override is an informed choice. */
  readonly rootDescription: string;
  defaultRoot(homedir: string, joinPath: (...parts: string[]) => string): string;
  create(env: AdapterEnvironment): ProviderAdapter;
}

export const CLAUDE_CODE: ProviderDescriptor = {
  id: "claude-code",
  label: "Claude Code",
  tier: "A",
  rootDescription:
    "Where the CLI keeps its per-project session directories. Override this if your " +
    "installation puts them elsewhere.",
  scopeNote:
    "Only conversations this vault has a Claudian record for are synced — a session started " +
    "with a bare `claude` in a terminal is not, even inside this vault.",
  defaultRoot: (homedir, joinPath) => joinPath(homedir, ".claude", "projects"),
  create: (env) => createClaudeCodeAdapter(env),
};

export const CODEX: ProviderDescriptor = {
  id: "codex",
  label: "Codex",
  tier: "A",
  experimental: true,
  rootDescription:
    "Where the CLI keeps rollout files, normally <CODEX_HOME>/sessions. Override this if " +
    "CODEX_HOME points elsewhere on this machine.",
  scopeNote:
    "Only conversations this vault has a Claudian record for are synced — Codex keeps every " +
    "project's sessions in one place, and the rest are none of this vault's business.",
  // No AppData branch on any platform: Claudian resolves CODEX_HOME as the env
  // var, else HOME/USERPROFILE + `.codex`, on Windows too. Matching that
  // exactly matters — a machine where they disagree is a machine where this
  // plugin watches a directory the CLI does not use.
  defaultRoot: (homedir, joinPath) => joinPath(homedir, ".codex", "sessions"),
  create: (env) => createCodexAdapter(env),
};

/**
 * What exists, in the order the settings panel shows it.
 *
 * OpenCode is deliberately absent and will stay absent: its history lives
 * entirely inside one SQLite database with no per-session file and no official
 * export route, so there is nothing this plugin can carry (§6.1.1). That is a
 * structural exclusion, not a missing measurement — no probe would change it.
 * Grok and Pi wait for M3 and a real-machine lifecycle probe.
 */
export const PROVIDERS: readonly ProviderDescriptor[] = [CLAUDE_CODE, CODEX];

export function providerById(id: string): ProviderDescriptor | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
}
