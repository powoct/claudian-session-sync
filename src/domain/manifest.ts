/**
 * The manifest (architecture §5.3) — a cache, and nothing more.
 *
 * It lives in the sync directory, which means other machines write it and an
 * external tool moves it. So the design goal is not "keep it accurate", it is
 * **make an inaccurate one harmless**. Every rule here follows from that:
 *
 *  - It may authorise exactly one outcome: NOOP. Doing nothing is the only
 *    decision whose worst case is a wasted pass (§5.3.2).
 *  - Losing it entirely costs I/O, never correctness — the pass falls back to
 *    reading files, which is what it would have done anyway.
 *  - A version newer than this plugin understands is *never* rewritten, because
 *    that is direct evidence a newer client is using this directory.
 *
 * The failure it exists to prevent is concrete (§5.3.1): the manifest remembers
 * remote R0's hash; a sync tool swaps in a same-size, same-mtime, divergent R1;
 * local extends R0. Reusing the remembered hash concludes R1 is still a prefix
 * and overwrites it. That is U-18, and the defence is that no hash from here
 * can reach the planner at all.
 */
import type { E0Signature } from "./stability";

export const MANIFEST_SCHEMA_VERSION = 1;

/**
 * Evidence tiers (§5.3.1). A discriminated union so the compiler can enforce
 * the authorisation matrix: the branches that produce an overwrite or a
 * conflict accept only E2.
 */
export type FileEvidence =
  /** stat only: size, timestamps, inode, tail hash. */
  | { readonly level: "E0"; readonly e0: E0Signature }
  /** stat matched the manifest exactly, so its content facts are assumed. */
  | { readonly level: "E1"; readonly e0: E0Signature; readonly contentHash: string; readonly lineCount: number }
  /** Read this pass. The only tier that may authorise a write. */
  | { readonly level: "E2"; readonly e0: E0Signature; readonly contentHash: string; readonly lineCount: number };

export interface ManifestEntry {
  readonly provider: string;
  readonly workspaceId: string;
  readonly logicalId: string;
  readonly mode: string;
  readonly size: number;
  readonly lineCount: number;
  readonly contentHash: string;
  readonly e0: E0Signature;
  readonly lastWriter: string;
  readonly updatedAt: string;
  readonly generation: number;
  /** Fields written by a newer version; preserved verbatim on write-back. */
  readonly unknown?: Readonly<Record<string, unknown>>;
}

export interface Manifest {
  readonly schemaVersion: number;
  readonly updatedAt: string;
  readonly entries: Readonly<Record<string, ManifestEntry>>;
  readonly unknown?: Readonly<Record<string, unknown>>;
}

export type ManifestLoad =
  /** Usable and writable. */
  | { readonly status: "ok"; readonly manifest: Manifest; readonly droppedKeys: readonly string[] }
  /** Older schema, upgraded in place. */
  | { readonly status: "migrate"; readonly manifest: Manifest; readonly droppedKeys: readonly string[] }
  /** Missing, truncated or not JSON — rebuild from a full scan. */
  | { readonly status: "rebuild"; readonly reason: string }
  /**
   * Parsed, but from a newer version. Readable-as-nothing and **not writable**:
   * a newer client is demonstrably using this directory, and rebuilding would
   * destroy what it recorded. Files still move this pass; only the cache is
   * ignored.
   */
  | { readonly status: "unusable"; readonly reason: string; readonly writable: false };

export function emptyManifest(nowIso: string): Manifest {
  return { schemaVersion: MANIFEST_SCHEMA_VERSION, updatedAt: nowIso, entries: {} };
}

/**
 * Parses a manifest, tiering by schema version (§5.3.4).
 *
 * Note the asymmetry with `formatVersion` (§5.4), which is read-only when too
 * new. They are not in conflict: the manifest is a cache, so losing it changes
 * nothing about correctness, while formatVersion describes where the real data
 * lives — misread it and the plugin writes to the wrong place.
 */
