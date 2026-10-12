// @vitest-environment happy-dom
import { type ComponentChild, type ContainerNode, options } from "preact";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type CheckpointSettings, DEFAULT_SETTINGS } from "../../src/app/settings";
import type { HabitInput } from "../../src/domain/habits";
import * as matcher from "../../src/domain/blockQuery";
import * as parser from "../../src/parsing/blockQuery";
import { BLOCK_LANGUAGE, type BlockEnv, type BlockSession, DETACHED_DRAW_MS, NOT_RUNNING_TEXT, REFRESH_MS, registerDashboardBlock, TICK_MS } from "../../src/obsidian/dashboardBlock";
import { collectionsOf } from "../../src/persistence/schema";
import { type AppHarness, appHarness } from "../app/harness";
import { Plugin } from "../app/obsidian-stub";
import { settle } from "../ui/calendar-helpers";
import { U1Host } from "../ui/app-helpers";

// The `logwell` code block processor. The environment (database session, task opening) is a fake; the
// element's `win`, `doc` and `isShown` are Obsidian's additions to HTMLElement, defined here over happy-dom.

/** The first argument of every Preact render a block made: a tree to draw, or null to unmount. */
const drawn = vi.hoisted(() => ({ trees: [] as unknown[] }));
vi.mock("../../src/domain/blockQuery", async (importActual) => {
	const actual = await importActual<typeof import("../../src/domain/blockQuery")>();
	return { ...actual, runBlockQuery: vi.fn(actual.runBlockQuery) };
});
vi.mock("preact", async (importActual) => {
	const actual = await importActual<typeof import("preact")>();
	return {
		...actual,
		render: (tree: ComponentChild, root: ContainerNode) => {
			drawn.trees.push(tree);
			actual.render(tree, root);
		},
	};
});
vi.mock("../../src/parsing/blockQuery", async (importActual) => {
	const actual = await importActual<typeof import("../../src/parsing/blockQuery")>();
	return { ...actual, parseBlockQuery: vi.fn(actual.parseBlockQuery) };
});

