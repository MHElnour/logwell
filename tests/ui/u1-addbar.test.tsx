// @vitest-environment happy-dom
import { render } from "preact";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CheckpointApp } from "../../src/app/App";
import { type WeekStart } from "../../src/app/settings";
import { QuickAddForm } from "../../src/ui/QuickAddForm";
import { chipLabel } from "../../src/ui/quickadd/chipLabels";
import { appHarness } from "../app/harness";

// The add bar (highlighting, manual pills, tools), the date popover and the more menu.
// Real services and parser, a fake host. The harness clock is 2026-10-01T10:00Z (Thursday),
// zone Europe/Berlin, so October 2026 starts on a Thursday.

beforeAll(() => {
	(HTMLElement.prototype as unknown as { empty: () => void }).empty = function (this: HTMLElement) {
		this.replaceChildren();
	};
});

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
	input.value = value;
	input.dispatchEvent(new Event("input", { bubbles: true }));
	await settle();
}

async function press(el: Element, key: string, extra: KeyboardEventInit = {}): Promise<KeyboardEvent> {
	const evt = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra });
	el.dispatchEvent(evt);
	await settle();
	return evt;
}

async function click(el: Element | null): Promise<void> {
	if (el === null) throw new Error("element not found");
	(el as HTMLElement).click();
	await settle();
}

let container: HTMLElement | null = null;
afterEach(() => {
	if (container !== null) render(null, container);
	container?.remove();
	container = null;
});

interface Mounted {
	app: CheckpointApp;
	root: HTMLElement;
	saved: string[];
	closed: { n: number };
	closeOverlay: () => boolean;
}

async function mountForm(opts: { weekStart?: WeekStart; eveningTime?: string; preset?: { date?: string | null } } = {}): Promise<Mounted> {
	const app = (await appHarness()).app;
	const saved: string[] = [];
	const closed = { n: 0 };
	const m: Mounted = { app, root: document.createElement("div"), saved, closed, closeOverlay: () => false };
	container = m.root;
	document.body.appendChild(container);
	render(
		<QuickAddForm
			app={app}
			preset={opts.preset ?? {}}
			locale={() => "en"}
			weekStart={() => opts.weekStart ?? "MO"}
			eveningTime={() => opts.eveningTime ?? "20:00"}
			keepOpen={() => false}
			pickNote={async () => null}
			resolveNote={() => []}
			setIcon={(el, icon) => el.setAttribute("data-icon", icon)}
			attachTokenSuggest={() => ({ isOpen: () => false, dispose: () => undefined })}
			onSaved={(title) => void saved.push(title)}
			onError={(err) => {
				throw err;
			}}
			onClose={() => void closed.n++}
			registerEscape={(fn) => {
				m.closeOverlay = fn;
			}}
		/>,
		container,
	);
	await settle();
	return m;
}

const input = (root: HTMLElement) => root.querySelector<HTMLInputElement>(".cp-quick-add-title")!;
const tool = (root: HTMLElement, label: string) => root.querySelector<HTMLButtonElement>(`.cp-qa-tool[aria-label="${label}"]`)!;
const dateTool = (root: HTMLElement) => tool(root, "Date");
const moreTool = (root: HTMLElement) => tool(root, "Priority, list, tags and note");
const datePop = (root: HTMLElement) => root.querySelector<HTMLElement>(".cp-date-pop");
const morePop = (root: HTMLElement) => root.querySelector<HTMLElement>(".cp-more-pop");
const byText = (scope: ParentNode, sel: string, text: string) =>
	[...scope.querySelectorAll<HTMLElement>(sel)].find((e) => e.textContent?.trim().startsWith(text)) ?? null;
const day = (root: HTMLElement, date: string) => root.querySelector<HTMLButtonElement>(`.cp-cal-day[data-date="${date}"]`)!;
const tasks = (m: Mounted) => [...m.app.store.state.tasks.values()];

