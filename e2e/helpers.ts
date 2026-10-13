import { readFileSync } from "node:fs";
import { browser } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";

export const DB_PATH = "Checkpoint.cpbase";

/**
 * The pristine empty database. Specs write it over the vault copy, so a
 * test-vault/ that was opened by hand (and changed) cannot leak into tests.
 */
const SEED_DB = readFileSync(new URL("./fixtures/seed.cpbase", import.meta.url), "utf8");

/**
 * Resets the vault copy to the seeded test-vault/ state and opens the test
 * database as the active one. Call in `beforeEach` so specs are independent.
 */
export async function freshDatabase(): Promise<void> {
	await closeLeftoverMenus();
	// Close the session first, so resetting the file is not seen as an external edit.
	await browser.executeObsidian(async ({ plugins }) => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await (plugins as any).logwell.setActiveDatabase("");
	});
	await obsidianPage.resetVault();
	// The test window is about 1024 px wide. Collapse Obsidian's side docks so the app gets
	// the full width (sidebar visible above the 800 px breakpoint, as on a laptop).
	await browser.executeObsidian(({ app }) => {
		app.workspace.leftSplit.collapse();
		app.workspace.rightSplit.collapse();
	});
	await browser.executeObsidian(async ({ app, plugins }, dbPath, seed) => {
		// A new dbId per test: backups, journal and "last written" state live
		// outside the vault and would otherwise leak between tests.
		const file = app.vault.getFileByPath(dbPath);
		if (file === null) throw new Error("missing seed database");
		await app.vault.process(file, () => seed.replace(/"dbId":"[^"]+"/, `"dbId":"${crypto.randomUUID()}"`));
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const plugin = (plugins as any).logwell;
		await plugin.setActiveDatabase(dbPath);
		await plugin.ready();
		// Count reloads so specs can tell a silent reload from an ignored self-write.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const w = window as any;
		w.__cpReloads = 0;
		const store = plugin.session.app.store;
		const original = store.notifyReloaded.bind(store);
		store.notifyReloaded = () => {
			w.__cpReloads++;
			original();
		};
	}, DB_PATH, SEED_DB);
}

/**
 * Closes a DOM menu a previous spec left open (the Lists and Tags menus show themselves
 * again after a pick, so a spec that ended mid-loop leaves one), so it cannot take focus or key
 * presses from the next spec. Add-bar popovers are Preact-owned and go with the view when the database is reset.
 */
export async function closeLeftoverMenus(): Promise<void> {
	await browser.execute(() => {
		for (const el of Array.from(document.querySelectorAll(".menu"))) el.remove();
	});
}

/** Flushes pending saves so the file on disk matches memory. */
export async function flush(): Promise<void> {
	await browser.executeObsidian(async ({ plugins }) => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await (plugins as any).logwell.session?.store.flush();
	});
}

export async function readVaultFile(path: string): Promise<string> {
	return browser.executeObsidian(async ({ app }, p) => app.vault.adapter.read(p), path);
}

export async function reloadCount(): Promise<number> {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return browser.execute(() => (window as any).__cpReloads as number);
}

export async function conflictCount(): Promise<number> {
	return browser.executeObsidian(async ({ plugins }) => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const list = await (plugins as any).logwell.session.store.listConflicts();
		return list.length as number;
	});
}

/** Creates a task through the app service and returns its ID. */
export async function createTask(title: string, extra: Record<string, unknown> = {}): Promise<string> {
	return browser.executeObsidian(
		async ({ plugins }, t, x) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const r = await (plugins as any).logwell.session.app.tasks.create({ title: t, ...x });
			return r.task.id as string;
		},
		title,
		extra,
	);
}

/** The task record, or null when it does not exist. */
export async function getTask(id: string): Promise<Record<string, unknown> | null> {
	return browser.executeObsidian(({ plugins }, taskId) => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const task = (plugins as any).logwell.session.app.store.state.tasks.get(taskId);
		return task === undefined ? null : JSON.parse(JSON.stringify(task));
	}, id);
}

export async function markdownCount(): Promise<number> {
	return browser.executeObsidian(({ app }) => app.vault.getMarkdownFiles().length);
}

