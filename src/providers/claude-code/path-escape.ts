/**
 * Claude Code's project-directory naming rule (architecture §6.3).
 *
 * Measured on macOS, Windows and Linux on 2026-08-06 (OQ-3); the samples are in
 * tests/fixtures/path-escape-cases.json and every one of them is `verified:
 * true`. The rule itself is one line:
 *
 *     escape(p) = for each character of realpath(p):
 *                   [A-Za-z0-9-] is kept, anything else becomes a single "-"
 *
 * Two consequences that shape the rest of the design:
 *
 *  - **The input is a realpath, not the string the user typed.** `/tmp/x`
 *    becomes `-private-tmp-x` on macOS, and a session opened inside a symlinked
 *    directory lands in the target's directory, not a new one. The adapter must
 *    call `fs.realpathSync.native` before calling this function — which is why
 *    this module takes a plain string and does no I/O: the realpath step is the
 *    caller's, and making it invisible here would hide it.
 *  - **It is not reversible.** `my.vault`, `my-vault` and `my vault` all
 *    produce the same directory name, and any two same-length non-ASCII names
 *    collide. So landing a file always means re-escaping the local vault path;
 *    `unescape` exists only to make a diagnostic message readable.
 */
import { InvalidInputError } from "../../domain/types";

const KEEP = /[A-Za-z0-9-]/;

const POSIX_ABSOLUTE = /^\//;
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const UNC = /^[\\/]{2}/;

/**
 * Maps an absolute path to the directory name Claude Code stores it under.
 *
 * Rejects anything that is not an absolute path — including its own output.
 * Feeding an already-escaped name back in is a real bug (it would write a
 * user's conversations into a directory derived from a directory name), and
 * making it idempotent would let that bug produce a plausible-looking result
 * and survive. It throws on the first occurrence instead.
 */
export function escapeProjectPath(absolutePath: string): string {
  if (typeof absolutePath !== "string" || absolutePath.length === 0) {
    throw new InvalidInputError("escapeProjectPath requires a non-empty absolute path");
  }
  if (UNC.test(absolutePath)) {
    // Never measured (no share to test against), so it is unsupported rather
    // than guessed at — a wrong directory name here means writing somebody's
    // conversations somewhere nobody will look for them.
    throw new InvalidInputError(`UNC paths are not supported: ${absolutePath}`);
  }
  if (!POSIX_ABSOLUTE.test(absolutePath) && !WINDOWS_ABSOLUTE.test(absolutePath)) {
    throw new InvalidInputError(
      `escapeProjectPath requires an absolute path (got ${JSON.stringify(absolutePath)}). ` +
        "Passing an already-escaped directory name back in is the bug this catches.",
    );
  }

  let escaped = "";
  // Iterated by UTF-16 code unit rather than code point, which is what a
  // `replace(/[^A-Za-z0-9-]/g, "-")` in the CLI would do. It matters only for
  // astral characters (emoji), where this yields two dashes rather than one.
  // The measured samples cover BMP CJK, where the two readings agree, so this
  // one edge is inferred, not verified — a vault path containing emoji should
  // use the `custom` escape strategy until it is measured.
  for (const char of splitCodeUnits(absolutePath)) {
    escaped += KEEP.test(char) ? char : "-";
  }
  return escaped;
}

/**
 * Diagnostic only.
 *
 * The return type deliberately cannot be handed to anything that lands a file:
 * there is no `value: string` to reach for, only `candidates`. A "-" could have
 * been "/", "." or " ", so any single answer would be a guess, and a guess here
 * writes conversation history to the wrong directory.
 */
export function unescapeProjectDirName(dirName: string): {
  readonly certain: false;
  readonly candidates: readonly string[];
} {
  const candidates: string[] = [];

  const windows = /^([A-Za-z])--(.*)$/.exec(dirName);
  if (windows) {
    candidates.push(`${windows[1]}:\\${(windows[2] ?? "").split("-").join("\\")}`);
  }
  if (dirName.startsWith("-")) {
    candidates.push(`/${dirName.slice(1).split("-").join("/")}`);
  }

  return { certain: false, candidates };
}

function splitCodeUnits(value: string): string[] {
  const units: string[] = [];
  for (let i = 0; i < value.length; i++) units.push(value.charAt(i));
  return units;
}
