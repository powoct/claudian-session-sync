/**
 * The uncompressed size a zstd frame header declares (ADR-83).
 *
 * Codex writes it into every rollout it compresses — `set_pledged_src_size`
 * with the plain file's length, since rust-v0.152 (codex-rs
 * `rollout/src/compression.rs`) — and reads it back itself to bound a prefix
 * without decoding (`seekable_reader.rs`, `rollout_contains_prefix`). Here it
 * answers the one question ADR-83 needs about a compressed rollout without a
 * decoder: how long was the file Codex compressed?
 *
 * Only the frame header is parsed (RFC 8878 §3.1.1.1), never a block: the
 * magic number, the descriptor byte, then the optional window, dictionary id
 * and content-size fields. Anything that is not a plain zstd frame with a
 * declared size — a skippable frame first, a reserved bit set, a frame from an
 * older Codex that declared none, a header cut short — is null, and null means
 * "cannot tell", never a size.
 */

/** Magic number, then a header of at most 14 more bytes. */
export const ZSTD_FRAME_HEADER_MAX_BYTES = 18;

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd] as const;
const DICTIONARY_ID_BYTES = [0, 1, 2, 4] as const;

export function zstdFrameContentSize(header: Uint8Array): number | null {
  if (header.length < 5) return null;
  for (let i = 0; i < ZSTD_MAGIC.length; i++) if (header[i] !== ZSTD_MAGIC[i]) return null;

  const descriptor = header[4] as number;
  if ((descriptor & 0x08) !== 0) return null; // Reserved bit: not a frame this parser knows.
  const sizeFlag = descriptor >> 6;
  const singleSegment = (descriptor & 0x20) !== 0;
  const sizeBytes = sizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << sizeFlag;
  if (sizeBytes === 0) return null; // Declared nothing.

  const at = 5 + (singleSegment ? 0 : 1) + (DICTIONARY_ID_BYTES[descriptor & 0x03] as number);
  if (header.length < at + sizeBytes) return null;
  let size = 0;
  for (let i = sizeBytes - 1; i >= 0; i--) size = size * 256 + (header[at + i] as number);
  // The two-byte form is offset by 256 (RFC 8878 §3.1.1.1.4).
  if (sizeBytes === 2) size += 256;
  return Number.isSafeInteger(size) ? size : null;
}
