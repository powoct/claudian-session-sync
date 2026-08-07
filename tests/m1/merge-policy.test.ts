/**
 * testing.md §5.3 — prefix and tail-segment logic.
 *
 * This is the module that decides whether one machine's file may overwrite the
 * other's, so the cases here are the ones that would silently destroy a
 * conversation branch if the rule were "more lines wins": a fork, and two files
 * of equal size with different content.
 */
import { describe, expect, it } from "vitest";
import {
  canBeOverwriteSource,
  endsWithNewline,
  compareBySignature,
  comparableLength,
  comparePrefix,
  resolveNotLineAligned,
  tailState,
} from "../../src/domain/merge-policy";

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A JSONL record, the shape everything here actually deals with. */
const rec = (n: number): string => `{"uuid":"r${n}","type":"user"}\n`;
const lines = (count: number): string =>
  Array.from({ length: count }, (_, i) => rec(i + 1)).join("");

describe("comparePrefix", () => {
  it("calls identical files a prefix", () => {
    const bytes = enc(lines(3));
    expect(comparePrefix(bytes, bytes).verdict).toBe("prefix");
  });

  it("calls an empty file a prefix of anything", () => {
    expect(comparePrefix(enc(""), enc(lines(3))).verdict).toBe("prefix");
  });

  it("calls anything a prefix of itself when both are empty", () => {
    expect(comparePrefix(enc(""), enc("")).verdict).toBe("prefix");
  });

  it("recognises a strict append", () => {
    expect(comparePrefix(enc(lines(3)), enc(lines(9))).verdict).toBe("prefix");
  });

  it("refuses when the shorter argument is actually longer", () => {
    const result = comparePrefix(enc(lines(9)), enc(lines(3)));
    expect(result.verdict).toBe("divergent");
  });

  it("reports divergence at the first line", () => {
    const result = comparePrefix(enc(`{"uuid":"a"}\n`), enc(`{"uuid":"b"}\n`));
    expect(result.verdict).toBe("divergent");
    expect(result.firstDiffOffset).toBe(9);
  });

  it("reports divergence in the last line only", () => {
    const shared = lines(5);
    const result = comparePrefix(enc(shared + rec(6)), enc(shared + rec(7)));
    expect(result.verdict).toBe("divergent");
    expect(result.firstDiffOffset).toBe(shared.length + rec(6).indexOf("6"));
  });

  /**
   * The fork case (U-07), and the reason "more lines wins" was abandoned:
   * both sides share a history and then diverge. Neither may overwrite the
   * other, however many lines each has.
   */
  it("refuses to call a longer fork a prefix", () => {
    const shared = lines(10);
    const left = enc(shared + rec(99));
    const right = enc(shared + rec(50) + rec(51) + rec(52));

    expect(right.length).toBeGreaterThan(left.length);
    expect(comparePrefix(left, right).verdict).toBe("divergent");
  });

  it("treats CRLF and LF as different bytes", () => {
    // Normalising line endings would rewrite the file, which invariant I3
    // forbids outright — so these are simply two different files.
    const result = comparePrefix(enc('{"a":1}\n'), enc('{"a":1}\r\n'));
    expect(result.verdict).toBe("divergent");
  });

  it("stops at a record boundary, not just a byte boundary", () => {
    // The shorter side ends mid-record: the bytes agree, but treating it as a
    // prefix would let the engine append to half a line.
    const result = comparePrefix(enc('{"uuid":"r1","ty'), enc(rec(1)));
    expect(result.verdict).toBe("not-line-aligned");
  });

  it("handles a difference beyond the first chunk", () => {
    // Past 64 KiB, where the chunked comparison would go wrong if the chunk
    // arithmetic were off by one.
    const filler = "x".repeat(70 * 1024);
    const result = comparePrefix(enc(`${filler}A\n`), enc(`${filler}B\n`));
    expect(result.verdict).toBe("divergent");
    expect(result.firstDiffOffset).toBe(filler.length);
  });

  it("compares multi-byte characters by byte, not by code point", () => {
    const base = '{"text":"🎉 中文"}\n';
    expect(comparePrefix(enc(base), enc(base + rec(2))).verdict).toBe("prefix");
    expect(comparePrefix(enc('{"text":"🎉"}\n'), enc('{"text":"🎊"}\n')).verdict).toBe("divergent");
  });
});

describe("compareBySignature — the short circuit before any bytes are read", () => {
  it("calls equal size and equal hash identical", () => {
    expect(compareBySignature({ size: 10, hash: "abc" }, { size: 10, hash: "abc" })).toBe("identical");
  });

  it("calls equal size and different hash divergent without reading", () => {
    // Two files of the same length cannot be a strict prefix of one another,
    // so this needs no byte comparison at all. It is also U-18: same size, same
    // mtime, different content.
    expect(compareBySignature({ size: 10, hash: "abc" }, { size: 10, hash: "def" })).toBe("divergent");
  });

  it("asks for bytes when the sizes differ", () => {
    expect(compareBySignature({ size: 10, hash: "abc" }, { size: 20, hash: "abc" })).toBe("needs-bytes");
  });
});