export async function pause(ms: number): Promise<void> {
	await browser.pause(ms);
}

/** Opens Quick Add with the command and returns the modal (scope further queries to it). */
export async function openQuickAdd(): Promise<WebdriverIO.Element> {
	await browser.executeObsidian(({ app }) => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(app as any).commands.executeCommandById("logwell:quick-add-task");
	});
	await browser.$(".checkpoint-quick-add-modal").waitForExist({ timeout: 5000, timeoutMsg: "Quick Add did not open" });
	const modals = await browser.$$(".checkpoint-quick-add-modal");
	for (const modal of modals) return modal;
	throw new Error("Quick Add did not open");
}

/** Closes any open Quick Add modal, so one spec cannot leak into the next. */
export async function closeQuickAdd(): Promise<void> {
	// Obsidian 1.13 renders the close control as `.modal-header-button` (older builds: `.modal-close-button`).
	for (let i = 0; i < 5; i++) {
		const open = await browser.execute(() => {
			const modals = Array.from(document.querySelectorAll<HTMLElement>(".checkpoint-quick-add-modal"));
			for (const m of modals) m.querySelector<HTMLElement>(".modal-close-button, .modal-header-button")?.click();
			return modals.length;
		});
		if (open === 0) return;
		await browser.pause(100);
	}
}

/** Every task in the active database, as plain objects. */
export async function allTasks(): Promise<Record<string, unknown>[]> {
	return browser.executeObsidian(({ plugins }) => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const tasks = (plugins as any).logwell.session.app.store.state.tasks;
		return JSON.parse(JSON.stringify([...tasks.values()]));
	});
}

/** Creates a category through the app service and returns its ID. */
export async function createCategory(name: string): Promise<string> {
	return browser.executeObsidian(async ({ plugins }, n) => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const c = await (plugins as any).logwell.session.app.categories.create(n);
		return c.id as string;
	}, name);
}

// -- Tasks section and settings helpers ---------------------------------------------------------------------------

/** Opens the app and returns the visible Tasks section (background tabs keep hidden copies). */
export async function visibleTasksSection(): Promise<WebdriverIO.Element> {
	await browser.executeObsidian(async ({ plugins }) => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await (plugins as any).logwell.openApp("tasks");
	});
	let section: WebdriverIO.Element | undefined;
	await browser.waitUntil(
		async () => {
			for (const el of await browser.$$(".cp-tasks")) if (await el.isDisplayed()) section = el;
			return section !== undefined;
		},
		{ timeout: 5000, timeoutMsg: "no visible Tasks section" },
	);
	return section!;
}

/** Shows the Inbox list (it has no preset date, unlike Today). */
export async function showInbox(section: WebdriverIO.Element): Promise<void> {
	await section.$(".cp-sidebar").$(`.//*[normalize-space(text())="Inbox"]`).click();
}

/** Today's date in the plugin's zone, as the app computes it. */
export async function appToday(): Promise<string> {
	return browser.executeObsidian(({ plugins }) => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return (plugins as any).logwell.session.app.queryContext().today as string;
	});
}

/** Adds days to a YYYY-MM-DD date (calendar arithmetic, no zone involved). */
export function plusDays(date: string, days: number): string {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

/** Changes a plugin setting the way the settings tab does and waits for the view to re-render. */
export async function setPluginSetting(key: string, value: unknown): Promise<void> {
	await browser.executeObsidian(
		async ({ plugins }, k, v) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const plugin = (plugins as any).logwell;
			plugin.settings = { ...plugin.settings, [k]: v };
			await plugin.saveSettings();
			await plugin.onSettingChanged(k);
		},
		key,
		value,
	);
	await browser.pause(300);
}

/** The platform's Mod key as WebDriver names it. */
export const MOD_KEY = process.platform === "darwin" ? "Meta" : "Control";

// -- Calendar helpers -----------------------------------------------------------------------

export type WeekStartSetting = "MO" | "SU" | "SA";

/** The display zone the app uses (the "Time zone" setting, or the device zone). */
export async function appZone(): Promise<string> {
	return browser.executeObsidian(({ plugins }) => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return (plugins as any).logwell.session.app.queryContext().zone as string;
	});
}

