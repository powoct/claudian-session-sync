/**
 * The sync directory's own metadata (architecture §5.3, §5.4, §9.6) — store (c).
 *
 * Everything here is written by other machines and moved by a tool this plugin
 * does not control, so §5.6 rule 3 applies without exception: **nothing read
 * from this directory may authorise a destructive act.** What it can do is
 * make the pass more conservative, and identify which directory this is.
 *
 * Hence the asymmetry that looks odd until you name the failure behind each
 * half. `manifest.json` is a cache: unreadable means rebuild, and losing it
 * costs a slow pass. `root.json` is the directory's identity: unreadable means
 * *stop*, because rebuilding it would destroy the anchor the other machine uses
 * to recognise this directory, and a rebuilt-from-nothing rootId is exactly
 * what a cloud drive rolling the folder back would produce.
 *
 * Every path written here goes through `resolveUnderRoot`, not `mintStatePath`.
 * The home directory is ours and its layout is constructed; this one is
 * untrusted, so the per-level symlink walk is the point.
 */
import type { Result, SafeAbsolutePath } from "../domain/types";
import {
  type Manifest,
  type ManifestLoad,
  MANIFEST_SCHEMA_VERSION,
  emptyManifest,
  parseManifest,
  serialiseManifest,
} from "../domain/manifest";
import type { Counts, ReadinessObservation } from "../domain/readiness";
import type { FsGateway } from "./fs-gateway";
import { type PathGuardDeps, isTransferArtifact, resolveUnderRoot } from "./path-guard";
import { createJsonExclusive, readJson, writeJson } from "./json-file";

/** The neutral layout version this build understands (§5.4). */
export const SUPPORTED_FORMAT_VERSION = 1;

export const AISS_DIR = ".aiss";
export const ROOT_FILE = "root.json";
export const MANIFEST_FILE = "manifest.json";

/**
 * Recognises a file we wrote, so `root.json` is not mistaken for a session.
 *
 * Deliberately still the plugin's original name after the rename to
 * "Claudian Session Sync": this string is wire format, stamped into every
 * initialised sync directory, and changing it would make each of them read as
 * "not the folder this vault was set up with" (NR-2) for zero benefit.
 */
const MAGIC = "ai-session-sync";

export interface RootFile {
  readonly magic: string;
  readonly formatVersion: number;
  readonly rootId: string;
  readonly createdAt: string;
  readonly createdBy: {
    readonly machineId: string;
    readonly label: string;
    readonly platform: string;
  };
  /** Set only while a §5.4 layout migration is in flight. */
  readonly migration: unknown;
}

export interface WorkspaceScan {
  counts: Counts;
  /** Paths relative to the workspace subtree that currently hold zero bytes. */
  zeroByteRels: string[];
}

export interface SyncDirStoreDeps {
  readonly fs: FsGateway;
  readonly guard: PathGuardDeps;
  readonly joinPath: (...parts: string[]) => string;
  /** The sync directory, already realpath'd. */
  readonly syncDirRoot: string;
}

export interface SyncDirStore {
  /** Is the directory there at all? False is NR-9, not "it is empty". */
  reachable(): Promise<boolean>;
  readRoot(): Promise<ReadinessObservation["root"]>;
  /**
   * Creates `root.json`, exclusively. Losing the race is a normal outcome:
   * another machine initialised the same directory a moment earlier, and its
   * rootId is the one that counts.
   */
  initialise(file: RootFile): Promise<{ readonly ok: boolean; readonly reason?: string }>;
  /** Writes and deletes a probe file, proving the directory takes writes. */
  probeWritable(machineId: string): Promise<boolean>;
  /**
   * Walks one workspace subtree once, for everything readiness needs.
   *
   * One walk rather than two because the zero-byte list and the counts are
   * both readings of the same directory at the same moment; taking them
   * separately would let a file change between them and put the shrink
   * detector and the regression detector into disagreement.
   */
  scanWorkspace(workspaceId: string): Promise<WorkspaceScan>;
  isEmpty(): Promise<boolean>;
  workspaceSubtreeExists(workspaceId: string): Promise<boolean>;
  loadManifest(): Promise<ManifestLoad>;
  saveManifest(manifest: Manifest, nowIso: string): Promise<void>;
  resolve(rel: string): Promise<Result<SafeAbsolutePath>>;
}

