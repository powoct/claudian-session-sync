/**
 * The three ways out of a conflict (architecture §8.1) — S-04c.
 *
 * Detection without resolution would leave the plugin able to notice a problem
 * and unable to end it, so M1 ships all three. What they share is the rule that
 * makes them safe to offer at all: **neither branch is destroyed.** The
 * abandoned version stays in quarantine, and the side being overwritten is
 * backed up first, exactly as any other overwrite is.
 *
 * Resolution deliberately reads the chosen branch **from quarantine**, not from
 * the live file. Quarantine is the frozen record of what the conflict was
 * about; the live file may have moved since the user opened the dialog, and
 * copying a version they never looked at is not what they asked for. If it has
 * moved, the conflict they are resolving no longer exists and the command says
 * so rather than resolving a different one.
 */
import type { ConflictMeta, ConflictResolution } from "../domain/conflict";
import { resolutionAction } from "../domain/conflict";
import type { LogicalId } from "../domain/types";
import type { FsGateway } from "../infra/fs-gateway";
import { readJson } from "../infra/json-file";
import type { BackupRequest } from "../infra/backup-writer";
import type { MintOutcome } from "./sync-engine";

export const QUARANTINE_DIR = ".quarantine";

export interface ConflictEntry {
  readonly conflictId: string;
  readonly providerId: string;
  readonly logicalIdPrefix: string;
  readonly meta: ConflictMeta;
  /** Absolute path of the quarantine directory, for `reveal`. */
  readonly directory: string;
  readonly localCopy: string;
  readonly remoteCopy: string;
}

export interface ConflictCommandDeps {
  readonly fs: FsGateway;
  readonly joinPath: (...parts: string[]) => string;
  readonly workspaceId: string;
  readonly replicaRoot: string;
  /** Where a neutral-relative path lands on this machine, per provider. */
  readonly localPathFor: (providerId: string, neutralRel: string) => Promise<string | null>;
  /**
   * The same validator the engine writes through.
   *
   * Shared on purpose: a resolution is an overwrite of a session file, so it
   * gets the same containment walk and the same branded type. A second,
   * "simpler" write path here would be a second place for a traversal to land.
   */
  readonly mintWritePath: (target: string) => Promise<MintOutcome>;
  readonly backup: (request: BackupRequest) => Promise<{ readonly path: string | null }>;
  readonly hashBytes: (bytes: Uint8Array) => string;
  /** False unless the remote is READY; keeping local writes to the sync dir. */
  readonly mayWriteRemote: () => boolean;
}

export type ResolveOutcome =
  | { readonly ok: true; readonly action: "PUSH_OVERWRITE" | "PULL_OVERWRITE"; readonly backupPath: string | null }
  | { readonly ok: true; readonly action: "REVEAL"; readonly directory: string }
  | { readonly ok: false; readonly reason: ResolveFailure };

export type ResolveFailure =
  | "unknown-conflict"
  /** The chosen branch is no longer what quarantine froze — a different conflict now. */
  | "branch-moved"
  | "remote-not-ready"
  | "backup-failed"
  | "path-rejected"
  | "write-failed";

/** Everything currently quarantined for this workspace, newest first. */
export async function listConflicts(deps: ConflictCommandDeps): Promise<ConflictEntry[]> {
  const base = deps.joinPath(deps.replicaRoot, QUARANTINE_DIR, deps.workspaceId);
  const providers = await deps.fs.readDir(base).catch(() => []);
  const found: ConflictEntry[] = [];

  for (const provider of providers) {
    if (!provider.isDirectory) continue;
    const providerDir = deps.joinPath(base, provider.name);
    for (const entry of await deps.fs.readDir(providerDir).catch(() => [])) {
      if (!entry.isDirectory) continue;
      const directory = deps.joinPath(providerDir, entry.name);
      const parsed = await readEntry(deps, directory, provider.name, entry.name);
      if (parsed) found.push(parsed);
    }
  }
  return found.sort((a, b) => (a.meta.detectedAt < b.meta.detectedAt ? 1 : -1));
}

