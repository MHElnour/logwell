// @vitest-environment happy-dom
import { type VNode, render } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { repeatRuleProblem } from "../../src/domain/recurrence";
import type { RepeatRule } from "../../src/domain/types";
import { RepeatCustom, RepeatField, RepeatPicker, RepeatPresets } from "../../src/ui/RepeatPicker";
import {
	type RepeatChoice,
	afterCompletionHint,
	draftOf,
	draftProblem,
	presetChoice,
	presetOf,
	repeatLine,
	ruleOfDraft,
	ruleText,
	weekdaysFrom,
} from "../../src/ui/repeat";

// The repeat picker. Friday 2026-10-09 is the picked date.

const ANCHOR = "2026-10-09";
const TODAY = "2026-10-05";
const env: { anchor: string; today: string; weekStart: "MO" | "SU" | "SA" } = { anchor: ANCHOR, today: TODAY, weekStart: "MO" };

const rule = (patch: Partial<RepeatRule> = {}): RepeatRule => ({
	freq: "weekly",
	interval: 1,
	weekdays: null,
	monthly: null,
	afterCompletion: false,
	time: null,
	tz: null,
	...patch,
});
const never = { kind: "never" } as const;

let container: HTMLElement | null = null;
afterEach(() => {
	if (container !== null) render(null, container);
	container?.remove();
	container = null;
	vi.useRealTimers();
});