/** The "Week starts on" setting as the plugin holds it. */
export async function appWeekStart(): Promise<WeekStartSetting> {
	return browser.executeObsidian(({ plugins }) => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return (plugins as any).logwell.settings.weekStart as WeekStartSetting;
	});
}

/** The 7 dates of the week that holds `date`, honoring the week start (calendar arithmetic, no zone). */
export function weekDatesOf(date: string, weekStart: WeekStartSetting): string[] {
	const startIndex = { SU: 0, MO: 1, SA: 6 }[weekStart];
	const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
	const first = plusDays(date, -((dow - startIndex + 7) % 7));
	return Array.from({ length: 7 }, (_, i) => plusDays(first, i));
}

/** Opens the Calendar section and returns the visible `.cp-calendar` (background tabs keep hidden copies). */
export async function visibleCalendar(): Promise<WebdriverIO.Element> {
	await browser.executeObsidian(async ({ plugins }) => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await (plugins as any).logwell.openApp("calendar");
	});
	return waitForVisibleCalendar();
}

/** The visible `.cp-calendar`, waiting for it to show. */
export async function waitForVisibleCalendar(): Promise<WebdriverIO.Element> {
	let calendar: WebdriverIO.Element | undefined;
	await browser.waitUntil(
		async () => {
			calendar = undefined;
			for (const el of await browser.$$(".cp-calendar")) if (await el.isDisplayed()) calendar = el;
			return calendar !== undefined;
		},
		{ timeout: 5000, timeoutMsg: "no visible Calendar section" },
	);
	return calendar!;
}

/** A rail button of the visible app by its label ("Tasks", "Calendar", "Search", "Data"). */
export async function railButton(label: string): Promise<WebdriverIO.Element> {
	let button: WebdriverIO.Element | undefined;
	await browser.waitUntil(
		async () => {
			button = undefined;
			for (const rail of await browser.$$(".cp-rail")) {
				if (await rail.isDisplayed()) button = await rail.$(`button[aria-label="${label}"]`).getElement();
			}
			return button !== undefined;
		},
		{ timeout: 5000, timeoutMsg: `no visible rail button "${label}"` },
	);
	return button!;
}

// -- Matrix and drag helpers ----------------------------------------------------------------

/** Opens the Matrix section and returns the visible `.cp-matrix` (background tabs keep hidden copies). */
export async function visibleMatrix(): Promise<WebdriverIO.Element> {
	await browser.executeObsidian(async ({ plugins }) => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await (plugins as any).logwell.openApp("matrix");
	});
	return waitForVisibleMatrix();
}

/** The visible `.cp-matrix`, waiting for it to show. */
export async function waitForVisibleMatrix(): Promise<WebdriverIO.Element> {
	let matrix: WebdriverIO.Element | undefined;
	await browser.waitUntil(
		async () => {
			matrix = undefined;
			for (const el of await browser.$$(".cp-matrix")) if (await el.isDisplayed()) matrix = el;
			return matrix !== undefined;
		},
		{ timeout: 5000, timeoutMsg: "no visible Matrix section" },
	);
	return matrix!;
}

export interface ViewportPoint {
	x: number;
	y: number;
}

/** An element or the chainable promise `$()` returns. */
export type ElementLike = WebdriverIO.Element | ChainablePromiseElement;

/** The viewport rectangle of an element. */
export async function rectOf(el: ElementLike): Promise<{ left: number; top: number; right: number; bottom: number; width: number; height: number }> {
	const element = await el;
	return browser.execute((e) => {
		const r = (e as unknown as HTMLElement).getBoundingClientRect();
		return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
	}, element);
}

/** The center of an element in viewport coordinates, rounded to whole pixels. */
export async function centerOf(el: ElementLike): Promise<ViewportPoint> {
	const r = await rectOf(el);
	return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
}

/**
 * Resolves once the element's rectangle is the same on two reads in a row, so no render or scroll is
 * still moving it. A condition wait, not a sleep.
 */
