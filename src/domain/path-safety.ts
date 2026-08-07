/**
 * Pure string validation for every path and identifier that reaches this plugin
 * from outside (architecture §9.7.3).
 *
 * Zero dependencies on purpose — not even `path`. Node's `path` is
 * platform-dependent, and the neutral layer has to mean the same thing on both
 * machines: `path.join` on Windows would happily normalise `a\b` into a segment
 * boundary that POSIX reads as one filename. So this module splits on "/"
 * itself and rejects everything it does not positively recognise.
 *
 * Three inputs are untrusted, and none of them is hostile-by-default — they are
 * just not ours: files an external sync tool moved into the sync directory,
 * files another program left in the provider directory, and the adapter's own
 * output (our code, but written to tolerate CLI changes it has not seen).
 * Everything here fails closed: reject and report, never "clean it up a bit".
 */
import {
  err,
  ok,
  type LogicalId,
  type MachineId,
  type Result,
  type SafeRelativePath,
  type SafeSegment,
  type WorkspaceId,
} from "./types";

/** NTFS/ext4 filename limit. */
export const MAX_SEGMENT_BYTES = 255;
/** Neutral relative path budget — deliberately far below any OS limit (§9.7.3). */
export const MAX_REL_LENGTH = 200;
/** `<workspaceId>/<provider>/<...>` needs 3; 8 leaves room without inviting deep trees. */
export const MAX_DEPTH = 8;

/**
 * Rejected regardless of the platform we happen to be running on. A neutral
 * path is written on one machine and read on another, so a name that only
 * breaks on Windows still has to be refused on Linux. findings F-3: Node can in
 * fact create `CON` and `aux.txt` through the `\\?\` prefix — the reason to
 * reject them is that Explorer and every sync tool fall over, not that the
 * write fails.
 */
const RESERVED_BASENAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 10 }, (_, i) => `com${i}`),
  ...Array.from({ length: 10 }, (_, i) => `lpt${i}`),
]);

