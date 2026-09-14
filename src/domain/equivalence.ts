/**
 * The same records, written in a different member order (ADR-75).
 *
 * Codex serialises a rollout record's `changes` map from a Rust
 * `HashMap<PathBuf, FileChange>` with a derived `Serialize`, and Rust seeds a
 * HashMap's iteration order randomly per process. So when two machines each
 * migrate the same legacy rollout, every turn that touched more than one file
 * comes out with its object members in a different order: same length, same
 * line count, same records, different bytes.
 *
 * The engine compared bytes, called that a divergence, and quarantined it. Then
 * each machine's user pressed "keep mine", which published their variant and
 * made the other machine disagree — a ping-pong with no end, measured across
 * ten sessions on 2026-09-14. Nobody was wrong: both versions really are the
 * conversation, and there is nothing to choose between them.
 *
 * ## What this refuses to forgive
 *
 * Only member order, and only within a line. Everything else is a divergence:
 *
 *  - **Scalars are compared as written.** The canonical form copies numbers,
 *    strings, booleans and nulls *verbatim from the source slice* rather than
 *    re-rendering them. A `JSON.parse` round trip would fold
 *    `{"n":12345678901234567890}` and `…891` onto one IEEE double — same
 *    length, same canonical text — and this function would then authorise
 *    overwriting one record with a different one. Verbatim text cannot.
 *  - **Duplicate keys fail the line.** `{"a":1,"a":2}` and `{"a":2,"a":1}` sort
 *    to the same member list and mean different things, so last-wins would make
 *    the refusal depend on luck.
 *  - **A moved newline fails.** If a differing byte is an LF on either side the
 *    records have been re-cut, and every later byte offset has shifted. That
 *    matters beyond this function: Codex indexes its paginated history by byte
 *    offset, so "every record still starts where it started" is a promise made
 *    to a file this plugin does not own.
 *  - **Anything unparseable.** Unreadable is never equivalent.
 *
 * Structural whitespace is normalised. That is the only other thing forgiven,
 * and it follows from comparing a canonical rendering at all.
 *
 * Pure and Node-free, like `merge-policy.ts` beside it. Who may *ask* — which
 * provider, which merge mode, which size — is the engine's business and is
 * decided at the call site; this file only answers about bytes.
 */

const LF = 0x0a;
/** The chunk the byte scan walks, matching `comparePrefix`'s idiom. */
const CHUNK = 64 * 1024;

export type EquivalenceVerdict = "equivalent" | "divergent";

/**
 * Are these two byte-different files the same JSONL records?
 *
 * Equal length is a precondition, not an optimisation: a key permutation
 * preserves length exactly, so anything else is already a real difference. The
 * scan then visits only the bytes that actually differ, and canonicalises only
 * the lines that contain one — four lines out of 5722 in the measured case.
 */
export function compareRecordwise(a: Uint8Array, b: Uint8Array): EquivalenceVerdict {
  if (a.length !== b.length) return "divergent";

  let from = 0;
  for (;;) {
    const at = nextDifference(a, b, from);
    if (at === -1) return "equivalent";
    // A newline that moved re-cuts the records, and every byte offset after it
    // shifts. The line-length comparison below already refuses this on its own
    // — a side whose differing byte is an LF ends its line here and the other
    // does not — so this is the promise stated where a reader looks for it,
    // not a second check. It is the promise the whole function rests on:
    // Codex indexes its paginated history by byte offset, and "every record
    // still starts where it started" is what lets this authorise a write into
    // a file the plugin does not own.
    if (a[at] === LF || b[at] === LF) return "divergent";

    // Every byte before `at` is equal, so the line start is shared.
    const start = lineStart(a, at);
    const endA = lineEnd(a, at);
    const endB = lineEnd(b, at);
    if (endA !== endB) return "divergent";

    let left: string;
    let right: string;
    try {
      left = canonicalLine(decodeUtf8(a.subarray(start, endA)));
      right = canonicalLine(decodeUtf8(b.subarray(start, endB)));
    } catch {
      return "divergent";
    }
    if (left !== right) return "divergent";

    from = endA + 1;
    if (from >= a.length) return "equivalent";
  }
}

/** First index at or after `from` where the two differ, or -1. */
function nextDifference(a: Uint8Array, b: Uint8Array, from: number): number {
  for (let base = from; base < a.length; base += CHUNK) {
    const end = Math.min(base + CHUNK, a.length);
    for (let i = base; i < end; i += 1) {
      if (a[i] !== b[i]) return i;
    }
  }
  return -1;
}

