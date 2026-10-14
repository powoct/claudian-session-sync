/**
 * Is a session on this machine in its CLI's compressed form (ADR-83)?
 *
 * One answer for every place that has to act on it — the engine, which then
 * keeps the sync folder's copy from landing beside it; a restore, which would
 * put an old version in front of it; the conflict panel, which has nothing
 * here to keep; and the audit, which says where the session is. Four copies of
 * the question were how ADR-79's archive check came to miss the compressed
 * archive, and ADR-83's first cut to miss compression in place outside the
 * engine.
 */
import type { FileStat, FsGateway } from "../infra/fs-gateway";
import type { ProviderAdapter } from "../providers/provider-adapter";

export type CompressedLook =
  /** Something is at the target, or the provider compresses nothing. */
  | { readonly kind: "none" }
  /** Nothing at the target, and a regular file where its compressed form goes. */
  | { readonly kind: "compressed"; readonly path: string; readonly stat: FileStat }
  /**
   * Nothing at the target, and its compressed form could not be asked about.
   * A caller about to write treats this as compressed; one that only
   * describes treats it as not.
   */
  | { readonly kind: "unknown"; readonly path: string };

export async function lookForCompressed(
  fs: Pick<FsGateway, "lstat">,
  adapter: Pick<ProviderAdapter, "compressedSiblingOf">,
  target: string,
): Promise<CompressedLook> {
  const path = adapter.compressedSiblingOf?.(target) ?? null;
  if (path === null) return { kind: "none" };
  try {
    if ((await fs.lstat(target)) !== null) return { kind: "none" };
  } catch {
    // The target itself cannot be asked about; whoever reads it next finds
    // that out for themselves, as they did before compression was a shape.
    return { kind: "none" };
  }
  try {
    const stat = await fs.lstat(path);
    return stat !== null && stat.isFile ? { kind: "compressed", path, stat } : { kind: "none" };
  } catch {
    return { kind: "unknown", path };
  }
}
