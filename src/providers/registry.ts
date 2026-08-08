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

export interface AdapterEnvironment {
  readonly providerRoot: string;
  /** Realpath of the vault — the escape rule's measured input (§6.3). */
  readonly vaultRealPath: string;
  readonly joinPath: (...parts: string[]) => string;
  readonly listDir: (path: string) => Promise<Array<{ name: string; isFile: boolean }>>;
  readonly statFile: (path: string) => Promise<{ mtimeMs: number } | null>;
}

export interface ProviderDescriptor {
  readonly id: string;
  readonly label: string;
  readonly tier: ProviderTier;
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
  defaultRoot: (homedir, joinPath) => joinPath(homedir, ".claude", "projects"),
  create: (env) => createClaudeCodeAdapter(env),
};

/**
 * M1 ships one provider (CLAUDE.md milestones).
 *
 * Codex is a measured Tier A candidate (OQ-2) and OpenCode is understood but
 * unverified; both wait for M2 rather than shipping as "probably fine". Tier
 * requires evidence, and an unverified provider that writes is the one kind of
 * bug this project cannot take back.
 */
export const PROVIDERS: readonly ProviderDescriptor[] = [CLAUDE_CODE];

export function providerById(id: string): ProviderDescriptor | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
}