export function parseManifest(raw: unknown, supported = MANIFEST_SCHEMA_VERSION): ManifestLoad {
  if (raw === undefined || raw === null) return { status: "rebuild", reason: "absent" };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { status: "rebuild", reason: "not-an-object" };
  }

  const candidate = raw as Record<string, unknown>;
  const version = candidate.schemaVersion;
  if (typeof version !== "number" || !Number.isFinite(version)) {
    return { status: "rebuild", reason: "missing-schema-version" };
  }
  if (version > supported) {
    return { status: "unusable", reason: "newer-schema", writable: false };
  }

  const { entries, droppedKeys } = parseEntries(candidate.entries);
  // Forward compatibility: whatever a newer version added at the top level
  // survives a read-modify-write by an older one. Spread conditionally —
  // `exactOptionalPropertyTypes` distinguishes an absent key from an explicit
  // undefined, and only the former means "there was nothing extra".
  const extras = pickUnknown(candidate, ["schemaVersion", "updatedAt", "entries"]);
  const manifest: Manifest = {
    schemaVersion: supported,
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : "",
    entries,
    ...(extras ? { unknown: extras } : {}),
  };

  return version < supported
    ? { status: "migrate", manifest, droppedKeys }
    : { status: "ok", manifest, droppedKeys };
}

/**
 * An entry key must parse as `<workspaceId>/<provider>/<relative path>`.
 *
 * A bad key drops that entry alone (M-06). Discarding the whole manifest for
 * one malformed line would turn a cosmetic problem into a full rescan, and
 * keeping it would let a traversal into a path lookup.
 */
export function isValidEntryKey(key: string, workspaceId: string): boolean {
  if (key.length === 0 || key.includes("\\") || key.includes("\0")) return false;
  if (key.startsWith("/") || /^[A-Za-z]:/.test(key)) return false;

  const segments = key.split("/");
  if (segments.length < 3) return false;
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return false;
  return segments[0] === workspaceId;
}

/**
 * Does the manifest's remembered stat match what we just observed?
 *
 * Full equality of all five components (rule EV-2) — "the size is the same" is
 * not a hit. `ctimeMs` and `ino` are one-way invalidation signals only: a
 * mismatch forces a read, a match adds no trust, because Windows reports
 * creation time as ctime and cloud drives do not preserve inodes.
 */
export function e0Matches(recorded: E0Signature, observed: E0Signature): boolean {
  return (
    recorded.size === observed.size &&
    recorded.mtimeMs === observed.mtimeMs &&
    recorded.ctimeMs === observed.ctimeMs &&
    recorded.ino === observed.ino &&
    recorded.tailHash === observed.tailHash
  );
}

/**
 * The part of a remembered file a cache has to supply for E1 to be possible.
 *
 * Named separately from `ManifestEntry` because the manifest is not the only
 * store that can corroborate an observation. The machine-local observations
 * ledger (§5.5) records the same three facts from its own last full read, and
 * it is strictly more trustworthy — it lives outside the sync directory, so no
 * external tool writes it. Both are subject to the same two rules (EV-1, EV-2)
 * and both may authorise exactly one outcome, so the engine has no reason to
 * care which one answered.
 */
export interface CachedContentFacts {
  readonly e0: E0Signature;
  readonly contentHash: string;
  readonly lineCount: number;
}

/**
 * Promotes an observation to E1 when a cache corroborates it exactly.
 *
 * Returns E0 otherwise — never a partial guess. E1 saves essentially all of the
 * steady-state I/O (two stats and a small tail read per file, no full reads);
 * what it is not allowed to do is authorise a write.
 */
export function evidenceFor(
  observed: E0Signature,
  entry: CachedContentFacts | undefined,
): FileEvidence {
  if (entry && e0Matches(entry.e0, observed)) {
    return { level: "E1", e0: observed, contentHash: entry.contentHash, lineCount: entry.lineCount };
  }
  return { level: "E0", e0: observed };
}

/** The authorisation matrix (§5.3.2), as a predicate. */
export function mayAuthoriseWrite(evidence: FileEvidence): evidence is Extract<FileEvidence, { level: "E2" }> {
  return evidence.level === "E2";
}

/**
 * Scrub triggers (§5.3.3) — the answer to "what if a file is same-size,
 * same-mtime, same-tail but different in the middle, forever?"
 */
export interface ScrubInput {
  readonly nowMs: number;
  readonly lastFullVerifyMs: number;
  readonly maxAgeMs: number;
  readonly firstPassAfterStartup: boolean;
  readonly msSinceLastStartupScrub: number;
  readonly lastResultWasUnsettled: boolean;
  readonly manifestUnusable: boolean;
  readonly justBecameReady: boolean;
  readonly manuallyRequested: boolean;
  /** True when this file was picked by the per-pass random sample (T6). */
  readonly sampled: boolean;
}

