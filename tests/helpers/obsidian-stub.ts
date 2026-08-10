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
  readonly listeners = new Map<string, Array<() => unknown>>();
  detached = false;
  tag = "div";

  setText(text: string): this {
    this.textContent = text;
    return this;
  }

  empty(): this {
    this.children.length = 0;
    this.textContent = "";
    return this;
  }

  /**
   * Honours `{ text }`, because Obsidian does.
   *
   * A stub that dropped it would let every modal render into a tree of empty
   * nodes and still "pass" — the assertions would be about structure, which is
   * the part nobody cares about, instead of about what the user reads.
   */
  createEl(tag: string, attrs?: { text?: string }): FakeElement {
    const child = new FakeElement();
    child.tag = tag;
    if (attrs?.text !== undefined) child.textContent = attrs.text;
    this.children.push(child);
    return child;
  }

  createDiv(attrs?: { text?: string }): FakeElement {
    return this.createEl("div", attrs);
  }

  createSpan(attrs?: { text?: string }): FakeElement {
    return this.createEl("span", attrs);
  }

  addEventListener(event: string, handler: () => unknown): void {
    const existing = this.listeners.get(event) ?? [];
    existing.push(handler);
    this.listeners.set(event, existing);
  }

  /** Test-side: fire an event, as a click would. */
  dispatch(event: string): void {
    for (const handler of this.listeners.get(event) ?? []) handler();
  }

  /** This element and every descendant, depth first. */
  descendants(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }

  /** All text in the subtree, for asserting on what the user can read. */
  allText(): string {
    return [this.textContent, ...this.descendants().map((child) => child.textContent)]
      .filter(Boolean)
      .join("\n");
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
  vault: { getName(): string; adapter: { getBasePath?: () => string } };
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
  /**
   * What `vault.adapter.getBasePath()` returns.
   *
   * Desktop Obsidian exposes the vault's absolute path here, and the plugin
   * resolves it at startup. A test that leaves it unset gets a plugin pointed
   * at nowhere, which is a fine thing to assert about and a poor default for
   * anything else.
   */
  basePath?: string;
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
    vault: {
      getName: () => "test-vault",
      adapter: options.basePath === undefined ? {} : { getBasePath: () => options.basePath as string },
    },
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

/** Controls a Setting can hold, recorded so a test can drive them. */
export class StubTextComponent {
  value = "";
  placeholder = "";
  disabled = false;
  onChanged: (value: string) => unknown = () => undefined;

  setValue(value: string): this {
    this.value = value;
    return this;
  }

  setPlaceholder(placeholder: string): this {
    this.placeholder = placeholder;
    return this;
  }

  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    return this;
  }

  onChange(handler: (value: string) => unknown): this {
    this.onChanged = handler;
    return this;
  }

  /** Test-side: type a value and fire the handler, as a user would. */
  async type(value: string): Promise<void> {
    this.value = value;
    await this.onChanged(value);
  }
}

export class StubToggleComponent {
  value = false;
  onChanged: (value: boolean) => unknown = () => undefined;

  setValue(value: boolean): this {
    this.value = value;
    return this;
  }

  onChange(handler: (value: boolean) => unknown): this {
    this.onChanged = handler;
    return this;
  }

  async toggle(value: boolean): Promise<void> {
    this.value = value;
    await this.onChanged(value);
  }
}

export class StubButtonComponent {
  label = "";
  cta = false;
  disabled = false;
  onClicked: () => unknown = () => undefined;

  setButtonText(label: string): this {
    this.label = label;
    return this;
  }

  setCta(): this {
    this.cta = true;
    return this;
  }

  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    return this;
  }

  setWarning(): this {
    return this;
  }

  onClick(handler: () => unknown): this {
    this.onClicked = handler;
    return this;
  }

  async click(): Promise<void> {
    await this.onClicked();
  }
}

export class StubDropdownComponent {
  value = "";
  readonly options = new Map<string, string>();
  onChanged: (value: string) => unknown = () => undefined;

  addOption(value: string, label: string): this {
    this.options.set(value, label);
    return this;
  }

  setValue(value: string): this {
    this.value = value;
    return this;
  }

  onChange(handler: (value: string) => unknown): this {
    this.onChanged = handler;
    return this;
  }

  async select(value: string): Promise<void> {
    this.value = value;
    await this.onChanged(value);
  }
}

export class Setting {
  name = "";
  desc = "";
  heading = false;
  disabled = false;
  /** Obsidian appends a `.setting-item` to the container; mirror that. */
  readonly settingEl: FakeElement;
  readonly texts: StubTextComponent[] = [];
  readonly toggles: StubToggleComponent[] = [];
  readonly buttons: StubButtonComponent[] = [];
  readonly dropdowns: StubDropdownComponent[] = [];

  constructor(readonly containerEl: FakeElement) {
    this.settingEl = containerEl.createEl("div");
    this.settingEl.addClass("setting-item");
    settingsCreated.push(this);
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

  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    return this;
  }

  addText(build: (text: StubTextComponent) => unknown): this {
    const component = new StubTextComponent();
    this.texts.push(component);
    build(component);
    return this;
  }

  addToggle(build: (toggle: StubToggleComponent) => unknown): this {
    const component = new StubToggleComponent();
    this.toggles.push(component);
    build(component);
    return this;
  }

  addButton(build: (button: StubButtonComponent) => unknown): this {
    const component = new StubButtonComponent();
    this.buttons.push(component);
    build(component);
    return this;
  }

  addDropdown(build: (dropdown: StubDropdownComponent) => unknown): this {
    const component = new StubDropdownComponent();
    this.dropdowns.push(component);
    build(component);
    return this;
  }
}

/**
 * Every `Setting` built since the last reset.
 *
 * A settings tab renders into a tree of anonymous divs, so asserting on the
 * DOM would test the layout rather than the behaviour. What a test actually
 * wants is "which controls exist and what happens when I use them", and this
 * is the cheapest honest way to offer that.
 */
export const settingsCreated: Setting[] = [];

export function resetStubSettings(): void {
  settingsCreated.length = 0;
}

export class Modal {
  readonly contentEl = new FakeElement();
  readonly titleEl = new FakeElement();
  opened = false;

  constructor(readonly app: StubApp) {}

  onOpen(): void | Promise<void> {}
  onClose(): void {}

  open(): void {
    this.opened = true;
    void this.onOpen();
  }

  close(): void {
    this.opened = false;
    this.onClose();
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
    id: "claudian-session-sync",
    name: "Claudian Session Sync",
    version: "0.0.0-test",
    minAppVersion: "1.5.0",
    description: "test stub manifest",
    author: "test",
    isDesktopOnly: true,
    ...overrides,
  };
}