export async function waitForStableRect(el: ElementLike): Promise<void> {
	let last = "";
	await browser.waitUntil(
		async () => {
			const r = await rectOf(el);
			const key = [r.left, r.top, r.width, r.height].join(",");
			const same = key === last;
			last = key;
			return same;
		},
		{ timeout: 5000, interval: 50, timeoutMsg: "the element kept moving" },
	);
}

/** How long (ms) the real pointer must have been silent before a drag may start. */
const QUIET_MS = 300;

/**
 * Waits until no pointermove has reached the window for QUIET_MS. Pointer events that are not ours mean the
 * real mouse is moving over the window (logged: a trusted, button-less glide that starts while the window
 * is being created, or whenever a hand touches the mouse). Chromium drops pointer capture when such an
 * event arrives during a synthetic drag, which ends the drag. The first call installs the window-level
 * counter and parks the WebDriver pointer inside the window; a condition wait, not a sleep or a retry.
 */
export async function waitForQuietPointer(): Promise<void> {
	const installed = await browser.execute(() => {
		const w = window as unknown as { __cpLastMove?: number };
		if (w.__cpLastMove !== undefined) return true;
		w.__cpLastMove = performance.now();
		window.addEventListener("pointermove", () => (w.__cpLastMove = performance.now()), true);
		// Our synthetic moves use whole pixels; a real device reports fractions (and no button while we hold one).
		(w as unknown as { __cpForeign: number }).__cpForeign = 0;
		window.addEventListener(
			"pointermove",
			(e) => {
				if (!Number.isInteger(e.clientX) || !Number.isInteger(e.clientY)) (w as unknown as { __cpForeign: number }).__cpForeign++;
			},
			true,
		);
		return false;
	});
	if (!installed) await mouse().move({ x: 10, y: 10, duration: 0 }).perform();
	await browser.waitUntil(
		async () =>
			browser.execute((quiet) => performance.now() - ((window as unknown as { __cpLastMove: number }).__cpLastMove ?? 0) >= quiet, QUIET_MS),
		{ timeout: 20000, interval: 50, timeoutMsg: "the real mouse keeps moving over the test window; leave it alone while e2e runs" },
	);
}

const mouse = () => browser.action("pointer", { parameters: { pointerType: "mouse" } });

/**
 * Presses the mouse at `from`, moves to `to` in `steps` intermediate moves (so the 4 px drag threshold is
 * passed and the hit tests see the way) and releases there, unless `release` is false (then the mouse
 * stays down; finish with `releaseMouse`). Coordinates are viewport pixels.
 */
export async function dragPointer(
	from: ViewportPoint | (() => Promise<ViewportPoint>),
	to: ViewportPoint | ((from: ViewportPoint) => Promise<ViewportPoint>),
	opts: { steps?: number; release?: boolean } = {},
): Promise<void> {
	const steps = opts.steps ?? 6;
	// The whole gesture takes tens of milliseconds, not a quarter of a second: a real mouse move over the
	// window (the cursor is not ours) ends the drag, because Chromium releases pointer capture when an
	// event arrives with no button down. A short gesture leaves that far less time to happen.
	await waitForQuietPointer();
	// Measure immediately before pressing: a render or a scroll between an earlier measurement and the
	// press would leave the pointer on the wrong spot. Functions are called here, right before perform().
	const start = typeof from === "function" ? await from() : from;
	const end = typeof to === "function" ? await to(start) : to;
	await browser.execute(() => ((window as unknown as { __cpForeign: number }).__cpForeign = 0));
	const chain = mouse().move({ x: start.x, y: start.y, duration: 0 }).down({ button: 0 });
	for (let i = 1; i <= steps; i++) {
		chain.move({ x: Math.round(start.x + ((end.x - start.x) * i) / steps), y: Math.round(start.y + ((end.y - start.y) * i) / steps), duration: 8 });
	}
	if (opts.release !== false) chain.up({ button: 0 });
	// wdio releases all input sources after perform() unless told to skip; a held button must survive.
	await chain.perform(opts.release === false);
	if (opts.release !== false) await browser.releaseActions();
	const foreign = await browser.execute(() => (window as unknown as { __cpForeign: number }).__cpForeign);
	if (foreign > 0) {
		throw new Error(`the real mouse moved over the test window during the drag (${foreign} events); a drag cannot be tested while the cursor is touched`);
	}
}

