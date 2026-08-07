/**
 * The filesystem half of path safety (architecture §9.7.4–§9.7.6).
 *
 * `domain/path-safety.ts` answers what a string is allowed to look like; this
 * answers where it is allowed to point, which needs the filesystem. It is also
 * the only place in the plugin that mints `SafeAbsolutePath` — lint forbids the
 * cast everywhere else, so every validated path in the system traces back to a
 * call here.
 *
 * The recurring decision is to fail closed. A symlink in the middle of a
 * session directory is not normal; refusing it costs a skipped file and a line
 * in the report, while following it costs a credential file in a cloud folder.
 */
import { type SafeAbsolutePath, type Result, err, ok } from "../domain/types";
import { isSameOrDescendant, parseNeutralRel } from "../domain/path-safety";
import type { FsGateway } from "./fs-gateway";

/**
 * Exact filenames that are never session files, whatever an adapter claims
 * (§9.7.6). This is a backstop, not the main defence — that is the adapter only
 * listing shapes it recognises. It earns its place when an adapter is loosened
 * for a new CLI version, or when someone points a directory override at `~`.
 */
const DENY_EXACT = new Set([
  ".credentials.json",
  "credentials.json",
  "auth.json",
  ".env",
  ".netrc",
  "_netrc",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "known_hosts",
  "config.toml",
  "config.json",
  "settings.json",
]);

const DENY_SUFFIX = [
  ".key",
  ".pem",
  ".p12",
  ".pfx",
  ".keychain",
  ".kdbx",
  // §6.5 red line: an index is machine-local and never travels.
  ".sqlite",
  ".sqlite3",
  ".db",
  "-wal",
  "-shm",
];

const DENY_PREFIX = [".env."];

/** Whole directories that are skipped without descending. */
const DENY_DIRS = new Set([".ssh", ".gnupg", ".aws", ".gcloud", ".docker"]);

/** Transfer leftovers from external sync tools (§8.2). */
const IGNORED_PATTERNS = [
  /^\.syncthing\./,
  /^~syncthing~/,
  /^\.stfolder$/,
  /^\.stversions$/,
  /\.crdownload$/,
  /\.partial$/,
  /^\.dropbox/,
  /\.tmp$/,
];

export function isDenylisted(name: string): boolean {
  const lower = name.toLowerCase();
  if (DENY_EXACT.has(lower)) return true;
  if (DENY_DIRS.has(lower)) return true;
  if (DENY_PREFIX.some((prefix) => lower.startsWith(prefix))) return true;
  return DENY_SUFFIX.some((suffix) => lower.endsWith(suffix));
}

export function isTransferArtifact(name: string): boolean {
  return IGNORED_PATTERNS.some((pattern) => pattern.test(name));
}

export interface PathGuardDeps {
  readonly fs: FsGateway;
  readonly platform: string;
  /** Result of a runtime probe, never a guess from the platform (§9.7.4). */
  readonly caseSensitive: boolean;
  readonly joinPath: (...parts: string[]) => string;
  readonly dirnameOf: (target: string) => string;
  readonly splitPath: (target: string) => string[];
}

export interface ResolveOptions {
  /** The final segment must be a regular file, not a directory. */
  readonly requireRegularFile?: boolean;
  /** Reject nlink > 1 (read side only — see below). */
  readonly rejectHardLinks?: boolean;
}

/**
 * Resolves `<root>/<rel>` and proves it stays inside `root`.
 *
 * Walks segment by segment with `lstat`, refusing any symlink along the way
 * rather than following it and re-checking. "Follow, then verify we are still
 * inside" loses to TOCTOU: the link can be repointed between the check and the
 * write. OQ-9 measured that Windows junctions report `isSymbolicLink()` true,
 * so this covers them without any reparse-tag handling.
 */
export async function resolveUnderRoot(
  deps: PathGuardDeps,
  realRoot: string,
  rel: string,
  options: ResolveOptions = {},
): Promise<Result<SafeAbsolutePath>> {
  const parsed = parseNeutralRel(rel);
  if (!parsed.ok) return err(parsed.violation, parsed.detail);

  const segments = rel.split("/");
  for (const segment of segments) {
    if (isDenylisted(segment)) return err("DENYLISTED", segment);
  }

  let current = realRoot;
  let sawMissing = false;

  for (const [index, segment] of segments.entries()) {
    current = deps.joinPath(current, segment);
    const isLast = index === segments.length - 1;
    const st = await deps.fs.lstat(current);

    if (st === null) {
      // Once a level is missing, every deeper level must be missing too.
      // Anything else means the path partly exists through something we did
      // not walk — which is what a swapped symlink looks like.
      sawMissing = true;
      continue;
    }
    if (sawMissing) return err("SYMLINK", `${segment} exists below a missing parent`);

    if (st.isSymbolicLink) return err("SYMLINK", segment);
    if (!isLast && !st.isDirectory) return err("NOT_REGULAR_FILE", segment);
    if (isLast && options.requireRegularFile && !st.isFile) return err("NOT_REGULAR_FILE", segment);
    if (isLast && options.rejectHardLinks && st.nlink > 1) {
      // Read side only. A file in the provider directory hard-linked to a
      // private key would otherwise be pushed into the sync folder. Writes are
      // immune by construction: temp-file + rename replaces a directory entry
      // and never writes through to the other link.
      return err("HARDLINK_SUSPECT", `${segment} has ${st.nlink} links`);
    }
  }

  // After the walk: the parent, resolved, must still be inside the root. Catches
  // a link that was swapped in while we were walking.
  const parent = deps.dirnameOf(current);
  const parentReal = await deps.fs.realpath(parent).catch(() => null);
  if (parentReal !== null && !containsPath(deps, realRoot, parentReal)) {
    return err("SYMLINK", "path escaped its root during resolution");
  }

  return ok(current as SafeAbsolutePath);
}

