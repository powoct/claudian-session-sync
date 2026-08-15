/**
 * Backup before overwrite (architecture §9.3).
 *
 * Invariant I1 says a file's bytes must always be recoverable, and this module
 * is what makes that true across an overwrite. Two consequences shape it:
 *
 *  - **Backups cannot be turned off** (§9.3.1). An invariant a user can disable
 *    is not an invariant — the tests would have to either bypass it or assert
 *    it does not hold. The only knob is how many copies to keep.
 *  - **Rotation is itself governed by I1** (§9.3.3). Deleting an old backup is
 *    the only place this plugin destroys bytes on purpose, so a version may
 *    only be dropped once something still live can reproduce it. Otherwise
 *    `keep = 3` would itself be a data-loss path.
 */
import type { LogicalId } from "../domain/types";

/** Range accepted by the settings panel. Zero is refused, with a reason. */
export const MIN_BACKUP_KEEP = 1;
export const MAX_BACKUP_KEEP = 20;
export const DEFAULT_BACKUP_KEEP = 3;

/** Sequence numbers before falling back to a random suffix. */
export const MAX_SEQ = 100;

/**
 * `YYYYMMDDTHHMMSS-mmmZ` — ISO-8601 with the characters Windows forbids removed.
 *
 * A literal ISO timestamp contains ":", which is illegal in an NTFS filename
 * and is read as an alternate-data-stream separator. Dropping the separators
 * keeps the property that actually matters: lexicographic order equals
 * chronological order, so a directory listing is sorted by time for free.
 */
export function backupStamp(epochMs: number): string {
  const iso = new Date(epochMs).toISOString(); // 2026-08-06T11:00:00.123Z
  const [date, time] = iso.split("T");
  const [hms, millis] = (time ?? "").replace("Z", "").split(".");
  return `${(date ?? "").replace(/-/g, "")}T${(hms ?? "").replace(/:/g, "")}-${millis ?? "000"}Z`;
}

export function backupFileName(originalName: string, stamp: string, seq: number, suffix = ""): string {
  const sequence = String(seq).padStart(2, "0");
  return `${originalName}.${stamp}.${sequence}${suffix ? `.${suffix}` : ""}.bak`;
}

/** `20260806T110000-123Z` — the stamp shape `backupStamp` produces. */
const STAMP = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})-(\d{3})Z$/;

export interface ParsedBackupName {
  /** Basename of the file this preserves — never a path (§9.3.2 flattens). */
  readonly originalName: string;
  readonly stamp: string;
  readonly takenAtMs: number;
  readonly seq: number;
}

/**
 * The inverse of `backupFileName`, and deliberately its neighbour.
 *
 * Recovery may not lean on `index.jsonl` — that file is a convenience for
 * someone reading the directory and is written best-effort, so a restore that
 * needed it would be a restore that a lost line can block. Everything the UI
 * shows about a backup therefore comes from its name plus its bytes, which
 * makes this parser part of the recovery path rather than a display helper.
 *
 * Compose and parse living in one file is the response to a mistake this
 * project has made twice: a rule written down twice drifts, and the copy that
 * drifts looser is the one that touches user data.
 */
export function parseBackupName(name: string): ParsedBackupName | null {
  if (!name.endsWith(".bak")) return null;
  const parts = name.slice(0, -".bak".length).split(".");
  // `<original...>.<stamp>.<seq>` at minimum, and the original itself contains
  // dots (`<uuid>.jsonl`), so the fields are taken from the end. A trailing
  // collision suffix (`nextBackupName`'s last resort) sits between seq and
  // `.bak`, so try both shapes rather than assuming the common one.
  for (const tail of [2, 3]) {
    if (parts.length <= tail) continue;
    const seqIndex = parts.length - (tail === 2 ? 1 : 2);
    const stamp = parts[seqIndex - 1];
    const seq = parts[seqIndex];
    if (stamp === undefined || seq === undefined) continue;
    if (!STAMP.test(stamp) || !/^\d{2}$/.test(seq)) continue;
    const takenAtMs = stampToMs(stamp);
    if (takenAtMs === null) continue;
    const originalName = parts.slice(0, seqIndex - 1).join(".");
    const suffix = tail === 3 ? (parts[parts.length - 1] ?? "") : "";
    // The no-drift claim, made mechanical: a parse is only accepted when the
    // composer rebuilds the exact name from it. Two families in one directory
    // whose names could be read more than one way therefore resolve to the
    // reading that round-trips, or to null.
    if (backupFileName(originalName, stamp, Number(seq), suffix) !== name) continue;
    return { originalName, stamp, takenAtMs, seq: Number(seq) };
  }
  return null;
}