/** Releases a mouse button that `dragPointer(..., { release: false })` left down. */
export async function releaseMouse(): Promise<void> {
	await mouse().up({ button: 0 }).perform();
}

// -- View menu helpers ---------------------------------------------------------------

/**
 * Turns Obsidian's native menus off, because on macOS WebDriver cannot see them, and returns the
 * previous value for `restoreMenus`. Keep it off for the whole test: the Lists and Tags menus show
 * themselves again after each pick.
 */
export async function useDomMenus(): Promise<boolean | undefined> {
	return browser.executeObsidian(({ app }) => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const vault = app.vault as any;
		const was = vault.getConfig("nativeMenus") as boolean | undefined;
		vault.setConfig("nativeMenus", false);
		return was;
	});
}

export async function restoreMenus(was: boolean | undefined): Promise<void> {
	await browser.executeObsidian(({ app }, value) => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const vault = app.vault as any;
		// WebDriver turns undefined into null. Obsidian's setConfig(key, undefined) deletes the key (checked in 1.13.7),
		// and getConfig then falls back to its default; null would be stored as null.
		vault.setConfig("nativeMenus", value === null || value === undefined ? undefined : value);
	}, was);
}

/** Clicks the ⋯ "View options" button of the visible section (`.cp-tasks`, `.cp-calendar` or `.cp-matrix`). */
export async function openViewMenu(section: ".cp-tasks" | ".cp-calendar" | ".cp-matrix"): Promise<void> {
	const clicked = await browser.execute((sel) => {
		const root = Array.from(document.querySelectorAll<HTMLElement>(sel)).find((e) => e.offsetParent !== null);
		const button = root?.querySelector<HTMLElement>('[aria-label="View options"]');
		if (button === null || button === undefined) return false;
		button.click();
		return true;
	}, section);
	if (!clicked) throw new Error(`no View options button in ${section}`);
	await browser.waitUntil(async () => (await menuTitles()).length > 0, { timeout: 5000, timeoutMsg: "the view menu did not open" });
}

/** The titles of the open DOM menu. */
export async function menuTitles(): Promise<string[]> {
	return browser.execute(() => Array.from(document.querySelectorAll(".menu .menu-item-title")).map((e) => e.textContent ?? ""));
}

/**
 * Clicks the open menu's item with this title, waiting for it to appear.
 *
 * Obsidian's Menu.showAtPosition loads the menu (and pushes its key scope) in a setTimeout(0). A click that
 * lands before that timer has run hides the menu first, and the late load then leaves a scope on the key stack
 * that eats Enter and Escape. Yielding one macrotask first means that timer, which was queued
 * earlier, has run. A person cannot click that fast; a script can.
 */
export async function pickMenuItem(title: string): Promise<void> {
	await browser.executeAsync((done) => {
		window.setTimeout(done, 0);
	});
	await browser.waitUntil(
		() =>
			browser.execute((t) => {
				const item = Array.from(document.querySelectorAll<HTMLElement>(".menu .menu-item")).find((e) => e.querySelector(".menu-item-title")?.textContent === t);
				if (item === undefined) return false;
				item.click();
				return true;
			}, title),
		{ timeout: 5000, timeoutMsg: `no menu item "${title}"` },
	);
}

// -- Board helpers ----------------------------------------------------------------------------

/** Clicks a sidebar view ("Today", "Upcoming", "Inbox") of the visible Tasks section. */
export async function showSidebarView(section: WebdriverIO.Element, label: string): Promise<void> {
	await section.$(".cp-sidebar").$(`.//*[normalize-space(text())="${label}"]`).click();
	await browser.waitUntil(async () => (await section.$(".cp-main-title").getText()) === label, {
		timeout: 5000,
		timeoutMsg: `the ${label} view did not open`,
	});
}

