// The calendar in the real app.
// Tasks are seeded through the app services with dates relative to the real today, so they land in
// the current week whatever day the suite runs. Every DOM read is scoped to the visible calendar
// (background tabs keep hidden copies).
import { browser, expect } from "@wdio/globals";
import {
	type WeekStartSetting,
	appToday,
	appWeekStart,
	appZone,
	createTask,
	freshDatabase,
	railButton,
	restoreMenus,
	setPluginSetting,
	useDomMenus,
	visibleCalendar,
	waitForVisibleCalendar,
	weekDatesOf,
} from "../helpers";

// -- text helpers (mirror src/ui/calendar/format.ts) ---------------------------------------------

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Thu Oct 8", the day text of an entry's accessible name. */
function fmtDay(date: string): string {
	const d = new Date(`${date}T00:00:00Z`);
	return `${DOW[d.getUTCDay()]} ${MON[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// -- DOM reads, scoped to the visible calendar ------------------------------------------------------

interface EntryRead {
	id: string;
	/** Where the entry sits: the all-day row, a timed block in a day column, or a month cell. */
	place: "allday" | "block" | "month";
	/** The `data-date` of that cell or column. */
	date: string;
	classes: string;
	/** The accessible name (the visually hidden text). */
	name: string;
	/** The visible text. */
	body: string;
	start: string;
	len: string;
	col: string;
	cols: string;
	top: number;
	height: number;
	left: number;
	width: number;
	hostTop: number;
	hostLeft: number;
	hostHeight: number;
	hostWidth: number;
}

/** Entries of one task (or every entry when `taskId` is empty) in the visible calendar. */
async function readEntries(taskId = ""): Promise<EntryRead[]> {
	return browser.execute((id) => {
		const root = Array.from(document.querySelectorAll<HTMLElement>(".cp-calendar")).find((e) => e.offsetParent !== null);
		if (root === undefined) return [];
		const selector = id === "" ? ".cp-cal-entry" : `.cp-cal-entry[data-task-id="${id}"]`;
		return Array.from(root.querySelectorAll<HTMLElement>(selector)).map((el) => {
			const column = el.closest<HTMLElement>(".cp-cal-daycol");
			const allDay = el.closest<HTMLElement>(".cp-cal-allday-cell");
			const cell = el.closest<HTMLElement>(".cp-cal-cell");
			const host = column ?? allDay ?? cell;
			const r = el.getBoundingClientRect();
			const h = host?.getBoundingClientRect();
			return {
				id: el.getAttribute("data-task-id") ?? "",
				place: column !== null ? ("block" as const) : allDay !== null ? ("allday" as const) : ("month" as const),
				date: host?.getAttribute("data-date") ?? "",
				classes: el.className,
				name: el.querySelector(".cp-sr-only")?.textContent ?? "",
				body: el.querySelector(".cp-cal-entry-body")?.textContent ?? "",
				start: el.style.getPropertyValue("--cp-start"),
				len: el.style.getPropertyValue("--cp-len"),
				col: el.style.getPropertyValue("--cp-col"),
				cols: el.style.getPropertyValue("--cp-cols"),
				top: r.top,
				height: r.height,
				left: r.left,
				width: r.width,
				hostTop: h?.top ?? 0,
				hostLeft: h?.left ?? 0,
				hostHeight: h?.height ?? 0,
				hostWidth: h?.width ?? 0,
			};
		});
	}, taskId);
}

/** Waits until the predicate holds for the entries of a task, and returns them. */
async function waitForEntries(taskId: string, ok: (entries: EntryRead[]) => boolean, message: string): Promise<EntryRead[]> {
	let last: EntryRead[] = [];
	await browser.waitUntil(
		async () => {
			last = await readEntries(taskId);
			return ok(last);
		},
		{ timeout: 6000, timeoutMsg: message },
	);
	return last;
}

/** Text of the header title (`.cp-cal-title`) of the visible calendar. */
async function calendarTitle(): Promise<string> {
	return browser.execute(() => {
		const root = Array.from(document.querySelectorAll<HTMLElement>(".cp-calendar")).find((e) => e.offsetParent !== null);
		return root?.querySelector(".cp-cal-title")?.textContent ?? "";
	});
}

/** Clicks a control of the visible calendar by selector (a plain DOM click, so a scrolled-away or covered control still works). */
async function clickInCalendar(selector: string): Promise<void> {
	const found = await browser.execute((sel) => {
		const root = Array.from(document.querySelectorAll<HTMLElement>(".cp-calendar")).find((e) => e.offsetParent !== null);
		const el = root?.querySelector<HTMLElement>(sel);
		if (el === null || el === undefined) return false;
		el.click();
		return true;
	}, selector);
	if (!found) throw new Error(`no ${selector} in the visible calendar`);
}

async function countInCalendar(selector: string): Promise<number> {
	return browser.execute((sel) => {
		const root = Array.from(document.querySelectorAll<HTMLElement>(".cp-calendar")).find((e) => e.offsetParent !== null);
		return root?.querySelectorAll(sel).length ?? 0;
	}, selector);
}

async function focusInCalendar(selector: string): Promise<void> {
	const found = await browser.execute((sel) => {
		const root = Array.from(document.querySelectorAll<HTMLElement>(".cp-calendar")).find((e) => e.offsetParent !== null);
		const el = root?.querySelector<HTMLElement>(sel);
		if (el === null || el === undefined) return false;
		el.focus();
		return true;
	}, selector);
	if (!found) throw new Error(`no ${selector} in the visible calendar`);
}

/** The scroll position of the week grid, and how far it can scroll. */
async function gridScroll(): Promise<{ top: number; max: number }> {
	return browser.execute(() => {
		const root = Array.from(document.querySelectorAll<HTMLElement>(".cp-calendar")).find((e) => e.offsetParent !== null);
		const el = root?.querySelector<HTMLElement>(".cp-cal-scroller");
		return el === null || el === undefined ? { top: -1, max: -1 } : { top: el.scrollTop, max: el.scrollHeight - el.clientHeight };
	});
}

/** Wall-clock minutes since midnight in the zone, from the renderer's clock. */
async function nowMinutesIn(zone: string): Promise<number> {
	return browser.execute((z) => {
		const parts = new Intl.DateTimeFormat("en-GB", { timeZone: z, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
		const num = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
		return num("hour") * 60 + num("minute");
	}, zone);
}

async function setAppWidth(width: number | null): Promise<void> {
	await browser.execute((w) => {
		for (const el of Array.from(document.querySelectorAll<HTMLElement>(".cp-app"))) {
			if (el.offsetParent !== null) el.style.width = w === null ? "" : `${w}px`;
		}
	}, width);
	await browser.pause(200);
}

async function setTheme(mode: "light" | "dark"): Promise<void> {
	// Same switch as theme.e2e.ts: Obsidian's internal changeTheme, then the body classes the
	// plugin's rules key on. Obsidian can re-apply its own theme a moment later (seen once in three
	// full runs), so the classes are checked after a pause and forced again, at most 4 times.
	for (let attempt = 0; attempt < 4; attempt++) {
		await browser.executeObsidian(({ app }, m) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const a = app as any;
			if (typeof a.changeTheme === "function") a.changeTheme(m === "light" ? "moonstone" : "obsidian");
			document.body.classList.toggle("theme-light", m === "light");
			document.body.classList.toggle("theme-dark", m === "dark");
		}, mode);
		await browser.pause(400);
		const ok = await browser.execute((m) => document.body.classList.contains(`theme-${m}`) && !document.body.classList.contains(`theme-${m === "light" ? "dark" : "light"}`), mode);
		if (ok) return;
	}
}

// -- seeding --------------------------------------------------------------------------------------

interface Seed {
	today: string;
	zone: string;
	weekStart: WeekStartSetting;
	/** The 7 dates of the visible week. */
	days: string[];
	dateOnly: string;
	timed: string;
	noDuration: string;
	deadline: string;
	someday: string;
	/** Where the timed, no-duration and deadline tasks were placed. */
	timedDay: string;
	noDurationDay: string;
	deadlineDay: string;
}

/**
 * One task of each kind in the current week: a date-only task today, a 19:00 block of 45 minutes, a
 * 10:00 task with no duration, a task with only a deadline, and a task with no date at all.
 */
async function seedWeek(): Promise<Seed> {
	const today = await appToday();
	const zone = await appZone();
	const weekStart = await appWeekStart();
	const days = weekDatesOf(today, weekStart);
	const timedDay = days[2]!;
	const noDurationDay = days[3]!;
	const deadlineDay = days[4]!;
	const dateOnly = await createTask("Cal date-only", { scheduled: { kind: "date", date: today } });
	const timed = await createTask("Cal timed", {
		scheduled: { kind: "datetime", local: `${timedDay}T19:00`, tz: zone },
		plannedDurationMin: 45,
	});
	const noDuration = await createTask("Cal no duration", { scheduled: { kind: "datetime", local: `${noDurationDay}T10:00`, tz: zone } });
	const deadline = await createTask("Cal deadline only", { deadline: { kind: "date", date: deadlineDay } });
	const someday = await createTask("Cal someday");
	return { today, zone, weekStart, days, dateOnly, timed, noDuration, deadline, someday, timedDay, noDurationDay, deadlineDay };
}

async function detachAppLeaves(): Promise<void> {
	await browser.executeObsidian(({ app }) => {
		app.workspace.detachLeavesOfType("checkpoint-app");
	});
}

describe("Calendar", function () {
	let nativeMenus: boolean | undefined;
	before(async function () {
		// macOS shows native menus, which WebDriver cannot see; the view menu needs Obsidian's DOM menu.
		nativeMenus = await useDomMenus();
	});

	after(async function () {
		await restoreMenus(nativeMenus);
	});

	beforeEach(async function () {
		await freshDatabase();
		// A fresh view per test, so the calendar's own state (mode, anchor, scroll) never leaks.
		await detachAppLeaves();
	});

	afterEach(async function () {
		await setAppWidth(null);
		if ((await appWeekStart()) !== "MO") await setPluginSetting("weekStart", "MO");
	});

	it("opens from the rail and from the command, and starts in the week view", async function () {
		await browser.executeObsidian(async ({ plugins }) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			await (plugins as any).logwell.openApp("tasks");
		});
		// The rail: Tasks, Calendar, Matrix, Search, Data in that order.
		const labels = await browser.execute(() => {
			const rail = Array.from(document.querySelectorAll<HTMLElement>(".cp-rail")).find((e) => e.offsetParent !== null);
			return Array.from(rail?.querySelectorAll("button") ?? []).map((b) => b.getAttribute("aria-label"));
		});
		expect(labels).toEqual(["Tasks", "Calendar", "Focus", "Habits", "Matrix", "Search", "Data"]);

		await (await railButton("Calendar")).click();
		const calendar = await waitForVisibleCalendar();
		await expect(calendar.$(".cp-cal-week")).toBeDisplayed();
		await expect(calendar.$('.cp-cal-mode-btn[aria-pressed="true"]')).toHaveText("Week");
		expect(await countInCalendar(".cp-cal-dayhead")).toBe(7);
		await expect(await railButton("Calendar")).toHaveAttribute("aria-pressed", "true");

		// Back to Tasks, then the command brings the calendar back.
		await (await railButton("Tasks")).click();
		await browser.waitUntil(async () => (await browser.$$(".cp-calendar").filter((e) => e.isDisplayed())).length === 0, {
			timeout: 5000,
			timeoutMsg: "the calendar stayed visible after switching to Tasks",
		});
		await browser.executeObsidian(({ app }) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(app as any).commands.executeCommandById("logwell:open-calendar");
		});
		await waitForVisibleCalendar();
		await expect(await railButton("Calendar")).toHaveAttribute("aria-pressed", "true");
	});

	// Regression: `openApp(section)` on a tab that was not open yet showed Tasks, because the request
	// came before the app root registered its handle (SectionRelay queues it now).
	it("the Open calendar command on a closed tab shows the calendar", async function () {
		await browser.executeObsidian(async ({ plugins }) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			await (plugins as any).logwell.openApp("calendar");
		});
		await waitForVisibleCalendar();
	});

	it("renders date-only, timed, no-duration and deadline entries in the right place with the right names", async function () {
		const s = await seedWeek();
		await visibleCalendar();

		// The header title is the visible week, and today's header is marked.
		expect(await calendarTitle()).toMatch(/^[A-Z][a-z]{2} \d{1,2} – [A-Z][a-z]{2} \d{1,2}, \d{4}$|^[A-Z][a-z]{2} \d{1,2}, \d{4} – [A-Z][a-z]{2} \d{1,2}, \d{4}$/);
		const heads = await browser.execute(() => {
			const root = Array.from(document.querySelectorAll<HTMLElement>(".cp-calendar")).find((e) => e.offsetParent !== null);
			return Array.from(root?.querySelectorAll<HTMLElement>(".cp-cal-dayhead") ?? []).map((h) => ({
				date: h.getAttribute("data-date"),
				today: h.classList.contains("is-today"),
			}));
		});
		expect(heads.map((h) => h.date)).toEqual(s.days);
		expect(heads.filter((h) => h.today).map((h) => h.date)).toEqual([s.today]);

		// Date-only: the all-day cell of today.
		const [dateOnly] = await waitForEntries(s.dateOnly, (e) => e.length === 1, "date-only entry did not render");
		expect(dateOnly!.place).toBe("allday");
		expect(dateOnly!.date).toBe(s.today);
		expect(dateOnly!.name.startsWith(`Cal date-only, ${fmtDay(s.today)}, all day`)).toBe(true);

		// Timed: 19:00 for 45 minutes in its day column, at the hour row's offset and the right height.
		const [timed] = await waitForEntries(s.timed, (e) => e.length === 1, "timed block did not render");
		expect(timed!.place).toBe("block");
		expect(timed!.date).toBe(s.timedDay);
		expect(timed!.start).toBe("1140");
		expect(timed!.len).toBe("45");
		const hour = timed!.hostHeight / 24;
		expect(Math.abs(timed!.top - timed!.hostTop - hour * 19)).toBeLessThan(1.5);
		expect(Math.abs(timed!.height - (hour * 0.75 - 2))).toBeLessThan(1.5);
		expect(timed!.body).toContain("19:00–19:45");
		// The accessible name: "title, Thu Oct 8, 19:00–19:45", plus "overdue" once the block has ended.
		const timedExpected = `Cal timed, ${fmtDay(s.timedDay)}, 19:00–19:45`;
		expect([timedExpected, `${timedExpected}, overdue`]).toContain(timed!.name);

		// No duration: a dashed 30 minute block saying so.
		const [noDur] = await waitForEntries(s.noDuration, (e) => e.length === 1, "no-duration block did not render");
		expect(noDur!.place).toBe("block");
		expect(noDur!.date).toBe(s.noDurationDay);
		expect(noDur!.start).toBe("600");
		expect(noDur!.len).toBe("30");
		expect(noDur!.classes).toContain("is-noduration");
		expect(noDur!.body).toContain("no duration");
		expect(noDur!.name).toContain("no duration");
		expect(Math.abs(noDur!.top - noDur!.hostTop - hour * 10)).toBeLessThan(1.5);

		// Deadline: the all-day cell of its day, as a flag pill. A deadline before today is missed.
		const [deadline] = await waitForEntries(s.deadline, (e) => e.length === 1, "deadline flag did not render");
		expect(deadline!.place).toBe("allday");
		expect(deadline!.date).toBe(s.deadlineDay);
		expect(deadline!.classes).toContain("is-deadline");
		expect(deadline!.name.startsWith(`Cal deadline only, ${fmtDay(s.deadlineDay)}, deadline`)).toBe(true);
		const missed = s.deadlineDay < s.today;
		expect(deadline!.classes.includes("is-missed")).toBe(missed);
		expect(deadline!.name.includes("missed deadline")).toBe(missed);
		const hasFlag = await browser.execute((id) => {
			const root = Array.from(document.querySelectorAll<HTMLElement>(".cp-calendar")).find((e) => e.offsetParent !== null);
			return root?.querySelector(`.cp-cal-entry[data-task-id="${id}"] svg`) !== null;
		}, s.deadline);
		expect(hasFlag).toBe(true);

		// The task with no date is not on the grid.
		expect(await readEntries(s.someday)).toHaveLength(0);
	});

	it("starts scrolled to 07:00 or one hour before now, and keeps the offset across section switches", async function () {
		const zone = await appZone();
		// Open on Tasks first: the grid's first visit is when the section first becomes visible.
		await browser.executeObsidian(async ({ plugins }) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			await (plugins as any).logwell.openApp("tasks");
		});
		await (await railButton("Calendar")).click();
		await waitForVisibleCalendar();

		const nowMin = await nowMinutesIn(zone);
		let scroll = await gridScroll();
		expect(scroll.max).toBeGreaterThan(0);
		// The hour line at or before that, 7 px short, so that hour's label stays whole under the sticky rows (LABEL_PEEK_PX).
		const target = Math.min(Math.floor(Math.max(7 * 60, nowMin - 60) / 60) * 48 - 7, scroll.max);
		await browser.waitUntil(async () => Math.abs((await gridScroll()).top - target) <= 4, {
			timeout: 4000,
			timeoutMsg: `initial scroll was ${(await gridScroll()).top}, expected about ${target}`,
		});

		// The offset is remembered while another section is shown.
		await browser.execute(() => {
			const root = Array.from(document.querySelectorAll<HTMLElement>(".cp-calendar")).find((e) => e.offsetParent !== null);
			const el = root?.querySelector<HTMLElement>(".cp-cal-scroller");
			if (el !== null && el !== undefined) el.scrollTop = 100;
		});
		await browser.pause(300);
		scroll = await gridScroll();
		expect(Math.abs(scroll.top - 100)).toBeLessThan(2);
		await (await railButton("Tasks")).click();
		await (await railButton("Calendar")).click();
		await waitForVisibleCalendar();
		await browser.waitUntil(async () => Math.abs((await gridScroll()).top - 100) < 2, {
			timeout: 4000,
			timeoutMsg: `the scroll offset was not restored, got ${(await gridScroll()).top}`,
		});
	});

	it("shows the current-time line in today's column at the current time", async function () {
		const zone = await appZone();
		await seedWeek();
		await visibleCalendar();
		const info = await browser.execute(() => {
			const root = Array.from(document.querySelectorAll<HTMLElement>(".cp-calendar")).find((e) => e.offsetParent !== null);
			const lines = Array.from(root?.querySelectorAll<HTMLElement>(".cp-cal-now") ?? []);
			const line = lines[0];
			const col = line?.closest<HTMLElement>(".cp-cal-daycol");
			return {
				count: lines.length,
				inToday: col?.classList.contains("is-today") ?? false,
				start: Number(line?.style.getPropertyValue("--cp-start") ?? "-1"),
				top: line?.getBoundingClientRect().top ?? 0,
				colTop: col?.getBoundingClientRect().top ?? 0,
				colHeight: col?.getBoundingClientRect().height ?? 0,
			};
		});
		expect(info.count).toBe(1);
		expect(info.inToday).toBe(true);
		const nowMin = await nowMinutesIn(zone);
		// A few minutes of slack: the line moves once a minute.
		expect(Math.abs(info.start - nowMin)).toBeLessThanOrEqual(3);
		expect(Math.abs(info.top - info.colTop - (info.colHeight / 24) * (info.start / 60))).toBeLessThan(2);
	});

	it("limits the all-day row to three entries per day, keeps labels whole, keeps short blocks to one line and clears the status bar", async function () {
		const today = await appToday();
		const zone = await appZone();
		for (let i = 1; i <= 6; i++) await createTask(`Cal chore ${i}`, { scheduled: { kind: "date", date: today } });
		const short = await createTask("Cal a rather long title for a very short block", {
			scheduled: { kind: "datetime", local: `${today}T09:00`, tz: zone },
			plannedDurationMin: 15,
		});
		await visibleCalendar();
		await waitForEntries(short, (e) => e.length === 1, "short block did not render");
		const allDay = async () =>
			browser.execute((d) => {
				const root = Array.from(document.querySelectorAll<HTMLElement>(".cp-calendar")).find((e) => e.offsetParent !== null);
				const row = root?.querySelector<HTMLElement>(".cp-cal-allday");
				const cellEl = root?.querySelector<HTMLElement>(`.cp-cal-allday-cell[data-date="${d}"]`);
				return {
					height: row?.getBoundingClientRect().height ?? 0,
					entries: cellEl?.querySelectorAll(".cp-cal-entry").length ?? 0,
					more: cellEl?.querySelector(".cp-cal-allday-more")?.getAttribute("aria-label") ?? null,
					less: cellEl?.querySelector(".cp-cal-allday-less") !== null,
				};
			}, today);
		const collapsed = await allDay();
		expect(collapsed.entries).toBe(3);
		expect(collapsed.more).toBe("Show 3 more all-day items");
		expect(collapsed.height).toBeLessThan(110);

		// Keyboard path: the control is a button, so Enter on the focused one expands the row.
		await focusInCalendar(`.cp-cal-allday-cell[data-date="${today}"] .cp-cal-allday-more`);
		await browser.keys("Enter");
		await browser.waitUntil(async () => (await allDay()).entries === 6, { timeout: 3000, timeoutMsg: "the row did not expand" });
		const expanded = await allDay();
		expect(expanded.less).toBe(true);
		expect(expanded.height).toBeGreaterThan(collapsed.height);
		await clickInCalendar(`.cp-cal-allday-cell[data-date="${today}"] .cp-cal-allday-less`);
		await browser.waitUntil(async () => (await allDay()).entries === 3, { timeout: 3000, timeoutMsg: "the row did not collapse" });

		// The label of the first visible hour is whole under the sticky rows: at the 07:00 start offset
		// (the same math as initialScrollTop, so the test does not depend on the time of day) and at 0.
		const label = async (scrollTop: number, hour: number) =>
			browser.execute(
				(top, h) => {
					const root = Array.from(document.querySelectorAll<HTMLElement>(".cp-calendar")).find((e) => e.offsetParent !== null);
					const scroller = root?.querySelector<HTMLElement>(".cp-cal-scroller");
					const sticky = root?.querySelector<HTMLElement>(".cp-cal-sticky");
					const el = root?.querySelectorAll<HTMLElement>(".cp-cal-hour-label")[h];
					if (scroller === null || scroller === undefined || sticky === null || sticky === undefined || el === undefined) return null;
					scroller.scrollTop = top;
					const r = el.getBoundingClientRect();
					return { labelTop: r.top, labelBottom: r.bottom, stickyBottom: sticky.getBoundingClientRect().bottom, scrollTop: scroller.scrollTop };
				},
				scrollTop,
				hour,
			);
		const seven = await label(7 * 48 - 7, 7);
		expect(seven).not.toBeNull();
		expect(seven!.scrollTop).toBe(7 * 48 - 7);
		expect(seven!.labelTop).toBeGreaterThanOrEqual(seven!.stickyBottom - 0.5);
		const midnight = await label(0, 0);
		expect(midnight!.labelTop).toBeGreaterThanOrEqual(midnight!.stickyBottom - 0.5);

		// A short block is one line: nothing in it is cut by the box edge (a wrapped line is hidden whole).
		const lines = await browser.execute((id) => {
			const root = Array.from(document.querySelectorAll<HTMLElement>(".cp-calendar")).find((e) => e.offsetParent !== null);
			const body = root?.querySelector<HTMLElement>(`.cp-cal-entry[data-task-id="${id}"] .cp-cal-entry-body`);
			if (body === null || body === undefined) return null;
			const box = body.getBoundingClientRect();
			return {
				short: body.closest(".cp-cal-entry")?.classList.contains("is-short") ?? false,
				parts: Array.from(body.children).map((c) => {
					const r = c.getBoundingClientRect();
					return { top: r.top - box.top, bottom: r.bottom - box.top, height: box.height };
				}),
			};
		}, short);
		expect(lines?.short).toBe(true);
		for (const p of lines!.parts) {
			const whole = p.top >= -0.5 && p.bottom <= p.height + 0.5;
			const hidden = p.top >= p.height - 0.5;
			expect(whole || hidden).toBe(true);
		}
		expect(lines!.parts[0]!.top).toBeGreaterThanOrEqual(-0.5);

		// Nothing of the app sits under Obsidian's status bar.
		const room = await browser.execute(() => {
			const root = Array.from(document.querySelectorAll<HTMLElement>(".cp-calendar")).find((e) => e.offsetParent !== null);
			const app = root?.closest<HTMLElement>(".cp-app");
			const bar = document.querySelector<HTMLElement>(".status-bar");
			if (app === null || app === undefined) return null;
			const main = root!.querySelector<HTMLElement>(".cp-cal-main");
			const content = root!.querySelector<HTMLElement>(".cp-cal-content");
			return {
				padding: parseFloat(getComputedStyle(main!).paddingBottom),
				contentBottom: content!.getBoundingClientRect().bottom,
				barTop: bar === null || getComputedStyle(bar).display === "none" ? null : bar.getBoundingClientRect().top,
			};
		});
		expect(room).not.toBeNull();
		expect(room!.padding).toBeGreaterThan(20);
		if (room!.barTop !== null) expect(room!.contentBottom).toBeLessThanOrEqual(room!.barTop + 0.5);
	});

	it("overlapping blocks sit side by side in their day column", async function () {
		const today = await appToday();
		const zone = await appZone();
		const day = weekDatesOf(today, await appWeekStart())[1]!;
		const a = await createTask("Overlap A", { scheduled: { kind: "datetime", local: `${day}T09:00`, tz: zone }, plannedDurationMin: 60 });
		const b = await createTask("Overlap B", { scheduled: { kind: "datetime", local: `${day}T09:30`, tz: zone }, plannedDurationMin: 60 });
		await visibleCalendar();
		const [ea] = await waitForEntries(a, (e) => e.length === 1, "block A did not render");
		const [eb] = await waitForEntries(b, (e) => e.length === 1, "block B did not render");
		expect(ea!.date).toBe(day);
		expect(eb!.date).toBe(day);
		expect([ea!.cols, eb!.cols]).toEqual(["2", "2"]);
		expect(new Set([ea!.col, eb!.col])).toEqual(new Set(["0", "1"]));
		// Each takes about half of the column, and they do not overlap horizontally.
		expect(Math.abs(ea!.width - ea!.hostWidth / 2)).toBeLessThan(4);
		expect(Math.abs(eb!.width - eb!.hostWidth / 2)).toBeLessThan(4);
		const [left, right] = ea!.left < eb!.left ? [ea!, eb!] : [eb!, ea!];
		expect(left.left + left.width).toBeLessThanOrEqual(right.left + 0.5);
	});

	// Regression: below 1200 px the open unscheduled drawer covered the header's right end, including
	// the toggle that opens it. The drawer starts under the header now and has its own close button.
	it("the Unscheduled toggle stays clickable while the floating drawer is open", async function () {
		const calendar = await visibleCalendar();
		await calendar.$(".cp-cal-unscheduled-toggle").click();
		await calendar.$(".cp-cal-unscheduled").waitForExist({ timeout: 3000 });
		await calendar.$(".cp-cal-unscheduled-toggle").click();
		await expect(calendar.$(".cp-cal-unscheduled")).not.toExist();
	});

	it("the unscheduled drawer floats under 1200 px and is an inline 300 px column from 1200 px; details stack above it", async function () {
		const s = await seedWeek();
		const calendar = await visibleCalendar();
		await calendar.$(".cp-cal-unscheduled-toggle").click();
		await calendar.$(".cp-cal-unscheduled").waitForExist({ timeout: 3000 });

		await setAppWidth(1300);
		let drawer = await browser.execute(() => {
			const root = Array.from(document.querySelectorAll<HTMLElement>(".cp-calendar")).find((e) => e.offsetParent !== null);
			const el = root?.querySelector<HTMLElement>(".cp-cal-unscheduled");
			return { position: el === null || el === undefined ? "" : getComputedStyle(el).position, width: el?.getBoundingClientRect().width ?? 0 };
		});
		expect(drawer.position).not.toBe("absolute");
		expect(Math.abs(drawer.width - 300)).toBeLessThan(2);

		await setAppWidth(1100);
		drawer = await browser.execute(() => {
			const root = Array.from(document.querySelectorAll<HTMLElement>(".cp-calendar")).find((e) => e.offsetParent !== null);
			const el = root?.querySelector<HTMLElement>(".cp-cal-unscheduled");
			return { position: el === null || el === undefined ? "" : getComputedStyle(el).position, width: el?.getBoundingClientRect().width ?? 0 };
		});
		expect(drawer.position).toBe("absolute");

		// Selecting a row opens the details; the details drawer is on top of the unscheduled one.
		await calendar.$(`.cp-cal-unscheduled .cp-task-row[data-task-id="${s.someday}"]`).click();
		await calendar.$(".cp-details-pane .cp-details").waitForExist({ timeout: 5000 });
		const topmost = await browser.execute(() => {
			const root = Array.from(document.querySelectorAll<HTMLElement>(".cp-calendar")).find((e) => e.offsetParent !== null);
			const pane = root?.querySelector<HTMLElement>(".cp-details-pane");
			if (pane === null || pane === undefined) return "none";
			const r = pane.getBoundingClientRect();
			const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 200));
			return hit !== null && pane.contains(hit) ? "details" : (hit?.className ?? "nothing");
		});
		expect(topmost).toBe("details");
		await expect(calendar.$(".cp-cal-unscheduled")).toExist();
	});

	it("keeps the week grid at 7 columns inside its own scroller on a narrow view", async function () {
		await seedWeek();
		await visibleCalendar();
		await setAppWidth(700);
		const m = await browser.execute(() => {
			const root = Array.from(document.querySelectorAll<HTMLElement>(".cp-calendar")).find((e) => e.offsetParent !== null);
			const scroller = root?.querySelector<HTMLElement>(".cp-cal-scroller");
			const app = Array.from(document.querySelectorAll<HTMLElement>(".cp-app")).find((e) => e.offsetParent !== null);
			return {
				columns: root?.querySelectorAll(".cp-cal-daycol").length ?? 0,
				scrollerOverflows: scroller !== null && scroller !== undefined && scroller.scrollWidth > scroller.clientWidth,
				pageOverflows: app !== undefined && app.scrollWidth > app.clientWidth + 1,
			};
		});
		expect(m.columns).toBe(7);
		expect(m.scrollerOverflows).toBe(true);
		expect(m.pageOverflows).toBe(false);
	});

	describe("dark and light themes", function () {
		after(async function () {
			await setTheme("dark");
		});

		for (const mode of ["dark", "light"] as const) {
			it(`renders the week and the month in ${mode} mode`, async function () {
				const s = await seedWeek();
				const calendar = await visibleCalendar();
				await setTheme(mode);
				const classes = await browser.execute(() => document.body.className);
				expect(classes).toContain(`theme-${mode}`);
				for (const sel of [".cp-cal-header", ".cp-cal-week", ".cp-cal-dayhead.is-today", ".cp-cal-allday"]) {
					await expect(calendar.$(sel)).toBeDisplayed();
				}
				await waitForEntries(s.timed, (e) => e.length === 1, "timed block did not render");
				const style = await browser.execute((id) => {
					const root = Array.from(document.querySelectorAll<HTMLElement>(".cp-calendar")).find((e) => e.offsetParent !== null);
					const block = root?.querySelector<HTMLElement>(`.cp-cal-entry[data-task-id="${id}"]`);
					const todayDom = root?.querySelector<HTMLElement>(".cp-cal-dayhead.is-today .cp-cal-dom");
					const otherDom = root?.querySelector<HTMLElement>(".cp-cal-dayhead:not(.is-today) .cp-cal-dom");
					const app = root?.closest<HTMLElement>(".cp-app");
					return {
						blockBg: block === null || block === undefined ? "" : getComputedStyle(block).backgroundColor,
						blockHeight: block?.getBoundingClientRect().height ?? 0,
						todayBg: todayDom === null || todayDom === undefined ? "" : getComputedStyle(todayDom).backgroundColor,
						otherBg: otherDom === null || otherDom === undefined ? "" : getComputedStyle(otherDom).backgroundColor,
						blueSoft: app === undefined || app === null ? "" : getComputedStyle(app).getPropertyValue("--cp-blue-soft").trim(),
					};
				}, s.timed);
				expect(style.blockHeight).toBeGreaterThan(10);
				expect(style.blockBg).not.toBe("rgba(0, 0, 0, 0)");
				expect(style.blockBg).not.toBe("");
				// Today's number is filled with the blue soft token; other days are not.
				expect(style.blueSoft).not.toBe("");
				expect(style.todayBg).not.toBe("rgba(0, 0, 0, 0)");
				expect(style.otherBg).toBe("rgba(0, 0, 0, 0)");

				await calendar.$(".cp-cal-mode-btn=Month").click();
				await calendar.$(".cp-cal-month").waitForExist({ timeout: 5000 });
				await expect(calendar.$(".cp-cal-month-head")).toBeDisplayed();
				await expect(calendar.$(".cp-cal-cell.is-today")).toBeDisplayed();
				expect(await countInCalendar(".cp-cal-cell")).toBeGreaterThanOrEqual(28);
			});
		}
	});
});