/** Is `candidate` the same as, or inside, `ancestor`? Segment-wise. */
export function containsPath(deps: PathGuardDeps, ancestor: string, candidate: string): boolean {
  return isSameOrDescendant(deps.splitPath(candidate), deps.splitPath(ancestor), deps.caseSensitive);
}

export interface RootSpec {
  /** Symbolic name used in reports; never a raw absolute path (§11.1). */
  readonly name: string;
  readonly realPath: string;
}

export interface RootOverlap {
  readonly a: string;
  readonly b: string;
  readonly relation: "same" | "a-contains-b" | "b-contains-a";
}

/**
 * The four-root overlap check (§9.7.5).
 *
 * Pass-level, not file-level: an overlap means the configuration itself is
 * poisonous — `syncDir` inside the vault pushes every conversation into
 * Obsidian's index, `syncDir = ~` makes the plugin sync its own backups and
 * somebody's credentials, `backupDir` inside `syncDir` puts the backups in the
 * same tree they exist to survive. None of those is recoverable by skipping a
 * file, so the pass does not start.
 *
 * Inputs must already be realpaths: two different spellings of one directory
 * have to compare equal, or the check silently passes on the case it most
 * needs to catch.
 */
export function findRootOverlaps(deps: PathGuardDeps, roots: readonly RootSpec[]): RootOverlap[] {
  const overlaps: RootOverlap[] = [];
  for (let i = 0; i < roots.length; i++) {
    for (let j = i + 1; j < roots.length; j++) {
      const a = roots[i];
      const b = roots[j];
      if (!a || !b) continue;

      const aInB = containsPath(deps, b.realPath, a.realPath);
      const bInA = containsPath(deps, a.realPath, b.realPath);
      if (aInB && bInA) overlaps.push({ a: a.name, b: b.name, relation: "same" });
      else if (bInA) overlaps.push({ a: a.name, b: b.name, relation: "a-contains-b" });
      else if (aInB) overlaps.push({ a: a.name, b: b.name, relation: "b-contains-a" });
    }
  }
  return overlaps;
}

/**
 * Detects case-insensitivity by experiment (§9.7.4).
 *
 * Never inferred from the platform: macOS can be formatted case-sensitive and
 * Linux can mount a filesystem that is not, and guessing wrong turns the
 * overlap check above into a formality.
 */
export async function probeCaseSensitivity(
  fs: FsGateway,
  probeDir: SafeAbsolutePath,
  joinPath: (...parts: string[]) => string,
  token: string,
): Promise<boolean> {
  const lower = joinPath(probeDir, `aiss-case-${token}.probe`) as SafeAbsolutePath;
  const upper = joinPath(probeDir, `AISS-CASE-${token.toUpperCase()}.PROBE`);
  try {
    await fs.writeFileAtomic(lower, new Uint8Array(0));
    const seen = await fs.lstat(upper);
    return seen === null;
  } finally {
    await fs.removeFile(lower).catch(() => undefined);
  }
}

/**
 * Mints a path inside this plugin's own home state directory (§5.5).
 *
 * A legitimate second minting site alongside `resolveUnderRoot`, and worth
 * naming rather than casting inline: these paths are *constructed* by the
 * plugin from the OS home directory, not received from a sync folder or an
 * adapter, so the containment walk has nothing to check. What still has to be
 * checked is that nobody has built a path out of untrusted text — hence the
 * explicit root containment test rather than a bare cast.
 */
export function mintStatePath(
  deps: PathGuardDeps,
  stateRoot: string,
  absoluteTarget: string,
): Result<SafeAbsolutePath> {
  if (absoluteTarget.includes("\0")) return err("NUL_OR_CONTROL", "state path");
  if (!containsPath(deps, stateRoot, absoluteTarget)) {
    return err("ROOT_OVERLAP", "state path outside the state root");
  }
  return ok(absoluteTarget as SafeAbsolutePath);
}