export function createSyncDirStore(deps: SyncDirStoreDeps): SyncDirStore {
  const rootFilePath = deps.joinPath(deps.syncDirRoot, AISS_DIR, ROOT_FILE);
  const manifestPath = deps.joinPath(deps.syncDirRoot, AISS_DIR, MANIFEST_FILE);

  async function mint(rel: string): Promise<SafeAbsolutePath | null> {
    const resolved = await resolveUnderRoot(deps.guard, deps.syncDirRoot, rel);
    return resolved.ok ? resolved.value : null;
  }

  return {
    async reachable() {
      const st = await deps.fs.lstat(deps.syncDirRoot);
      return st !== null && st.isDirectory;
    },

    async readRoot() {
      const load = await readJson(deps.fs, rootFilePath);
      if (load.status === "absent") return { status: "missing" };
      // Unreadable is *not* missing. "Missing plus an empty directory" is the
      // one path that offers to initialise, and a permissions error must never
      // reach it.
      if (load.status === "unusable") return { status: "corrupt" };

      const raw = load.raw;
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { status: "corrupt" };
      const c = raw as Partial<RootFile>;
      if (c.magic !== MAGIC) return { status: "corrupt" };
      if (typeof c.formatVersion !== "number" || !Number.isFinite(c.formatVersion)) {
        return { status: "corrupt" };
      }
      if (typeof c.rootId !== "string" || c.rootId.length === 0) return { status: "corrupt" };
      return { status: "ok", rootId: c.rootId, formatVersion: c.formatVersion };
    },

    async initialise(file) {
      const dir = await mint(AISS_DIR);
      const target = await mint(`${AISS_DIR}/${ROOT_FILE}`);
      if (!dir || !target) return { ok: false, reason: "path-rejected" };
      const created = await createJsonExclusive(deps.fs, target, file, dir);
      return created.ok ? { ok: true } : { ok: false, reason: created.reason };
    },

    async probeWritable(machineId) {
      const dir = await mint(AISS_DIR);
      // The probe name carries the machine id so two machines probing at once
      // do not collide and read each other's failure as their own.
      const probe = await mint(`${AISS_DIR}/.probe-${sanitiseId(machineId)}`);
      if (!dir || !probe) return false;
      try {
        await deps.fs.mkdirp(dir);
        await deps.fs.writeFileAtomic(probe, new Uint8Array(0));
        return true;
      } catch {
        return false;
      } finally {
        await deps.fs.removeFile(probe).catch(() => undefined);
      }
    },

    async scanWorkspace(workspaceId) {
      const base = deps.joinPath(deps.syncDirRoot, workspaceId);
      const scan: WorkspaceScan = { counts: { files: 0, bytes: 0 }, zeroByteRels: [] };
      await walk(deps, base, "", scan);
      return scan;
    },

    async isEmpty() {
      const entries = await deps.fs.readDir(deps.syncDirRoot).catch(() => null);
      if (entries === null) return false; // Unreadable is not empty.
      // A directory holding only noise has not received anything yet. This is
      // only ever asked when `root.json` is absent, which is why `.aiss/`
      // counts as noise here: an empty one is what our own write probe leaves
      // behind, and treating it as content would wedge the user out of the one
      // screen that lets them initialise.
      return entries.every((entry) => isNotContent(entry.name));
    },

    async workspaceSubtreeExists(workspaceId) {
      const st = await deps.fs.lstat(deps.joinPath(deps.syncDirRoot, workspaceId));
      return st !== null && st.isDirectory;
    },

    async loadManifest() {
      const load = await readJson(deps.fs, manifestPath);
      if (load.status === "absent") return { status: "rebuild", reason: "absent" };
      if (load.status === "unusable") return { status: "rebuild", reason: load.reason };
      return parseManifest(load.raw);
    },

    async saveManifest(manifest, nowIso) {
      const dir = await mint(AISS_DIR);
      const target = await mint(`${AISS_DIR}/${MANIFEST_FILE}`);
      if (!dir || !target) return;
      await writeJson(deps.fs, target, serialiseManifest(manifest, nowIso), dir);
    },

    resolve(rel) {
      return resolveUnderRoot(deps.guard, deps.syncDirRoot, rel);
    },
  };
}

export function newRootFile(input: {
  readonly rootId: string;
  readonly nowIso: string;
  readonly machineId: string;
  readonly label: string;
  readonly platform: string;
}): RootFile {
  return {
    magic: MAGIC,
    formatVersion: SUPPORTED_FORMAT_VERSION,
    rootId: input.rootId,
    createdAt: input.nowIso,
    createdBy: { machineId: input.machineId, label: input.label, platform: input.platform },
    migration: null,
  };
}

export function manifestOrEmpty(load: ManifestLoad, nowIso: string): Manifest {
  return load.status === "ok" || load.status === "migrate"
    ? load.manifest
    : emptyManifest(nowIso);
}

/** A manifest from a newer schema is read as nothing and never written back. */
export function manifestIsWritable(load: ManifestLoad): boolean {
  return load.status !== "unusable";
}

export function manifestSchemaVersion(): number {
  return MANIFEST_SCHEMA_VERSION;
}

/**
 * Walks a workspace subtree, counting and noting which files are empty.
 *
 * Transfer artifacts are excluded: a `.dropbox.cache` directory appearing or
 * vanishing is the sync tool breathing, and letting it move the numbers would
 * make the shrink detector fire on its own noise.
 *
 * The zero-byte list is what NR-8 needs. A file that used to have content and
 * is now empty is the loudest single signal that the sync tool is misbehaving
 * — a placeholder, an interrupted transfer, a rollback — and it is worth
 * detecting before the pass starts rather than one file at a time inside it.
 */
async function walk(
  deps: SyncDirStoreDeps,
  dir: string,
  prefix: string,
  into: { counts: Counts; zeroByteRels: string[] },
): Promise<void> {
  const entries = await deps.fs.readDir(dir).catch(() => []);
  for (const entry of entries) {
    if (isTransferArtifact(entry.name)) continue;
    const child = deps.joinPath(dir, entry.name);
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory) {
      await walk(deps, child, rel, into);
      continue;
    }
    if (!entry.isFile) continue;
    const st = await deps.fs.lstat(child);
    if (st === null) continue;
    into.counts = { files: into.counts.files + 1, bytes: into.counts.bytes + st.size };
    if (st.size === 0) into.zeroByteRels.push(rel);
  }
}

/**
 * Names that are not evidence the directory holds anything.
 *
 * OS metadata belongs here for a concrete reason: a folder the user just made
 * in Finder already contains `.DS_Store`, and calling that "not empty" would
 * turn every fresh sync directory on macOS into NR-1 instead of the screen
 * that offers to initialise it.
 */
const OS_NOISE = new Set([".ds_store", "thumbs.db", "desktop.ini", ".localized", AISS_DIR]);

function isNotContent(name: string): boolean {
  return OS_NOISE.has(name.toLowerCase()) || isTransferArtifact(name);
}

/** Machine ids are UUIDs, but a probe filename must not trust that. */
function sanitiseId(machineId: string): string {
  return machineId.replace(/[^A-Za-z0-9-]/g, "").slice(0, 36) || "unknown";
}