function stampToMs(stamp: string): number | null {
  const match = STAMP.exec(stamp);
  if (!match) return null;
  const [, y, mo, d, h, mi, sec, ms] = match;
  const at = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${sec}.${ms}Z`);
  return Number.isNaN(at) ? null : at;
}

export interface BackupTarget {
  readonly workspaceId: string;
  readonly providerId: string;
  /** True when preserving a *remote* version about to be overwritten (§9.3.2). */
  readonly remote: boolean;
}

/**
 * `backups/<workspaceId>/<providerId>[/remote]`.
 *
 * The `remote/` subtree is what makes PUSH_OVERWRITE survivable. The version
 * being overwritten there may have come from another machine and will vanish
 * from the sync directory the moment it is replaced, so the overwriting machine
 * has to bring a copy down first. Without it, PUSH_OVERWRITE would be the one
 * action that can destroy bytes with no local record — a direct I1 violation.
 */
export function backupDirFor(target: BackupTarget): string[] {
  const parts = [target.workspaceId, target.providerId];
  if (target.remote) parts.push("remote");
  return parts;
}

export interface BackupRecord {
  readonly name: string;
  readonly logicalId: LogicalId;
  readonly createdAtMs: number;
  readonly sizeBytes: number;
  readonly lineCount: number;
  /** First 8 hex characters only — never the full digest (§11.1). */
  readonly hashPrefix: string;
  readonly action: string;
}

/**
 * Chooses the next free filename, given what is already there.
 *
 * Two backups can land in the same millisecond, so the sequence number is
 * probed upward. Past 99 a random suffix takes over rather than silently
 * reusing a name: the caller creates with "wx", so a collision is a failed
 * backup, and a failed backup cancels the overwrite it was protecting.
 */
export function nextBackupName(
  originalName: string,
  stamp: string,
  existing: ReadonlySet<string>,
  randomSuffix: () => string,
): string | null {
  for (let seq = 0; seq < MAX_SEQ; seq++) {
    const candidate = backupFileName(originalName, stamp, seq);
    if (!existing.has(candidate)) return candidate;
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = backupFileName(originalName, stamp, MAX_SEQ - 1, randomSuffix());
    if (!existing.has(candidate)) return candidate;
  }
  // Every name taken: report a failed backup rather than overwrite one.
  return null;
}

export interface RotationCandidate {
  readonly name: string;
  readonly createdAtMs: number;
  /**
   * Can this version still be reconstructed from something that survives
   * rotation — the live file, or a retained backup that contains it as a
   * prefix? Computed by the caller, which has the bytes.
   */
  readonly recoverableFromSurvivor: boolean;
}

export interface RotationPlan {
  readonly deleteNames: readonly string[];
  readonly keptCount: number;
  /** Set when something was retained past `keep` because I1 would have been broken. */
  readonly deferred: boolean;
}

/**
 * Decides which backups may be deleted (§9.3.3).
 *
 * Newest `keep` are retained unconditionally. Beyond that, a version is deleted
 * only if it can still be reproduced from a survivor; anything else is kept and
 * the rotation is reported as deferred. Keeping too many backups is untidy,
 * whereas deleting the only copy of a branch is the failure this whole module
 * exists to prevent.
 */
export function planRotation(
  candidates: readonly RotationCandidate[],
  keep: number,
): RotationPlan {
  const bounded = Math.min(Math.max(keep, MIN_BACKUP_KEEP), MAX_BACKUP_KEEP);
  const newestFirst = [...candidates].sort((a, b) => b.createdAtMs - a.createdAtMs);

  const retained = newestFirst.slice(0, bounded);
  const surplus = newestFirst.slice(bounded);

  const deleteNames = surplus.filter((entry) => entry.recoverableFromSurvivor).map((e) => e.name);
  const deferred = surplus.length > deleteNames.length;

  return { deleteNames, keptCount: retained.length + (surplus.length - deleteNames.length), deferred };
}

/**
 * A backup write failure cancels the overwrite it was protecting (§9.3.3).
 *
 * Stated as a function because the direction is counterintuitive under
 * pressure: the tempting reading is "the backup is only a safety net, proceed
 * without it". But an overwrite with no backup is precisely the case I1
 * forbids. Better to not sync than to have no way back.
 */
export function backupFailureIsFatal(): true {
  return true;
}

/** Rotation failures are not fatal: the way back already exists. */
export function rotationFailureIsFatal(): false {
  return false;
}

/** One line of the human-facing index; losing it never affects recovery. */
export function indexLine(record: BackupRecord): string {
  return JSON.stringify(record);
}