/** Clicks the List or Board button of the layout switch and waits until the view shows that layout. */
export async function setLayout(section: WebdriverIO.Element, layout: "List" | "Board"): Promise<void> {
	await section.$(".cp-mode-switch").$(`button=${layout}`).click();
	await browser.waitUntil(async () => (await section.$(".cp-board").isExisting()) === (layout === "Board"), {
		timeout: 5000,
		timeoutMsg: `the view did not switch to ${layout}`,
	});
}

/** A board column of the section by id ("overdue", "today", a date, "none"). */
export function boardColumn(section: WebdriverIO.Element, id: string): ChainablePromiseElement {
	return section.$(`.cp-board-col[data-column="${id}"]`);
}

/** The task IDs of the open board cards of a column, top to bottom. */
export async function columnCardIds(section: WebdriverIO.Element, id: string): Promise<string[]> {
	const col = await boardColumn(section, id).getElement();
	return browser.execute(
		(el) => Array.from((el as unknown as HTMLElement).querySelectorAll<HTMLElement>(".cp-board-card")).map((c) => c.dataset.taskId ?? ""),
		col,
	);
}

/** The task IDs of the visible list rows, top to bottom. */
export async function listRowIds(section: WebdriverIO.Element): Promise<string[]> {
	const root = await section.getElement();
	return browser.execute(
		(el) => Array.from((el as unknown as HTMLElement).querySelectorAll<HTMLElement>(".cp-task-row")).map((r) => r.dataset.taskId ?? ""),
		root,
	);
}

/** Task IDs in the stored manual order (sortKey ascending), restricted to `ids`. */
export async function storedOrder(ids: string[]): Promise<string[]> {
	const tasks = await allTasks();
	return tasks
		.filter((t) => ids.includes(t.id as string))
		.sort((a, b) => ((a.sortKey as string) < (b.sortKey as string) ? -1 : (a.sortKey as string) > (b.sortKey as string) ? 1 : 0))
		.map((t) => t.id as string);
}

// -- Section helpers --------------------------------------------------------------------------

/** Creates a section through the app service and returns its ID. */
export async function createSectionDirect(categoryId: string, name: string): Promise<string> {
	return browser.executeObsidian(
		async ({ plugins }, c, n) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const s = await (plugins as any).logwell.session.app.sections.create(c, n);
			return s.id as string;
		},
		categoryId,
		name,
	);
}

/** The sections of one list, in stored order. */
export async function sectionsOf(categoryId: string): Promise<{ id: string; name: string }[]> {
	return browser.executeObsidian(({ plugins }, c) => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const list = (plugins as any).logwell.session.app.sections.inList(c) as { id: string; name: string }[];
		return list.map((s) => ({ id: s.id, name: s.name }));
	}, categoryId);
}

// -- Group-by helpers --------------------------------------------------------------------------

/** Opens the view menu, then "Group by…", and picks one option (List mode). */
export async function setGroupBy(option: "None" | "Section" | "Date" | "List" | "Priority" | "Tag"): Promise<void> {
	await openViewMenu(".cp-tasks");
	await pickMenuItem("Group by…");
	// The second menu shows on the next tick; "Section" or "Date" are not in the first menu, "None" is not either.
	await browser.waitUntil(async () => (await menuTitles()).includes(option), { timeout: 5000, timeoutMsg: `the Group by menu has no ${option}` });
	await pickMenuItem(option);
	await browser.waitUntil(async () => (await menuTitles()).length === 0, { timeout: 5000, timeoutMsg: "the menu did not close" });
}

/** The keys of the list groups shown in the section, in order ("priority:1", "nodate", "section:none", …). */
export async function groupKeys(section: WebdriverIO.Element): Promise<string[]> {
	const root = await section.getElement();
	return browser.execute(
		(el) => Array.from((el as unknown as HTMLElement).querySelectorAll<HTMLElement>(".cp-task-list [data-group-key]")).map((g) => g.dataset.groupKey ?? ""),
		root,
	);
}

// -- Habits helpers ---------------------------------------------------------------------------

export interface HabitSeed {
	name: string;
	icon?: string | null;
	color?: string | null;
	timeOfDay?: "morning" | "afternoon" | "evening" | "anytime";
	reminder?: { time: string } | null;
	goal: { type: "binary" | "count" | "quantity"; target: number; unit: string | null; period: "day" | "week" };
	schedule?: { kind: "daily" } | { kind: "weekdays"; days: string[] } | { kind: "weekly" };
}