/** Printable ASCII minus the characters Windows forbids in a filename. */
const SEGMENT_CHARSET = /^[\x20-\x7E]+$/;
const WINDOWS_ILLEGAL = /[\\/:*?"<>|]/;

/**
 * 8.3 short names. `C:\PROGRA~1` and `C:\Program Files` are the same directory
 * spelled two ways, which would slip straight past the string-level overlap
 * check. OQ-9 measured that `realpath` does *not* expand them, so this
 * rejection is the only defence there is.
 */
const SHORTNAME_LIKE = /^.{1,6}~\d(\.[^.]{1,3})?$/;

/** Strict lowercase UUID v4. No toLowerCase tolerance — see parseWorkspaceId. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Control characters, including NUL, in any position.
 *
 * Checked by code point rather than by regex: a character-class regex needs
 * literal control escapes in its source, which `no-control-regex` flags, and
 * `domain/` deliberately runs with inline eslint directives disabled — there is
 * nowhere to put the suppression, by design. The loop is clearer regardless.
 */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Validates one path segment.
 *
 * Order matters and is asserted by the tests: the more specific diagnosis wins,
 * because "SEGMENT_CHARSET" tells someone far less than "RESERVED_NAME".
 */
export function validateSegment(segment: string): Result<SafeSegment> {
  if (segment.length === 0) return err("EMPTY_SEGMENT", "empty segment");
  if (segment === ".") return err("DOT_SEGMENT", segment);
  if (segment === "..") return err("TRAVERSAL", segment);

  if (hasControlChar(segment)) return err("NUL_OR_CONTROL", "control character in segment");

  // Byte length, not code units: the filesystem's limit is in bytes.
  const byteLength = utf8Length(segment);
  if (byteLength > MAX_SEGMENT_BYTES) {
    return err("SEGMENT_TOO_LONG", `${byteLength} bytes > ${MAX_SEGMENT_BYTES}`);
  }

  if (!SEGMENT_CHARSET.test(segment)) {
    // Neutral names are NFC + ASCII (§9.7.3 ⑦): macOS stores NFD and Windows
    // NFC, so the same visible name would differ byte for byte across machines
    // and the session would be copied back and forth forever.
    return err("SEGMENT_CHARSET", "segment must be printable ASCII");
  }
  if (WINDOWS_ILLEGAL.test(segment)) {
    return err("SEGMENT_CHARSET", "segment contains a character Windows forbids");
  }

  const basename = stripExtension(segment).toLowerCase();
  if (RESERVED_BASENAMES.has(basename)) return err("RESERVED_NAME", segment);

  if (SHORTNAME_LIKE.test(segment)) return err("SHORTNAME_LIKE", segment);

  const last = segment[segment.length - 1];
  if (last === "." || last === " ") return err("TRAILING_DOT_OR_SPACE", segment);

  return ok(segment as SafeSegment);
}

/**
 * Parses a neutral relative path: POSIX separators, relative, no traversal.
 *
 * The check order is normative (architecture §9.7.3): control characters, then
 * UNC / drive letter / absolute, then any backslash at all, then the segments.
 * UNC is tested before "absolute" because `//server/share` starts with a
 * separator too, and reporting it as ABSOLUTE would hide what it really is.
 */
export function parseNeutralRel(input: string): Result<SafeRelativePath> {
  if (input.length === 0) return err("EMPTY_SEGMENT", "empty path");

  // ① Control characters first: a NUL truncates the path in any syscall that
  // takes a C string, so nothing below may run before this.
  if (hasControlChar(input)) return err("NUL_OR_CONTROL", "control character in path");

  // ② Rooted forms. Each is a distinct diagnosis.
  if (/^[\\/]{2}/.test(input)) return err("UNC", input);
  if (/^[A-Za-z]:/.test(input)) return err("DRIVE_LETTER", input);
  if (/^[\\/]/.test(input)) return err("ABSOLUTE", input);

  // ③ POSIX treats "\" as an ordinary filename character; Windows does not.
  // A neutral path that means different things on the two machines is not
  // neutral, so it is rejected outright rather than translated.
  if (input.includes("\\")) return err("BACKSLASH_IN_REL", input);

  // ④ Segments. Traversal is diagnosed before anything else a segment could be
  // wrong about: "./../x" is both a dot segment and an escape attempt, and
  // reporting the dot would bury the part that matters.
  const segments = input.split("/");
  if (segments.includes("..")) return err("TRAVERSAL", input);
  if (segments.includes("")) return err("EMPTY_SEGMENT", input);
  if (segments.includes(".")) return err("DOT_SEGMENT", input);

  // ⑤ Depth, then ⑥ each segment, then ⑦ the total — the order in §9.7.3.
  // Segment length is checked before total length so that one 300-character
  // filename is reported as the oversized name it is, not as a long path.
  if (segments.length > MAX_DEPTH) {
    return err("TOO_DEEP", `${segments.length} segments > ${MAX_DEPTH}`);
  }

  for (const segment of segments) {
    const result = validateSegment(segment);
    if (!result.ok) return err(result.violation, result.detail);
  }

  if (input.length > MAX_REL_LENGTH) {
    return err("PATH_TOO_LONG", `${input.length} chars > ${MAX_REL_LENGTH}`);
  }

  return ok(input as SafeRelativePath);
}

/**
 * Strict lowercase UUID v4.
 *
 * No `toLowerCase()` tolerance, deliberately: accepting both spellings would
 * mint two identifiers that differ as strings but collide as directory names on
 * a case-insensitive filesystem — one workspace that looks like two, or two
 * that look like one, depending on which machine you ask.
 */
export function parseWorkspaceId(input: string): Result<WorkspaceId> {
  if (!UUID_V4.test(input)) return err("SEGMENT_CHARSET", "workspaceId must be a lowercase UUID v4");
  return ok(input as WorkspaceId);
}

export function parseMachineId(input: string): Result<MachineId> {
  if (!UUID_V4.test(input)) return err("SEGMENT_CHARSET", "machineId must be a lowercase UUID v4");
  return ok(input as MachineId);
}

/**
 * A logical id must be a single segment matching the provider's own pattern.
 * A non-match is not an error: it means "this file is not a session of ours",
 * which the caller reports as UNKNOWN_FILE and otherwise ignores (§8.2).
 */
export function parseLogicalId(input: string, pattern: RegExp): Result<LogicalId> {
  const segment = validateSegment(input);
  if (!segment.ok) return err(segment.violation, segment.detail);
  if (!pattern.test(input)) return err("SEGMENT_CHARSET", "does not match the provider's logicalIdPattern");
  return ok(input as LogicalId);
}

/**
 * A user-supplied directory name override. Same rules as any segment, with one
 * explicit allowance: Claude Code's own directories start with "-"
 * (`-home-testuser-vault`), so a leading dash must pass.
 */
export function parseCustomDirName(input: string): Result<SafeSegment> {
  return validateSegment(input);
}

/**
 * Two names that differ only in case cannot both land on a case-insensitive
 * filesystem — one would silently overwrite the other. Neither is written.
 */
export function findCaseCollisions(names: readonly string[]): string[][] {
  return groupBy(names, (name) => name.toLowerCase());
}

/**
 * macOS stores NFD, Windows and Linux store NFC. The same visible filename can
 * therefore arrive as two distinct byte strings, and writing both would produce
 * a pair of files that look identical and sync against each other forever.
 */
export function findNormalizationCollisions(names: readonly string[]): string[][] {
  return groupBy(names, (name) => name.normalize("NFC")).filter((group) =>
    // Same NFC form but different bytes — a pure-NFC duplicate list is just a
    // duplicate, which is the caller's problem, not a normalisation collision.
    group.some((name) => name !== group[0]),
  );
}

function groupBy(names: readonly string[], key: (name: string) => string): string[][] {
  const groups = new Map<string, string[]>();
  for (const name of names) {
    const k = key(name);
    const existing = groups.get(k);
    if (existing) existing.push(name);
    else groups.set(k, [name]);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

/**
 * Segment-wise ancestry test for the four-root overlap check (§9.7.5).
 *
 * Segment-wise and not `startsWith`: "/a/bc".startsWith("/a/b") is true, and
 * treating /a/bc as living inside /a/b is how a root-overlap check quietly
 * fails to fire. `caseSensitive` is a runtime probe result, never a guess from
 * the platform — macOS can be formatted case-sensitive and Linux can mount a
 * filesystem that is not.
 */
export function isSameOrDescendant(
  candidate: readonly string[],
  ancestor: readonly string[],
  caseSensitive: boolean,
): boolean {
  if (candidate.length < ancestor.length) return false;
  for (const [index, segment] of ancestor.entries()) {
    const other = candidate[index] ?? "";
    const same = caseSensitive ? other === segment : other.toLowerCase() === segment.toLowerCase();
    if (!same) return false;
  }
  return true;
}

/** Everything before the final dot; a name that is all extension keeps its name. */
function stripExtension(segment: string): string {
  const dot = segment.lastIndexOf(".");
  return dot > 0 ? segment.slice(0, dot) : segment;
}

function utf8Length(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code < 0x10000) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}