function lineStart(bytes: Uint8Array, at: number): number {
  for (let i = at; i > 0; i -= 1) {
    if (bytes[i - 1] === LF) return i;
  }
  return 0;
}

function lineEnd(bytes: Uint8Array, at: number): number {
  for (let i = at; i < bytes.length; i += 1) {
    if (bytes[i] === LF) return i;
  }
  return bytes.length;
}

/** Throws on malformed input, which the caller reads as "not equivalent". */
function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/**
 * One JSONL line → a canonical rendering, or a throw.
 *
 * Hand-rolled rather than `JSON.parse` + `JSON.stringify`, and the reason is
 * the whole safety argument: every scalar is copied out of the source text
 * unchanged, so two numbers that differ beyond a double's precision stay
 * different. A parse-based version loses exactly that and would authorise a
 * write between two genuinely different records.
 *
 * Only the top level being an object is accepted — that is what every rollout
 * record is, and a bare array or scalar is not a shape worth reasoning about.
 */
export function canonicalLine(text: string): string {
  const scanner = new Scanner(text);
  scanner.skipWhitespace();
  if (scanner.peek() !== "{") throw new SyntaxError("line is not a JSON object");
  const rendered = scanner.value();
  scanner.skipWhitespace();
  if (!scanner.done()) throw new SyntaxError("trailing content after the record");
  return rendered;
}

class Scanner {
  private at = 0;

  constructor(private readonly text: string) {}

  done(): boolean {
    return this.at >= this.text.length;
  }

  peek(): string {
    if (this.done()) throw new SyntaxError("unexpected end of line");
    return this.text[this.at] as string;
  }

  skipWhitespace(): void {
    while (this.at < this.text.length && " \t\n\r".includes(this.text[this.at] as string)) {
      this.at += 1;
    }
  }

  /** Renders the value at the cursor, canonically, and advances past it. */
  value(): string {
    this.skipWhitespace();
    const c = this.peek();
    if (c === "{") return this.object();
    if (c === "[") return this.array();
    if (c === '"') return this.rawString();
    return this.scalar();
  }

  private object(): string {
    this.expect("{");
    const members: Array<{ key: string; rendered: string }> = [];
    const seen = new Set<string>();
    this.skipWhitespace();
    if (this.peek() === "}") {
      this.at += 1;
      return "{}";
    }
    for (;;) {
      this.skipWhitespace();
      const key = this.rawString();
      // Refused outright. Last-wins would make `{"a":1,"a":2}` and
      // `{"a":2,"a":1}` compare equal by the order they happen to arrive in.
      if (seen.has(key)) throw new SyntaxError("duplicate key");
      seen.add(key);
      this.skipWhitespace();
      this.expect(":");
      members.push({ key, rendered: this.value() });
      this.skipWhitespace();
      const next = this.peek();
      this.at += 1;
      if (next === "}") break;
      if (next !== ",") throw new SyntaxError("expected , or } in object");
    }
    // Sorted by the key's raw text — the one thing this function forgives.
    members.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
    return `{${members.map((m) => `${m.key}:${m.rendered}`).join(",")}}`;
  }

  private array(): string {
    this.expect("[");
    const items: string[] = [];
    this.skipWhitespace();
    if (this.peek() === "]") {
      this.at += 1;
      return "[]";
    }
    for (;;) {
      items.push(this.value());
      this.skipWhitespace();
      const next = this.peek();
      this.at += 1;
      if (next === "]") break;
      if (next !== ",") throw new SyntaxError("expected , or ] in array");
    }
    // Array order is meaning, never formatting — preserved.
    return `[${items.join(",")}]`;
  }

  /** The string exactly as written, escapes and all. */
  private rawString(): string {
    const start = this.at;
    this.expect('"');
    for (;;) {
      const c = this.peek();
      this.at += 1;
      if (c === "\\") {
        if (this.done()) throw new SyntaxError("unterminated escape");
        this.at += 1;
        continue;
      }
      if (c === '"') return this.text.slice(start, this.at);
    }
  }

  /** A number, `true`, `false` or `null` — copied verbatim from the source. */
  private scalar(): string {
    const start = this.at;
    while (this.at < this.text.length && !',]}  \t\n\r'.includes(this.text[this.at] as string)) {
      this.at += 1;
    }
    const raw = this.text.slice(start, this.at);
    if (raw.length === 0) throw new SyntaxError("empty value");
    if (raw === "true" || raw === "false" || raw === "null") return raw;
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)) {
      throw new SyntaxError(`not a JSON scalar: ${raw}`);
    }
    return raw;
  }

  private expect(c: string): void {
    if (this.peek() !== c) throw new SyntaxError(`expected ${c}`);
    this.at += 1;
  }
}