describe("add bar tools", () => {
	it("renders the Date and more tools as icon buttons with ARIA labels and the Lucide icons", async () => {
		const m = await mountForm();
		expect(dateTool(m.root).querySelector('[data-icon="calendar"]')).not.toBeNull();
		expect(moreTool(m.root).querySelector('[data-icon="chevron-down"]')).not.toBeNull();
		expect(m.root.querySelector('.cp-qa-bar [data-icon="plus"]')).not.toBeNull();
		expect(dateTool(m.root).getAttribute("aria-expanded")).toBe("false");
		expect(dateTool(m.root).classList.contains("is-on")).toBe(false);
	});

	it("opens and closes the date popover from its tool and marks the tool .is-on", async () => {
		const m = await mountForm();
		await click(dateTool(m.root));
		expect(datePop(m.root)).not.toBeNull();
		expect(dateTool(m.root).classList.contains("is-on")).toBe(true);
		expect(dateTool(m.root).getAttribute("aria-expanded")).toBe("true");
		await click(dateTool(m.root));
		expect(datePop(m.root)).toBeNull();
		expect(dateTool(m.root).classList.contains("is-on")).toBe(false);
	});

	it("opening the more menu closes the date popover (one popover at a time)", async () => {
		const m = await mountForm();
		await click(dateTool(m.root));
		await click(moreTool(m.root));
		expect(datePop(m.root)).toBeNull();
		expect(morePop(m.root)).not.toBeNull();
		expect(moreTool(m.root).classList.contains("is-on")).toBe(true);
	});

	it("renders popovers inside the plugin container, never on the body", async () => {
		const m = await mountForm();
		await click(dateTool(m.root));
		const pop = datePop(m.root)!;
		expect(m.root.contains(pop)).toBe(true);
		expect(pop.parentElement).not.toBe(document.body);
		expect(pop.getAttribute("role")).toBe("dialog");
		expect(pop.hasAttribute("aria-label")).toBe(false);
		expect(document.getElementById(pop.getAttribute("aria-labelledby")!)!.textContent).toBe("Date and duration");
	});

	it("moves focus into the popover on open", async () => {
		const m = await mountForm();
		await click(dateTool(m.root));
		expect(datePop(m.root)!.contains(document.activeElement)).toBe(true);
		await press(datePop(m.root)!, "Escape");
		await click(moreTool(m.root));
		expect(morePop(m.root)!.contains(document.activeElement)).toBe(true);
	});

	it("closes on an outside press and stays open on a press inside", async () => {
		const m = await mountForm();
		await click(dateTool(m.root));
		datePop(m.root)!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		await settle();
		expect(datePop(m.root)).not.toBeNull();
		document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		await settle();
		expect(datePop(m.root)).toBeNull();
	});

	it("removes the outside-press listener on unmount (no leaks)", async () => {
		const spy = vi.spyOn(document, "removeEventListener");
		const m = await mountForm();
		await click(dateTool(m.root));
		render(null, container!);
		expect(spy.mock.calls.some(([type]) => type === "mousedown")).toBe(true);
		spy.mockRestore();
	});
});

describe("Escape and Enter", () => {
	it("Escape in the popover closes only the popover, returns focus to the tool and does not reach the form", async () => {
		const m = await mountForm();
		const seen: string[] = [];
		m.root.addEventListener("keydown", (e) => seen.push(e.key));
		await click(dateTool(m.root));
		const evt = await press(datePop(m.root)!, "Escape");
		expect(datePop(m.root)).toBeNull();
		expect(evt.defaultPrevented).toBe(true);
		expect(seen).toEqual([]);
		expect(document.activeElement).toBe(dateTool(m.root));
		expect(m.closed.n).toBe(0);
	});

	it("the escape hook (used by the modal's close()) closes an open popover first, then reports nothing open", async () => {
		const m = await mountForm();
		await click(moreTool(m.root));
		expect(m.closeOverlay()).toBe(true);
		await settle();
		expect(morePop(m.root)).toBeNull();
		expect(m.closeOverlay()).toBe(false);
	});

	it("Enter in the input saves while no popover is open", async () => {
		const m = await mountForm();
		await typeInto(input(m.root), "Pay rent");
		await press(input(m.root), "Enter");
		expect(m.saved).toEqual(["Pay rent"]);
	});

	it("Enter in the input saves even when a popover is open (focus is in the input)", async () => {
		const m = await mountForm();
		await typeInto(input(m.root), "Pay rent");
		await click(dateTool(m.root));
		await press(input(m.root), "Enter");
		expect(m.saved).toEqual(["Pay rent"]);
	});

	it("Enter inside the popover does not save: a time input commits and stays in the popover", async () => {
		const m = await mountForm();
		await typeInto(input(m.root), "Pay rent");
		await click(dateTool(m.root));
		await click(day(m.root, "2026-10-05"));
		await click(m.root.querySelector('.cp-pop-row[data-row="time"]'));
		const time = m.root.querySelector<HTMLInputElement>('.cp-date-pop input[type="time"]')!;
		time.value = "19:00";
		time.dispatchEvent(new Event("input", { bubbles: true }));
		const evt = await press(time, "Enter");
		expect(evt.defaultPrevented).toBe(true);
		expect(m.saved).toEqual([]);
		expect(datePop(m.root)).not.toBeNull();
	});

	it("Enter on a day button picks it and does not save", async () => {
		const m = await mountForm();
		await typeInto(input(m.root), "Pay rent");
		await click(dateTool(m.root));
		const target = day(m.root, "2026-10-07");
		target.focus();
		await press(target, "Enter");
		expect(m.saved).toEqual([]);
		expect(day(m.root, "2026-10-07").classList.contains("is-picked")).toBe(true);
	});
});

