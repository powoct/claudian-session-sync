/**
 * The three-way state split (architecture §5.5, §5.6, §10.2, §10.3).
 *
 * Where a value lives is decided by whether it survives being copied to another
 * machine:
 *
 *   (a) vault     — workspace identity and portable settings. Copy the whole
 *                   vault to a different OS and it must still be correct, so no
 *                   absolute path and no machine id may appear here.
 *   (b) home      — machineId, absolute paths, the observation ledger, backups.
 *                   Never synced, and never reconstructible from (a) or (c):
 *                   losing it means "reconfigure this machine", not "lost data".
 *   (c) sync-dir  — manifest and audit tables. Written by other machines and
 *                   therefore untrusted; may never authorise a destructive act.
 *
 * This module owns (b), plus reading (a)'s identity file. Everything it reads
 * from disk is treated as possibly absent, possibly truncated, and possibly
 * written by a newer version of this plugin.
 */
import { type MachineId, type WorkspaceId } from "../domain/types";
import { parseMachineId, parseWorkspaceId } from "../domain/path-safety";
import type { E0Signature } from "../domain/stability";

export const STATE_SCHEMA_VERSION = 1;

/** Entries unseen for this long are dropped at commit (§5.5). */
export const LEDGER_GC_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** At most this many retired identities are kept (§10.2). */
export const MAX_SUPERSEDED = 10;

export type Platform = "darwin" | "win32" | "linux";

export interface MachineIdentity {
  readonly hostname: string;
  readonly platform: Platform;
  /** Diagnostic only — never compared, because a moved home is not a new machine. */
  readonly homedir: string;
}

export interface SupersededIdentity {
  readonly machineId: MachineId;
  readonly retiredAt: string;
  readonly reason: "hostname-drift" | "platform-drift" | "remote-collision";
  readonly identity: MachineIdentity;
}

export interface MachineFile {
  readonly schemaVersion: number;
  readonly machineId: MachineId;
  readonly machineLabel: string;
  readonly createdAt: string;
  readonly identity: MachineIdentity;
  readonly superseded: readonly SupersededIdentity[];
}

export interface LedgerEntryRecord {
  readonly sig: E0Signature;
  readonly firstSeenMs: number;
  readonly lastSeenMs: number;
  readonly lastFullVerifyMs: number;
  readonly contentHash: string;
  readonly lastAction: string;
  readonly lastResult: string;
  readonly abortStreak: number;
  readonly skippedForBudgetPasses: number;
  readonly truncatedTailPasses: number;
}

export interface ObservationsFile {
  readonly schemaVersion: number;
  readonly machineId: MachineId;
  /** sha256 of the canonical syncDir path; a mismatch voids the whole file. */
  readonly syncDirFingerprint: string;
  readonly remote: Readonly<Record<string, LedgerEntryRecord>>;
  readonly local: Readonly<Record<string, LedgerEntryRecord>>;
  readonly cursor: { readonly write: string | null; readonly scrub: string | null };
}

/**
 * An empty ledger, which is also what a lost or unreadable one degrades to.
 *
 * Deliberately fail-safe (§5.5): with no observations, nothing is stable, so
 * every action that requires stability defers and the pass becomes read-only
 * for one round. The cost of losing this file is a slow pass, never a wrong
 * decision — which is the opposite of what would happen if absence were read as
 * "nothing has changed".
 */
export function emptyObservations(machineId: MachineId, syncDirFingerprint: string): ObservationsFile {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    machineId,
    syncDirFingerprint,
    remote: {},
    local: {},
    cursor: { write: null, scrub: null },
  };
}

export type LoadOutcome<T> =
  | { readonly status: "loaded"; readonly value: T }
  | { readonly status: "absent" }
  /** Present but unusable. `reason` goes into the report; the file is not rewritten. */
  | { readonly status: "unusable"; readonly reason: string };

