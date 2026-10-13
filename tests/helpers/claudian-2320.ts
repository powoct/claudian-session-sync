/**
 * What Claudian 2.3.20 does to `.claudian/sessions`, on a test harness's vault.
 *
 * The existing fixtures write records the way Claudian 2.2.x did: indented,
 * with deletion as a tombstone beside the record. Claudian 2.3.3 (#1386)
 * stopped writing markers and 2.3.6 stopped indenting, and the tests that
 * pinned the old behaviour stayed green across both changes — a fixture that
 * models the past cannot notice the present. Every helper here is a line-for-
 * line reading of the upstream code it names (Claudian HEAD 48434077, 2.3.20).
 *
 * Ids must look like Claudian's (`conv-<ms>-<base36>`): the records provider
 * rejects anything else, so the `conv-fake-*` names the admission fixtures use
 * would test nothing here.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import type { RuntimeHarness } from "./runtime-harness";

export type Layer = "flat" | { readonly device: string };

export const store = (machine: RuntimeHarness): string =>
  path.join(machine.vaultRoot, ".claudian", "sessions");

function folder(machine: RuntimeHarness, layer: Layer): string {
  return layer === "flat" ? store(machine) : path.join(store(machine), "devices", layer.device);
}

/** `ConversationPersistenceStore.saveMetadata`: compact JSON, no newline (0868909f). */
export async function saveRecord(
  machine: RuntimeHarness,
  conv: string,
  body: Record<string, unknown>,
  layer: Layer = "flat",
): Promise<void> {
  const dir = folder(machine, layer);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `${conv}.meta.json`), JSON.stringify({ id: conv, ...body }));
}

/**
 * `ConversationRepository.delete` → `deleteCurrentMetadata(id, target)`: the
 * one meta file in the target layer, and nothing else. No marker, no legacy
 * copy (0e72a8ed). Claudian's own automatic delete (R2) is the same call.
 */
export async function deleteRecord(machine: RuntimeHarness, conv: string, layer: Layer = "flat"): Promise<void> {
  await fsp.rm(path.join(folder(machine, layer), `${conv}.meta.json`), { force: true });
}

/**
 * `assignMetadataToDevice`: throws where upstream throws, then a plain rename
 * from the flat layer into the device folder. No fence.
 */
export async function assignToDevice(machine: RuntimeHarness, conv: string, device: string): Promise<void> {
  const source = path.join(store(machine), `${conv}.meta.json`);
  const targetDir = path.join(store(machine), "devices", device);
  const target = path.join(targetDir, `${conv}.meta.json`);
  if (await exists(target)) throw new Error(`Cannot assign ${conv}: device metadata already exists`);
  if (!(await exists(source))) throw new Error(`Cannot assign ${conv}: unscoped metadata is missing`);
  await fsp.mkdir(targetDir, { recursive: true });
  await fsp.rename(source, target);
}

/**
 * `migrateSessionSidecars` (C:src/app/storage/migrateSessionSidecars.ts), run
 * at every launch with no completion marker.
 *
 * One recursive listing, then the `.assigned` pass, then the `.deleted` pass
 * over the same listing — including other devices' folders. Returns the
 * `.inputs.json` paths for the deferred cleanup, which upstream runs after
 * layout-ready (`layoutReadyCleanup`).
 */
export async function launch(machine: RuntimeHarness): Promise<string[]> {
  const root = store(machine);
  const files = await listRecursive(root);
  const legacy = path.join(machine.vaultRoot, ".claude", "sessions");
  for (const file of files) {
    if (!file.endsWith(".assigned.json")) continue;
    const id = path.basename(file).slice(0, -".assigned.json".length);
    type Assignment = { schemaVersion?: unknown; conversationId?: unknown; deviceKey?: unknown };
    const assignment = await fsp
      .readFile(file, "utf8")
      .then((text) => JSON.parse(text) as Assignment | null)
      .catch(() => null);
    if (
      !assignment ||
      assignment.schemaVersion !== 1 ||
      assignment.conversationId !== id ||
      typeof assignment.deviceKey !== "string" ||
      !/^device-[a-f0-9]{64}$/.test(assignment.deviceKey)
    ) {
      await fsp.rm(file, { force: true });
      continue;
    }
    const source = path.join(root, `${id}.meta.json`);
    const targetDir = path.join(root, "devices", assignment.deviceKey);
    const target = path.join(targetDir, `${id}.meta.json`);
    if (await exists(source)) {
      if (await exists(target)) await fsp.rm(source, { force: true });
      else {
        await fsp.mkdir(targetDir, { recursive: true });
        await fsp.rename(source, target);
      }
    }
    await fsp.rm(path.join(legacy, `${id}.meta.json`), { force: true });
    await fsp.rm(file, { force: true });
  }
  for (const file of files) {
    if (!file.endsWith(".deleted.json")) continue;
    const id = path.basename(file).slice(0, -".deleted.json".length);
    const dir = path.dirname(file);
    await fsp.rm(path.join(dir, `${id}.meta.json`), { force: true });
    if (dir === root) await fsp.rm(path.join(legacy, `${id}.meta.json`), { force: true });
    await fsp.rm(file, { force: true });
  }
  return files.filter((file) => file.endsWith(".inputs.json"));
}

/** `SharedStorageService.cleanupObsoleteSessionInputs`, one file at a time. */
export async function layoutReadyCleanup(list: readonly string[]): Promise<void> {
  for (const file of list) await fsp.rm(file, { force: true });
}

/**
 * Claudian 2.3.2 and older: `markDeleted` writes an indented tombstone in the
 * target layer, then the record is removed. Only for mixed-version tests.
 */
export async function legacyPeerDelete(machine: RuntimeHarness, conv: string, layer: Layer = "flat"): Promise<void> {
  const dir = folder(machine, layer);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(
    path.join(dir, `${conv}.deleted.json`),
    JSON.stringify({ schemaVersion: 1, conversationId: conv, deletedAt: 1 }, null, 2),
  );
  await deleteRecord(machine, conv, layer);
}

/** What Claudian 2.3.6+ lists: this device's folder first, then the flat layer. Legacy is ignored. */
export async function visibleToClaudian(machine: RuntimeHarness, device: string | null): Promise<string[]> {
  const ids = new Set<string>();
  const dirs = [...(device ? [path.join(store(machine), "devices", device)] : []), store(machine)];
  for (const dir of dirs) {
    for (const name of await fsp.readdir(dir).catch(() => [])) {
      if (name.endsWith(".meta.json")) ids.add(name.slice(0, -".meta.json".length));
    }
  }
  return [...ids].sort();
}

/** `InactiveSessionArchiver`: a rewrite nobody asked for. */
export async function autoArchiveRewrite(machine: RuntimeHarness, conv: string): Promise<void> {
  const target = path.join(store(machine), `${conv}.meta.json`);
  const body = JSON.parse(await fsp.readFile(target, "utf8")) as Record<string, unknown>;
  await fsp.writeFile(target, JSON.stringify({ ...body, isArchived: true, isPinned: false }));
}

async function listRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listRecursive(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

async function exists(target: string): Promise<boolean> {
  return (await fsp.lstat(target).catch(() => null)) !== null;
}