const settle = async () => {
	for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

function mount(node: VNode): HTMLElement {
	container = document.createElement("div");
	document.body.appendChild(container);
	render(node, container);
	return container;
}

const click = async (el: Element | null | undefined) => {
	if (el === null || el === undefined) throw new Error("element not found");
	(el as HTMLElement).click();
	await settle();
};
const q = <T extends HTMLElement = HTMLElement>(root: ParentNode, sel: string): T => {
	const el = root.querySelector<T>(sel);
	if (el === null) throw new Error(`no ${sel}`);
	return el;
};
const keydown = (el: Element, key: string) => {
	const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
	el.dispatchEvent(e);
	return e;
};
const setValue = async (el: HTMLInputElement | HTMLSelectElement, value: string, event: "input" | "change" = "input") => {
	el.value = value;
	el.dispatchEvent(new Event(event, { bubbles: true }));
	await settle();
};
const opt = (root: ParentNode, id: string) => q<HTMLButtonElement>(root, `[data-preset="${id}"]`);

describe("preset helpers", () => {
	it("tells the preset of a value, ignoring time and the end", () => {
		expect(presetOf(null, ANCHOR)).toBe("never");
		expect(presetOf({ rule: rule({ freq: "daily" }), end: never }, ANCHOR)).toBe("daily");
		expect(presetOf({ rule: rule({ weekdays: ["MO", "TU", "WE", "TH", "FR"] }), end: never }, ANCHOR)).toBe("weekday");
		expect(presetOf({ rule: rule(), end: never }, ANCHOR)).toBe("weekly");
		expect(presetOf({ rule: rule({ weekdays: ["FR"] }), end: { kind: "count", count: 3 } }, ANCHOR)).toBe("weekly");
		expect(presetOf({ rule: rule({ weekdays: ["MO"] }), end: never }, ANCHOR)).toBe("custom");
		expect(presetOf({ rule: rule({ freq: "monthly" }), end: never }, ANCHOR)).toBe("monthly");
		expect(presetOf({ rule: rule({ freq: "monthly", monthly: { kind: "day", day: 9 } }), end: never }, ANCHOR)).toBe("monthly");
		expect(presetOf({ rule: rule({ freq: "monthly", monthly: { kind: "day", day: 15 } }), end: never }, ANCHOR)).toBe("custom");
		expect(presetOf({ rule: rule({ interval: 2 }), end: never }, ANCHOR)).toBe("custom");
		expect(presetOf({ rule: rule({ freq: "daily", afterCompletion: true }), end: never }, ANCHOR)).toBe("custom");
	});

	it("builds every preset as a valid rule and keeps the time, the zone and the end of the value it replaces", () => {
		for (const id of ["daily", "weekday", "weekly", "monthly", "yearly"] as const) {
			const c = presetChoice(id, null)!;
			expect(repeatRuleProblem(c.rule), id).toBeNull();
			expect(presetOf(c, ANCHOR), id).toBe(id);
		}
		expect(presetChoice("never", { rule: rule(), end: never })).toBeNull();
		const timed: RepeatChoice = { rule: rule({ time: "09:30", tz: "Europe/Berlin" }), end: { kind: "date", date: "2026-12-31" } };
		const daily = presetChoice("daily", timed)!;
		expect(daily.rule.time).toBe("09:30");
		expect(daily.rule.tz).toBe("Europe/Berlin");
		expect(daily.end).toEqual({ kind: "date", date: "2026-12-31" });
	});

	it("words the Repeat line: Never, or the rule and its end", () => {
		expect(repeatLine(null, ANCHOR, TODAY)).toBe("Never");
		expect(repeatLine({ rule: rule(), end: never }, ANCHOR, TODAY)).toBe("every Fri");
		expect(repeatLine({ rule: rule(), end: { kind: "count", count: 10 } }, ANCHOR, TODAY)).toBe("every Fri · ends after 10 times");
	});

	it("orders the weekdays from the week start", () => {
		expect(weekdaysFrom("MO")[0]).toBe("MO");
		expect(weekdaysFrom("SU")).toEqual(["SU", "MO", "TU", "WE", "TH", "FR", "SA"]);
		expect(weekdaysFrom("SA")[0]).toBe("SA");
	});
});

describe("rule wording (M7 fix round)", () => {
	const timed = (patch: Partial<RepeatRule> = {}): RepeatChoice => ({ rule: rule({ time: "17:00", tz: "Europe/Berlin", weekdays: ["MO"], ...patch }), end: never });

	it("says the time of a timed rule in the short and the long wording", () => {
		expect(repeatLine(timed(), ANCHOR, TODAY)).toBe("every Mon at 17:00");
		expect(repeatLine(timed(), ANCHOR, TODAY, true)).toBe("every Monday at 17:00");
		expect(ruleText(timed(), ANCHOR)).toBe("every Mon at 17:00");
		expect(ruleText({ rule: rule(), end: never }, ANCHOR)).toBe("every Fri");
	});

	it("spells weekdays out only in the long wording, and only the short names", () => {
		const choice: RepeatChoice = { rule: rule({ weekdays: ["MO", "WE"] }), end: { kind: "count", count: 2 } };
		expect(repeatLine(choice, ANCHOR, TODAY)).toBe("every Mon, Wed · ends after 2 times");
		expect(repeatLine(choice, ANCHOR, TODAY, true)).toBe("every Monday, Wednesday · ends after 2 times");
		expect(repeatLine({ rule: rule({ freq: "monthly", monthly: { kind: "nth", n: -1, weekday: "FR" } }), end: never }, ANCHOR, TODAY, true)).toBe("monthly on the last Friday");
	});

	it("the Weekly and Monthly presets name the date's weekday and day when asked to, and agree with their own hint", () => {
		const weekly = presetChoice("weekly", null, "2026-10-09")!;
		expect(weekly.rule.weekdays).toEqual(["FR"]);
		expect(presetOf(weekly, "2026-10-09")).toBe("weekly");
		const monthly = presetChoice("monthly", null, "2026-10-09")!;
		expect(monthly.rule.monthly).toEqual({ kind: "day", day: 9 });
		expect(presetOf(monthly, "2026-10-09")).toBe("monthly");
		expect(presetChoice("weekly", null)!.rule.weekdays).toBeNull();
		expect(presetChoice("monthly", null)!.rule.monthly).toBeNull();
	});

	it("the after-completion hint is the mockup's example from today and the interval", () => {
		const d = { ...draftOf(null, ANCHOR), freq: "daily" as const, interval: "3" };
		expect(afterCompletionHint(d, TODAY)).toBe("Done on Oct 5 → next Oct 8. Done late on Oct 10 → next Oct 13.");
		expect(afterCompletionHint({ ...d, freq: "weekly", interval: "2" }, TODAY)).toBe("Done on Oct 5 → next Oct 19. Done late on Oct 10 → next Oct 24.");
		expect(afterCompletionHint({ ...d, freq: "monthly", interval: "1" }, "2026-01-31")).toBe("Done on Jan 31 → next Feb 28. Done late on Feb 5 → next Mar 5.");
		expect(afterCompletionHint({ ...d, freq: "weekly", days: ["MO"] }, TODAY)).toBe("Not with picked weekdays: the days are fixed.");
	});
});

describe("presets face", () => {
	function presets(value: RepeatChoice | null = null) {
		const onPick = vi.fn();
		const onCustom = vi.fn();
		const root = mount(
			<div>
				<span id="lbl">Repeat</span>
				<RepeatPresets value={value} anchor={ANCHOR} labelledBy="lbl" onPick={onPick} onCustom={onCustom} />
			</div>,
		);
		return { root, onPick, onCustom };
	}

	it("is a listbox of the seven presets with the mockup's small texts", () => {
		const { root } = presets();
		const list = q(root, '[role="listbox"]');
		expect(list.getAttribute("aria-labelledby")).toBe("lbl");
		expect(list.hasAttribute("aria-label")).toBe(false);
		const options = [...list.querySelectorAll('[role="option"]')];
		expect(options.map((o) => o.querySelector(".cp-repeat-opt-label")?.textContent)).toEqual([
			"Never",
			"Daily",
			"Every weekday",
			"Weekly",
			"Monthly",
			"Yearly",
			"Custom…",
		]);
		expect(opt(root, "weekday").querySelector("small")?.textContent).toBe("Mon–Fri");
		expect(opt(root, "weekly").querySelector("small")?.textContent).toBe("on Friday");
		expect(opt(root, "monthly").querySelector("small")?.textContent).toBe("on the 9th");
		expect(opt(root, "yearly").querySelector("small")?.textContent).toBe("on Oct 9");
		expect(opt(root, "never").querySelector("small")).toBeNull();
	});

	it("marks the current preset: Never without a value, Custom for a rule no preset is", () => {
		expect(opt(presets().root, "never").getAttribute("aria-selected")).toBe("true");
		expect(opt(presets({ rule: rule({ freq: "daily" }), end: never }).root, "daily").getAttribute("aria-selected")).toBe("true");
		expect(opt(presets({ rule: rule({ interval: 3 }), end: never }).root, "custom").getAttribute("aria-selected")).toBe("true");
	});

	it("picks each preset with the right rule", async () => {
		const expected: Record<string, Partial<RepeatRule> | null> = {
			never: null,
			daily: { freq: "daily", interval: 1, weekdays: null },
			weekday: { freq: "weekly", interval: 1, weekdays: ["MO", "TU", "WE", "TH", "FR"] },
			weekly: { freq: "weekly", interval: 1, weekdays: null },
			monthly: { freq: "monthly", interval: 1, monthly: null },
			yearly: { freq: "yearly", interval: 1, weekdays: null, monthly: null },
		};
		for (const [id, want] of Object.entries(expected)) {
			const { root, onPick } = presets({ rule: rule({ freq: "daily" }), end: { kind: "count", count: 4 } });
			await click(opt(root, id));
			expect(onPick, id).toHaveBeenCalledTimes(1);
			const got = onPick.mock.calls[0]![0] as RepeatChoice | null;
			if (want === null) expect(got, id).toBeNull();
			else {
				expect(got!.rule, id).toMatchObject({ ...want, afterCompletion: false });
				expect(got!.end, id).toEqual({ kind: "count", count: 4 });
			}
			render(null, container!);
			container!.remove();
			container = null;
		}
	});

	it("picking the preset a value already is hands the value back unchanged (nothing to rewrite)", async () => {
		const value: RepeatChoice = { rule: rule({ time: "09:00", tz: "Europe/Berlin" }), end: { kind: "count", count: 3 } };
		const { root, onPick } = presets(value);
		await click(opt(root, "weekly"));
		expect(onPick).toHaveBeenCalledWith(value);
	});

	it("Custom… opens the editor instead of picking", async () => {
		const { root, onPick, onCustom } = presets();
		await click(opt(root, "custom"));
		expect(onCustom).toHaveBeenCalledTimes(1);
		expect(onPick).not.toHaveBeenCalled();
	});

	it("has one tab stop (the selected option) and arrow keys, Home and End move focus", async () => {
		const { root } = presets({ rule: rule({ freq: "daily" }), end: never });
		const options = [...root.querySelectorAll<HTMLElement>('[role="option"]')];
		expect(options.filter((o) => o.tabIndex === 0)).toHaveLength(1);
		expect(opt(root, "daily").tabIndex).toBe(0);
		opt(root, "daily").focus();
		keydown(opt(root, "daily"), "ArrowDown");
		expect(document.activeElement).toBe(opt(root, "weekday"));
		keydown(opt(root, "weekday"), "ArrowUp");
		expect(document.activeElement).toBe(opt(root, "daily"));
		keydown(opt(root, "daily"), "End");
		expect(document.activeElement).toBe(opt(root, "custom"));
		keydown(opt(root, "custom"), "ArrowDown");
		expect(document.activeElement).toBe(opt(root, "custom"));
		keydown(opt(root, "custom"), "Home");
		expect(document.activeElement).toBe(opt(root, "never"));
	});
});

describe("custom face", () => {
	function custom(value: RepeatChoice | null = null, extra: Partial<typeof env> = {}) {
		const onBack = vi.fn();
		const onDone = vi.fn();
		const root = mount(<RepeatCustom {...env} {...extra} value={value} onBack={onBack} onDone={onDone} />);
		return { root, onBack, onDone };
	}
	const interval = (root: HTMLElement) => q<HTMLInputElement>(root, 'input[aria-label="Interval"]');
	const unit = (root: HTMLElement) => q<HTMLSelectElement>(root, 'select[aria-label="Unit"]');
	const done = (root: HTMLElement) => q<HTMLButtonElement>(root, ".cp-repeat-done");
	const summary = (root: HTMLElement) => q(root, ".cp-repeat-summary").textContent;
	const day = (root: HTMLElement, d: string) => q<HTMLButtonElement>(root, `.cp-repeat-day[data-day="${d}"]`);
	const check = (root: HTMLElement) => q<HTMLInputElement>(root, '.cp-repeat-check input[type="checkbox"]');
	const ends = (root: HTMLElement, kind: string) => q<HTMLButtonElement>(root, `.cp-repeat-seg [data-end="${kind}"]`);

	it("starts from the picked date: every 1 week, no weekday pressed, Done enabled", () => {
		const { root } = custom();
		expect(q(root, ".cp-repeat-title").textContent).toBe("Custom repeat");
		expect(interval(root).value).toBe("1");
		expect(unit(root).value).toBe("weekly");
		expect([...unit(root).options].map((o) => o.textContent)).toEqual(["days", "weeks", "months", "years"]);
		expect(root.querySelectorAll('.cp-repeat-day[aria-pressed="true"]')).toHaveLength(0);
		expect(summary(root)).toBe("Every Friday");
		expect(done(root).disabled).toBe(false);
	});

	it("builds a weekly rule with picked weekdays, an interval and an end count", async () => {
		const { root, onDone } = custom();
		await setValue(interval(root), "2");
		for (const d of ["WE", "MO", "FR"]) await click(day(root, d));
		expect(day(root, "MO").getAttribute("aria-pressed")).toBe("true");
		expect(day(root, "MO").getAttribute("aria-label")).toBe("Monday");
		await click(ends(root, "count"));
		await setValue(q<HTMLInputElement>(root, 'input[aria-label="Times"]'), "10");
		expect(summary(root)).toBe("Every 2 weeks, Monday, Wednesday, Friday · ends after 10 times");
		await click(done(root));
		expect(onDone).toHaveBeenCalledTimes(1);
		const choice = onDone.mock.calls[0]![0] as RepeatChoice;
		expect(choice.rule).toEqual(rule({ interval: 2, weekdays: ["MO", "WE", "FR"] }));
		expect(choice.end).toEqual({ kind: "count", count: 10 });
	});

	it("shows the weekday buttons from the week start", () => {
		const { root } = custom(null, { weekStart: "SU" });
		expect([...root.querySelectorAll<HTMLElement>(".cp-repeat-day")].map((b) => b.dataset.day)).toEqual(["SU", "MO", "TU", "WE", "TH", "FR", "SA"]);
	});

	it("turns Count from when I complete it off, with the reason, while weekdays are picked", async () => {
		const { root, onDone } = custom();
		await click(check(root));
		expect(check(root).checked).toBe(true);
		expect(q(root, ".cp-repeat-check small").textContent).toBe("Done on Oct 5 → next Oct 12. Done late on Oct 10 → next Oct 17.");
		await click(day(root, "MO"));
		expect(check(root).disabled).toBe(true);
		expect(check(root).checked).toBe(false);
		expect(q(root, ".cp-repeat-check small").textContent).toBe("Not with picked weekdays: the days are fixed.");
		await click(day(root, "MO"));
		expect(check(root).disabled).toBe(false);
		await click(done(root));
		expect((onDone.mock.calls[0]![0] as RepeatChoice).rule).toMatchObject({ afterCompletion: true, weekdays: null });
	});

	it("builds a daily after-completion rule: every 3 days", async () => {
		const { root, onDone } = custom();
		await setValue(interval(root), "3");
		await setValue(unit(root), "daily", "change");
		expect(root.querySelector(".cp-repeat-days")).toBeNull();
		await click(check(root));
		expect(summary(root)).toBe("3 days after done");
		await click(done(root));
		expect((onDone.mock.calls[0]![0] as RepeatChoice).rule).toEqual(rule({ freq: "daily", interval: 3, afterCompletion: true }));
	});

	it("builds the three monthly forms", async () => {
		const { root, onDone } = custom({ rule: rule({ freq: "monthly" }), end: never }, { anchor: "2026-10-31" });
		expect(root.querySelector(".cp-repeat-day")).toBeNull();
		const group = q(root, '[role="radiogroup"]');
		expect(group.getAttribute("aria-labelledby")).not.toBeNull();
		expect(group.hasAttribute("aria-label")).toBe(false);
		expect(group.textContent).toContain("Day 31");
		expect(group.textContent).toContain("(else the month’s last day)");
		expect(summary(root)).toBe("Monthly on the 31st (or the month's last day)");
		await click(done(root));
		expect((onDone.mock.calls[0]![0] as RepeatChoice).rule).toMatchObject({ freq: "monthly", monthly: { kind: "day", day: 31 } });

		await click(q(root, 'input[data-kind="nth"]'));
		await setValue(q<HTMLSelectElement>(root, 'select[aria-label="Which one"]'), "-1", "change");
		await setValue(q<HTMLSelectElement>(root, 'select[aria-label="Weekday"]'), "FR", "change");
		expect(summary(root)).toBe("Monthly on the last Friday");
		expect(check(root).disabled).toBe(true);
		expect(q(root, ".cp-repeat-check small").textContent).toBe("Not with this day of the month: the day is fixed.");
		await click(done(root));
		expect((onDone.mock.calls[1]![0] as RepeatChoice).rule).toMatchObject({ monthly: { kind: "nth", n: -1, weekday: "FR" } });

		await click(q(root, 'input[data-kind="lastDay"]'));
		expect(summary(root)).toBe("Monthly on the last day");
		await click(done(root));
		expect((onDone.mock.calls[2]![0] as RepeatChoice).rule).toMatchObject({ monthly: { kind: "lastDay" } });
	});

	it("changing the weekday or the position of the Nth form selects that form", async () => {
		const { root } = custom({ rule: rule({ freq: "monthly" }), end: never });
		expect(q<HTMLInputElement>(root, 'input[data-kind="day"]').checked).toBe(true);
		await setValue(q<HTMLSelectElement>(root, 'select[aria-label="Which one"]'), "2", "change");
		expect(q<HTMLInputElement>(root, 'input[data-kind="nth"]').checked).toBe(true);
	});

	it("starts the Nth form on the picked date's own position (the 9th of October 2026 is the second Friday)", async () => {
		const { root, onDone } = custom({ rule: rule({ freq: "monthly" }), end: never });
		await click(q(root, 'input[data-kind="nth"]'));
		await click(done(root));
		expect((onDone.mock.calls[0]![0] as RepeatChoice).rule.monthly).toEqual({ kind: "nth", n: 2, weekday: "FR" });
	});

	it("moves the monthly selection with the arrow keys (the radiogroup)", async () => {
		const { root } = custom({ rule: rule({ freq: "monthly" }), end: never });
		const radio = (k: string) => q<HTMLInputElement>(root, `input[data-kind="${k}"]`);
		radio("day").focus();
		const e = keydown(radio("day"), "ArrowDown");
		expect(e.defaultPrevented).toBe(true);
		await settle();
		expect(radio("nth").checked).toBe(true);
		expect(document.activeElement).toBe(radio("nth"));
		keydown(radio("nth"), "ArrowDown");
		await settle();
		expect(radio("lastDay").checked).toBe(true);
		keydown(radio("lastDay"), "ArrowDown");
		await settle();
		expect(radio("day").checked).toBe(true);
		keydown(radio("day"), "ArrowUp");
		await settle();
		expect(radio("lastDay").checked).toBe(true);
	});

	it("ends: Never, On date and After N times", async () => {
		const { root, onDone } = custom();
		expect(ends(root, "never").getAttribute("aria-pressed")).toBe("true");
		await click(ends(root, "date"));
		expect(ends(root, "date").getAttribute("aria-pressed")).toBe("true");
		expect(ends(root, "never").getAttribute("aria-pressed")).toBe("false");
		await setValue(q<HTMLInputElement>(root, 'input[aria-label="End date"]'), "2026-12-31");
		expect(summary(root)).toBe("Every Friday · ends Dec 31");
		await click(done(root));
		expect((onDone.mock.calls[0]![0] as RepeatChoice).end).toEqual({ kind: "date", date: "2026-12-31" });
	});

	it("shows the problem instead of saving: interval 0, no end date, a date before the start, 0 times", async () => {
		const { root, onDone } = custom();
		await setValue(interval(root), "0");
		expect(summary(root)).toBe("Repeat every 1 to 999.");
		expect(q(root, ".cp-repeat-summary").classList.contains("is-problem")).toBe(true);
		expect(done(root).disabled).toBe(true);
		await click(done(root));
		expect(onDone).not.toHaveBeenCalled();
		await setValue(interval(root), "");
		expect(summary(root)).toBe("Repeat every 1 to 999.");
		await setValue(interval(root), "1");
		await click(ends(root, "date"));
		expect(summary(root)).toBe("Pick an end date.");
		await setValue(q<HTMLInputElement>(root, 'input[aria-label="End date"]'), "2026-10-01");
		expect(summary(root)).toBe("The repeat ends before its first date.");
		await click(ends(root, "count"));
		await setValue(q<HTMLInputElement>(root, 'input[aria-label="Times"]'), "0");
		expect(summary(root)).toBe("End after 1 to 999 times.");
		expect(done(root).disabled).toBe(true);
	});

	it("opens on the value being edited, keeping its time and zone", async () => {
		const value: RepeatChoice = {
			rule: rule({ interval: 2, weekdays: ["TU", "TH"], time: "09:30", tz: "Europe/Berlin" }),
			end: { kind: "count", count: 5 },
		};
		const { root, onDone } = custom(value);
		expect(interval(root).value).toBe("2");
		expect(day(root, "TU").getAttribute("aria-pressed")).toBe("true");
		expect(day(root, "TH").getAttribute("aria-pressed")).toBe("true");
		expect(ends(root, "count").getAttribute("aria-pressed")).toBe("true");
		await click(done(root));
		expect(onDone.mock.calls[0]![0]).toEqual(value);
	});

	it("Back leaves without a value; focus starts on the interval", async () => {
		const { root, onBack, onDone } = custom();
		await settle();
		expect(document.activeElement).toBe(interval(root));
		await click(q(root, ".cp-repeat-back"));
		expect(onBack).toHaveBeenCalledTimes(1);
		expect(onDone).not.toHaveBeenCalled();
	});

	it("draft helpers: a draft always describes a rule the domain accepts or names the problem", () => {
		const d = draftOf(null, ANCHOR);
		expect(draftProblem(d, ANCHOR)).toBeNull();
		expect(repeatRuleProblem(ruleOfDraft(d))).toBeNull();
		expect(draftProblem({ ...d, interval: "1.5" }, ANCHOR)).toBe("Repeat every 1 to 999.");
		expect(draftProblem({ ...d, freq: "monthly", monthKind: "nth", after: true }, ANCHOR)).toBeNull();
		expect(ruleOfDraft({ ...d, freq: "monthly", monthKind: "nth", after: true }).afterCompletion).toBe(false);
	});
});

describe("the picker on its own", () => {
	function picker(value: RepeatChoice | null = null) {
		const onDone = vi.fn();
		const onClose = vi.fn();
		const outer = vi.fn();
		const root = mount(
			<div onKeyDown={outer}>
				<RepeatPicker {...env} value={value} onDone={onDone} onClose={onClose} />
			</div>,
		);
		return { root, onDone, onClose, outer };
	}

	it("is a dialog named by hidden text, with the Repeat line and the presets", () => {
		const { root } = picker({ rule: rule(), end: never });
		const dialog = q(root, '[role="dialog"]');
		expect(dialog.hasAttribute("aria-label")).toBe(false);
		expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe("Repeat");
		expect(q(root, ".cp-repeat-line").textContent).toContain("every Fri");
		expect(opt(root, "weekly").getAttribute("aria-selected")).toBe("true");
	});

	it("picks a preset at once, and Custom… then Done returns the custom value", async () => {
		const { root, onDone } = picker();
		await click(opt(root, "daily"));
		expect((onDone.mock.calls[0]![0] as RepeatChoice).rule.freq).toBe("daily");
		await click(opt(root, "custom"));
		expect(q(root, '[role="dialog"]').textContent).toContain("Custom repeat");
		await click(q(root, ".cp-repeat-done"));
		expect(onDone).toHaveBeenCalledTimes(2);
		expect((onDone.mock.calls[1]![0] as RepeatChoice).rule).toMatchObject({ freq: "weekly", interval: 1 });
	});

	it("Back from Custom returns to the presets with focus on Custom…", async () => {
		const { root } = picker();
		await click(opt(root, "custom"));
		await click(q(root, ".cp-repeat-back"));
		expect(root.querySelector(".cp-repeat-custom")).toBeNull();
		expect(document.activeElement).toBe(opt(root, "custom"));
	});

	it("Escape closes only the picker: the key stops there", async () => {
		const { root, onClose, outer } = picker();
		const e = keydown(opt(root, "never"), "Escape");
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(e.defaultPrevented).toBe(true);
		expect(outer).not.toHaveBeenCalled();
		await click(opt(root, "custom"));
		keydown(q(root, ".cp-repeat-num"), "Escape");
		expect(onClose).toHaveBeenCalledTimes(2);
		expect(outer).not.toHaveBeenCalled();
	});

	it("keeps Tab inside the picker", async () => {
		const { root } = picker();
		await click(opt(root, "custom"));
		const focusable = [...root.querySelectorAll<HTMLElement>("button, input, select")].filter((e) => !(e as HTMLButtonElement).disabled);
		const last = focusable[focusable.length - 1]!;
		last.focus();
		const e = keydown(last, "Tab");
		expect(e.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(focusable[0]);
	});

	it("puts aria-label only on controls (Obsidian shows a tooltip for any element that has one)", async () => {
		const { root } = picker();
		await click(opt(root, "custom"));
		await setValue(q<HTMLSelectElement>(root, 'select[aria-label="Unit"]'), "monthly", "change");
		for (const el of root.querySelectorAll("[aria-label]")) {
			expect(["BUTTON", "INPUT", "SELECT"], `${el.tagName}.${el.className}`).toContain(el.tagName);
		}
		expect(root.querySelectorAll("[aria-label]").length).toBeGreaterThan(3);
	});
});

describe("the Repeat field", () => {
	it("shows the rule on its button, opens the picker in place and applies a pick", async () => {
		const onChange = vi.fn();
		const root = mount(<RepeatField {...env} value={null} onChange={onChange} />);
		const button = q<HTMLButtonElement>(root, ".cp-repeat-button");
		expect(button.textContent).toBe("Never");
		expect(button.getAttribute("aria-expanded")).toBe("false");
		expect(button.getAttribute("aria-haspopup")).toBe("dialog");
		await click(button);
		expect(button.getAttribute("aria-expanded")).toBe("true");
		expect(root.querySelector(".cp-repeat-pop")).not.toBeNull();
		await click(opt(root, "weekday"));
		expect(onChange).toHaveBeenCalledTimes(1);
		expect((onChange.mock.calls[0]![0] as RepeatChoice).rule.weekdays).toEqual(["MO", "TU", "WE", "TH", "FR"]);
		expect(root.querySelector(".cp-repeat-pop")).toBeNull();
	});

	it("shows an existing rule with its end and returns focus to the button on Escape", async () => {
		const root = mount(<RepeatField {...env} value={{ rule: rule(), end: { kind: "count", count: 3 } }} onChange={() => undefined} />);
		const button = q<HTMLButtonElement>(root, ".cp-repeat-button");
		expect(button.textContent).toBe("every Fri · ends after 3 times");
		await click(button);
		keydown(opt(root, "weekly"), "Escape");
		await settle();
		expect(root.querySelector(".cp-repeat-pop")).toBeNull();
		expect(document.activeElement).toBe(button);
	});

	it("can be disabled with a title (a subtask does not repeat)", () => {
		const root = mount(<RepeatField {...env} value={null} onChange={() => undefined} disabled title="A subtask cannot repeat" />);
		const button = q<HTMLButtonElement>(root, ".cp-repeat-button");
		expect(button.disabled).toBe(true);
		expect(button.title).toBe("A subtask cannot repeat");
	});

	it("opens when something else asks for it", async () => {
		const root = mount(<RepeatField {...env} value={null} onChange={() => undefined} openRequest={1} />);
		await settle();
		expect(root.querySelector(".cp-repeat-pop")).not.toBeNull();
	});
});