/**
 * Parses an observations file, rejecting anything it cannot fully trust.
 *
 * A fingerprint mismatch voids the entire file rather than individual entries:
 * it means the ledger describes a different sync directory, so every
 * `firstSeenMs` in it is a statement about files this pass has never seen.
 *
 * A newer schemaVersion is also unusable — and, importantly, must not be
 * rewritten. An old client rebuilding a new format would destroy whatever the
 * newer one recorded.
 */
export function parseObservations(
  raw: unknown,
  expected: { readonly machineId: MachineId; readonly syncDirFingerprint: string },
): LoadOutcome<ObservationsFile> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { status: "unusable", reason: "not-an-object" };
  }
  const candidate = raw as Partial<ObservationsFile>;

  if (typeof candidate.schemaVersion !== "number") {
    return { status: "unusable", reason: "missing-schema-version" };
  }
  if (candidate.schemaVersion > STATE_SCHEMA_VERSION) {
    return { status: "unusable", reason: "newer-schema" };
  }
  if (candidate.syncDirFingerprint !== expected.syncDirFingerprint) {
    return { status: "unusable", reason: "sync-dir-fingerprint-mismatch" };
  }
  if (candidate.machineId !== expected.machineId) {
    return { status: "unusable", reason: "machine-id-mismatch" };
  }

  return {
    status: "loaded",
    value: {
      schemaVersion: candidate.schemaVersion,
      machineId: expected.machineId,
      syncDirFingerprint: expected.syncDirFingerprint,
      remote: sanitiseEntries(candidate.remote),
      local: sanitiseEntries(candidate.local),
      cursor: {
        write: typeof candidate.cursor?.write === "string" ? candidate.cursor.write : null,
        scrub: typeof candidate.cursor?.scrub === "string" ? candidate.cursor.scrub : null,
      },
    },
  };
}

/**
 * Drops entries that are malformed rather than rejecting the file.
 *
 * The whole-file checks above are about provenance; this one is about a single
 * corrupt record, where losing one entry costs one deferred file and keeping it
 * would put a partly-undefined signature into a stability comparison.
 */
function sanitiseEntries(input: unknown): Record<string, LedgerEntryRecord> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const output: Record<string, LedgerEntryRecord> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const entry = asLedgerEntry(value);
    if (entry) output[key] = entry;
  }
  return output;
}

function asLedgerEntry(value: unknown): LedgerEntryRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const sig = v.sig as Partial<E0Signature> | undefined;
  if (
    typeof sig !== "object" ||
    sig === null ||
    typeof sig.size !== "number" ||
    typeof sig.mtimeMs !== "number" ||
    typeof sig.ctimeMs !== "number" ||
    typeof sig.ino !== "number" ||
    typeof sig.tailHash !== "string"
  ) {
    return null;
  }
  if (typeof v.firstSeenMs !== "number") return null;

  return {
    sig: { size: sig.size, mtimeMs: sig.mtimeMs, ctimeMs: sig.ctimeMs, ino: sig.ino, tailHash: sig.tailHash },
    firstSeenMs: v.firstSeenMs,
    lastSeenMs: typeof v.lastSeenMs === "number" ? v.lastSeenMs : v.firstSeenMs,
    lastFullVerifyMs: typeof v.lastFullVerifyMs === "number" ? v.lastFullVerifyMs : 0,
    contentHash: typeof v.contentHash === "string" ? v.contentHash : "",
    lastAction: typeof v.lastAction === "string" ? v.lastAction : "",
    lastResult: typeof v.lastResult === "string" ? v.lastResult : "",
    abortStreak: typeof v.abortStreak === "number" ? v.abortStreak : 0,
    skippedForBudgetPasses:
      typeof v.skippedForBudgetPasses === "number" ? v.skippedForBudgetPasses : 0,
    truncatedTailPasses: typeof v.truncatedTailPasses === "number" ? v.truncatedTailPasses : 0,
  };
}