/**
 * Applies one resolution.
 *
 * `reveal` writes nothing at all — it exists because "let me look at both and
 * decide myself" is a legitimate answer, and a plugin that only offers two
 * irreversible-looking buttons pushes people into guessing.
 */
export async function resolveConflict(
  deps: ConflictCommandDeps,
  conflictId: string,
  resolution: ConflictResolution,
): Promise<ResolveOutcome> {
  const entry = (await listConflicts(deps)).find((c) => c.conflictId === conflictId);
  if (!entry) return { ok: false, reason: "unknown-conflict" };

  const action = resolutionAction(resolution);
  if (action === null) return { ok: true, action: "REVEAL", directory: entry.directory };

  const keepingLocal = resolution === "keep-local";
  // Keeping local means writing into the sync directory, and that is only
  // allowed when the remote is READY — a half-hydrated directory is the one
  // place a push does real damage (§9.6.3).
  if (keepingLocal && !deps.mayWriteRemote()) return { ok: false, reason: "remote-not-ready" };

  const chosenCopy = deps.joinPath(entry.directory, keepingLocal ? entry.localCopy : entry.remoteCopy);
  const chosen = await deps.fs.readFile(chosenCopy).catch(() => null);
  if (chosen === null) return { ok: false, reason: "unknown-conflict" };

  const neutralRel = `${entry.providerId}/${entry.meta.logicalId}${extensionOf(entry.localCopy)}`;
  const remotePath = deps.joinPath(deps.replicaRoot, deps.workspaceId, neutralRel);
  const localPath = await deps.localPathFor(entry.providerId, neutralRel);
  if (localPath === null) return { ok: false, reason: "path-rejected" };

  // The side the user is keeping must still hold what quarantine froze. If it
  // has changed, the disagreement they were shown is not the one on disk, and
  // the next pass will compute a different conflict id for the real one.
  const keptPath = keepingLocal ? localPath : remotePath;
  const kept = await deps.fs.readFile(keptPath).catch(() => null);
  if (kept === null || deps.hashBytes(kept) !== deps.hashBytes(chosen)) {
    return { ok: false, reason: "branch-moved" };
  }

  const targetPath = keepingLocal ? remotePath : localPath;
  const minted = await deps.mintWritePath(targetPath);
  if (!minted.ok) return { ok: false, reason: "path-rejected" };

  const backup = await deps.backup({
    sourcePath: targetPath,
    workspaceId: deps.workspaceId,
    providerId: entry.providerId,
    logicalId: entry.meta.logicalId as LogicalId,
    remote: keepingLocal,
    action,
  });
  // Same rule as every other overwrite: no backup, no overwrite (§9.3.3).
  // Resolution is a user's deliberate choice, which makes it *more* worth
  // backing up, not less — they are choosing between two branches, and the one
  // they discard has to remain reachable if they change their mind.
  if (backup.path === null) return { ok: false, reason: "backup-failed" };

  try {
    await deps.fs.writeFileAtomic(minted.value, chosen);
  } catch {
    return { ok: false, reason: "write-failed" };
  }

  return { ok: true, action, backupPath: backup.path };
}

async function readEntry(
  deps: ConflictCommandDeps,
  directory: string,
  providerId: string,
  conflictId: string,
): Promise<ConflictEntry | null> {
  const load = await readJson(deps.fs, deps.joinPath(directory, "meta.json"));
  if (load.status !== "loaded") return null;
  const meta = load.raw as Partial<ConflictMeta>;
  if (typeof meta.logicalId !== "string" || typeof meta.conflictId !== "string") return null;

  const names = (await deps.fs.readDir(directory).catch(() => [])).map((entry) => entry.name);
  const localCopy = names.find((name) => name.startsWith("local-"));
  const remoteCopy = names.find((name) => name.startsWith("remote-"));
  if (!localCopy || !remoteCopy) return null;

  return {
    conflictId,
    providerId,
    logicalIdPrefix: meta.logicalId.slice(0, 8),
    meta: meta as ConflictMeta,
    directory,
    localCopy,
    remoteCopy,
  };
}

function extensionOf(copyName: string): string {
  const dot = copyName.indexOf(".");
  return dot === -1 ? "" : copyName.slice(dot);
}
