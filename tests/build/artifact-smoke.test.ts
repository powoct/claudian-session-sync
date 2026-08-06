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
  "read",
  "readSync",
  "readv",
  "readvSync",
  "readdir",
  "readdirSync",
  "stat",
  "statSync",
  "fstat",
  "fstatSync",
  "lstat",
  "lstatSync",
  "statfs",
  "statfsSync",
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
  "copyFile",
  "copyFileSync",
  "cp",
  "cpSync",
  // A watcher started in onload() would keep the sync directory busy for the
  // whole session — exactly the kind of startup cost §12.2c is about.
  "watch",
  "watchFile",
] as const;

const fsCalls: Array<{ method: string; target: string }> = [];

/**
 * Recording is armed only around the call under test. The hooks below are
 * process-wide, so without this flag anything else the worker happens to do —
 * vitest's own module loading, a coverage writer — would be recorded as if the
 * plugin bundle had done it, and the assertions would be measuring the harness.
 */
let recording = false;

async function whileRecording<T>(fn: () => Promise<T> | T): Promise<T> {
  fsCalls.length = 0;
  liveTimers.clear();
  recording = true;
  try {
    return await fn();
  } finally {
    recording = false;
  }
}

function recordingProxy<T extends object>(target: T, label = ""): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);

      // `import fs from "fs"; await fs.promises.readFile(...)` is the idiomatic
      // way M1 will read files, and it never goes through require("fs/promises")
      // — so without wrapping this property the whole §12.2c assertion goes
      // quietly vacuous exactly when it finally has something to catch.
      if (prop === "promises" && value && typeof value === "object") {
        return recordingProxy(value as object, "promises.");
      }

      if (typeof value === "function" && FS_READ_METHODS.includes(prop as never)) {
        return (...args: unknown[]) => {
          if (recording) fsCalls.push({ method: `${label}${String(prop)}`, target: String(args[0]) });
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
    if (recording) liveTimers.add(handle);
    return handle;
  }) as typeof setInterval;
  globalThis.clearInterval = ((handle: Parameters<typeof clearInterval>[0]) => {
    liveTimers.delete(handle);
    return realClearInterval(handle);
  }) as typeof clearInterval;
  globalThis.setTimeout = ((callback: (...cbArgs: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    // A timeout that fires is finished, not leaked. Counting it as live would
    // fail correct code — so drop it from the set when it runs, and let only
    // still-pending timers count against unload.
    const holder: { handle?: ReturnType<typeof setTimeout> } = {};
    const wrapped = (...cbArgs: unknown[]) => {
      if (holder.handle !== undefined) liveTimers.delete(holder.handle);
      callback(...cbArgs);
    };
    holder.handle = realSetTimeout(wrapped, ms, ...rest);
    if (recording) liveTimers.add(holder.handle);
    return holder.handle;
  }) as unknown as typeof setTimeout;
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

  it("renders its settings tab without throwing", async () => {
    // main.ts is excluded from coverage on the grounds that the bundle smoke
    // test covers it — which is only true if the smoke test actually drives it.
    // display() is never called by onload(), so a broken settings pane would
    // otherwise only surface in Obsidian itself.
    const plugin = instantiate();
    await plugin.onload();
    const tab = plugin.settingTabs[0];

    expect(() => tab?.display()).not.toThrow();
    expect(tab?.containerEl.children.length, "display() rendered nothing").toBeGreaterThan(0);
  });

  it("shows the user something when a stub command is invoked", async () => {
    const plugin = instantiate();
    await plugin.onload();

    obsidianStub.Notice.instances.length = 0;
    plugin.commands.find((command) => command.id === "sync-now")?.callback?.();

    expect(obsidianStub.Notice.instances).toHaveLength(1);
  });

  it("leaves no live timers after unload", async () => {
    const plugin = instantiate();
    await whileRecording(async () => {
      await plugin.onload();
      plugin.unload();
    });

    expect(plugin.activeIntervals.size).toBe(0);
    expect(liveTimers.size, "the bundle created a timer it never cleared").toBe(0);
  });

  it("would notice a leaked timer", async () => {
    // Proves the previous assertion can fail: without this, "0 live timers"
    // could equally mean the recorder never sees anything.
    await whileRecording(() => {
      const handle = setInterval(() => {}, 1000);
      expect(liveTimers.size).toBe(1);
      clearInterval(handle);
    });
    expect(liveTimers.size).toBe(0);
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
    await whileRecording(() => plugin.onload());

    expect(fsCalls, "the first pass must be queued, never run inside onload()").toEqual([]);
  });

  it("would notice a filesystem read", async () => {
    // Same reasoning as the timer canary: proves the recording fs proxy is
    // actually installed, so an empty fsCalls means "did nothing", not
    // "watched nothing". This matters from M1 on, when the plugin really does
    // reach the filesystem through infra/fs-gateway.
    const requireFromHere = createRequire(import.meta.url);
    await whileRecording(() => {
      const patchedFs = requireFromHere("fs") as typeof realFs;
      patchedFs.existsSync(BUNDLE);
    });
    expect(fsCalls.map((call) => call.method)).toEqual(["existsSync"]);
  });

  it("would notice a read via fs.promises, the idiomatic M1 style", async () => {
    // `import fs from "fs"; await fs.promises.readFile(...)` never touches
    // require("fs/promises"), so this is the path most likely to slip past.
    const requireFromHere = createRequire(import.meta.url);
    await whileRecording(async () => {
      const patchedFs = requireFromHere("fs") as typeof realFs;
      await patchedFs.promises.readFile(BUNDLE);
    });
    expect(fsCalls.map((call) => call.method)).toEqual(["promises.readFile"]);
  });

  it("defers its first pass to layout-ready rather than running it inline", async () => {
    const app = makeStubApp();
    const { default: PluginClass } = loadBundle();
    const plugin = new PluginClass(app, makeStubManifest());

    await whileRecording(() => plugin.onload());

    expect(app.workspace.layoutReadyCallbacks).toHaveLength(1);
    expect(fsCalls).toEqual([]);

    // Running the queued callback is allowed to do work; it is off the startup path.
    app.workspace.layoutReadyCallbacks[0]?.();
  });

  it("still does no synchronous filesystem work when the layout is already ready", async () => {
    // Enabling the plugin from the settings pane hits this path: the callback
    // runs inline, inside onload(). Deferring to onLayoutReady is therefore not
    // by itself enough — the queued work must also be asynchronous.
    const app = makeStubApp({ layoutAlreadyReady: true });
    const { default: PluginClass } = loadBundle();
    const plugin = new PluginClass(app, makeStubManifest());

    const started = performance.now();
    await whileRecording(() => plugin.onload());
    const elapsed = performance.now() - started;

    expect(app.workspace.layoutReadyRanInline).toHaveLength(1);
    expect(fsCalls, "the first pass must be queued asynchronously, not merely deferred").toEqual([]);
    expect(elapsed).toBeLessThan(100);
  });
});