describe("date popover", () => {
	it("honors weekStart: Monday, Sunday and Saturday grids", async () => {
		for (const [start, firstDay, initials] of [
			["MO", "2026-09-28", "MTWTFSS"],
			["SU", "2026-09-27", "SMTWTFS"],
			["SA", "2026-09-26", "SSMTWTF"],
		] as const) {
			const m = await mountForm({ weekStart: start });
			await click(dateTool(m.root));
			const days = [...m.root.querySelectorAll<HTMLElement>(".cp-cal-day")];
			expect(days[0]!.getAttribute("data-date")).toBe(firstDay);
			expect(days.length % 7).toBe(0);
			expect([...m.root.querySelectorAll(".cp-cal-wd")].map((e) => e.textContent).join("")).toBe(initials);
			render(null, container!);
			container!.remove();
			container = null;
		}
	});

	it("shows the month title and marks today, muted out-of-month days and the picked day", async () => {
		const m = await mountForm();
		await click(dateTool(m.root));
		expect(m.root.querySelector(".cp-cal-title")!.textContent).toBe("October 2026");
		expect(day(m.root, "2026-10-01").classList.contains("is-today")).toBe(true);
		expect(day(m.root, "2026-09-30").classList.contains("is-muted")).toBe(true);
		expect(day(m.root, "2026-10-14").classList.contains("is-muted")).toBe(false);
		await click(day(m.root, "2026-10-14"));
		expect(day(m.root, "2026-10-14").classList.contains("is-picked")).toBe(true);
		expect(day(m.root, "2026-10-14").getAttribute("aria-pressed")).toBe("true");
	});

	it("has Previous month and Next month buttons", async () => {
		const m = await mountForm();
		await click(dateTool(m.root));
		await click(m.root.querySelector('.cp-date-pop [aria-label="Next month"]'));
		expect(m.root.querySelector(".cp-cal-title")!.textContent).toBe("November 2026");
		await click(m.root.querySelector('.cp-date-pop [aria-label="Previous month"]'));
		await click(m.root.querySelector('.cp-date-pop [aria-label="Previous month"]'));
		expect(m.root.querySelector(".cp-cal-title")!.textContent).toBe("September 2026");
	});

	it("quick picks set the date: Today, Tomorrow, Next week and Tonight, with a pill", async () => {
		const m = await mountForm();
		await click(dateTool(m.root));
		const labels = [...m.root.querySelectorAll(".cp-quick button")].map((b) => b.textContent.trim());
		expect(labels).toEqual(["Today", "Tomorrow", "Next week", "Tonight"]);
		expect([...m.root.querySelectorAll(".cp-quick [data-icon]")].map((e) => e.getAttribute("data-icon"))).toEqual([
			"sun",
			"sunrise",
			"calendar-plus",
			"moon",
		]);
		await click(byText(m.root, ".cp-quick button", "Tomorrow"));
		const pill = m.root.querySelector('.cp-qa-manual[data-kind="scheduled"]')!;
		expect(pill.textContent).toContain("Tomorrow");
		expect(day(m.root, "2026-10-02").classList.contains("is-picked")).toBe(true);
		await click(byText(m.root, ".cp-quick button", "Next week"));
		expect(day(m.root, "2026-10-08").classList.contains("is-picked")).toBe(true);
		await typeInto(input(m.root), "Pay rent");
		await press(input(m.root), "Enter");
		expect(tasks(m)[0]!.scheduled).toEqual({ kind: "date", date: "2026-10-08" });
	});

	it("Tonight is today at the evening time (default 20:00), like the parser's 'tonight' (plan §11.6 #59)", async () => {
		const m = await mountForm();
		await click(dateTool(m.root));
		await click(byText(m.root, ".cp-quick button", "Tonight"));
		expect(m.root.querySelector('.cp-pop-row[data-row="time"] .cp-pop-val')!.textContent).toBe("20:00");
		await typeInto(input(m.root), "Pay rent");
		await press(input(m.root), "Enter");
		expect(tasks(m)[0]!.scheduled).toEqual({ kind: "datetime", local: "2026-10-01T20:00", tz: "Europe/Berlin" });
	});

	it("Tonight follows the evening time setting, and the typed word gives the same value", async () => {
		const m = await mountForm({ eveningTime: "18:45" });
		await click(dateTool(m.root));
		await click(byText(m.root, ".cp-quick button", "Tonight"));
		await typeInto(input(m.root), "Pay rent");
		await press(input(m.root), "Enter");
		const picked = tasks(m)[0]!.scheduled;
		expect(picked).toEqual({ kind: "datetime", local: "2026-10-01T18:45", tz: "Europe/Berlin" });
		const typed = await mountForm({ eveningTime: "18:45" });
		await typeInto(input(typed.root), "Pay rent tonight");
		await press(input(typed.root), "Enter");
		expect(tasks(typed)[0]!.scheduled).toEqual(picked);
	});

	it("a picked day plus the Time row saves a datetime; the Deadline row saves a deadline", async () => {
		const m = await mountForm();
		await click(dateTool(m.root));
		await click(day(m.root, "2026-10-05"));
		expect(m.root.querySelector('.cp-pop-row[data-row="time"] .cp-pop-val')!.textContent).toBe("None");
		await click(m.root.querySelector('.cp-pop-row[data-row="time"]'));
		const time = m.root.querySelector<HTMLInputElement>('.cp-date-pop input[type="time"]')!;
		time.value = "19:00";
		time.dispatchEvent(new Event("input", { bubbles: true }));
		await settle();
		expect(m.root.querySelector('.cp-pop-row[data-row="time"] .cp-pop-val')!.textContent).toBe("19:00");
		await click(m.root.querySelector('.cp-pop-row[data-row="deadline"]'));
		const dl = m.root.querySelector<HTMLInputElement>('.cp-date-pop input[type="date"]')!;
		dl.value = "2026-10-09";
		dl.dispatchEvent(new Event("input", { bubbles: true }));
		await settle();
		expect(m.root.querySelector('.cp-pop-row[data-row="deadline"] .cp-pop-val')!.textContent).not.toBe("None");
		await typeInto(input(m.root), "Pay rent");
		await press(input(m.root), "Enter");
		const t = tasks(m)[0]!;
		expect(t.scheduled).toEqual({ kind: "datetime", local: "2026-10-05T19:00", tz: "Europe/Berlin" });
		expect(t.deadline).toEqual({ kind: "date", date: "2026-10-09" });
	});

	it("a time with no date yet picks today", async () => {
		const m = await mountForm();
		await click(dateTool(m.root));
		await click(m.root.querySelector('.cp-pop-row[data-row="time"]'));
		const time = m.root.querySelector<HTMLInputElement>('.cp-date-pop input[type="time"]')!;
		time.value = "08:30";
		time.dispatchEvent(new Event("input", { bubbles: true }));
		await settle();
		await typeInto(input(m.root), "Pay rent");
		await press(input(m.root), "Enter");
		expect(tasks(m)[0]!.scheduled).toEqual({ kind: "datetime", local: "2026-10-01T08:30", tz: "Europe/Berlin" });
	});

	it("Clear removes the picked values; OK closes the popover and returns focus to the tool", async () => {
		const m = await mountForm();
		await click(dateTool(m.root));
		await click(day(m.root, "2026-10-05"));
		expect(m.root.querySelector('.cp-qa-manual[data-kind="scheduled"]')).not.toBeNull();
		await click(m.root.querySelector(".cp-pop-clear"));
		expect(m.root.querySelector('.cp-qa-manual[data-kind="scheduled"]')).toBeNull();
		expect(day(m.root, "2026-10-05").classList.contains("is-picked")).toBe(false);
		await typeInto(input(m.root), "Pay rent");
		await click(day(m.root, "2026-10-06"));
		await click(m.root.querySelector(".cp-pop-ok"));
		expect(datePop(m.root)).toBeNull();
		expect(document.activeElement).toBe(dateTool(m.root));
		await press(input(m.root), "Enter");
		expect(tasks(m)[0]!.scheduled).toEqual({ kind: "date", date: "2026-10-06" });
	});

	it("a typed date then a popover pick follows the replace-date rule (B4): the typed one becomes a suggestion", async () => {
		const m = await mountForm();
		await typeInto(input(m.root), "Call mom tomorrow");
		await click(dateTool(m.root));
		await click(day(m.root, "2026-10-15"));
		const chip = m.root.querySelector('.cp-qa-chip[data-kind="scheduled"]')!;
		expect(chip.getAttribute("data-status")).toBe("suggestion");
		await press(input(m.root), "Enter");
		expect(tasks(m)[0]!.scheduled).toEqual({ kind: "date", date: "2026-10-15" });
	});

	it("Duration tab: presets and a custom value set the duration", async () => {
		const m = await mountForm();
		await click(dateTool(m.root));
		await click(byText(m.root, ".cp-seg button", "Duration"));
		expect([...m.root.querySelectorAll(".cp-dur-presets button")].map((b) => b.textContent)).toEqual(["15m", "30m", "45m", "1h", "1h30", "2h"]);
		const p45 = byText(m.root, ".cp-dur-presets button", "45m")!;
		await click(p45);
		expect(byText(m.root, ".cp-dur-presets button", "45m")!.classList.contains("is-on")).toBe(true);
		expect(m.root.querySelector('.cp-qa-manual[data-kind="duration"]')!.textContent).toContain("45");
		const custom = m.root.querySelector<HTMLInputElement>(".cp-dur-custom input")!;
		custom.value = "50";
		custom.dispatchEvent(new Event("input", { bubbles: true }));
		await settle();
		await typeInto(input(m.root), "Pay rent");
		await press(input(m.root), "Enter");
		expect(tasks(m)[0]!.plannedDurationMin).toBe(50);
	});

	it("two quick arrow keys on the same day both count (the second arrives before focus moves)", async () => {
		const m = await mountForm();
		await click(dateTool(m.root));
		const start = day(m.root, "2026-10-01");
		// Dispatch both keys to the day that has focus now, without waiting for a re-render.
		start.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
		start.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
		for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
		expect(document.activeElement).toBe(day(m.root, "2026-10-09"));
	});

	it("arrow keys move within the day grid with a roving tabindex; Enter picks", async () => {
		const m = await mountForm();
		await click(dateTool(m.root));
		const active = () => document.activeElement as HTMLElement;
		expect(active()).toBe(day(m.root, "2026-10-01"));
		expect(day(m.root, "2026-10-01").tabIndex).toBe(0);
		expect(day(m.root, "2026-10-02").tabIndex).toBe(-1);
		await press(active(), "ArrowRight");
		expect(active()).toBe(day(m.root, "2026-10-02"));
		expect(day(m.root, "2026-10-02").tabIndex).toBe(0);
		expect(day(m.root, "2026-10-01").tabIndex).toBe(-1);
		await press(active(), "ArrowDown");
		expect(active()).toBe(day(m.root, "2026-10-09"));
		await press(active(), "ArrowLeft");
		await press(active(), "ArrowUp");
		expect(active()).toBe(day(m.root, "2026-10-01"));
		await press(active(), "ArrowDown");
		await press(active(), "ArrowDown");
		await press(active(), "ArrowDown");
		await press(active(), "ArrowDown");
		expect(m.root.querySelector(".cp-cal-title")!.textContent).toBe("October 2026");
		await press(active(), "ArrowDown");
		expect(m.root.querySelector(".cp-cal-title")!.textContent).toBe("November 2026");
		expect(active().getAttribute("data-date")).toBe("2026-11-05");
		await press(active(), " ");
		expect(active().classList.contains("is-picked")).toBe(true);
	});

	it("Tab at the last control wraps to the first (focus stays in the popover)", async () => {
		const m = await mountForm();
		await click(dateTool(m.root));
		const pop = datePop(m.root)!;
		const ok = pop.querySelector<HTMLElement>(".cp-pop-ok")!;
		ok.focus();
		const evt = await press(ok, "Tab");
		expect(evt.defaultPrevented).toBe(true);
		expect(pop.contains(document.activeElement)).toBe(true);
		expect(document.activeElement).not.toBe(ok);
		const first = document.activeElement as HTMLElement;
		const back = await press(first, "Tab", { shiftKey: true });
		expect(back.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(ok);
	});
});

describe("more menu", () => {
	it("has four priority flags with ARIA labels and aria-pressed; none is on by default", async () => {
		const m = await mountForm();
		await click(moreTool(m.root));
		const flags = [...m.root.querySelectorAll<HTMLButtonElement>(".cp-pri-flags button")];
		expect(flags.map((f) => f.getAttribute("aria-label"))).toEqual(["High priority", "Medium priority", "Low priority", "No priority"]);
		expect(flags.map((f) => f.getAttribute("aria-pressed"))).toEqual(["false", "false", "false", "true"]);
		expect(flags[3]!.classList.contains("is-on")).toBe(true);
		expect(m.root.querySelector(".cp-more-pop .cp-pop-label")!.textContent).toBe("Priority");
	});

	it("picking High priority marks it .is-on, shows a pill and saves priority 1", async () => {
		const m = await mountForm();
		await click(moreTool(m.root));
		await click(m.root.querySelector('.cp-pri-flags [aria-label="High priority"]'));
		const flag = m.root.querySelector('.cp-pri-flags [aria-label="High priority"]')!;
		expect(flag.classList.contains("is-on")).toBe(true);
		expect(flag.getAttribute("aria-pressed")).toBe("true");
		const pill = m.root.querySelector('.cp-qa-manual[data-kind="priority"]')!;
		expect(pill.textContent).toContain("High priority");
		expect(pill.getAttribute("data-priority")).toBe("1");
		await typeInto(input(m.root), "Pay rent");
		await press(input(m.root), "Enter");
		expect(tasks(m)[0]!.priority).toBe(1);
	});

	it("choosing No priority after a pick saves 0 and removes the pill", async () => {
		const m = await mountForm();
		await click(moreTool(m.root));
		await click(m.root.querySelector('.cp-pri-flags [aria-label="Low priority"]'));
		await click(m.root.querySelector('.cp-pri-flags [aria-label="No priority"]'));
		expect(m.root.querySelector('.cp-qa-manual[data-kind="priority"]')).toBeNull();
		await typeInto(input(m.root), "Pay rent");
		await press(input(m.root), "Enter");
		expect(tasks(m)[0]!.priority).toBe(0);
	});

	it("a typed !2 shows a priority chip, 'Medium priority', and marks the flag", async () => {
		const m = await mountForm();
		await typeInto(input(m.root), "Pay rent !2");
		const chip = m.root.querySelector('.cp-qa-chip[data-kind="priority"]')!;
		expect(chip.textContent).toContain("Medium priority");
		expect(chip.getAttribute("data-priority")).toBe("2");
		await click(moreTool(m.root));
		expect(m.root.querySelector('.cp-pri-flags [aria-label="Medium priority"]')!.classList.contains("is-on")).toBe(true);
	});

	it("a manual priority then a typed token follows the replace rule (B4)", async () => {
		const m = await mountForm();
		await click(moreTool(m.root));
		await click(m.root.querySelector('.cp-pri-flags [aria-label="Low priority"]'));
		await typeInto(input(m.root), "Pay rent !1");
		expect(m.root.querySelector('.cp-qa-chip[data-kind="priority"]')!.getAttribute("data-status")).toBe("suggestion");
	});

	it("lists List, Tags, Description note and Matrix quadrant rows, 44px rows with chevrons", async () => {
		const m = await mountForm();
		await click(moreTool(m.root));
		const rows = [...m.root.querySelectorAll<HTMLElement>(".cp-more-pop .cp-pop-row")];
		expect(rows.map((r) => r.getAttribute("data-row"))).toEqual(["list", "tags", "note", "quadrant"]);
		expect(rows[0]!.querySelector(".cp-pop-val")!.textContent).toBe("Inbox");
		expect(rows[0]!.querySelector('[data-icon="chevron-right"]')).not.toBeNull();
	});

	it("List: opens an inline list of categories; picking one sets the list and goes back", async () => {
		const m = await mountForm();
		const study = await m.app.categories.create("Study");
		await click(moreTool(m.root));
		await click(m.root.querySelector('.cp-pop-row[data-row="list"]'));
		const items = [...m.root.querySelectorAll<HTMLElement>(".cp-pop-choice")];
		expect(items.map((i) => i.textContent.trim())).toContain("Study");
		await click(byText(m.root, ".cp-pop-choice", "Study"));
		expect(m.root.querySelector('.cp-pop-row[data-row="list"] .cp-pop-val')!.textContent).toBe("Study");
		expect(m.root.querySelector('.cp-qa-manual[data-kind="category"]')!.textContent).toContain("Study");
		await typeInto(input(m.root), "Pay rent");
		await press(input(m.root), "Enter");
		expect(tasks(m)[0]!.categoryId).toBe(study.id);
	});

	it("Tags: toggles existing tags; the task gets them", async () => {
		const m = await mountForm();
		await m.app.tags.create("python");
		await click(moreTool(m.root));
		await click(m.root.querySelector('.cp-pop-row[data-row="tags"]'));
		const choice = byText(m.root, ".cp-pop-choice", "python")!;
		await click(choice);
		expect(byText(m.root, ".cp-pop-choice", "python")!.getAttribute("aria-pressed")).toBe("true");
		await typeInto(input(m.root), "Pay rent");
		await press(input(m.root), "Enter");
		expect(tasks(m)[0]!.tagKeys).toEqual(["python"]);
	});

	it("Matrix quadrant: Urgent and Important toggles", async () => {
		const m = await mountForm();
		await click(moreTool(m.root));
		await click(m.root.querySelector('.cp-pop-row[data-row="quadrant"]'));
		await click(byText(m.root, ".cp-pop-choice", "Urgent"));
		await typeInto(input(m.root), "Pay rent");
		await press(input(m.root), "Enter");
		expect(tasks(m)[0]).toMatchObject({ urgent: true, important: false });
	});

	it("Matrix quadrant: the row names both flags joined with a dot, like a task row", async () => {
		const m = await mountForm();
		await click(moreTool(m.root));
		const value = () => m.root.querySelector('.cp-pop-row[data-row="quadrant"] .cp-pop-val')?.textContent;
		expect(value()).toBe("Not set");
		await click(m.root.querySelector('.cp-pop-row[data-row="quadrant"]'));
		await click(byText(m.root, ".cp-pop-choice", "Urgent"));
		await click(byText(m.root, ".cp-pop-choice", "Important"));
		await click(m.root.querySelector(".cp-pop-back"));
		expect(value()).toBe("Urgent · Important");
	});

	it("Escape in a submenu closes the whole popover (and nothing else)", async () => {
		const m = await mountForm();
		await click(moreTool(m.root));
		await click(m.root.querySelector('.cp-pop-row[data-row="list"]'));
		await press(morePop(m.root)!, "Escape");
		expect(morePop(m.root)).toBeNull();
		expect(m.closed.n).toBe(0);
		expect(document.activeElement).toBe(moreTool(m.root));
	});

	it("arrow keys move through the flags", async () => {
		const m = await mountForm();
		await click(moreTool(m.root));
		const flags = [...m.root.querySelectorAll<HTMLButtonElement>(".cp-pri-flags button")];
		flags[0]!.focus();
		await press(flags[0]!, "ArrowRight");
		expect(document.activeElement).toBe(flags[1]);
		await press(flags[1]!, "ArrowLeft");
		expect(document.activeElement).toBe(flags[0]);
	});
});

describe("token highlighting and chips", () => {
	it("highlights date, duration, list and priority spans with kind classes (priority by level)", async () => {
		const m = await mountForm();
		await typeInto(input(m.root), "Read tomorrow for 45m #Inbox !1");
		const marks = [...m.root.querySelectorAll<HTMLElement>(".cp-qa-mirror mark.cp-qa-span")];
		const byKind = (cls: string) => marks.find((x) => x.classList.contains(cls));
		expect(byKind("cp-qa-tok-date")?.textContent).toBe("tomorrow");
		expect(byKind("cp-qa-tok-dur")?.textContent).toBe("for 45m");
		expect(byKind("cp-qa-tok-cat")?.textContent).toBe("#Inbox");
		expect(byKind("cp-qa-tok-pri-1")?.textContent).toBe("!1");
	});

	it("the highlight layer is one inline run, so spaces between highlights are kept", async () => {
		const m = await mountForm();
		const text = "Plan demo next friday for 1h #Inbox !1";
		await typeInto(input(m.root), text);
		const mirror = m.root.querySelector<HTMLElement>(".cp-qa-mirror")!;
		// A flex container drops whitespace-only children; a single wrapper keeps them.
		expect(mirror.children).toHaveLength(1);
		expect(mirror.children[0]!.classList.contains("cp-qa-mirror-text")).toBe(true);
		expect(mirror.textContent).toBe(text);
	});

	it("priority levels 2 and 3 get their own classes", async () => {
		const m = await mountForm();
		await typeInto(input(m.root), "A !2");
		expect(m.root.querySelector(".cp-qa-mirror mark.cp-qa-tok-pri-2")).not.toBeNull();
		await typeInto(input(m.root), "A !3");
		expect(m.root.querySelector(".cp-qa-mirror mark.cp-qa-tok-pri-3")).not.toBeNull();
	});

	it("priority chip labels read 'High priority', 'Medium priority' and 'Low priority'", () => {
		const env = { zone: "Europe/Berlin", today: "2026-10-01", categories: [], tags: [] };
		const chip = (priority: 1 | 2 | 3) => ({ kind: "priority", status: "applied", priority, text: `!${priority}` }) as never;
		expect(chipLabel(chip(1), env)).toBe("High priority");
		expect(chipLabel(chip(2), env)).toBe("Medium priority");
		expect(chipLabel(chip(3), env)).toBe("Low priority");
	});

	it("manual pills are removable and do not count as parsed chips", async () => {
		const m = await mountForm();
		await click(moreTool(m.root));
		await click(m.root.querySelector('.cp-pri-flags [aria-label="High priority"]'));
		expect(m.root.querySelectorAll(".cp-qa-chip")).toHaveLength(0);
		const remove = m.root.querySelector<HTMLButtonElement>('.cp-qa-manual[data-kind="priority"] .cp-qa-manual-remove')!;
		expect(remove.getAttribute("aria-label")).toMatch(/Remove/);
		await click(remove);
		expect(m.root.querySelector('.cp-qa-manual[data-kind="priority"]')).toBeNull();
	});
});

describe("inline add bar in the app", () => {
	it("uses the view name in the placeholder, has the tools, and shows a count pill by the title", async () => {
		const { mountApp } = await import("./quick-add.helpers");
		const { root, unmount } = await mountApp();
		const bar = root.querySelector<HTMLInputElement>('.cp-add-bar input[aria-label="Add task"]')!;
		expect(bar.placeholder).toBe("Add task to Today — try “Read chapter 3 tomorrow 7pm #Study !1”");
		expect(root.querySelector('.cp-add-bar [aria-label="Date"]')).not.toBeNull();
		expect(root.querySelector('.cp-add-bar [aria-label="Priority, list, tags and note"]')).not.toBeNull();
		const pill = root.querySelector(".cp-main-header .cp-count-pill");
		expect(pill).not.toBeNull();
		unmount();
	});

	it("Escape in the inline popover closes only the popover; Enter still saves with the picked date", async () => {
		const { mountApp } = await import("./quick-add.helpers");
		const { h, root, unmount } = await mountApp();
		const bar = root.querySelector<HTMLInputElement>('.cp-add-bar input[aria-label="Add task"]')!;
		const dateBtn = root.querySelector<HTMLButtonElement>('.cp-add-bar [aria-label="Date"]')!;
		await click(dateBtn);
		const pop = root.querySelector<HTMLElement>(".cp-add-bar .cp-date-pop")!;
		expect(pop).not.toBeNull();
		await click(pop.querySelector(`.cp-cal-day[data-date="2026-10-20"]`));
		await press(pop, "Escape");
		expect(root.querySelector(".cp-date-pop")).toBeNull();
		expect(root.querySelector(".cp-sidebar")).not.toBeNull();
		await typeInto(bar, "Buy milk");
		await press(bar, "Enter");
		expect([...h.app.store.state.tasks.values()][0]!.scheduled).toEqual({ kind: "date", date: "2026-10-20" });
		unmount();
	});
});

describe("U1 review fixes", () => {
	it("Clear also dismisses typed date, deadline and duration chips (their text stays literal)", async () => {
		const m = await mountForm();
		await typeInto(input(m.root), "buy milk tomorrow");
		expect(m.root.querySelector('.cp-qa-chip[data-kind="scheduled"], [data-kind="scheduled"]')).not.toBeNull();
		await click(dateTool(m.root));
		await click(m.root.querySelector(".cp-pop-clear"));
		await press(input(m.root), "Enter");
		const t = tasks(m)[0]!;
		expect(t.scheduled).toBeNull();
		expect(t.title).toBe("buy milk tomorrow");
	});

	it("Clear keeps focus inside the popover", async () => {
		const m = await mountForm();
		await typeInto(input(m.root), "buy milk tomorrow");
		await click(dateTool(m.root));
		const clear = m.root.querySelector<HTMLButtonElement>(".cp-pop-clear")!;
		clear.focus();
		await click(clear);
		expect(datePop(m.root)!.contains(document.activeElement)).toBe(true);
	});

	it("Enter in the Time field returns focus to the Time row", async () => {
		const m = await mountForm();
		await click(dateTool(m.root));
		await click(day(m.root, "2026-10-05"));
		await click(m.root.querySelector('.cp-pop-row[data-row="time"]'));
		const time = m.root.querySelector<HTMLInputElement>('.cp-date-pop input[type="time"]')!;
		await press(time, "Enter");
		expect(document.activeElement).toBe(m.root.querySelector('.cp-pop-row[data-row="time"]'));
	});

	it("Enter in the Deadline field returns focus to the Deadline row", async () => {
		const m = await mountForm();
		await click(dateTool(m.root));
		await click(m.root.querySelector('.cp-pop-row[data-row="deadline"]'));
		const f = m.root.querySelector<HTMLInputElement>('.cp-date-pop input[type="date"]')!;
		await press(f, "Enter");
		expect(document.activeElement).toBe(m.root.querySelector('.cp-pop-row[data-row="deadline"]'));
	});

	it("Escape with focus in the bar input closes an open popover and stops there", async () => {
		const m = await mountForm();
		const seen: string[] = [];
		m.root.parentElement!.addEventListener("keydown", (e) => seen.push(e.key));
		await click(dateTool(m.root));
		const evt = await press(input(m.root), "Escape");
		expect(datePop(m.root)).toBeNull();
		expect(evt.defaultPrevented).toBe(true);
		expect(seen).toEqual([]);
	});

	it("Escape in the bar input with no popover open is left alone", async () => {
		const m = await mountForm();
		const evt = await press(input(m.root), "Escape");
		expect(evt.defaultPrevented).toBe(false);
	});

	it("the more menu Back button has visible text as its accessible name", async () => {
		const m = await mountForm();
		await click(moreTool(m.root));
		await click(m.root.querySelector('.cp-pop-row[data-row="list"]'));
		const back = m.root.querySelector<HTMLElement>(".cp-pop-back")!;
		expect(back.hasAttribute("aria-label")).toBe(false);
		expect(back.textContent).toContain("List");
	});
});

// Popovers fit the space they have; the footer stays visible.
describe("popover fit (short views, Quick Add modal, status bar)", () => {
	const rect = (top: number, height: number): DOMRect => ({ top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) });
	let restore: () => void = () => undefined;
	function fakeLayout(opts: { barTop: number; popHeight: number; windowHeight: number; clipBottom?: number; statusTop?: number }) {
		const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
			if (this.classList.contains("cp-qa-barwrap")) return rect(opts.barTop, 52);
			if (this.classList.contains("cp-pop")) return rect(opts.barTop + 60, opts.popHeight);
			if (this.classList.contains("status-bar")) return rect(opts.statusTop ?? 0, 24);
			if (this.classList.contains("fake-clip")) return rect(0, opts.clipBottom ?? 0);
			return rect(0, 0);
		});
		const innerHeight = window.innerHeight;
		Object.defineProperty(window, "innerHeight", { value: opts.windowHeight, configurable: true });
		restore = () => {
			spy.mockRestore();
			Object.defineProperty(window, "innerHeight", { value: innerHeight, configurable: true });
		};
	}
	afterEach(() => {
		restore();
		restore = () => undefined;
		document.querySelectorAll(".status-bar").forEach((e) => e.remove());
		vi.restoreAllMocks();
	});
	const maxOf = (el: HTMLElement) => el.style.getPropertyValue("--cp-pop-max");

	it("the date popover gets a max height from the space below the bar", async () => {
		fakeLayout({ barTop: 100, popHeight: 480, windowHeight: 500 });
		const m = await mountForm();
		await click(dateTool(m.root));
		expect(maxOf(datePop(m.root)!)).toBe(`${500 - 152 - 8 - 12}px`);
		expect(datePop(m.root)!.classList.contains("is-above")).toBe(false);
	});

	it("stops above Obsidian's status bar", async () => {
		fakeLayout({ barTop: 100, popHeight: 480, windowHeight: 900, statusTop: 476 });
		const m = await mountForm();
		const status = document.createElement("div");
		status.className = "status-bar";
		document.body.appendChild(status);
		await click(dateTool(m.root));
		expect(maxOf(datePop(m.root)!)).toBe(`${476 - 152 - 8 - 12}px`);
	});

	it("stops at the bottom of a clipping container, like the Quick Add modal", async () => {
		fakeLayout({ barTop: 100, popHeight: 480, windowHeight: 900, clipBottom: 420 });
		const m = await mountForm();
		const wrapper = document.createElement("div");
		wrapper.className = "fake-clip";
		// A clipping ancestor, as the modal is (no stylesheet is applied in this environment).
		const real = window.getComputedStyle.bind(window);
		vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) =>
			el.classList.contains("fake-clip") ? ({ overflowY: "auto" } as CSSStyleDeclaration) : real(el, pseudo),
		);
		m.root.parentElement!.appendChild(wrapper);
		wrapper.appendChild(m.root);
		await click(dateTool(m.root));
		expect(maxOf(datePop(m.root)!)).toBe(`${420 - 152 - 8 - 12}px`);
	});

	it("flips above the bar when that has more room", async () => {
		fakeLayout({ barTop: 600, popHeight: 480, windowHeight: 700 });
		const m = await mountForm();
		await click(dateTool(m.root));
		expect(datePop(m.root)!.classList.contains("is-above")).toBe(true);
		expect(maxOf(datePop(m.root)!)).toBe(`${600 - 8 - 12}px`);
	});

	it("the more menu is constrained the same way", async () => {
		fakeLayout({ barTop: 100, popHeight: 400, windowHeight: 400 });
		const m = await mountForm();
		await click(moreTool(m.root));
		expect(maxOf(morePop(m.root)!)).toBe(`${400 - 152 - 8 - 12}px`);
	});

	it("without layout (nothing measurable) no limit is set", async () => {
		const m = await mountForm();
		await click(dateTool(m.root));
		expect(maxOf(datePop(m.root)!)).toBe("");
	});

	it("Clear and OK sit outside the scrolling body, so they stay visible", async () => {
		const m = await mountForm();
		await click(dateTool(m.root));
		const pop = datePop(m.root)!;
		const body = pop.querySelector(".cp-pop-body")!;
		expect(body).not.toBeNull();
		expect(body.querySelector(".cp-quick")).not.toBeNull();
		expect(body.querySelector(".cp-cal")).not.toBeNull();
		const footer = pop.querySelector(".cp-pbtns")!;
		expect(body.contains(footer)).toBe(false);
		expect(footer.parentElement).toBe(pop);
		expect(footer.querySelector(".cp-pop-ok")).not.toBeNull();
		expect(footer.querySelector(".cp-pop-clear")).not.toBeNull();
	});

	it("the stylesheet caps the popover with the variable, scrolls the body and pins the footer", async () => {
		const css = (await import("node:fs")).readFileSync("styles.css", "utf8");
		expect(css).toMatch(/\.cp-pop,[^{]*\{[^}]*max-height:\s*min\(480px,\s*var\(--cp-pop-max,\s*480px\)\)/);
		expect(css).toMatch(/\.cp-pop-body[^{]*\{[^}]*overflow-y:\s*auto/);
		expect(css).toMatch(/\.cp-pop\.is-above[^{]*\{[^}]*bottom:/);
		expect(css).toMatch(/\.cp-more-pop[^{]*\{[^}]*overflow-y:\s*auto/);
	});
});