/** Drops entries not seen for LEDGER_GC_AGE_MS, at commit time (§5.5). */
export function gcObservations(file: ObservationsFile, nowMs: number): ObservationsFile {
  const keep = (entries: Readonly<Record<string, LedgerEntryRecord>>) =>
    Object.fromEntries(
      Object.entries(entries).filter(([, entry]) => nowMs - entry.lastSeenMs <= LEDGER_GC_AGE_MS),
    );
  return { ...file, remote: keep(file.remote), local: keep(file.local) };
}

// ── machine identity (§10.3) ────────────────────────────────────────────────

export type DriftReason = "hostname-drift" | "platform-drift";

/**
 * Has this machine's fingerprint changed since the id was minted?
 *
 * A cloned home directory, a roaming profile and a renamed computer are
 * indistinguishable from here, so all three are treated as the worst case: this
 * id may now be in use by another machine. Hostname comparison is trimmed and
 * case-insensitive, because a case change is a display detail, not a new host.
 *
 * `homedir` is deliberately not compared — a moved home is still this machine.
 */
export function detectIdentityDrift(
  recorded: MachineIdentity,
  current: MachineIdentity,
): DriftReason | null {
  if (recorded.platform !== current.platform) return "platform-drift";
  if (recorded.hostname.trim().toLowerCase() !== current.hostname.trim().toLowerCase()) {
    return "hostname-drift";
  }
  return null;
}

/**
 * Retires the current id and adopts a new one.
 *
 * Always safe, by design: machineId may never take part in a decision (§10.3),
 * so the entire cost of rotating is one more line in an audit list. That is
 * what allows the drift response to be "give way, silently" rather than a
 * dialog the user cannot act on. Two machines detecting a collision at the same
 * time both give way and converge within one round.
 */
export function rotateMachineId(
  file: MachineFile,
  next: { readonly machineId: MachineId; readonly identity: MachineIdentity; readonly nowIso: string },
  reason: SupersededIdentity["reason"],
): MachineFile {
  const retired: SupersededIdentity = {
    machineId: file.machineId,
    retiredAt: next.nowIso,
    reason,
    identity: file.identity,
  };
  return {
    ...file,
    machineId: next.machineId,
    identity: next.identity,
    // Newest first, oldest dropped: this is an audit aid, not a record anything
    // depends on.
    superseded: [retired, ...file.superseded].slice(0, MAX_SUPERSEDED),
  };
}

export function parseMachineFile(raw: unknown): LoadOutcome<MachineFile> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { status: "unusable", reason: "not-an-object" };
  }
  const c = raw as Partial<MachineFile>;
  if (typeof c.schemaVersion !== "number") return { status: "unusable", reason: "missing-schema-version" };
  if (c.schemaVersion > STATE_SCHEMA_VERSION) return { status: "unusable", reason: "newer-schema" };

  const id = parseMachineId(String(c.machineId ?? ""));
  if (!id.ok) return { status: "unusable", reason: "invalid-machine-id" };

  const identity = c.identity;
  if (
    typeof identity !== "object" ||
    identity === null ||
    typeof identity.hostname !== "string" ||
    typeof identity.platform !== "string"
  ) {
    return { status: "unusable", reason: "invalid-identity" };
  }

  return {
    status: "loaded",
    value: {
      schemaVersion: c.schemaVersion,
      machineId: id.value,
      machineLabel: typeof c.machineLabel === "string" ? c.machineLabel : identity.hostname,
      createdAt: typeof c.createdAt === "string" ? c.createdAt : "",
      identity: {
        hostname: identity.hostname,
        platform: identity.platform as Platform,
        homedir: typeof identity.homedir === "string" ? identity.homedir : "",
      },
      superseded: Array.isArray(c.superseded) ? c.superseded.slice(0, MAX_SUPERSEDED) : [],
    },
  };
}

// ── workspace identity, read from the vault (§5.2.3) ─────────────────────────