describe("tailState", () => {
  it("recognises a trailing newline", () => {
    expect(tailState(enc(lines(3)))).toBe("lf-terminated");
  });

  it("treats an empty file as having no partial record", () => {
    expect(tailState(enc(""))).toBe("lf-terminated");
  });

  it("recognises a complete final record with no trailing newline", () => {
    expect(tailState(enc(lines(2) + '{"uuid":"r3"}'))).toBe("complete-no-lf");
  });

  it("recognises a half-written final record", () => {
    expect(tailState(enc(lines(2) + '{"uuid":"r3'))).toBe("truncated");
  });

  it("does not mistake a top-level scalar for a record", () => {
    // The known exception to "a prefix of valid JSON is not valid JSON": 123 is
    // a valid prefix of 1234. JSONL records are objects, so a scalar tail means
    // the write was cut.
    expect(tailState(enc("123"))).toBe("truncated");
    expect(tailState(enc(lines(1) + "123"))).toBe("truncated");
  });

  it("does not mistake an array for a record", () => {
    expect(tailState(enc('[{"uuid":"r1"}]'))).toBe("truncated");
  });

  it("does not mistake a bare string or null for a record", () => {
    expect(tailState(enc('"text"'))).toBe("truncated");
    expect(tailState(enc("null"))).toBe("truncated");
  });

  it("treats a cut multi-byte character as truncated", () => {
    const full = enc('{"t":"中"}');
    const cut = full.subarray(0, full.length - 2);
    expect(tailState(cut)).toBe("truncated");
  });
});

describe("overwrite eligibility (§7.4.1 table)", () => {
  it("allows an lf-terminated file to be a source", () => {
    expect(canBeOverwriteSource(enc(lines(3)))).toBe(true);
  });

  it("allows a complete-no-lf file to be a source", () => {
    expect(canBeOverwriteSource(enc('{"uuid":"r1"}'))).toBe(true);
  });

  it("never lets a truncated file be a source", () => {
    // Pushing half a record means the other machine appends to a line that was
    // never finished; both files are then unparseable.
    expect(canBeOverwriteSource(enc(lines(2) + '{"uuid":"r3'))).toBe(false);
  });

  it("compares a truncated file only up to its last complete record", () => {
    const complete = lines(2);
    const damaged = enc(complete + '{"uuid":"r3');
    expect(comparableLength(damaged)).toBe(complete.length);
  });

  it("compares an intact file over its whole length", () => {
    const bytes = enc(lines(2));
    expect(comparableLength(bytes)).toBe(bytes.length);
  });
});

describe("endsWithNewline — the literal question tailState does not answer", () => {
  it("says no for an empty file, which tailState calls lf-terminated", () => {
    // The one place the two disagree, and the reason this function exists: a
    // batch-3 caller deciding "do I need a separator before appending?" would
    // start the file with a blank line if it read the answer off tailState.
    expect(tailState(enc(""))).toBe("lf-terminated");
    expect(endsWithNewline(enc(""))).toBe(false);
  });

  it("says yes for a file that really ends with LF", () => {
    expect(endsWithNewline(enc(lines(2)))).toBe(true);
  });

  it("says no for a complete record with no trailing LF", () => {
    // Appending without a separator here would weld two records into one
    // unparseable line.
    expect(endsWithNewline(enc('{"uuid":"r1"}'))).toBe(false);
  });

  it("says no for a truncated tail", () => {
    expect(endsWithNewline(enc(lines(1) + '{"uuid":"r2'))).toBe(false);
  });
});

describe("resolveNotLineAligned", () => {
  it("accepts a complete record that merely lacks its newline", () => {
    // Same content, one side missing only the trailing LF: the short side is a
    // strict prefix and the pair converges through an ordinary overwrite.
    expect(resolveNotLineAligned(enc('{"uuid":"r1"}'))).toBe("prefix");
  });

  it("defers on a genuinely half-written record", () => {
    expect(resolveNotLineAligned(enc('{"uuid":"r1'))).toBe("defer-truncated-tail");
  });

  it("converges the missing-newline pair through the normal path", () => {
    const withoutLf = enc('{"uuid":"r1","type":"user"}');
    const withLf = enc(rec(1));

    expect(comparePrefix(withoutLf, withLf).verdict).toBe("not-line-aligned");
    expect(resolveNotLineAligned(withoutLf)).toBe("prefix");
  });
});
