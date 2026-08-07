/**
 * The invariants (testing.md §1).
 *
 * I1 is the one everything else serves: no version of a file may become
 * unrecoverable. It is stated over **ordered bytes**, not over a set of lines —
 * a set ignores order and multiplicity, so reordering `[a,b,c]` to `[c,b,a]` or
 * de-duplicating `[a,a,b]` would both "preserve the set" while destroying a
 * session the CLI can no longer resume.
 */
import { expect } from "vitest";
import type { WorldSnapshot } from "./world";

interface RecoveryFailure {
  readonly origin: string;
  readonly hash: string;
  readonly size: number;
  readonly nearestLive: string;
}

/**
 * Every version that was live before the pass must still be recoverable after.
 *
 * Two ways to survive, and only two:
 *   1. some live file still has those exact bytes as a prefix (equality counts,
 *      so a NOOP or an idempotent re-run never violates this); or
 *   2. the exact bytes are in the archive — verified byte for byte, not by
 *      hash alone, because a hash match with different bytes is precisely the
 *      corruption this is meant to detect.
 */
export function assertRecoverable(before: WorldSnapshot, after: WorldSnapshot): void {
  const versions = new Map<string, { origin: string; bytes: Uint8Array }>();
  for (const [loc, version] of before.live) {
    if (!versions.has(version.hash)) versions.set(version.hash, { origin: loc, bytes: version.read() });
  }

  const liveAfter = [...after.live.values()];
  const archiveAfter = [...after.archive.values()];
  const failures: RecoveryFailure[] = [];

  for (const [hash, { origin, bytes }] of versions) {
    const survivesAsPrefix = liveAfter.some(
      (candidate) => candidate.size >= bytes.length && startsWith(candidate.read(), bytes),
    );
    const survivesInArchive = archiveAfter.some(
      (candidate) =>
        candidate.hash === hash && candidate.size === bytes.length && equalBytes(candidate.read(), bytes),
    );
    if (!survivesAsPrefix && !survivesInArchive) {
      failures.push({ origin, hash, size: bytes.length, nearestLive: diagnose(bytes, liveAfter) });
    }
  }

  expect(
    failures,
    failures.length === 0
      ? ""
      : `I1 violated — a version became unrecoverable:\n${failures
          .map((f) => `  ${f.origin} (${f.size}B, ${f.hash.slice(0, 16)}): ${f.nearestLive}`)
          .join("\n")}`,
  ).toEqual([]);
}

/**
 * I1-a: every applied overwrite left a backup behind (§1.2).
 *
 * Asserted against the report rather than the filesystem, because the report is
 * what a user is shown — an overwrite whose `backupPath` is missing is an
 * implementation bug even if a backup happens to exist.
 */
export function assertEveryOverwriteBacked(report: {
  actions: readonly { action: string; result: string; backupPath?: string }[];
}): void {
  const unbacked = report.actions.filter(
    (entry) => entry.action.endsWith("_OVERWRITE") && entry.result === "APPLIED" && !entry.backupPath,
  );
  expect(unbacked, "an applied overwrite reported no backupPath").toEqual([]);
}

/**
 * I1-c: quarantining adds versions, never removes them (§1.2).
 *
 * A version may legitimately disappear only by being extended — i.e. it is now
 * a strict prefix of something live.
 */
export function assertInventoryPreserved(before: WorldSnapshot, after: WorldSnapshot): void {
  const afterHashes = new Set([...after.live.values(), ...after.archive.values()].map((v) => v.hash));
  const liveAfter = [...after.live.values()];

  const illegal: string[] = [];
  for (const version of before.live.values()) {
    if (afterHashes.has(version.hash)) continue;
    const bytes = version.read();
    const extended = liveAfter.some((c) => c.size > bytes.length && startsWith(c.read(), bytes));
    if (!extended) illegal.push(version.hash.slice(0, 16));
  }
  expect(illegal, "a version vanished during merge or quarantine").toEqual([]);
}

/** I1-b: a conflicted session's primary files are byte-identical before and after. */
export function assertConflictFrozen(
  before: WorldSnapshot,
  after: WorldSnapshot,
  match: (loc: string) => boolean,
): void {
  for (const [loc, version] of before.live) {
    if (!match(loc)) continue;
    const now = after.live.get(loc);
    expect(now, `${loc} disappeared during a conflict`).toBeDefined();
    expect(now?.hash, `${loc} was modified during a conflict`).toBe(version.hash);
  }
}

function startsWith(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (haystack.length < needle.length) return false;
  for (let i = 0; i < needle.length; i++) if (haystack[i] !== needle[i]) return false;
  return true;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && startsWith(a, b);
}

/** Without this a property-test failure is unlocatable (§1.1). */
function diagnose(bytes: Uint8Array, liveAfter: Array<{ size: number; read(): Uint8Array }>): string {
  let best = { shared: -1, size: 0 };
  for (const candidate of liveAfter) {
    const other = candidate.read();
    let shared = 0;
    while (shared < bytes.length && shared < other.length && bytes[shared] === other[shared]) shared++;
    if (shared > best.shared) best = { shared, size: other.length };
  }
  if (best.shared < 0) return "no live file to compare against";
  return `nearest live file shares ${best.shared} bytes then diverges (its size ${best.size})`;
}
