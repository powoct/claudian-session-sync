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
import { makeRealTmpDir, removeTree } from "../helpers/fs-cleanup";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BUNDLE = path.join(REPO_ROOT, "main.js");

/**
 * The UI surface the plugin is expected to register. Written out as a literal on
 * purpose: if a command disappears from main.ts, this test should fail and make
 * someone confirm the removal was intended.
 */
const EXPECTED_COMMAND_IDS = [
  "sync-now",
  "dry-run",
  "verify-all",
  "show-last-report",
  "restore-backup",
  "clean-half-copied",
  "open-backups-folder",
  "show-conflicts",
  "repair-shared-records",
  "conflict-keep-local",
  "conflict-keep-remote",
  "conflict-reveal",
];

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
        // A Proxy rather than a plain wrapper function, because these carry
        // properties that matter: `fs.realpath.native` is what the gateway
        // promisifies at module scope, and a wrapper that dropped it turned
        // loading the bundle into a TypeError — a harness bug that looks
        // exactly like a plugin bug.
        return recordingFunction(value as FsFunction, obj, `${label}${String(prop)}`);
      }
      return value;
    },
  });
}

type FsFunction = (...args: unknown[]) => unknown;

/** Records calls while leaving the function's own properties reachable. */
function recordingFunction(fn: FsFunction, thisArg: object, label: string): FsFunction {
  return new Proxy(fn, {
    apply(target, _thisArg, args: unknown[]) {
      if (recording) fsCalls.push({ method: label, target: String(args[0]) });
      return Reflect.apply(target, thisArg, args);
    },
    get(target, prop, receiver) {
      const nested = Reflect.get(target, prop, receiver) as unknown;
      // `realpath.native` and `realpathSync.native` are reads too, and the
      // gateway deliberately uses them (the escape rule's measured input is
      // the OS's own resolution).
      if (prop === "native" && typeof nested === "function") {
        return recordingFunction(nested as FsFunction, thisArg, `${label}.native`);
      }
      return nested;
    },
  }) as FsFunction;
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

/**
 * Plugins built during a test, unloaded after it.
 *
 * A loaded plugin is a *running* plugin: from M1 on, `onload()` schedules the
 * first pass, and a test that leaves one loaded lets that pass fire in the
 * middle of a later test — where the recording fs proxy dutifully attributes
 * its reads to whatever was being measured at the time. Unloading is not
 * tidiness here, it is what keeps the assertions about the right process.
 */
const loadedPlugins: StubPlugin[] = [];

/**
 * A throwaway home and vault for the whole file.
 *
 * Without this the bundle writes `~/.claudian-session-sync/machine.json` on whoever
 * runs the suite — a build test that leaves state in a developer's home
 * directory is a build test nobody trusts. `os.homedir()` reads these, and the
 * plugin only calls it once the first pass starts, so setting them before the
 * bundle loads is enough.
 */
let sandboxHome = "";
let sandboxVault = "";
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  sandboxHome = makeRealTmpDir("aiss-smoke-home-");
  sandboxVault = makeRealTmpDir("aiss-smoke-vault-");
  for (const key of ["HOME", "USERPROFILE"]) savedEnv[key] = process.env[key];
  process.env.HOME = sandboxHome;
  process.env.USERPROFILE = sandboxHome;
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  removeTree(sandboxHome);
  removeTree(sandboxVault);
});

afterEach(async () => {
  for (const plugin of loadedPlugins.splice(0)) plugin.unload();
  // Drain whatever the plugin started before clearing the log: work still in
  // flight would otherwise land inside the next test and be attributed to it.
  await settle();
  fsCalls.length = 0;
  obsidianStub.Notice.instances.length = 0;
});

function loadBundle(): { default: new (app: unknown, manifest: unknown) => StubPlugin } {
  const requireFromHere = createRequire(import.meta.url);
  const resolved = requireFromHere.resolve(BUNDLE);
  delete requireFromHere.cache[resolved];
  return requireFromHere(BUNDLE) as { default: new (app: unknown, manifest: unknown) => StubPlugin };
}

