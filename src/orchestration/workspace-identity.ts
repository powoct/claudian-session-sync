/**
 * Workspace identity, in the vault (architecture §5.2.3, §5.6 store (a)).
 *
 * `<vault>/.claudian-session-sync/workspace.json` answers one question — *which*
 * workspace is this vault — and it travels with the vault, which is what makes
 * the answer the same on every machine.
 *
 * The load-bearing decision is that it is **created explicitly, by the user,
 * once** (§5.2.3, ADR-20). Generating one automatically on first run reads as
 * obviously convenient and is the accident path: two new machines starting
 * before the vault has finished syncing each mint a UUID, each build a subtree
 * in the sync directory the other cannot see, and neither ever reports an
 * error. Everything below therefore refuses rather than guesses — a missing
 * identity on a machine that had one is a vault sync in progress, not
 * permission to invent a replacement.
 */
import { checkWorkspaceIdentity, findIdentityConflictCopies } from "../infra/state-store";
import type {
  WorkspaceIdentityFile,
  WorkspaceIdentityStatus,
} from "../infra/state-store";
import { STATE_SCHEMA_VERSION } from "../infra/state-store";
import type { WorkspaceId } from "../domain/types";
import type { FsGateway } from "../infra/fs-gateway";
import { type PathGuardDeps, mintStatePath } from "../infra/path-guard";
import { createJsonExclusive, readJson } from "../infra/json-file";

export const IDENTITY_DIR = ".claudian-session-sync";
export const IDENTITY_FILE = "workspace.json";

export interface WorkspaceIdentityDeps {
  readonly fs: FsGateway;
  readonly guard: PathGuardDeps;
  readonly joinPath: (...parts: string[]) => string;
  /** Realpath of the vault. */
  readonly vaultRoot: string;
}

export interface IdentityOutcome {
  readonly status: WorkspaceIdentityStatus;
  readonly file?: WorkspaceIdentityFile;
  /** Names of conflict copies found beside it, for the message shown to the user. */
  readonly conflictCopies: readonly string[];
}

export async function readWorkspaceIdentity(
  deps: WorkspaceIdentityDeps,
  boundWorkspaceId: WorkspaceId | null,
): Promise<IdentityOutcome> {
  const dir = deps.joinPath(deps.vaultRoot, IDENTITY_DIR);
  const names = (await deps.fs.readDir(dir).catch(() => [])).map((entry) => entry.name);
  const conflictCopies = findIdentityConflictCopies(names);

  const load = await readJson(deps.fs, deps.joinPath(dir, IDENTITY_FILE));
  // `unusable` is passed through as a value the checker can see, not as
  // "absent": a truncated identity file is a half-finished vault sync, and
  // reading it as "no identity yet" would offer the user a Create button that
  // mints a second id for a workspace that already has one.
  const raw = load.status === "loaded" ? load.raw : load.status === "unusable" ? null : undefined;

  const verdict = checkWorkspaceIdentity({ raw, boundWorkspaceId, conflictCopyNames: conflictCopies });
  return {
    status: verdict.status,
    ...(verdict.file ? { file: verdict.file } : {}),
    conflictCopies,
  };
}

/**
 * Creates the identity file, exclusively.
 *
 * Exclusive because "it already exists" is a real outcome with a real cause:
 * the vault sync delivered the other machine's file between the moment the UI
 * decided to offer this button and the moment it was pressed. Winning that
 * race by overwriting would split one workspace into two.
 */
export async function createWorkspaceIdentity(
  deps: WorkspaceIdentityDeps,
  input: { readonly workspaceId: WorkspaceId; readonly label: string; readonly nowIso: string },
): Promise<{ readonly ok: true; readonly file: WorkspaceIdentityFile } | { readonly ok: false; readonly reason: string }> {
  const dirPath = deps.joinPath(deps.vaultRoot, IDENTITY_DIR);
  const dir = mintStatePath(deps.guard, deps.vaultRoot, dirPath);
  const target = mintStatePath(deps.guard, deps.vaultRoot, deps.joinPath(dirPath, IDENTITY_FILE));
  if (!dir.ok || !target.ok) return { ok: false, reason: "path-rejected" };

  const file: WorkspaceIdentityFile = {
    schemaVersion: STATE_SCHEMA_VERSION,
    workspaceId: input.workspaceId,
    label: input.label,
    createdAt: input.nowIso,
  };
  const created = await createJsonExclusive(deps.fs, target.value, file, dir.value);
  return created.ok ? { ok: true, file } : { ok: false, reason: created.reason };
}

/**
 * What to tell the user, per status.
 *
 * Kept as data next to the checker rather than in the settings tab: these
 * strings are the whole user-facing contract of a fail-closed design, and a
 * status whose message says "something went wrong" would make refusing to
 * sync look like a bug instead of a decision.
 */
export const IDENTITY_MESSAGES: Record<WorkspaceIdentityStatus, string> = {
  ok: "This vault has a workspace identity.",
  WORKSPACE_IDENTITY_MISSING:
    "This machine is bound to a workspace, but the vault's identity file is missing. " +
    "That usually means the vault sync has not finished. Nothing will be synced until it appears — " +
    "creating a new identity here would split this workspace in two.",
  WORKSPACE_IDENTITY_CHANGED:
    "The vault's workspace identity differs from the one this machine is bound to. " +
    "Syncing is stopped. Re-bind deliberately once you know which one is right.",
  WORKSPACE_IDENTITY_INVALID:
    "The vault's workspace identity file could not be read. Syncing is stopped rather than " +
    "guessing — a truncated file is usually a sync still in progress.",
  WORKSPACE_IDENTITY_AMBIGUOUS:
    "There is more than one workspace identity file in this vault, which means your sync tool " +
    "made a conflict copy. Syncing is stopped until exactly one remains.",
};
