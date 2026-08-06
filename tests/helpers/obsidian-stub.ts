/**
 * Minimal hand-written Obsidian stub (testing.md §4).
 *
 * Only the surface the plugin actually touches is modelled, and every
 * registration is recorded so the bundle smoke test can assert what `onload()`
 * wired up. It is deliberately not a mock framework: the assertions are about
 * "did the built bundle register the expected UI surface", so the stub's job is
 * to remember, not to pretend.
 */

export class FakeElement {
  textContent = "";
  readonly children: FakeElement[] = [];
  readonly classes = new Set<string>();
  detached = false;

  setText(text: string): this {
    this.textContent = text;
    return this;
  }

  empty(): this {
    this.children.length = 0;
    this.textContent = "";
    return this;
  }

  createEl(_tag: string, _attrs?: unknown): FakeElement {
    const child = new FakeElement();
    this.children.push(child);
    return child;
  }

  createDiv(_attrs?: unknown): FakeElement {
    return this.createEl("div");
  }

  createSpan(_attrs?: unknown): FakeElement {
    return this.createEl("span");
  }

  addClass(...names: string[]): this {
    for (const name of names) this.classes.add(name);
    return this;
  }

  removeClass(...names: string[]): this {
    for (const name of names) this.classes.delete(name);
    return this;
  }

  remove(): void {
    this.detached = true;
  }

  detach(): void {
    this.detached = true;
  }
}

export interface StubCommand {
  id: string;
  name: string;
  callback?: () => unknown;
  checkCallback?: (checking: boolean) => boolean | void;
}

export interface StubRibbonIcon {
  icon: string;
  title: string;
  callback: (evt: unknown) => unknown;
}

export class Notice {
  static readonly instances: Notice[] = [];

  constructor(
    readonly message: string | DocumentFragment,
    readonly duration?: number,
  ) {
    Notice.instances.push(this);
  }

  setMessage(): this {
    return this;
  }

  hide(): void {}
}

export class Component {
  readonly registeredCleanups: Array<() => void> = [];
  readonly activeIntervals = new Set<number>();
  readonly children: Component[] = [];
  loaded = false;

  onload(): void | Promise<void> {}
  onunload(): void {}

  async load(): Promise<void> {
    this.loaded = true;
    await this.onload();
  }

  unload(): void {
    for (const cleanup of this.registeredCleanups.splice(0)) cleanup();
    for (const id of this.activeIntervals) clearInterval(id);
    this.activeIntervals.clear();
    for (const child of this.children.splice(0)) child.unload();
    this.loaded = false;
    this.onunload();
  }

  register(cleanup: () => void): void {
    this.registeredCleanups.push(cleanup);
  }

  registerEvent(_eventRef: unknown): void {}

  registerDomEvent(...args: unknown[]): void {
    void args;
  }

  registerInterval(id: number): number {
    this.activeIntervals.add(id);
    return id;
  }

  addChild<T extends Component>(child: T): T {
    this.children.push(child);
    return child;
  }
}

export interface StubApp {
  workspace: {
    onLayoutReady(callback: () => void): void;
    /** Callbacks queued but not yet run — the smoke test asserts deferral. */
    readonly layoutReadyCallbacks: Array<() => void>;
    /** Callbacks the stub ran immediately because the layout was already ready. */
    readonly layoutReadyRanInline: Array<() => void>;
  };
  vault: { getName(): string; adapter: Record<string, never> };
}

export interface StubAppOptions {
  /**
   * Obsidian's real `onLayoutReady` invokes the callback *synchronously* when
   * the layout is already up — which is what happens when a plugin is enabled
   * from settings rather than at startup. A stub that always defers would let a
   * plugin doing heavy work in that callback pass the deferral test and still
   * block the host in production, so both modes are testable.
   */
  layoutAlreadyReady?: boolean;
}

export function makeStubApp(options: StubAppOptions = {}): StubApp {
  const layoutReadyCallbacks: Array<() => void> = [];
  const layoutReadyRanInline: Array<() => void> = [];
  return {
    workspace: {
      layoutReadyCallbacks,
      layoutReadyRanInline,
      onLayoutReady(callback: () => void) {
        if (options.layoutAlreadyReady) {
          layoutReadyRanInline.push(callback);
          callback();
          return;
        }
        layoutReadyCallbacks.push(callback);
      },
    },
    vault: { getName: () => "test-vault", adapter: {} },
  };
}

export interface StubManifest {
  id: string;
  name: string;
  version: string;
  minAppVersion: string;
  description: string;
  author: string;
  isDesktopOnly: boolean;
}

export class Plugin extends Component {
  readonly commands: StubCommand[] = [];
  readonly ribbonIcons: StubRibbonIcon[] = [];
  readonly statusBarItems: FakeElement[] = [];
  readonly settingTabs: PluginSettingTab[] = [];
  savedData: unknown = null;

  constructor(
    readonly app: StubApp,
    readonly manifest: StubManifest,
  ) {
    super();
  }

  addCommand(command: StubCommand): StubCommand {
    this.commands.push(command);
    return command;
  }

  addRibbonIcon(icon: string, title: string, callback: (evt: unknown) => unknown): FakeElement {
    this.ribbonIcons.push({ icon, title, callback });
    return new FakeElement();
  }

  addStatusBarItem(): FakeElement {
    const element = new FakeElement();
    this.statusBarItems.push(element);
    return element;
  }

  addSettingTab(tab: PluginSettingTab): void {
    this.settingTabs.push(tab);
  }

  async loadData(): Promise<unknown> {
    return this.savedData;
  }

  async saveData(data: unknown): Promise<void> {
    this.savedData = data;
  }
}

export class PluginSettingTab {
  containerEl = new FakeElement();

  constructor(
    readonly app: StubApp,
    readonly plugin: Plugin,
  ) {}

  display(): void {}
  hide(): void {}
}

export class Setting {
  name = "";
  desc = "";
  heading = false;
  /** Obsidian appends a `.setting-item` to the container; mirror that. */
  readonly settingEl: FakeElement;

  constructor(readonly containerEl: FakeElement) {
    this.settingEl = containerEl.createEl("div");
    this.settingEl.addClass("setting-item");
  }

  setName(name: string): this {
    this.name = name;
    return this;
  }

  setDesc(desc: string): this {
    this.desc = desc;
    return this;
  }

  setHeading(): this {
    this.heading = true;
    return this;
  }
}

export const Platform = {
  isDesktopApp: true,
  isMobileApp: false,
  isDesktop: true,
  isMobile: false,
  isWin: process.platform === "win32",
  isMacOS: process.platform === "darwin",
  isLinux: process.platform === "linux",
};

export function makeStubManifest(overrides: Partial<StubManifest> = {}): StubManifest {
  return {
    id: "ai-session-sync",
    name: "AI Session Sync",
    version: "0.0.0-test",
    minAppVersion: "1.5.0",
    description: "test stub manifest",
    author: "test",
    isDesktopOnly: true,
    ...overrides,
  };
}