describe("the block processor", () => {
	const runs = () => vi.mocked(matcher.runBlockQuery).mock.calls.length;
	const parses = () => vi.mocked(parser.parseBlockQuery).mock.calls.length;
	/** How many times a block drew a tree (not counting the unmounts, which pass null). */
	const renders = () => drawn.trees.filter((tree) => tree !== null).length;

	class FakeObserver {
		static instances: FakeObserver[] = [];
		disconnected = false;
		observed: Element[] = [];
		constructor(
			readonly callback: (entries: { isIntersecting: boolean }[]) => void,
			readonly options?: { rootMargin?: string },
		) {
			FakeObserver.instances.push(this);
		}
		observe(el: Element): void {
			this.observed.push(el);
		}
		disconnect(): void {
			this.disconnected = true;
		}
		fire(isIntersecting: boolean): void {
			this.callback([{ isIntersecting }]);
		}
	}

	/** The window of the element: the page's, or a fake popout window whose timers the test can see. */
	let currentWin: Record<string, unknown> | Window = window;
	let shown = true;
	let settings: CheckpointSettings = DEFAULT_SETTINGS;

	// Preact runs effects after a frame through the window's timers. Faked timers that are dropped before that frame
	// leave its queue stuck for every later test, and the frame itself counts as a timer of the block. A microtask
	// runs the effects instead, whichever timers the test uses.
	const ownFrame: unknown = Reflect.get(options, "requestAnimationFrame");
	beforeAll(() => {
		options.requestAnimationFrame = (flush) => void Promise.resolve().then(flush);
	});
	afterAll(() => {
		Reflect.set(options, "requestAnimationFrame", ownFrame);
	});

	beforeAll(() => {
		const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
		proto.empty = function (this: HTMLElement) {
			this.replaceChildren();
		};
		Object.defineProperty(HTMLElement.prototype, "win", { configurable: true, get: () => currentWin });
		Object.defineProperty(HTMLElement.prototype, "doc", { configurable: true, get: () => document });
		proto.createDiv = function (this: HTMLElement, o: { cls: string }) {
			const el = this.ownerDocument.createElement("div");
			el.className = o.cls;
			this.appendChild(el);
			return el;
		};
		proto.isShown = function (this: HTMLElement) {
			return this.isConnected && shown;
		};
	});

	afterAll(() => {
		// Obsidian's additions do not exist on happy-dom's HTMLElement: removing them restores it.
		for (const key of ["empty", "win", "doc", "createDiv", "isShown"]) Reflect.deleteProperty(HTMLElement.prototype, key);
	});

	beforeEach(() => {
		currentWin = window;
		shown = true;
		FakeObserver.instances = [];
		vi.stubGlobal("IntersectionObserver", FakeObserver);
		(window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeObserver;
		vi.mocked(matcher.runBlockQuery).mockClear();
		vi.mocked(parser.parseBlockQuery).mockClear();
		drawn.trees.length = 0;
		settings = DEFAULT_SETTINGS;
	});

	const elements: HTMLElement[] = [];
	const children: { unload(): void }[] = [];
	afterEach(() => {
		vi.useRealTimers();
		for (const c of children.splice(0)) c.unload();
		for (const e of elements.splice(0)) e.remove();
		vi.unstubAllGlobals();
	});

	const habit: HabitInput = { name: "Run", icon: null, color: null, timeOfDay: "anytime", reminder: null, goal: { type: "binary", target: 1, unit: null, period: "day" }, schedule: { kind: "daily" } };

	interface Setup {
		h: AppHarness;
		env: BlockEnv;
		host: U1Host;
		plugin: Plugin;
		setSession: (s: BlockSession | null) => void;
		sessionListeners: () => number;
		storeListeners: (h: AppHarness) => number;
		openTask: ReturnType<typeof vi.fn>;
		openView: ReturnType<typeof vi.fn>;
		/** Runs the registered processor for a block of `source` in the note `path`; returns its element and context. */
		block: (source: string, path?: string, attached?: boolean) => { el: HTMLElement; ctx: { sourcePath: string; addChild(c: { load(): void; unload(): void }): void } };
	}

	/** Counts the "changed" subscriptions on a harness's store bus. */
	function watchBus(h: AppHarness, count: { n: number }): void {
		const bus = h.app.store.bus;
		const on = bus.on.bind(bus) as (event: string, fn: never) => () => void;
		(bus as unknown as { on: unknown }).on = (event: string, fn: never) => {
			count.n++;
			const off = on(event, fn);
			return () => {
				count.n--;
				off();
			};
		};
	}

	async function setup(): Promise<Setup> {
		const h = await appHarness();
		const host = new U1Host(h);
		const plugin = new Plugin({}, {});
		let session: BlockSession | null = { app: h.app, host };
		const listeners = new Set<() => void>();
		const watched = new Map<AppHarness, { n: number }>();
		const counter = { n: 0 };
		watched.set(h, counter);
		watchBus(h, counter);
		const openTask = vi.fn();
		const openView = vi.fn();
		const env: BlockEnv = {
			session: () => session,
			onSession: (fn) => {
				listeners.add(fn);
				return () => listeners.delete(fn);
			},
			settings: () => settings,
			openTask,
			openView,
		};
		registerDashboardBlock(plugin as never, env);
		const processor = plugin.codeBlockProcessors.get(BLOCK_LANGUAGE)!;
		return {
			h,
			env,
			host,
			plugin,
			openTask,
			openView,
			setSession: (s) => {
				session = s;
				for (const l of [...listeners]) l();
			},
			sessionListeners: () => listeners.size,
			storeListeners: (of) => {
				let c = watched.get(of);
				if (c === undefined) {
					c = { n: 0 };
					watched.set(of, c);
					watchBus(of, c);
				}
				return c.n;
			},
			block: (source, path = "Notes/Page.md", attached = true) => {
				const el = document.createElement("div");
				if (attached) document.body.appendChild(el);
				elements.push(el);
				const ctx = {
					sourcePath: path,
					addChild: (c: { load(): void; unload(): void }) => {
						children.push(c);
						c.load();
					},
				};
				processor(source, el, ctx);
				return { el, ctx };
			},
		};
	}

	const rows = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>(".cp-task-row")];
	const titles = (el: HTMLElement) => rows(el).map((r) => r.querySelector(".cp-task-title")!.textContent.trim());
	const text = (el: HTMLElement) => el.querySelector(".cp-block-msg")?.textContent ?? null;
	/** Lets Preact finish (it renders in microtasks) without moving fake timers. */
	const flush = () => settle();

	describe("the processor", () => {
		it("registers the logwell code block language", async () => {
			const s = await setup();
			expect(BLOCK_LANGUAGE).toBe("logwell");
			expect(s.plugin.codeBlockProcessors.has("logwell")).toBe(true);
		});

		it("draws the block synchronously when it loads, with no empty frame first", async () => {
			const s = await setup();
			await s.h.app.tasks.create({ title: "A" });
			const { el } = s.block("");
			expect(titles(el)).toEqual(["A"]);
			expect(el.querySelector(".cp-block")).not.toBeNull();
		});

		it("is a child of the render context, mounted on load and removed on unload", async () => {
			const s = await setup();
			await s.h.app.tasks.create({ title: "A" });
			const { el } = s.block("");
			expect(children).toHaveLength(1);
			expect(el.querySelector(".cp-block")).not.toBeNull();
			children[0]!.unload();
			expect(el.querySelector(".cp-block")).toBeNull();
			expect(el.childNodes).toHaveLength(0);
		});

		it("wraps the block in the theme classes the rows are styled by", async () => {
			const s = await setup();
			const { el } = s.block("");
			const root = el.querySelector(".cp-block")!;
			expect(root.classList.contains("cp-theme")).toBe(true);
			expect(root.classList.contains("checkpoint-view")).toBe(true);
			expect(root.classList.contains(`cp-accent-${DEFAULT_SETTINGS.accent}`)).toBe(true);
		});

		it("parses the source once per instance, not on each refresh, and each block reads its own source", async () => {
			const s = await setup();
			await s.h.app.tasks.create({ title: "High", priority: 1 });
			await s.h.app.tasks.create({ title: "Low", priority: 3 });
			const a = s.block("priority: high");
			const b = s.block("priority: low");
			expect(parses()).toBe(2);
			expect(titles(a.el)).toEqual(["High"]);
			expect(titles(b.el)).toEqual(["Low"]);
			vi.useFakeTimers();
			await s.h.app.tasks.create({ title: "High 2", priority: 1 });
			await vi.advanceTimersByTimeAsync(REFRESH_MS + 10);
			expect(titles(a.el)).toEqual(["High", "High 2"]);
			expect(parses()).toBe(2);
		});

		it("shows parser errors in the error style, without running the query", async () => {
			const s = await setup();
			const { el } = s.block("colour: red");
			expect(el.querySelector(".cp-block-msg")!.classList.contains("is-error")).toBe(true);
			expect(text(el)).toContain("Unknown filter");
			expect(runs()).toBe(0);
		});

		it("shows a matcher error in the error style", async () => {
			const s = await setup();
			const { el } = s.block("list: Wrok");
			expect(text(el)).toBe("No list named “Wrok”.");
			expect(el.querySelector(".cp-block-msg")!.classList.contains("is-error")).toBe(true);
		});

		it("says No tasks found. for valid filters with no match", async () => {
			const s = await setup();
			const { el } = s.block("priority: high");
			expect(text(el)).toBe("No tasks found.");
		});

		it("anchors linked: this note on the source path of the block, read again on every refresh", async () => {
			const s = await setup();
			const t = (await s.h.app.tasks.create({ title: "Linked", notePath: "Notes/Page.md" })).task;
			await s.h.app.tasks.create({ title: "Other" });
			const { el, ctx } = s.block("linked: this note", "Notes/Page.md");
			expect(titles(el)).toEqual(["Linked"]);
			// The note is renamed: Obsidian updates the context; the task's note path follows through the app.
			ctx.sourcePath = "Notes/Renamed.md";
			vi.useFakeTimers();
			await s.h.app.tasks.rewriteNotePaths("Notes/Page.md", "Notes/Renamed.md", false);
			await vi.advanceTimersByTimeAsync(REFRESH_MS + 10);
			expect(titles(el)).toEqual(["Linked"]);
			expect(s.h.app.store.state.tasks.get(t.id)!.descriptionNote!.path).toBe("Notes/Renamed.md");
		});
	});

	describe("no database", () => {
		it("says so, and keeps the block ready to fill when a database opens", async () => {
			const s = await setup();
			await s.h.app.tasks.create({ title: "A" });
			s.setSession(null);
			const { el } = s.block("");
			expect(text(el)).toBe("Open a Logwell database to see tasks.");
			expect(el.querySelector(".cp-block-msg")!.classList.contains("is-error")).toBe(false);
			vi.useFakeTimers();
			s.setSession({ app: s.h.app, host: s.host });
			await vi.advanceTimersByTimeAsync(REFRESH_MS + 10);
			expect(titles(el)).toEqual(["A"]);
		});

		it("goes back to the message when the session closes", async () => {
			const s = await setup();
			await s.h.app.tasks.create({ title: "A" });
			const { el } = s.block("");
			expect(titles(el)).toEqual(["A"]);
			vi.useFakeTimers();
			s.setSession(null);
			await vi.advanceTimersByTimeAsync(REFRESH_MS + 10);
			expect(text(el)).toBe("Open a Logwell database to see tasks.");
		});

		it("follows a database switch: the old store no longer drives it, the new one does", async () => {
			const s = await setup();
			await s.h.app.tasks.create({ title: "Old" });
			const second = await appHarness();
			await second.app.tasks.create({ title: "New" });
			// Watch its bus before the block can subscribe to it.
			expect(s.storeListeners(second)).toBe(0);
			const { el } = s.block("");
			expect(titles(el)).toEqual(["Old"]);
			expect(s.storeListeners(s.h)).toBe(1);
			vi.useFakeTimers();
			s.setSession({ app: second.app, host: new U1Host(second) });
			await vi.advanceTimersByTimeAsync(REFRESH_MS + 10);
			expect(titles(el)).toEqual(["New"]);
			expect(s.storeListeners(s.h)).toBe(0);
			expect(s.storeListeners(second)).toBe(1);
			await s.h.app.tasks.create({ title: "Old again" });
			await vi.advanceTimersByTimeAsync(REFRESH_MS + 10);
			expect(titles(el)).toEqual(["New"]);
			await second.app.tasks.create({ title: "New 2" });
			await vi.advanceTimersByTimeAsync(REFRESH_MS + 10);
			expect(titles(el)).toEqual(["New", "New 2"]);
		});
	});

	describe("refresh", () => {
		it("coalesces a burst of changes into one redraw after about 300 ms", async () => {
			const s = await setup();
			const { el } = s.block("");
			vi.useFakeTimers();
			const before = runs();
			for (const title of ["A", "B", "C"]) await s.h.app.tasks.create({ title });
			expect(runs() - before).toBe(0);
			await vi.advanceTimersByTimeAsync(REFRESH_MS - 50);
			expect(runs() - before).toBe(0);
			await vi.advanceTimersByTimeAsync(100);
			expect(runs() - before).toBe(1);
			expect(titles(el)).toEqual(["A", "B", "C"]);
			expect(REFRESH_MS).toBe(300);
		});

		it("uses the window of the element for its timers and observer, never the global ones", async () => {
			const s = await setup();
			const timers: { fn: () => void; ms: number; handle: number }[] = [];
			const cleared: number[] = [];
			class PopoutObserver extends FakeObserver {}
			currentWin = {
				setTimeout: (fn: () => void, ms: number) => {
					timers.push({ fn, ms, handle: timers.length + 1 });
					return timers.length;
				},
				clearTimeout: (h: number) => void cleared.push(h),
				setInterval: () => 99,
				clearInterval: () => undefined,
				IntersectionObserver: PopoutObserver,
			};
			const globalSet = vi.spyOn(window, "setTimeout");
			const { el } = s.block("");
			expect(FakeObserver.instances.at(-1)).toBeInstanceOf(PopoutObserver);
			await s.h.app.tasks.create({ title: "A" });
			await s.h.app.tasks.create({ title: "B" });
			// The second change joins the pending redraw of the first.
			expect(timers.map((t) => t.ms)).toEqual([REFRESH_MS]);
			expect(cleared).toEqual([]);
			timers[0]!.fn();
			expect(titles(el)).toEqual(["A", "B"]);
			const callsFromBlock = globalSet.mock.calls.filter(([, ms]) => ms === REFRESH_MS);
			expect(callsFromBlock).toEqual([]);
		});

		it("skips a change that cannot alter the block: no timer, no query", async () => {
			const s = await setup();
			s.block("");
			vi.useFakeTimers();
			const before = runs();
			await s.h.app.habits.create(habit);
			expect(vi.getTimerCount()).toBe(0);
			await vi.advanceTimersByTimeAsync(REFRESH_MS + 10);
			expect(runs() - before).toBe(0);
			await s.h.app.tasks.create({ title: "A" });
			expect(vi.getTimerCount()).toBe(1);
		});

		it("reads the query context again on every refresh", async () => {
			const s = await setup();
			const spy = vi.spyOn(s.h.app, "queryContext");
			s.block("");
			const first = spy.mock.calls.length;
			expect(first).toBeGreaterThan(0);
			vi.useFakeTimers();
			await s.h.app.tasks.create({ title: "A" });
			await vi.advanceTimersByTimeAsync(REFRESH_MS + 10);
			expect(spy.mock.calls.length).toBeGreaterThan(first);
		});

		it("a change of the day alone is picked up by the next change event", async () => {
			const s = await setup();
			await s.h.app.tasks.create({ title: "Due", scheduled: { kind: "date", date: "2026-10-02" } });
			const { el } = s.block("scheduled: today");
			expect(text(el)).toBe("No tasks found.");
			s.h.clock.set("2026-10-02T10:00:00.000Z");
			vi.useFakeTimers();
			// Settings and session events carry no store change; the day still counts as a change of the context.
			s.setSession(s.env.session());
			await vi.advanceTimersByTimeAsync(REFRESH_MS + 10);
			expect(titles(el)).toEqual(["Due"]);
		});

		it("ticking a row from the note redraws at once, not after the delay", async () => {
			const s = await setup();
			await s.h.app.tasks.create({ title: "A" });
			await s.h.app.tasks.create({ title: "B" });
			const { el } = s.block("");
			vi.useFakeTimers();
			const before = runs();
			const box = rows(el)[0]!.querySelector<HTMLInputElement>("input.cp-task-checkbox")!;
			box.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
			await vi.advanceTimersByTimeAsync(0);
			expect(runs() - before).toBe(1);
			// The completed row is held for its check animation, so both titles show, the first one done.
			expect(rows(el)[0]!.classList.contains("is-completed")).toBe(true);
			expect(el.querySelector(".cp-block-count")!.textContent).toBe("1 task");
			// The pending timer of the change event was replaced by the immediate redraw.
			await vi.advanceTimersByTimeAsync(REFRESH_MS + 10);
			expect(runs() - before).toBe(1);
		});
	});

	describe("hidden blocks", () => {
		it("does not draw while the block is not shown, and draws when it becomes visible", async () => {
			const s = await setup();
			await s.h.app.tasks.create({ title: "A" });
			shown = false;
			const { el } = s.block("");
			expect(runs()).toBe(0);
			expect(rows(el)).toHaveLength(0);
			vi.useFakeTimers();
			await s.h.app.tasks.create({ title: "B" });
			expect(vi.getTimerCount()).toBe(0);
			await vi.advanceTimersByTimeAsync(REFRESH_MS + 10);
			expect(runs()).toBe(0);
			// A collapsed callout opens: the observer reports the block.
			shown = true;
			FakeObserver.instances.at(-1)!.fire(true);
			await flush();
			expect(titles(el)).toEqual(["A", "B"]);
			expect(runs()).toBe(1);
		});

		it("watches the block a little beyond the viewport, so it has its height when it scrolls into view", async () => {
			const s = await setup();
			s.block("");
			expect(FakeObserver.instances.at(-1)!.options?.rootMargin).toBe("300px 0px");
			expect(FakeObserver.instances.at(-1)!.observed).toHaveLength(1);
		});

		it("an observer report while still hidden changes nothing, and one after drawing does not redraw", async () => {
			const s = await setup();
			await s.h.app.tasks.create({ title: "A" });
			shown = false;
			const { el } = s.block("");
			const observer = FakeObserver.instances.at(-1)!;
			observer.fire(true);
			expect(runs()).toBe(0);
			shown = true;
			observer.fire(true);
			observer.fire(true);
			await flush();
			expect(runs()).toBe(1);
			expect(titles(el)).toEqual(["A"]);
		});

		it("a block that was drawn and then hidden catches up when shown again", async () => {
			const s = await setup();
			const { el } = s.block("");
			const observer = FakeObserver.instances.at(-1)!;
			shown = false;
			vi.useFakeTimers();
			await s.h.app.tasks.create({ title: "Later" });
			await vi.advanceTimersByTimeAsync(REFRESH_MS + 10);
			expect(rows(el)).toHaveLength(0);
			shown = true;
			observer.fire(true);
			await flush();
			expect(titles(el)).toEqual(["Later"]);
		});

		it("a block that hides while a redraw is pending waits for the observer", async () => {
			const s = await setup();
			const { el } = s.block("");
			const observer = FakeObserver.instances.at(-1)!;
			vi.useFakeTimers();
			await s.h.app.tasks.create({ title: "A" });
			shown = false;
			await vi.advanceTimersByTimeAsync(REFRESH_MS + 10);
			expect(rows(el)).toHaveLength(0);
			shown = true;
			observer.fire(true);
			await flush();
			expect(titles(el)).toEqual(["A"]);
		});
	});

	describe("unload", () => {
		it("leaves no timer, store listener, session listener or observer behind", async () => {
			const s = await setup();
			await s.h.app.tasks.create({ title: "A" });
			vi.useFakeTimers();
			const a = s.block("");
			s.block("priority: high");
			expect(s.storeListeners(s.h)).toBe(1);
			expect(s.sessionListeners()).toBe(1);
			await s.h.app.tasks.create({ title: "B" });
			expect(vi.getTimerCount()).toBeGreaterThan(0);
			for (const c of children.splice(0)) c.unload();
			expect(vi.getTimerCount()).toBe(0);
			expect(s.storeListeners(s.h)).toBe(0);
			expect(s.sessionListeners()).toBe(0);
			expect(FakeObserver.instances.every((o) => o.disconnected)).toBe(true);
			expect(a.el.childNodes).toHaveLength(0);
			// Nothing runs after the unload.
			const before = runs();
			await s.h.app.tasks.create({ title: "C" });
			s.setSession({ app: s.h.app, host: s.host });
			await vi.advanceTimersByTimeAsync(REFRESH_MS + 10);
			expect(runs()).toBe(before);
		});

		it("one block unloading keeps the others subscribed, and the last one to go unsubscribes", async () => {
			const s = await setup();
			const a = s.block("");
			const b = s.block("");
			expect(s.storeListeners(s.h)).toBe(1);
			children[0]!.unload();
			expect(s.storeListeners(s.h)).toBe(1);
			vi.useFakeTimers();
			await s.h.app.tasks.create({ title: "A" });
			await vi.advanceTimersByTimeAsync(REFRESH_MS + 10);
			expect(titles(b.el)).toEqual(["A"]);
			expect(rows(a.el)).toHaveLength(0);
			children[1]!.unload();
			expect(s.storeListeners(s.h)).toBe(0);
			expect(s.sessionListeners()).toBe(0);
		});

		it("a block loaded again after the last one went subscribes again", async () => {
			const s = await setup();
			s.block("");
			children.splice(0)[0]!.unload();
			expect(s.storeListeners(s.h)).toBe(0);
			const b = s.block("");
			expect(s.storeListeners(s.h)).toBe(1);
			vi.useFakeTimers();
			await s.h.app.tasks.create({ title: "A" });
			await vi.advanceTimersByTimeAsync(REFRESH_MS + 10);
			expect(titles(b.el)).toEqual(["A"]);
		});
	});

	describe("opening", () => {
		it("a click on a row opens that task in the app", async () => {
			const s = await setup();
			const a = (await s.h.app.tasks.create({ title: "A" })).task;
			const { el } = s.block("");
			rows(el)[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
			expect(s.openTask).toHaveBeenCalledWith(a.id);
		});

		it("Open in Logwell opens the view that matches the filters", async () => {
			const s = await setup();
			const work = await s.h.app.categories.create("Work");
			const { el } = s.block("list: Work\ndue: today");
			el.querySelector<HTMLButtonElement>('button[aria-label="Open in Logwell"]')!.click();
			expect(s.openView).toHaveBeenCalledWith({ kind: "category", id: work.id });
		});

		it("Open in Logwell with filters that match no view opens the app without one", async () => {
			const s = await setup();
			const { el } = s.block("priority: high");
			el.querySelector<HTMLButtonElement>('button[aria-label="Open in Logwell"]')!.click();
			expect(s.openView).toHaveBeenCalledWith(null);
		});

		it("Open in Logwell works with no database", async () => {
			const s = await setup();
			s.setSession(null);
			const { el } = s.block("list: Work");
			el.querySelector<HTMLButtonElement>('button[aria-label="Open in Logwell"]')!.click();
			expect(s.openView).toHaveBeenCalledWith(null);
		});
	});

	describe("the day rolling over", () => {
		it("a block redraws after midnight without any change event", async () => {
			vi.useFakeTimers();
			const s = await setup();
			await s.h.app.tasks.create({ title: "Due", scheduled: { kind: "date", date: "2026-10-02" } });
			const { el } = s.block("scheduled: today");
			expect(text(el)).toBe("No tasks found.");
			s.h.clock.set("2026-10-02T10:00:00.000Z");
			await vi.advanceTimersByTimeAsync(TICK_MS + REFRESH_MS + 10);
			expect(titles(el)).toEqual(["Due"]);
		});

		it("a due block follows the day for a deadline", async () => {
			vi.useFakeTimers();
			const s = await setup();
			await s.h.app.tasks.create({ title: "Deadline", deadline: { kind: "date", date: "2026-10-02" }, scheduled: { kind: "date", date: "2026-10-01" } });
			const { el } = s.block("due: today");
			expect(text(el)).toBe("No tasks found.");
			s.h.clock.set("2026-10-02T10:00:00.000Z");
			await vi.advanceTimersByTimeAsync(TICK_MS + REFRESH_MS + 10);
			expect(titles(el)).toEqual(["Deadline"]);
		});

		it("runs one interval for all blocks, about once a minute", async () => {
			vi.useFakeTimers();
			const s = await setup();
			s.block("");
			s.block("priority: high");
			s.block("priority: low");
			expect(vi.getTimerCount()).toBe(1);
			expect(TICK_MS).toBe(60_000);
		});

		it("a tick on an unchanged day redraws nothing", async () => {
			vi.useFakeTimers();
			const s = await setup();
			await s.h.app.tasks.create({ title: "A" });
			s.block("");
			const before = runs();
			await vi.advanceTimersByTimeAsync(TICK_MS * 5);
			expect(runs() - before).toBe(0);
			expect(vi.getTimerCount()).toBe(1);
		});

		it("drops the interval with the last block and starts it again with the next", async () => {
			vi.useFakeTimers();
			const s = await setup();
			s.block("");
			s.block("");
			children[0]!.unload();
			expect(vi.getTimerCount()).toBe(1);
			children[1]!.unload();
			expect(vi.getTimerCount()).toBe(0);
			s.block("");
			expect(vi.getTimerCount()).toBe(1);
		});

		it("keeps the interval in a window that still has a block when the block that started it unloads", async () => {
			const intervals: { win: string; fn: () => void }[] = [];
			const cleared: string[] = [];
			const fakeWin = (name: string) => ({
				setTimeout: () => 1,
				clearTimeout: () => undefined,
				setInterval: (fn: () => void) => {
					intervals.push({ win: name, fn });
					return intervals.length;
				},
				clearInterval: () => void cleared.push(name),
			});
			const s = await setup();
			currentWin = fakeWin("popout");
			s.block("");
			currentWin = fakeWin("main");
			s.block("");
			expect(intervals.map((i) => i.win)).toEqual(["popout"]);
			// The popout window closes: its block unloads, and the other window's block still gets the tick.
			children[0]!.unload();
			expect(cleared).toEqual(["popout"]);
			expect(intervals.map((i) => i.win)).toEqual(["popout", "main"]);
		});
	});

	describe("the plugin unloading", () => {
		it("stops every live block: no tree, a message instead, and no listener or timer left", async () => {
			const s = await setup();
			await s.h.app.tasks.create({ title: "A" });
			vi.useFakeTimers();
			const a = s.block("");
			const b = s.block("priority: high");
			await s.h.app.tasks.create({ title: "B" });
			expect(vi.getTimerCount()).toBeGreaterThan(0);
			s.plugin.unload();
			expect(NOT_RUNNING_TEXT).toBe("Logwell is not running.");
			for (const { el } of [a, b]) {
				expect(el.querySelector(".cp-task-row")).toBeNull();
				expect(el.textContent).toBe("Logwell is not running.");
			}
			expect(vi.getTimerCount()).toBe(0);
			expect(s.storeListeners(s.h)).toBe(0);
			expect(s.sessionListeners()).toBe(0);
			expect(FakeObserver.instances.every((o) => o.disconnected)).toBe(true);
			// Nothing draws afterwards, and a late unload of a block does not throw.
			const before = renders();
			await s.h.app.tasks.create({ title: "C" });
			s.setSession({ app: s.h.app, host: s.host });
			await vi.advanceTimersByTimeAsync(REFRESH_MS + TICK_MS);
			expect(renders()).toBe(before);
			expect(() => children.splice(0).forEach((c) => c.unload())).not.toThrow();
			expect(a.el.childNodes).toHaveLength(0);
		});

		it("unmounts the Preact trees", async () => {
			const s = await setup();
			await s.h.app.tasks.create({ title: "A" });
			s.block("");
			drawn.trees.length = 0;
			s.plugin.unload();
			expect(drawn.trees.some((tree) => tree === null)).toBe(true);
		});

		it("registers the cleanup with the plugin once, not once per block", async () => {
			const s = await setup();
			s.block("");
			s.block("");
			s.plugin.unload();
			s.plugin.unload();
			expect(s.sessionListeners()).toBe(0);
		});
	});

	describe("settings", () => {
		it("a change of the accent redraws the block with the new accent class", async () => {
			const s = await setup();
			const { el } = s.block("");
			expect(el.querySelector(".cp-block")!.classList.contains("cp-accent-theme")).toBe(true);
			vi.useFakeTimers();
			settings = { ...DEFAULT_SETTINGS, accent: "blue" };
			// The plugin tells the blocks about a settings change with the session event.
			s.setSession(s.env.session());
			await vi.advanceTimersByTimeAsync(REFRESH_MS + 10);
			const cls = el.querySelector(".cp-block")!.classList;
			expect(cls.contains("cp-accent-blue")).toBe(true);
			expect(cls.contains("cp-accent-theme")).toBe(false);
		});

		it("a settings event that changes nothing the block shows draws nothing", async () => {
			const s = await setup();
			s.block("");
			vi.useFakeTimers();
			s.setSession(s.env.session());
			expect(vi.getTimerCount()).toBe(0);
		});
	});

	describe("messages are not redrawn", () => {
		it("a parse error ignores every store change", async () => {
			const s = await setup();
			const { el } = s.block("colour: red");
			vi.useFakeTimers();
			await s.h.app.tasks.create({ title: "A" });
			await s.h.app.categories.create("Work");
			expect(vi.getTimerCount()).toBe(0);
			expect(text(el)).toContain("Unknown filter");
		});

		it("a list that does not exist ignores task changes, and waits for a list change", async () => {
			const s = await setup();
			const { el } = s.block("list: Work");
			expect(text(el)).toBe("No list named “Work”.");
			vi.useFakeTimers();
			await s.h.app.tasks.create({ title: "A" });
			expect(vi.getTimerCount()).toBe(0);
			await s.h.app.categories.create("Work");
			expect(vi.getTimerCount()).toBe(1);
			await vi.advanceTimersByTimeAsync(REFRESH_MS + 10);
			expect(text(el)).toBe("No tasks found.");
		});

		it("a query that throws is not run again for a change nothing reads", async () => {
			const s = await setup();
			vi.mocked(matcher.runBlockQuery).mockImplementationOnce(() => {
				throw new Error("boom");
			});
			const { el } = s.block("");
			expect(text(el)).toBe("boom");
			expect(el.querySelector(".cp-block-msg")!.classList.contains("is-error")).toBe(true);
			vi.useFakeTimers();
			await s.h.app.habits.create(habit);
			expect(vi.getTimerCount()).toBe(0);
			// A change it may read tries again.
			await s.h.app.tasks.create({ title: "A" });
			await vi.advanceTimersByTimeAsync(REFRESH_MS + 10);
			expect(titles(el)).toEqual(["A"]);
		});

		it("with no database, a settings event does not redraw the message", async () => {
			const s = await setup();
			s.setSession(null);
			const { el } = s.block("");
			expect(text(el)).toBe("Open a Logwell database to see tasks.");
			vi.useFakeTimers();
			s.setSession(null);
			expect(vi.getTimerCount()).toBe(0);
			await vi.advanceTimersByTimeAsync(REFRESH_MS + 10);
			expect(text(el)).toBe("Open a Logwell database to see tasks.");
		});
	});

	describe("blocks that cannot wait for the observer", () => {
		it("draws at once when the browser has no IntersectionObserver, even if not shown", async () => {
			const s = await setup();
			await s.h.app.tasks.create({ title: "A" });
			(window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = undefined;
			shown = false;
			const { el } = s.block("");
			expect(titles(el)).toEqual(["A"]);
			vi.useFakeTimers();
			await s.h.app.tasks.create({ title: "B" });
			await vi.advanceTimersByTimeAsync(REFRESH_MS + 10);
			expect(titles(el)).toEqual(["A", "B"]);
		});

		it("draws a block that is never attached to the document (a print or export render) after a moment", async () => {
			const s = await setup();
			await s.h.app.tasks.create({ title: "A" });
			vi.useFakeTimers();
			const { el } = s.block("", "Notes/Page.md", false);
			expect(el.isConnected).toBe(false);
			expect(rows(el)).toHaveLength(0);
			await vi.advanceTimersByTimeAsync(DETACHED_DRAW_MS + 10);
			expect(titles(el)).toEqual(["A"]);
		});

		it("a block that is attached within that moment is left to the observer", async () => {
			const s = await setup();
			await s.h.app.tasks.create({ title: "A" });
			vi.useFakeTimers();
			const { el } = s.block("", "Notes/Page.md", false);
			document.body.appendChild(el);
			elements.push(el);
			shown = false;
			await vi.advanceTimersByTimeAsync(DETACHED_DRAW_MS + 10);
			expect(rows(el)).toHaveLength(0);
			shown = true;
			FakeObserver.instances.at(-1)!.fire(true);
			await vi.advanceTimersByTimeAsync(0);
			expect(titles(el)).toEqual(["A"]);
		});

		it("still waits when it is in the document but not shown, and an observer exists", async () => {
			const s = await setup();
			await s.h.app.tasks.create({ title: "A" });
			shown = false;
			const { el } = s.block("");
			expect(rows(el)).toHaveLength(0);
		});
	});

	describe("changes that cannot alter the block", () => {
		const wait = (ms = REFRESH_MS + 10) => vi.advanceTimersByTimeAsync(ms);

		it("a new task that no filter of the block matches arms no timer and runs no query", async () => {
			const s = await setup();
			await s.h.app.tasks.create({ title: "High", priority: 1 });
			const { el } = s.block("priority: high");
			vi.useFakeTimers();
			const before = runs();
			await s.h.app.tasks.create({ title: "Low", priority: 3 });
			expect(vi.getTimerCount()).toBe(0);
			await wait();
			expect(runs() - before).toBe(0);
			expect(titles(el)).toEqual(["High"]);
		});

		it("an edit of a task outside the block's list does not wake it, one inside does", async () => {
			const s = await setup();
			const work = await s.h.app.categories.create("Work");
			const outside = (await s.h.app.tasks.create({ title: "Outside" })).task;
			const inside = (await s.h.app.tasks.create({ title: "Inside", categoryId: work.id })).task;
			const { el } = s.block("list: Work");
			vi.useFakeTimers();
			await s.h.app.tasks.update(outside.id, { title: "Outside 2" });
			expect(vi.getTimerCount()).toBe(0);
			await s.h.app.tasks.update(inside.id, { title: "Inside 2" });
			expect(vi.getTimerCount()).toBe(1);
			await wait();
			expect(titles(el)).toEqual(["Inside 2"]);
		});

		it("a task that enters the block (priority raised) redraws it", async () => {
			const s = await setup();
			const t = (await s.h.app.tasks.create({ title: "Low", priority: 3 })).task;
			const { el } = s.block("priority: high");
			vi.useFakeTimers();
			await s.h.app.tasks.update(t.id, { priority: 1 });
			await wait();
			expect(titles(el)).toEqual(["Low"]);
		});

		it("a task that leaves the block (priority lowered) redraws it", async () => {
			const s = await setup();
			const t = (await s.h.app.tasks.create({ title: "High", priority: 1 })).task;
			const { el } = s.block("priority: high");
			vi.useFakeTimers();
			await s.h.app.tasks.update(t.id, { priority: 3 });
			await wait();
			expect(text(el)).toBe("No tasks found.");
		});

		it("a task that enters through its date redraws a scheduled block", async () => {
			const s = await setup();
			const t = (await s.h.app.tasks.create({ title: "Later", scheduled: { kind: "date", date: "2026-12-01" } })).task;
			const { el } = s.block("scheduled: today");
			vi.useFakeTimers();
			await s.h.app.tasks.update(t.id, { scheduled: { kind: "date", date: "2026-10-01" } });
			await wait();
			expect(titles(el)).toEqual(["Later"]);
		});

		it("a completed or deleted shown task redraws the block", async () => {
			const s = await setup();
			const a = (await s.h.app.tasks.create({ title: "A" })).task;
			const b = (await s.h.app.tasks.create({ title: "B" })).task;
			const { el } = s.block("");
			vi.useFakeTimers();
			await s.h.app.tasks.complete(a.id);
			await s.h.app.tasks.delete(b.id);
			await wait(REFRESH_MS + 700);
			expect(text(el)).toBe("No tasks found.");
		});

		it("a new subtask under a shown task redraws the block, and the parent's count follows", async () => {
			const s = await setup();
			const parent = (await s.h.app.tasks.create({ title: "Parent", priority: 1 })).task;
			const { el } = s.block("priority: high");
			vi.useFakeTimers();
			await s.h.app.tasks.create({ title: "Child", parentId: parent.id });
			expect(vi.getTimerCount()).toBe(1);
			await wait();
			expect(rows(el)[0]!.querySelector(".cp-meta-subtasks")!.textContent.replace(/\s/g, "")).toBe("0/1");
		});

		it("renaming the parent of a shown subtask redraws the block", async () => {
			const s = await setup();
			const parent = (await s.h.app.tasks.create({ title: "Old name" })).task;
			await s.h.app.tasks.create({ title: "Child", parentId: parent.id, priority: 1 });
			const { el } = s.block("priority: high");
			expect(rows(el)[0]!.textContent).toContain("Old name");
			vi.useFakeTimers();
			await s.h.app.tasks.update(parent.id, { title: "New name" });
			expect(vi.getTimerCount()).toBe(1);
			await wait();
			expect(rows(el)[0]!.textContent).toContain("New name");
		});

		it("a change to a list, a section or a tag still redraws the block", async () => {
			const s = await setup();
			const work = await s.h.app.categories.create("Work");
			await s.h.app.tasks.create({ title: "A", categoryId: work.id });
			const { el } = s.block("");
			expect(el.querySelector(".cp-meta-list-name")!.textContent).toBe("Work");
			vi.useFakeTimers();
			await s.h.app.categories.update(work.id, { name: "Job" });
			await wait();
			expect(el.querySelector(".cp-meta-list-name")!.textContent).toBe("Job");
		});

		it("a second change while a redraw is pending is not looked at again", async () => {
			const s = await setup();
			await s.h.app.tasks.create({ title: "High", priority: 1 });
			s.block("priority: high");
			vi.useFakeTimers();
			await s.h.app.tasks.create({ title: "High 2", priority: 1 });
			expect(vi.getTimerCount()).toBe(1);
			await s.h.app.tasks.create({ title: "High 3", priority: 1 });
			expect(vi.getTimerCount()).toBe(1);
		});

		it("an undo of a change that did not matter does not wake the block either", async () => {
			const s = await setup();
			await s.h.app.tasks.create({ title: "High", priority: 1 });
			s.block("priority: high");
			const low = (await s.h.app.tasks.create({ title: "Low", priority: 3 })).task;
			vi.useFakeTimers();
			await s.h.app.tasks.update(low.id, { title: "Low 2" });
			await s.h.app.store.undo();
			expect(vi.getTimerCount()).toBe(0);
		});
	});

	describe("changes without a change list", () => {
		const wait = (ms = REFRESH_MS + 10) => vi.advanceTimersByTimeAsync(ms);
		/** The collections of the store with one task's title replaced, as an import or an outside edit would bring them. */
		const renamed = (h: AppHarness, id: string, title: string) => {
			const c = collectionsOf(h.store.data);
			const tasks = new Map(c.tasks);
			tasks.set(id, { ...tasks.get(id)!, title });
			return { ...c, tasks };
		};

		it("an external reload redraws a block whose rows changed", async () => {
			const s = await setup();
			const t = (await s.h.app.tasks.create({ title: "Before" })).task;
			const { el } = s.block("");
			vi.useFakeTimers();
			await s.h.store.replaceAll(renamed(s.h, t.id, "After"), null);
			s.h.app.store.notifyReloaded();
			await wait();
			expect(titles(el)).toEqual(["After"]);
		});

		it("a replace-all (import or merge) redraws a block whose rows changed", async () => {
			const s = await setup();
			const t = (await s.h.app.tasks.create({ title: "Before" })).task;
			const { el } = s.block("");
			vi.useFakeTimers();
			await s.h.app.store.replaceAll(renamed(s.h, t.id, "After"), null);
			await wait();
			expect(titles(el)).toEqual(["After"]);
		});

		it("a relevant change while hidden, then an irrelevant one, still draws the new rows when shown", async () => {
			const s = await setup();
			await s.h.app.tasks.create({ title: "A", priority: 1 });
			const { el } = s.block("priority: high");
			const observer = FakeObserver.instances.at(-1)!;
			shown = false;
			vi.useFakeTimers();
			await s.h.app.tasks.create({ title: "B", priority: 1 });
			await wait();
			await s.h.app.tasks.create({ title: "Low", priority: 3 });
			await wait();
			expect(titles(el)).toEqual(["A"]);
			shown = true;
			observer.fire(true);
			await flush();
			expect(titles(el)).toEqual(["A", "B"]);
		});
	});

	describe("redrawing", () => {
		const wait = (ms = REFRESH_MS + 10) => vi.advanceTimersByTimeAsync(ms);

		it("does not render again when the query returns the same rows and counts", async () => {
			const s = await setup();
			const parent = (await s.h.app.tasks.create({ title: "Parent", priority: 1 })).task;
			const child = (await s.h.app.tasks.create({ title: "Child", parentId: parent.id })).task;
			s.block("priority: high");
			vi.useFakeTimers();
			const queries = runs();
			const draws = renders();
			// The child is not shown, but it is a subtask of a shown task: the query runs, and finds the same list.
			await s.h.app.tasks.update(child.id, { title: "Child, renamed" });
			expect(vi.getTimerCount()).toBe(1);
			await wait();
			expect(runs() - queries).toBe(1);
			expect(renders() - draws).toBe(0);
		});

		it("renders when only a subtask count changed", async () => {
			const s = await setup();
			const parent = (await s.h.app.tasks.create({ title: "Parent", priority: 1 })).task;
			const child = (await s.h.app.tasks.create({ title: "Child", parentId: parent.id })).task;
			const { el } = s.block("priority: high");
			vi.useFakeTimers();
			const draws = renders();
			await s.h.app.tasks.complete(child.id);
			await wait();
			expect(renders() - draws).toBe(1);
			expect(rows(el)[0]!.querySelector(".cp-meta-subtasks")!.textContent.replace(/\s/g, "")).toBe("1/1");
		});

		it("renders when the day changed, even if the rows are the same", async () => {
			const s = await setup();
			await s.h.app.tasks.create({ title: "A" });
			s.block("");
			vi.useFakeTimers();
			const draws = renders();
			s.h.clock.set("2026-10-02T10:00:00.000Z");
			s.setSession(s.env.session());
			await wait();
			expect(renders() - draws).toBe(1);
		});

		it("renders when the accent changed, even if the rows are the same", async () => {
			const s = await setup();
			await s.h.app.tasks.create({ title: "A" });
			s.block("");
			vi.useFakeTimers();
			const draws = renders();
			settings = { ...DEFAULT_SETTINGS, accent: "blue" };
			s.setSession(s.env.session());
			await wait();
			expect(renders() - draws).toBe(1);
		});
	});
});

describe("subtask counts", () => {
	// Issue 75: a task block reads the subtask counts of its shown parents from the task index (`subtaskCounts()`),
	// not from a pass over every task of its own.

	beforeAll(() => {
		const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
		proto.empty = function (this: HTMLElement) {
			this.replaceChildren();
		};
		Object.defineProperty(HTMLElement.prototype, "win", { configurable: true, get: () => window });
		Object.defineProperty(HTMLElement.prototype, "doc", { configurable: true, get: () => document });
		proto.createDiv = function (this: HTMLElement, o: { cls: string }) {
			const el = this.ownerDocument.createElement("div");
			el.className = o.cls;
			this.appendChild(el);
			return el;
		};
		proto.isShown = function (this: HTMLElement) {
			return this.isConnected;
		};
		vi.stubGlobal("IntersectionObserver", undefined);
		(window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = undefined;
	});
	afterAll(() => {
		vi.unstubAllGlobals();
		for (const key of ["empty", "win", "doc", "createDiv", "isShown"]) Reflect.deleteProperty(HTMLElement.prototype, key);
	});

	const children: { unload(): void }[] = [];
	const elements: HTMLElement[] = [];
	afterEach(() => {
		vi.useRealTimers();
		for (const c of children.splice(0)) c.unload();
		for (const e of elements.splice(0)) e.remove();
	});

	async function setup() {
		const h = await appHarness();
		const host = new U1Host(h);
		const plugin = new Plugin({}, {});
		const session = { app: h.app, host };
		const env: BlockEnv = { session: () => session, onSession: () => () => undefined, settings: () => DEFAULT_SETTINGS, openTask: () => undefined, openView: () => undefined };
		registerDashboardBlock(plugin as never, env);
		const processor = plugin.codeBlockProcessors.get(BLOCK_LANGUAGE)!;
		const block = (source: string) => {
			const el = document.createElement("div");
			document.body.appendChild(el);
			elements.push(el);
			processor(source, el, { sourcePath: "Note.md", addChild: (c: { load(): void; unload(): void }) => (children.push(c), c.load()) });
			return el;
		};
		return { h, block };
	}

	const badge = (el: HTMLElement, title: string) =>
		[...el.querySelectorAll<HTMLElement>(".cp-task-row")]
			.find((r) => r.querySelector(".cp-task-title")!.textContent.trim() === title)
			?.querySelector(".cp-meta-subtasks")
			?.textContent.replace(/\s/g, "");

	describe("#75: a task block's subtask counts", () => {
		it("reads them from the task index in a draw, and the badge matches", async () => {
			const { h, block } = await setup();
			const parent = (await h.app.tasks.create({ title: "Parent", priority: 1 })).task;
			const done = (await h.app.tasks.create({ title: "Done", parentId: parent.id })).task;
			await h.app.tasks.create({ title: "Open", parentId: parent.id });
			await h.app.tasks.complete(done.id);
			await h.app.tasks.create({ title: "Other", priority: 1 });
			const spy = vi.spyOn(h.app.tasks.lists, "subtaskCounts");
			const el = block("priority: high");
			// Once for the block's check of what changed, once by the list for its badges.
			expect(spy).toHaveBeenCalledTimes(2);
			expect(badge(el, "Parent")).toBe("1/2");
			expect(badge(el, "Other")).toBeUndefined();
		});

		it("follows a change of a count in the next draw", async () => {
			const { h, block } = await setup();
			const parent = (await h.app.tasks.create({ title: "Parent" })).task;
			const child = (await h.app.tasks.create({ title: "Child", parentId: parent.id })).task;
			const el = block("");
			expect(badge(el, "Parent")).toBe("0/1");
			vi.useFakeTimers();
			await h.app.tasks.complete(child.id);
			await vi.advanceTimersByTimeAsync(REFRESH_MS + 10);
			expect(badge(el, "Parent")).toBe("1/1");
		});
	});
});
