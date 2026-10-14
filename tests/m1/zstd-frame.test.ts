/**
 * ADR-83: the uncompressed size a zstd frame header declares.
 *
 * The headers below are the first 18 bytes of frames the `zstd` command-line
 * tool wrote (v1.5), so the parser is checked against an encoder rather than
 * against its own reading of the format.
 */
import { describe, expect, it } from "vitest";
import { ZSTD_FRAME_HEADER_MAX_BYTES, zstdFrameContentSize } from "../../src/providers/codex/zstd-frame";
import { zstdRawFrame } from "../helpers/zstd-frame";

const hex = (text: string) => Uint8Array.from(text.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));

describe("the size a zstd frame declares", () => {
  it.each([
    ["one byte, single segment", "28b52ffd24010900007823110483", 1],
    ["one byte, single segment, 200", "28b52ffd24c8410600e721d1f6f48091b4a0", 200],
    ["two bytes, offset by 256", "28b52ffd64b0039d0000606865", 1200],
    ["four bytes, with a checksum", "28b52ffda4a086010001350c48d4a9cc58a2", 100_000],
    ["four bytes, without one", "28b52ffda0a086010055000010000001009b", 100_000],
    // Not single segment: a window byte before the size — the shape the
    // streaming encoder gives a large rollout (`zstd --stream-size`).
    ["four bytes after a window byte (a 9 MB rollout)", "28b52ffd845840548900000010fba09f633d", 9_000_000],
    ["two bytes, from the streaming encoder", "28b52ffd642c004d00001030300100272ac0", 300],
  ])("reads %s", (_shape, header, size) => {
    expect(zstdFrameContentSize(hex(header))).toBe(size);
  });

  it("says nothing for a frame that declares no size, as Codex before 0.152 wrote them", () => {
    // `zstd --no-content-size`: descriptor 0x04, then a window byte.
    expect(zstdFrameContentSize(hex("28b52ffd04089d0000606865"))).toBeNull();
  });

  it("says nothing for anything that is not the start of a zstd frame", () => {
    expect(zstdFrameContentSize(new TextEncoder().encode('{"type":"session_meta"}\n'))).toBeNull();
    // A skippable frame first is valid zstd, and not a shape Codex writes.
    expect(zstdFrameContentSize(hex("502a4d1804000000"))).toBeNull();
    expect(zstdFrameContentSize(new Uint8Array(0))).toBeNull();
    // Reserved bit set.
    expect(zstdFrameContentSize(hex("28b52ffda8a0860100"))).toBeNull();
  });

  it("says nothing when the header is cut short of the size field", () => {
    expect(zstdFrameContentSize(hex("28b52ffda4a08601"))).toBeNull();
    expect(zstdFrameContentSize(hex("28b52ffd24"))).toBeNull();
  });

  it("skips a dictionary id and a window byte to find the size", () => {
    // Not single segment (window byte present), four-byte dictionary id,
    // eight-byte size.
    const header = hex("28b52ffd" + "c3" + "38" + "efbeadde" + "0100000001000000");
    expect(header.length).toBe(ZSTD_FRAME_HEADER_MAX_BYTES);
    expect(zstdFrameContentSize(header)).toBe(2 ** 32 + 1);
  });

  it("reads the frames the test fixtures write", () => {
    const content = new TextEncoder().encode("x".repeat(300_000));
    expect(zstdFrameContentSize(zstdRawFrame(content).subarray(0, ZSTD_FRAME_HEADER_MAX_BYTES))).toBe(300_000);
    expect(zstdFrameContentSize(zstdRawFrame(content, { declareSize: false }))).toBeNull();
  });
});