export type ScrubTrigger = "T1-age" | "T2-startup" | "T3-unsettled" | "T4-manifest" | "T5-ready" | "T6-sample" | "T7-manual";

/**
 * Returns the trigger that forces a full read, or null.
 *
 * T6 (random sampling) is the important one: it bounds how long a single file
 * can go unverified *without depending on a clock*, which matters because a
 * broken clock is one of the conditions T1 is supposed to catch. Full coverage
 * is T1's job — sampling gives a per-file expectation, not a guarantee that
 * every file has been seen.
 */
export function scrubTrigger(input: ScrubInput): ScrubTrigger | null {
  if (input.manuallyRequested) return "T7-manual";
  if (input.manifestUnusable) return "T4-manifest";
  if (input.justBecameReady) return "T5-ready";
  if (input.lastResultWasUnsettled) return "T3-unsettled";
  if (input.firstPassAfterStartup && input.msSinceLastStartupScrub > 6 * 60 * 60 * 1000) return "T2-startup";
  if (input.nowMs - input.lastFullVerifyMs > input.maxAgeMs) return "T1-age";
  if (input.sampled) return "T6-sample";
  return null;
}

/** T4/T5/T7 verify everything and ignore the budget; the rest are sampled. */
export function isUnbudgetedScrub(trigger: ScrubTrigger): boolean {
  return trigger === "T4-manifest" || trigger === "T5-ready" || trigger === "T7-manual";
}

/**
 * Serialises for write-back, preserving unknown fields at both levels.
 *
 * A newer version's fields must survive a read-modify-write by an older one, or
 * every pass on the older machine silently strips whatever the newer one is
 * relying on.
 */
export function serialiseManifest(manifest: Manifest, nowIso: string): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(manifest.entries)) {
    const { unknown, ...known } = entry;
    entries[key] = { ...unknown, ...known };
  }
  return {
    ...manifest.unknown,
    schemaVersion: manifest.schemaVersion,
    updatedAt: nowIso,
    entries,
  };
}

function parseEntries(raw: unknown): {
  entries: Record<string, ManifestEntry>;
  droppedKeys: string[];
} {
  const entries: Record<string, ManifestEntry> = {};
  const droppedKeys: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { entries, droppedKeys };

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry = parseEntry(value);
    if (entry === null) {
      droppedKeys.push(key);
      continue;
    }
    entries[key] = entry;
  }
  return { entries, droppedKeys };
}

function parseEntry(value: unknown): ManifestEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const e0 = v.e0 as Partial<E0Signature> | undefined;

  if (
    typeof e0 !== "object" ||
    e0 === null ||
    typeof e0.size !== "number" ||
    typeof e0.mtimeMs !== "number" ||
    typeof e0.ctimeMs !== "number" ||
    typeof e0.ino !== "number" ||
    typeof e0.tailHash !== "string"
  ) {
    // Without a complete E0 there is nothing to compare against, so the entry
    // could only ever force a re-read — which is what dropping it achieves.
    return null;
  }
  if (typeof v.contentHash !== "string") return null;

  return {
    provider: asString(v.provider),
    workspaceId: asString(v.workspaceId),
    logicalId: asString(v.logicalId),
    mode: asString(v.mode),
    size: typeof v.size === "number" ? v.size : e0.size,
    lineCount: typeof v.lineCount === "number" ? v.lineCount : 0,
    contentHash: v.contentHash,
    e0: { size: e0.size, mtimeMs: e0.mtimeMs, ctimeMs: e0.ctimeMs, ino: e0.ino, tailHash: e0.tailHash },
    lastWriter: asString(v.lastWriter),
    updatedAt: asString(v.updatedAt),
    generation: typeof v.generation === "number" ? v.generation : 0,
    ...unknownEntryFields(v),
  };
}

function unknownEntryFields(v: Record<string, unknown>): { unknown?: Record<string, unknown> } {
  const extras = pickUnknown(v, [
      "provider",
      "workspaceId",
      "logicalId",
      "mode",
      "size",
      "lineCount",
      "contentHash",
      "e0",
      "lastWriter",
    "updatedAt",
    "generation",
  ]);
  return extras ? { unknown: extras } : {};
}

function pickUnknown(
  source: Record<string, unknown>,
  known: readonly string[],
): Record<string, unknown> | undefined {
  const extras = Object.fromEntries(Object.entries(source).filter(([key]) => !known.includes(key)));
  return Object.keys(extras).length > 0 ? extras : undefined;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