function instantiate(app = makeStubApp({ basePath: sandboxVault })): StubPlugin {
  const { default: PluginClass } = loadBundle();
  const plugin = new PluginClass(app, makeStubManifest());
  loadedPlugins.push(plugin);
  return plugin;
}

/** Lets queued microtasks and 0 ms timers run, as the host's event loop would. */
/**
 * Waits until the bundle has stopped touching the filesystem.
 *
 * A fixed sleep here was a guess about how fast the machine is, and on the
 * two-core Windows runner it guessed wrong: `onload()` defers `start()` to a
 * timer, and on a slow box that work outlived the 20 ms drain, landed inside
 * the *next* test's recording window, and was attributed to it. That is the
 * failure this file already warns about two lines above — "work still in
 * flight would otherwise land inside the next test".
 *
 * So it polls instead of guessing, which is the rule `waitUntil` below already
 * states in its own comment. Recording is switched on for the drain because
 * the recorder is the only thing that can see the activity being drained;
 * `afterEach` clears the log immediately afterwards, so nothing observed here
 * reaches an assertion.
 */
async function settle(): Promise<void> {
  const wasRecording = recording;
  recording = true;
  try {
    const deadline = Date.now() + 2000;
    let previous = -1;
    while (Date.now() < deadline && fsCalls.length !== previous) {
      previous = fsCalls.length;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    recording = wasRecording;
  }
}

/** Polls until `predicate` holds, so a slow disk does not become a flake. */
async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
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

  it("reports back to the user when a command is invoked", async () => {
    // In M0 every command answered with a "not implemented" Notice. Now they
    // do work, and the feedback channel is the status bar — so what this
    // asserts is that invoking one is safe and visibly changes something,
    // rather than that a particular popup appears.
    const plugin = instantiate();
    await plugin.onload();
    const statusBar = plugin.statusBarItems[0];
    const initial = statusBar?.textContent;

    plugin.commands.find((command) => command.id === "sync-now")?.callback?.();
    await waitUntil(() => statusBar?.textContent !== initial);

    expect(statusBar?.textContent).toBeTruthy();
    expect(statusBar?.textContent, "the status bar never moved off its initial text").not.toBe(
      initial,
    );
  });

  it("survives every command being invoked with nothing configured", async () => {
    // The state a new user is in for the first minute. None of these may
    // throw: an unconfigured plugin that errors on click is indistinguishable
    // from a broken one.
    const plugin = instantiate();
    await plugin.onload();

    for (const command of plugin.commands) {
      expect(() => command.callback?.(), `command ${command.id} threw`).not.toThrow();
    }
    await settle();
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
    // `toContain`, not `toEqual`, and only here. This canary asks one thing —
    // is the proxy installed on the `fs.promises` path — and the answer is
    // whether our read shows up. An exact match would additionally assert that
    // nothing else in the process touched the filesystem across an `await`,
    // which this test neither controls nor is about; the sibling canary above
    // can keep its exact match because `existsSync` is synchronous and leaves
    // no window to interleave in.
    expect(fsCalls.map((call) => call.method)).toContain("promises.readFile");
  });

  it("defers its first pass to layout-ready rather than running it inline", async () => {
    const app = makeStubApp({ basePath: sandboxVault });
    const plugin = instantiate(app);

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
    const app = makeStubApp({ layoutAlreadyReady: true, basePath: sandboxVault });
    const plugin = instantiate(app);

    const started = performance.now();
    await whileRecording(() => plugin.onload());
    const elapsed = performance.now() - started;

    expect(app.workspace.layoutReadyRanInline).toHaveLength(1);
    expect(fsCalls, "the first pass must be queued asynchronously, not merely deferred").toEqual([]);
    expect(elapsed).toBeLessThan(100);
  });
});
