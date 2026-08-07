/**
 * Prefix-safe merge (architecture §7.4, §7.4.1).
 *
 * This is the module the entire product rests on. The rule it implements —
 * *only the side that is longer AND fully contains the other's bytes may
 * overwrite* — is what replaced "more lines wins", which silently deleted the
 * shorter branch whenever a conversation forked. Everything else in the sync
 * engine is arranged so that this function gets to make that call on real bytes
 * read this pass, never on a cached hash.
 *
 * Pure by construction: it takes bytes and returns a verdict. Reading them is
 * infra's job, which is what keeps the decision exhaustively testable.
 */

/** Where the comparison is structured to yield in a streaming implementation. */
const CHUNK_SIZE = 64 * 1024;

const LF = 0x0a;

export type PrefixVerdict = "prefix" | "divergent" | "not-line-aligned";

export interface PrefixResult {
  readonly verdict: PrefixVerdict;
  /** Byte offset of the first difference. Diagnostic only; absent unless divergent. */
  readonly firstDiffOffset?: number;
}

/**
 * The last line of a JSONL file, classified.
 *
 * A missing trailing newline does *not* mean the file is truncated — a valid
 * JSONL file may simply end without one. Conflating the two would make the
 * plugin refuse to sync perfectly good files, or worse, push half a line.
 */
export type TailState = "lf-terminated" | "complete-no-lf" | "truncated";

/**
 * Cheap verdict from size and content hash alone, before any bytes are read.
 *
 * Equal sizes can never be a strict prefix of one another, so a hash mismatch
 * at equal size is divergence and needs no comparison at all.
 */
export type SignatureVerdict = "identical" | "divergent" | "needs-bytes";

export function compareBySignature(
  left: { readonly size: number; readonly hash: string },
  right: { readonly size: number; readonly hash: string },
): SignatureVerdict {
  if (left.size !== right.size) return "needs-bytes";
  return left.hash === right.hash ? "identical" : "divergent";
}

/**
 * Is `shortBytes` a strict, line-aligned prefix of `longBytes`?
 *
 * Line alignment is part of the question, not an afterthought: a byte prefix
 * that stops mid-record would make the longer side look like a continuation of
 * a record the shorter side never finished, and appending to that produces a
 * file neither machine can parse.
 */
export function comparePrefix(shortBytes: Uint8Array, longBytes: Uint8Array): PrefixResult {
  // 1. A longer "short" side cannot be a prefix of anything shorter.
  if (shortBytes.length > longBytes.length) {
    return { verdict: "divergent", firstDiffOffset: longBytes.length };
  }

  // 2. Empty is a prefix of everything, and needs no line-alignment check:
  //    there is no partial record to be caught in the middle of.
  if (shortBytes.length === 0) return { verdict: "prefix" };

  // 3. Compare, structured in chunks so a streaming implementation has an
  //    obvious place to yield to the main thread.
  for (let start = 0; start < shortBytes.length; start += CHUNK_SIZE) {
    const end = Math.min(start + CHUNK_SIZE, shortBytes.length);
    for (let i = start; i < end; i++) {
      if (shortBytes[i] !== longBytes[i]) {
        return { verdict: "divergent", firstDiffOffset: i };
      }
    }
  }

  // 4. Bytes agree. Now: does the shorter side end on a record boundary?
  if (shortBytes[shortBytes.length - 1] !== LF) {
    return { verdict: "not-line-aligned" };
  }

  return { verdict: "prefix" };
}

/**
 * Classifies the bytes after the final LF (architecture §7.4.1).
 *
 * Step 3 leans on a property of JSON objects: a proper prefix of one is almost
 * never itself valid JSON (`{"a":1` does not parse; `{"a":1}` is already
 * closed). The known exception is a top-level scalar — `123` is a valid prefix
 * of `1234` — which is why a non-object parse result is treated as truncated
 * rather than complete. JSONL records are objects, so this costs nothing real.
 */
export function tailState(bytes: Uint8Array): TailState {
  // An empty file has no partial record in it.
  if (bytes.length === 0) return "lf-terminated";

  const lastLf = lastIndexOfByte(bytes, LF);
  const segment = bytes.subarray(lastLf + 1);
  if (segment.length === 0) return "lf-terminated";

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(segment);
  } catch {
    // Invalid UTF-8 after the last newline means the write was cut mid-character.
    return "truncated";
  }

  try {
    const parsed: unknown = JSON.parse(text);
    const isObject = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
    return isObject ? "complete-no-lf" : "truncated";
  } catch {
    return "truncated";
  }
}

/**
 * May these bytes be pushed over the other side?
 *
 * A truncated tail is never an overwrite source: half a record must not be
 * handed to another machine, which would then treat it as history and append
 * to it. It is still perfectly valid as an overwrite *target* — that is how a
 * partially transferred file gets repaired.
 */
export function canBeOverwriteSource(bytes: Uint8Array): boolean {
  return tailState(bytes) !== "truncated";
}

/**
 * The range of a file that participates in comparison.
 *
 * For a truncated file this stops at the last complete record: the trailing
 * fragment is transfer damage, not content, and comparing it would report
 * divergence between two files that agree on everything real.
 */
export function comparableLength(bytes: Uint8Array): number {
  if (tailState(bytes) !== "truncated") return bytes.length;
  return lastIndexOfByte(bytes, LF) + 1;
}

/**
 * Resolution for a `not-line-aligned` verdict (architecture §7.4.1).
 *
 * If the shorter side's final record is complete and merely lacks its trailing
 * newline, it really is a prefix — the longer side has the same record plus the
 * LF. Otherwise nothing may be overwritten in either direction, and the pass
 * defers with `truncatedTail`.
 *
 * Line endings are never normalised: "\n" and "\r\n" are different bytes and
 * stay different. Rewriting them would change the file's bytes, which is the
 * one thing invariant I3 forbids.
 */
export function resolveNotLineAligned(shortBytes: Uint8Array): "prefix" | "defer-truncated-tail" {
  return tailState(shortBytes) === "complete-no-lf" ? "prefix" : "defer-truncated-tail";
}

function lastIndexOfByte(bytes: Uint8Array, byte: number): number {
  for (let i = bytes.length - 1; i >= 0; i--) {
    if (bytes[i] === byte) return i;
  }
  return -1;
}
