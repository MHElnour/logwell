// A minimal runtime stand-in for the `obsidian` module, which ships types only.
// vitest.config.ts aliases "obsidian" to this file, so tests can load modules
// such as src/main.ts. Only what module loading and Plugin.onload touch exists.

class Stub {}

export class Plugin {
	/** Every ref passed to registerEvent, for assertions. */
	readonly registered: unknown[] = [];

	constructor(
		readonly app: unknown,
		readonly manifest: unknown,
	) {}

	registerEvent(ref: unknown): void {
		this.registered.push(ref);
	}
	registerDomEvent(): void {}
	/** Callbacks of `register`, run once by `unload` (Component.register in Obsidian). */
	private readonly cleanups: (() => void)[] = [];
	register(cleanup: () => void): void {
		this.cleanups.push(cleanup);
	}
	/** What Obsidian does when the plugin is disabled: runs the registered cleanups. */
	unload(): void {
		for (const c of this.cleanups.splice(0)) c();
	}
	registerInterval(id: number): number {
		return id;
	}
	/** Every code block processor, by language, for tests that run one. */
	readonly codeBlockProcessors = new Map<string, (source: string, el: HTMLElement, ctx: unknown) => void>();
	registerMarkdownCodeBlockProcessor(language: string, handler: (source: string, el: HTMLElement, ctx: unknown) => void): void {
		this.codeBlockProcessors.set(language, handler);
	}
	registerView(): void {}
	registerExtensions(): void {}
	registerHoverLinkSource(): void {}
	addSettingTab(): void {}
	addRibbonIcon(): void {}
	addCommand(): void {}
	addStatusBarItem(): unknown {
		return {};
	}
	loadData(): Promise<unknown> {
		return Promise.resolve(null);
	}
	saveData(): Promise<void> {
		return Promise.resolve();
	}
}

export class AbstractInputSuggest<T> {
	limit = 100;
	constructor(
		readonly app: unknown,
		readonly textInputEl: unknown,
	) {}
	open(): void {}
	close(): void {}
	setValue(): void {}
	getValue(): string {
		return "";
	}
	protected getSuggestions(_query: string): T[] {
		return [];
	}
}
/** The part of Component that render children use: load and unload run onload and onunload once, and unload runs the registered cleanups. */
export class Component {
	private cleanups: (() => void)[] = [];
	private loaded = false;
	onload(): void {}
	onunload(): void {}
	load(): void {
		if (this.loaded) return;
		this.loaded = true;
		this.onload();
	}
	unload(): void {
		if (!this.loaded) return;
		this.loaded = false;
		this.onunload();
		for (const c of this.cleanups.splice(0)) c();
	}
	register(cleanup: () => void): void {
		this.cleanups.push(cleanup);
	}
}
export class MarkdownRenderChild extends Component {
	constructor(readonly containerEl: HTMLElement) {
		super();
	}
}
export const FileView = Stub;
export const FuzzySuggestModal = Stub;
export const Keymap = {};
export const MarkdownRenderer = {};
export const Menu = Stub;
export const Modal = Stub;
export const Notice = Stub;
export const Platform = { isDesktop: false };
export const PluginSettingTab = Stub;
export const Setting = Stub;
/** Obsidian's secret field: remembers what the code under test sets and lets a test pick a secret. */
export class SecretComponent {
	value = "";
	changed: ((value: string) => unknown) | null = null;
	constructor(
		readonly app: unknown,
		readonly containerEl: HTMLElement,
	) {}
	setValue(value: string): this {
		this.value = value;
		return this;
	}
	onChange(cb: (value: string) => unknown): this {
		this.changed = cb;
		return this;
	}
}
export const TFile = Stub;
export const TFolder = Stub;
export const normalizePath = (path: string): string => path;
export const setIcon = (): void => undefined;
/** Tests of the TickTick client pass their own request function. */
export const requestUrl = (): Promise<never> => Promise.reject(new Error("requestUrl is not available in tests"));
