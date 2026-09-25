/**
 * Which Claudian this vault has installed, from its own manifest.
 *
 * Read, never inferred from what is on disk in `.claudian/`. The only reason
 * to ask is that 2.3.3 stopped writing markers, and "no marker seen" is the
 * one thing a markerless Claudian and an idle older one have in common.
 *
 * Obsidian keeps every community plugin in `<configDir>/plugins/<folder>/`,
 * and the folder is normally the plugin's id. Normally is not always — a
 * manual install can use any folder name — so the id is checked inside the
 * manifest rather than trusted from the path, and when the expected folder is
 * not it, the other folders are searched once. There are rarely more than a
 * few dozen.
 *
 * Every failure is null, and callers treat null as silence: this feeds
 * warnings, and a warning that fires on a guess is a warning the user learns
 * to skip.
 */
import type { FsGateway } from "./fs-gateway";

/** Claudian's plugin id — unchanged from 2.2.x through 2.3.3. */
export const CLAUDIAN_PLUGIN_ID = "realclaudian";

export interface ClaudianVersionDeps {
  readonly fs: Pick<FsGateway, "readDir" | "readFile">;
  readonly joinPath: (...parts: string[]) => string;
  /** `<vault>/<configDir>/plugins`, resolved by the caller that knows configDir. */
  readonly pluginsDir: string;
}

export async function readClaudianVersion(deps: ClaudianVersionDeps): Promise<string | null> {
  const direct = await versionAt(deps, CLAUDIAN_PLUGIN_ID);
  if (direct !== null) return direct;

  const entries = await deps.fs.readDir(deps.pluginsDir).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory || entry.name === CLAUDIAN_PLUGIN_ID) continue;
    const found = await versionAt(deps, entry.name);
    if (found !== null) return found;
  }
  return null;
}

async function versionAt(deps: ClaudianVersionDeps, folder: string): Promise<string | null> {
  try {
    const bytes = await deps.fs.readFile(deps.joinPath(deps.pluginsDir, folder, "manifest.json"));
    const manifest = JSON.parse(new TextDecoder().decode(bytes)) as { id?: unknown; version?: unknown };
    if (manifest.id !== CLAUDIAN_PLUGIN_ID) return null;
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}
