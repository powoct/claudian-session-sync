/**
 * Bundle contract, layers (b) and (c) — load the built bundle against the
 * Obsidian stub and drive its lifecycle (testing.md §12.2b, §12.2c).
 *
 * `node -e "require('./main.js')"` proves nothing here: `obsidian` is external,
 * so a bare require throws MODULE_NOT_FOUND, and catching that only proves the
 * file parses. Instead `Module._load` is hooked so the bundle's own
 * `require("obsidian")` resolves to the stub, and the same hook hands it a
 * recording `fs` — which is how (c) can assert that `onload()` touches no
 * filesystem at all. Obsidian blocks on plugin load, and the sync directory is
 * usually a cloud-drive folder that can stall for seconds.
 */
import { existsSync } from "node:fs";
import * as realFs from "node:fs";
import * as realFsPromises from "node:fs/promises";
import Module from "node:module";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as obsidianStub from "../helpers/obsidian-stub";
import { makeStubApp, makeStubManifest, type Plugin as StubPlugin } from "../helpers/obsidian-stub";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BUNDLE = path.join(REPO_ROOT, "main.js");

/**
 * The UI surface the plugin is expected to register. Written out as a literal on
 * purpose: if a command disappears from main.ts, this test should fail and make
 * someone confirm the removal was intended.
 */
const EXPECTED_COMMAND_IDS = ["sync-now", "dry-run", "show-last-report"];

const FS_READ_METHODS = [
  "readFile",
  "readFileSync",
  "readdir",
  "readdirSync",
  "stat",
  "statSync",
  "lstat",
  "lstatSync",
  "open",
  "openSync",
  "opendir",
  "opendirSync",
  "access",
  "accessSync",
  "exists",
  "existsSync",
  "realpath",
  "realpathSync",
  "createReadStream",
  "readlink",
  "readlinkSync",
] as const;

const fsCalls: Array<{ method: string; target: string }> = [];

function recordingProxy<T extends object>(target: T): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof value === "function" && FS_READ_METHODS.includes(prop as never)) {
        return (...args: unknown[]) => {
          fsCalls.push({ method: String(prop), target: String(args[0]) });
          return (value as (...a: unknown[]) => unknown).apply(obj, args);
        };
      }
      return value;
    },
  });
}

type LoadFn = (request: string, parent: unknown, isMain: boolean) => unknown;
const ModuleInternals = Module as unknown as { _load: LoadFn };
let originalLoad: LoadFn;

/** Timers created by the bundle, so a leak on unload is visible (§12.2b). */
const liveTimers = new Set<unknown>();
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

beforeAll(() => {
  if (!existsSync(BUNDLE)) {
    throw new Error(`missing ${BUNDLE}. Run \`npm run build\` before \`npm run check:bundle\`.`);
  }

  const fsProxy = recordingProxy(realFs);
  const fsPromisesProxy = recordingProxy(realFsPromises);

  originalLoad = ModuleInternals._load;
  ModuleInternals._load = function patchedLoad(request, parent, isMain) {
    if (request === "obsidian") return obsidianStub;
    if (request === "fs" || request === "node:fs") return fsProxy;
    if (request === "fs/promises" || request === "node:fs/promises") return fsPromisesProxy;
    return originalLoad.call(this, request, parent, isMain);
  };

  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const handle = realSetInterval(...args);
    liveTimers.add(handle);
    return handle;
  }) as typeof setInterval;
  globalThis.clearInterval = ((handle: Parameters<typeof clearInterval>[0]) => {
    liveTimers.delete(handle);
    return realClearInterval(handle);
  }) as typeof clearInterval;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const handle = realSetTimeout(...args);
    liveTimers.add(handle);
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: Parameters<typeof clearTimeout>[0]) => {
    liveTimers.delete(handle);
    return realClearTimeout(handle);
  }) as typeof clearTimeout;
});

afterAll(() => {
  ModuleInternals._load = originalLoad;
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  for (const handle of liveTimers) realClearInterval(handle as never);
  liveTimers.clear();
});

afterEach(() => {
  fsCalls.length = 0;
  obsidianStub.Notice.instances.length = 0;
});

function loadBundle(): { default: new (app: unknown, manifest: unknown) => StubPlugin } {
  const requireFromHere = createRequire(import.meta.url);
  const resolved = requireFromHere.resolve(BUNDLE);
  delete requireFromHere.cache[resolved];
  return requireFromHere(BUNDLE) as { default: new (app: unknown, manifest: unknown) => StubPlugin };
}

function instantiate(): StubPlugin {
  const { default: PluginClass } = loadBundle();
  return new PluginClass(makeStubApp(), makeStubManifest());
}

describe("bundle stub smoke (§12.2b)", () => {
  it("exports a Plugin subclass", () => {
    const { default: PluginClass } = loadBundle();

    expect(typeof PluginClass).toBe("function");
    expect(Object.getPrototypeOf(PluginClass)).toBe(obsidianStub.Plugin);
    expect(new PluginClass(makeStubApp(), makeStubManifest())).toBeInstanceOf(obsidianStub.Plugin);
  });

  it("registers exactly the expected UI surface on load", async () => {
    const plugin = instantiate();
    await plugin.onload();

    expect(plugin.commands.map((command) => command.id)).toEqual(EXPECTED_COMMAND_IDS);
    for (const command of plugin.commands) {
      expect(command.name, `command ${command.id} has no display name`).toBeTruthy();
    }
    expect(plugin.ribbonIcons).toHaveLength(1);
    expect(plugin.statusBarItems).toHaveLength(1);
    expect(plugin.statusBarItems[0]?.textContent).toBeTruthy();
    expect(plugin.settingTabs).toHaveLength(1);
    expect(plugin.settingTabs[0]).toBeInstanceOf(obsidianStub.PluginSettingTab);
  });

  it("leaves no live timers after unload", async () => {
    const plugin = instantiate();
    await plugin.onload();
    plugin.unload();

    expect(plugin.activeIntervals.size).toBe(0);
    expect(liveTimers.size, "the bundle created a timer it never cleared").toBe(0);
  });
});

describe("onload does not block Obsidian startup (§12.2c)", () => {
  it("resolves in under 100 ms", async () => {
    const plugin = instantiate();

    const started = performance.now();
    await plugin.onload();
    const elapsed = performance.now() - started;

    expect(elapsed, `onload() took ${elapsed.toFixed(1)} ms`).toBeLessThan(100);
  });

  it("performs no filesystem reads while loading", async () => {
    const plugin = instantiate();
    await plugin.onload();

    expect(fsCalls, "the first pass must be queued, never run inside onload()").toEqual([]);
  });

  it("defers its first pass to layout-ready rather than running it inline", async () => {
    const app = makeStubApp();
    const { default: PluginClass } = loadBundle();
    const plugin = new PluginClass(app, makeStubManifest());

    await plugin.onload();

    expect(app.workspace.layoutReadyCallbacks).toHaveLength(1);
    expect(fsCalls).toEqual([]);

    // Running the queued callback is allowed to do work; it is off the startup path.
    app.workspace.layoutReadyCallbacks[0]?.();
  });
});