export type WorkspaceIdentityStatus =
  | "ok"
  /** File absent although this machine has a binding — the vault sync has not arrived. */
  | "WORKSPACE_IDENTITY_MISSING"
  | "WORKSPACE_IDENTITY_CHANGED"
  | "WORKSPACE_IDENTITY_INVALID"
  | "WORKSPACE_IDENTITY_AMBIGUOUS";

export interface WorkspaceIdentityFile {
  readonly schemaVersion: number;
  readonly workspaceId: WorkspaceId;
  readonly label: string;
  readonly createdAt: string;
}

/**
 * Preflight identity check (§5.2.3). Every failure aborts the pass with zero
 * writes on either side.
 *
 * Nothing here guesses or repairs. A missing identity file most likely means
 * the vault sync has not finished, and inventing a new id would create a second
 * subtree in the sync directory that the other machine can never find — the
 * exact failure the two-step initialisation exists to prevent.
 */
export function checkWorkspaceIdentity(input: {
  readonly raw: unknown | undefined;
  readonly boundWorkspaceId: WorkspaceId | null;
  readonly conflictCopyNames: readonly string[];
}): { readonly status: WorkspaceIdentityStatus; readonly file?: WorkspaceIdentityFile } {
  if (input.conflictCopyNames.length > 0) {
    // Two identity files means two answers to "which workspace is this".
    return { status: "WORKSPACE_IDENTITY_AMBIGUOUS" };
  }
  if (input.raw === undefined) {
    return { status: input.boundWorkspaceId ? "WORKSPACE_IDENTITY_MISSING" : "ok" };
  }
  if (typeof input.raw !== "object" || input.raw === null || Array.isArray(input.raw)) {
    return { status: "WORKSPACE_IDENTITY_INVALID" };
  }

  const c = input.raw as Partial<WorkspaceIdentityFile>;
  if (typeof c.schemaVersion !== "number" || c.schemaVersion > STATE_SCHEMA_VERSION) {
    return { status: "WORKSPACE_IDENTITY_INVALID" };
  }
  const id = parseWorkspaceId(String(c.workspaceId ?? ""));
  if (!id.ok) return { status: "WORKSPACE_IDENTITY_INVALID" };

  if (input.boundWorkspaceId && input.boundWorkspaceId !== id.value) {
    return { status: "WORKSPACE_IDENTITY_CHANGED" };
  }

  return {
    status: "ok",
    file: {
      schemaVersion: c.schemaVersion,
      workspaceId: id.value,
      label: typeof c.label === "string" ? c.label : "",
      createdAt: typeof c.createdAt === "string" ? c.createdAt : "",
    },
  };
}

/** Names an external sync tool gives to a conflicting copy of the identity file. */
export function findIdentityConflictCopies(names: readonly string[]): string[] {
  return names.filter(
    (name) =>
      name !== "workspace.json" &&
      /^workspace.*\.json$/i.test(name) &&
      /sync-conflict|conflicted copy|\(\d+\)|副本/i.test(name),
  );
}

/**
 * Portable settings must survive being copied to another machine (§5.6 rule 1).
 *
 * The test is mechanical, so it is worth performing mechanically: serialise and
 * look for anything machine-shaped. A absolute path that leaks into (a) becomes
 * a path that does not exist on the other machine, silently.
 */
export function findNonPortableValues(settings: unknown): string[] {
  const offenders: string[] = [];
  const serialised = JSON.stringify(settings) ?? "";
  const patterns: Array<[string, RegExp]> = [
    ["posix-absolute-path", /"\/[^"]*"/],
    ["windows-absolute-path", /"[A-Za-z]:\\\\/],
    ["home-reference", /~[\\/]/],
    ["unc-path", /"\\\\\\\\/],
  ];
  for (const [name, pattern] of patterns) {
    if (pattern.test(serialised)) offenders.push(name);
  }
  return offenders;
}
