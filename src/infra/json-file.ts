/**
 * Reading and writing this plugin's own JSON files (architecture §5.5, §5.3).
 *
 * Every state file it owns is loaded through here, and they all share one
 * disposition: **a file that cannot be trusted is not a failure, it is an
 * answer**. Absent, truncated, half-written by a process that died, written by
 * a newer version — each of those has a defined degradation, and none of them
 * may throw out of a pass that has already started writing.
 *
 * The one rule that is not obvious: **`unusable` is never rewritten from
 * here.** Whether to rebuild a file depends on what the file is for — losing
 * the manifest costs a slow pass, losing `root.json` loses the other machine's
 * anchor — so the decision belongs to the caller, and a helper that silently
 * repaired would take it away from them.
 */
import type { SafeAbsolutePath } from "../domain/types";
import type { FsGateway } from "./fs-gateway";

export type JsonLoad =
  | { readonly status: "loaded"; readonly raw: unknown }
  | { readonly status: "absent" }
  /** Present but not JSON: truncated, or a partial write in flight. */
  | { readonly status: "unusable"; readonly reason: string };

/** Errors that mean "there is nothing here", as opposed to "something broke". */
const ABSENT_CODES = new Set(["ENOENT", "ENOTDIR"]);

/**
 * Reads and parses, distinguishing absent from unreadable from unparseable.
 *
 * EACCES is `unusable`, not `absent`: a directory we are not allowed to read is
 * emphatically not an empty one, and conflating them is how a permissions
 * problem turns into "the remote looks empty, push everything".
 */
export async function readJson(fs: FsGateway, target: string): Promise<JsonLoad> {
  let bytes: Uint8Array;
  try {
    bytes = await fs.readFile(target);
  } catch (error) {
    const code = errnoOf(error);
    if (code && ABSENT_CODES.has(code)) return { status: "absent" };
    return { status: "unusable", reason: code ?? "read-failed" };
  }

  // A zero-byte file is what a crash between create and write leaves behind.
  // It is not valid JSON and it is not absent; calling it unusable keeps the
  // caller's "should I rebuild this?" decision intact.
  if (bytes.length === 0) return { status: "unusable", reason: "empty" };

  try {
    return { status: "loaded", raw: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
  } catch {
    return { status: "unusable", reason: "not-json" };
  }
}

/**
 * Writes atomically, creating the parent directory if needed.
 *
 * Pretty-printed with a trailing newline because these files are meant to be
 * opened by a human debugging a sync problem, and a one-line 200 KB
 * `observations.json` is not.
 */
export async function writeJson(
  fs: FsGateway,
  target: SafeAbsolutePath,
  value: unknown,
  parentDir: SafeAbsolutePath,
): Promise<void> {
  await fs.mkdirp(parentDir);
  await fs.writeFileAtomic(target, encode(value));
}

/**
 * Writes only if the target does not exist yet.
 *
 * For the files whose whole point is to be created exactly once — `root.json`
 * is the sync directory's permanent identity, and two machines initialising the
 * same directory at the same moment must not both succeed.
 */
export async function createJsonExclusive(
  fs: FsGateway,
  target: SafeAbsolutePath,
  value: unknown,
  parentDir: SafeAbsolutePath,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  await fs.mkdirp(parentDir);
  const outcome = await fs.writeFileNoReplace(target, encode(value));
  return outcome.ok ? { ok: true } : { ok: false, reason: outcome.reason };
}

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

function errnoOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}
