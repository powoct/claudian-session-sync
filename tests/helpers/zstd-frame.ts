/**
 * A real zstd frame holding `content` uncompressed, in raw blocks (RFC 8878
 * §3.1.1.2) — what the `zstd` tool decodes, with the header Codex writes:
 * the content size declared, since rust-v0.151 (`set_pledged_src_size`), or
 * not, as before it.
 *
 * Node 20 has no zstd encoder, and the engine reads nothing past the header,
 * so a frame that does not actually compress is the honest fixture: it is the
 * format, and checked against the reference decoder when written.
 */
export function zstdRawFrame(content: Uint8Array, options: { declareSize?: boolean } = {}): Uint8Array {
  const parts: Uint8Array[] = [Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd)];
  if (options.declareSize ?? true) {
    // Single segment, four-byte content size.
    const size = new Uint8Array(4);
    new DataView(size.buffer).setUint32(0, content.length, true);
    parts.push(Uint8Array.of(0xa0), size);
  } else {
    // No size; a 128 KiB window.
    parts.push(Uint8Array.of(0x00, 0x38));
  }
  const MAX_BLOCK = 128 * 1024;
  let at = 0;
  do {
    const size = Math.min(MAX_BLOCK, content.length - at);
    const header = (size << 3) | (at + size >= content.length ? 1 : 0);
    parts.push(Uint8Array.of(header & 0xff, (header >> 8) & 0xff, (header >> 16) & 0xff), content.subarray(at, at + size));
    at += size;
  } while (at < content.length);

  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