/** Creates a habit through the app service (as of the plugin clock's today) and returns its ID. */
export async function createHabit(seed: HabitSeed): Promise<string> {
	return browser.executeObsidian(async ({ plugins }, s) => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const habit = await (plugins as any).logwell.session.app.habits.create({
			icon: null,
			color: null,
			timeOfDay: "anytime",
			reminder: null,
			schedule: { kind: "daily" },
			...s,
		});
		return habit.id as string;
	}, seed);
}

/** The active check-ins of a habit as `{ date, value }`, oldest first. */
export async function habitCheckins(id: string): Promise<{ date: string; value: number }[]> {
	return browser.executeObsidian(({ plugins }, habitId) => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const list = (plugins as any).logwell.session.app.habits.index().active(habitId) as { date: string; value: number }[];
		return list.map((c) => ({ date: c.date, value: c.value }));
	}, id);
}

/** Opens the Habits section and returns the visible `.cp-habits` (background tabs keep hidden copies). */
export async function visibleHabits(): Promise<WebdriverIO.Element> {
	await browser.executeObsidian(async ({ plugins }) => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await (plugins as any).logwell.openApp("habits");
	});
	let found: WebdriverIO.Element | undefined;
	await browser.waitUntil(
		async () => {
			found = undefined;
			for (const el of await browser.$$(".cp-habits")) if (await el.isDisplayed()) found = el;
			return found !== undefined;
		},
		{ timeout: 5000, timeoutMsg: "no visible Habits section" },
	);
	return found!;
}

/** The row of a habit on the Habits page or in the Today block, by its name. */
export function habitRow(scope: WebdriverIO.Element, name: string): ChainablePromiseElement {
	return scope.$(`.//div[contains(concat(" ", normalize-space(@class), " "), " cp-habit-row ")][.//*[contains(@class, "cp-habit-name")][normalize-space()="${name}"]]`);
}

// -- Recurrence helpers -----------------------------------------------------------------------

/** The texts of the notices on screen. */
export async function noticeTexts(): Promise<string[]> {
	return browser.execute(() => Array.from(document.querySelectorAll<HTMLElement>(".notice")).map((n) => n.textContent ?? ""));
}

/** Waits for a notice whose text contains `text` and returns the whole text. */
export async function waitForNotice(text: string): Promise<string> {
	let found = "";
	await browser.waitUntil(
		async () => {
			found = (await noticeTexts()).find((t) => t.includes(text)) ?? "";
			return found !== "";
		},
		{ timeout: 5000, timeoutMsg: `no notice with "${text}"` },
	);
	return found;
}

/** Clicks "Undo" on the newest notice that has one. */
export async function clickUndoNotice(): Promise<void> {
	await browser.waitUntil(
		() =>
			browser.execute(() => {
				const buttons = Array.from(document.querySelectorAll<HTMLElement>(".notice .checkpoint-notice-actions button")).filter((b) => b.textContent === "Undo");
				const last = buttons[buttons.length - 1];
				if (last === undefined) return false;
				last.click();
				return true;
			}),
		{ timeout: 5000, timeoutMsg: "no Undo notice" },
	);
}

/** The rule of the examples: every day. */
export const DAILY_RULE = { freq: "daily", interval: 1, weekdays: null, monthly: null, afterCompletion: false, time: null, tz: null } as const;

/** Creates a repeating task through the app service (the anchor is its `scheduled` date, else today) and returns its ID. */
export async function createRepeating(
	title: string,
	rule: Record<string, unknown>,
	extra: Record<string, unknown> = {},
	end?: Record<string, unknown>,
): Promise<string> {
	return createTask(title, { ...extra, repeat: end === undefined ? { rule } : { rule, end } });
}

/** Clicks with the DOM, so a floating notice cannot cover the target. */
export async function domClick(el: WebdriverIO.Element | ChainablePromiseElement): Promise<void> {
	const element = await el;
	await browser.execute((e) => (e as unknown as HTMLElement).click(), element);
}
