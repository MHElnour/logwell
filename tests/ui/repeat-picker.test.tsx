// @vitest-environment happy-dom
import { type VNode, render } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EDIT_REPEAT_LABEL } from "../../src/app/RecurrenceService";
import { explicitRule, repeatRuleProblem } from "../../src/domain/recurrence";
import type { RepeatRule } from "../../src/domain/types";
import type { Chip } from "../../src/parsing";
import { RepeatCustom, RepeatField, RepeatPicker, RepeatPresets } from "../../src/ui/RepeatPicker";
import { columnPatch, datePatch } from "../../src/ui/board/BoardView";
import { detailsDateText } from "../../src/ui/format";
import { groupPatch } from "../../src/ui/groupDrop";
import { QuickAddModel } from "../../src/ui/quickadd/QuickAddModel";
import { chipLabel } from "../../src/ui/quickadd/chipLabels";
import { manualPills } from "../../src/ui/quickadd/manualPills";
import { type RepeatChoice, afterCompletionHint, draftOf, draftProblem, presetChoice, presetHint, presetOf, repeatLine, ruleOfDraft, ruleText, weekdaysFrom } from "../../src/ui/repeat";
import { DEADLINE_CLEARED_TEXT, hasRepeatEditRequest, isPaneShown, notifyReanchored, onRepeatEditRequest, requestRepeatEdit } from "../../src/ui/repeatActions";
import { appHarness } from "../app/harness";
import { cal, cell, click, entries, entry, entryName, openCalendar } from "./calendar-helpers";
import { FRIDAY, type M7Mount, lastNotice, mountM7, openDetails, q, rowFor, rowsFor, settle, showInbox, taskById, weeklyFriday } from "./repeat-helpers";
import { menuItem } from "./app-helpers";
import { checkedOf, openViewMenu, pickItem } from "./view-menu-helpers";

describe("the repeat picker", () => {
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

	describe("rule wording", () => {
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
});

describe("the picker with series, panes and the calendar", () => {
	// Repeating tasks: timed series moves, re-anchor notices, selection of history rows, the
	// "Edit repeat…" request, the calendar's missed occurrences and the details picker's anchor.

	const mounted: M7Mount[] = [];
	afterEach(() => {
		for (const m of mounted.splice(0)) m.unmount();
	});
	async function mount(): Promise<M7Mount> {
		const m = await mountM7();
		mounted.push(m);
		return m;
	}

	const timedWeekly = { kind: "datetime", local: `${FRIDAY}T07:00`, tz: "Europe/Berlin" } as const;
	const create = async (m: M7Mount, title: string, extra: Record<string, unknown> = {}) =>
		(await m.h.app.tasks.create({ title, scheduled: { kind: "date", date: FRIDAY }, repeat: weeklyFriday, ...extra } as never)).task;
	const contextMenu = async (m: M7Mount, row: HTMLElement) => {
		row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
		await settle();
		return m.host.menus.at(-1)!;
	};
	const ZONE = "Europe/Berlin";

	describe("a timed series keeps its time when its date moves (D5)", () => {
		it("the board's patches move the current occurrence, keeping time and zone; a plain task is unchanged", async () => {
			const m = await mount();
			const t = await create(m, "Gym", { scheduled: timedWeekly });
			const spec = m.h.app.effectiveSchedule(taskById(m, t.id));
			expect(spec).toEqual(timedWeekly);
			expect(datePatch(t, "2026-10-12", ZONE, spec)).toEqual({ scheduled: { kind: "datetime", local: "2026-10-12T07:00", tz: ZONE } });
			// Its own current date is no change.
			expect(datePatch(t, FRIDAY, ZONE, spec)).toEqual({});
			const ctx = m.h.app.queryContext();
			const column = { id: "2026-10-12", title: "", date: "2026-10-12", acceptsDrop: true, cards: [], completed: [] };
			expect(columnPatch(t, column, ctx, spec)).toEqual({ scheduled: { kind: "datetime", local: "2026-10-12T07:00", tz: ZONE } });
			expect(groupPatch(t, { kind: "date", date: "2026-10-12" }, ctx, spec)).toEqual({ scheduled: { kind: "datetime", local: "2026-10-12T07:00", tz: ZONE } });
			// Without the schedule the series (scheduled null) would have become all-day: the bug.
			expect(datePatch(t, "2026-10-12", ZONE)).toEqual({ scheduled: { kind: "date", date: "2026-10-12" } });
			const plain = (await m.h.app.tasks.create({ title: "Plain", scheduled: { kind: "datetime", local: `${FRIDAY}T19:00`, tz: ZONE } })).task;
			expect(datePatch(plain, "2026-10-12", ZONE)).toEqual({ scheduled: { kind: "datetime", local: "2026-10-12T19:00", tz: ZONE } });
		});

		it("'Schedule for tomorrow' on a timed series re-anchors it at the same time", async () => {
			const m = await mount();
			const t = await create(m, "Gym", { scheduled: timedWeekly });
			const section = await showInbox(m);
			menuItem(await contextMenu(m, rowFor(section, "Gym")), "Schedule for tomorrow").run();
			await settle();
			const rec = taskById(m, t.id).recurrence!;
			expect(rec.anchor).toBe("2026-10-02");
			expect(rec.versions.at(-1)!.rule).toMatchObject({ time: "07:00", tz: ZONE });
			expect(m.h.app.effectiveSchedule(taskById(m, t.id))).toEqual({ kind: "datetime", local: "2026-10-02T07:00", tz: ZONE });
		});
	});

	describe("re-anchor notices", () => {
		/** The service answers `reanchored` the way the real service does; the real write still runs. */
		function reanchoring(m: M7Mount, reanchored: { date: string; endCleared: boolean }) {
			const orig = m.h.app.tasks.update.bind(m.h.app.tasks);
			vi.spyOn(m.h.app.tasks, "update").mockImplementation(async (...args) => ({ ...(await orig(...args)), reanchored }));
		}

		it("a Schedule for… item on a series says the series now repeats from the new date, and whether its end was removed", async () => {
			const m = await mount();
			await create(m, "Weekly review");
			reanchoring(m, { date: "2026-10-02", endCleared: true });
			const section = await showInbox(m);
			menuItem(await contextMenu(m, rowFor(section, "Weekly review")), "Schedule for tomorrow").run();
			await settle();
			expect(lastNotice(m)).toEqual({ message: '"Weekly review" now repeats from Tomorrow. Its end was removed.', label: "Edit task" });
			expect(lastNotice(m)?.label).toBe(m.h.app.store.undoLabel);
		});

		it("without endCleared the notice has no end sentence; a plain task's date change has no notice", async () => {
			const m = await mount();
			await create(m, "Weekly review");
			await m.h.app.tasks.create({ title: "Plain" });
			const section = await showInbox(m);
			reanchoring(m, { date: "2026-10-02", endCleared: false });
			menuItem(await contextMenu(m, rowFor(section, "Weekly review")), "Schedule for tomorrow").run();
			await settle();
			expect(lastNotice(m)?.message).toBe('"Weekly review" now repeats from Tomorrow.');
			vi.restoreAllMocks();
			const before = m.notices.length;
			menuItem(await contextMenu(m, rowFor(section, "Plain")), "Schedule for tomorrow").run();
			await settle();
			expect(m.notices.length).toBe(before);
		});

		it("no notice when the write changed nothing", async () => {
			const m = await mount();
			await create(m, "Weekly review");
			const orig = m.h.app.tasks.update.bind(m.h.app.tasks);
			vi.spyOn(m.h.app.tasks, "update").mockImplementation(async (...args) => ({ ...(await orig(...args)), changed: false, reanchored: { date: FRIDAY, endCleared: false } }));
			const section = await showInbox(m);
			menuItem(await contextMenu(m, rowFor(section, "Weekly review")), "Schedule for tomorrow").run();
			await settle();
			expect(m.notices).toEqual([]);
		});

		it("notifyReanchored words the date relative to today", async () => {
			const m = await mount();
			notifyReanchored(m.host, { title: "X" }, { date: FRIDAY, endCleared: false }, "Move task", m.h.app.store.undoMark());
			expect(lastNotice(m)).toEqual({ message: '"X" now repeats from Fri, Oct 9.', label: "Move task" });
		});
	});

	describe("selection and the Edit repeat… request", () => {
		it("selecting a series marks its open row, not its Completed history rows", async () => {
			const m = await mount();
			const t = await create(m, "Weekly review");
			await m.h.app.recurrence.complete(t.id);
			const section = await showInbox(m);
			await click(section.querySelector(".cp-completed-toggle"));
			await click(rowsFor(section, "Weekly review").find((r) => r.dataset.occurrence === undefined));
			const rows = rowsFor(section, "Weekly review");
			expect(rows).toHaveLength(2);
			expect(rows.filter((r) => r.classList.contains("is-selected")).map((r) => r.dataset.occurrence)).toEqual([undefined]);
			expect(rows.find((r) => r.dataset.occurrence !== undefined)!.getAttribute("aria-selected")).toBe("false");
		});

		it("the first visible pane takes the request and it is spent; a later mount does not open the picker", async () => {
			const m = await mount();
			const t = await create(m, "Weekly review");
			const seen: string[] = [];
			const off = onRepeatEditRequest((id) => {
				seen.push(id);
				return false; // a hidden copy: declines
			});
			requestRepeatEdit(t.id);
			expect(seen).toEqual([t.id]);
			// Nobody took it: a pane mounting now (visible) still finds it, once.
			expect(hasRepeatEditRequest(t.id, false)).toBe(false);
			expect(hasRepeatEditRequest(t.id)).toBe(true);
			expect(hasRepeatEditRequest(t.id)).toBe(false);
			off();
			// A listener that takes it spends it.
			const take = onRepeatEditRequest(() => true);
			requestRepeatEdit(t.id);
			expect(hasRepeatEditRequest(t.id)).toBe(false);
			take();
		});

		it("re-selecting the task after the picker closed does not open it again", async () => {
			const m = await mount();
			const t = await create(m, "Weekly review");
			const section = await showInbox(m);
			menuItem(await contextMenu(m, rowFor(section, "Weekly review")), "Edit repeat…").run();
			await settle();
			expect(section.querySelector(".cp-details .cp-repeat-pop")).not.toBeNull();
			await click(q(section, ".cp-details-close"));
			await click(rowFor(section, "Weekly review"));
			expect(section.querySelector(".cp-details .cp-repeat-pop")).toBeNull();
			expect(hasRepeatEditRequest(t.id)).toBe(false);
		});
	});

	describe("the details picker names the current occurrence", () => {
		it("a series anchored on a Monday and due on a Friday hints from the Friday, and Weekly and Monthly store that weekday and day", async () => {
			const m = await mount();
			// Every Monday and Friday from Monday Oct 5; completing the Monday leaves Friday Oct 9 as the current occurrence.
			const t = (
				await m.h.app.tasks.create({
					title: "Review",
					scheduled: { kind: "date", date: "2026-10-05" },
					repeat: { rule: { ...weeklyFriday.rule, weekdays: ["MO", "FR"] } },
				} as never)
			).task;
			await m.h.app.recurrence.complete(t.id);
			expect(m.h.app.effectiveSchedule(taskById(m, t.id))).toEqual({ kind: "date", date: FRIDAY });
			const section = await showInbox(m);
			await click(rowFor(section, "Review"));
			await click(q(section, ".cp-details .cp-due-chip"));
			await click(q(section, ".cp-details .cp-repeat-button"));
			const opt = (id: string) => q(section, `.cp-details [data-preset="${id}"]`);
			// The series' own anchor (Monday the 5th) must not be what the hints say.
			expect(opt("weekly").querySelector("small")?.textContent).toBe("on Friday");
			expect(opt("monthly").querySelector("small")?.textContent).toBe("on the 9th");
			await click(opt("weekly"));
			expect(taskById(m, t.id).recurrence?.versions.at(-1)?.rule.weekdays).toEqual(["FR"]);
			await click(q(section, ".cp-details .cp-repeat-button"));
			await click(opt("monthly"));
			expect(taskById(m, t.id).recurrence?.versions.at(-1)?.rule).toMatchObject({ freq: "monthly", monthly: { kind: "day", day: 9 } });
		});

		it("a month-end series due on the 30th still reads, and keeps, the 31st (Quick Add 'every month' on the 31st)", async () => {
			const m = await mount();
			const monthly = { ...weeklyFriday.rule, freq: "monthly" } as const;
			const t = (await m.h.app.tasks.create({ title: "Rent", scheduled: { kind: "date", date: "2026-10-31" }, repeat: { rule: monthly } } as never)).task;
			await m.h.app.recurrence.complete(t.id);
			expect(m.h.app.effectiveSchedule(taskById(m, t.id))).toEqual({ kind: "date", date: "2026-11-30" });
			const section = await showInbox(m);
			await click(rowFor(section, "Rent"));
			await click(q(section, ".cp-details .cp-due-chip"));
			const button = q(section, ".cp-details .cp-repeat-button");
			expect(button.textContent).toBe("monthly on the 31st");
			expect(rowFor(section, "Rent").querySelector(".cp-meta-repeat-text")?.textContent).toContain("31st");
			// Custom → Done with nothing changed is no edit; in particular it never stores the 30th (Dec 30, Jan 30, Mar 30).
			await click(button);
			await click(q(section, '.cp-details [data-preset="custom"]'));
			expect(q(section, ".cp-details .cp-repeat-custom").textContent).toContain("Day 31");
			const before = JSON.stringify(taskById(m, t.id).recurrence);
			await click(q(section, ".cp-details .cp-repeat-done"));
			expect(JSON.stringify(taskById(m, t.id).recurrence)).toBe(before);
			expect(m.notices).toEqual([]);
			// Changing something else in Custom keeps the 31st.
			await click(q(section, ".cp-details .cp-repeat-button"));
			await click(q(section, '.cp-details [data-preset="custom"]'));
			await click(q(section, '.cp-details .cp-repeat-seg [data-end="count"]'));
			await click(q(section, ".cp-details .cp-repeat-done"));
			const rec = taskById(m, t.id).recurrence!;
			expect(rec.end).toEqual({ kind: "count", count: 10 });
			// The rule still means the 31st (stored as "the anchor's day" or spelled out), never the 30th.
			expect(explicitRule(rec.versions.at(-1)!.rule, rec.anchor).monthly).toEqual({ kind: "day", day: 31 });
			expect(m.h.app.effectiveSchedule(taskById(m, t.id))).toEqual({ kind: "date", date: "2026-11-30" });
		});

		it("a weekly series with no picked weekday shows its own anchor's weekday pressed in Custom, and nothing is written until Done", async () => {
			const m = await mount();
			const t = await create(m, "Weekly review");
			const section = await showInbox(m);
			await click(rowFor(section, "Weekly review"));
			await click(q(section, ".cp-details .cp-due-chip"));
			await click(q(section, ".cp-details .cp-repeat-button"));
			await click(q(section, '.cp-details [data-preset="custom"]'));
			expect(q(section, ".cp-details .cp-repeat-day[data-day='FR']").getAttribute("aria-pressed")).toBe("true");
			expect(taskById(m, t.id).recurrence?.versions.at(-1)?.rule.weekdays).toBeNull();
		});
	});

	describe("which pane takes the Edit repeat… request", () => {
		it("isPaneShown: not inside a hidden section; Obsidian's isShown when the element has it, else a layout box", () => {
			const el = document.createElement("div");
			document.body.appendChild(el);
			expect(isPaneShown(null)).toBe(false);
			expect(isPaneShown(el)).toBe(true);
			// The fallback: no isShown, no layout box (a background tab's pane).
			el.getClientRects = () => [] as unknown as DOMRectList;
			expect(isPaneShown(el)).toBe(false);
			// With isShown the box is not asked.
			(el as HTMLElement & { isShown: () => boolean }).isShown = () => true;
			expect(isPaneShown(el)).toBe(true);
			(el as HTMLElement & { isShown: () => boolean }).isShown = () => false;
			el.getClientRects = () => [{}] as unknown as DOMRectList;
			expect(isPaneShown(el)).toBe(false);
			const hidden = document.createElement("section");
			hidden.hidden = true;
			const inner = document.createElement("div");
			hidden.appendChild(inner);
			document.body.appendChild(hidden);
			expect(isPaneShown(inner)).toBe(false);
			el.remove();
			hidden.remove();
		});

		it("a pane without a layout box (a background Logwell tab) leaves the request unspent and its picker closed", async () => {
			const m = await mount();
			const t = await create(m, "Weekly review");
			const section = await showInbox(m);
			await click(rowFor(section, "Weekly review"));
			const pane = q(section, ".cp-details");
			pane.getClientRects = () => [] as unknown as DOMRectList;
			requestRepeatEdit(t.id);
			await settle();
			expect(pane.querySelector(".cp-repeat-pop")).toBeNull();
			expect(hasRepeatEditRequest(t.id)).toBe(true);
		});
	});

	describe("calendar selection of a series", () => {
		it("only the current occurrence's entry is selected, not every date of the series", async () => {
			const m = await mount();
			await m.h.app.tasks.create({ title: "Chore", scheduled: { kind: "date", date: "2026-10-01" }, repeat: { rule: { ...weeklyFriday.rule, freq: "daily" } } } as never);
			await openCalendar(m);
			const week = cal(m.root);
			const chores = () => entries(week, "Chore");
			expect(chores().length).toBeGreaterThan(2);
			await click(entry(week, "Chore", `.cp-cal-allday-cell[data-date="2026-10-01"]`));
			const selected = chores().filter((e) => e.classList.contains("is-selected"));
			expect(selected).toHaveLength(1);
			expect(selected[0]!.closest("[data-date]")!.getAttribute("data-date")).toBe("2026-10-01");
		});
	});

	describe("the row chip describes the rule in force today", () => {
		it("a version that starts in the future is not the chip's text", async () => {
			const m = await mount();
			const t = await create(m, "Gym");
			await m.h.app.recurrence.setRepeat(t.id, { ...weeklyFriday.rule, freq: "daily" } as never, "2026-10-20");
			const section = await showInbox(m);
			expect(rowFor(section, "Gym").querySelector(".cp-meta-repeat-text")?.textContent).toBe("every Fri");
			expect(rowFor(section, "Gym").querySelector<HTMLElement>(".cp-meta-repeat")!.title).toBe("Repeats every Fri");
		});

		it("a timed rule's time is in the chip's title", async () => {
			const m = await mount();
			await create(m, "Gym", { scheduled: timedWeekly });
			const section = await showInbox(m);
			expect(rowFor(section, "Gym").querySelector(".cp-meta-repeat-text")?.textContent).toBe("every Fri");
			expect(rowFor(section, "Gym").querySelector<HTMLElement>(".cp-meta-repeat")!.title).toBe("Repeats every Fri at 07:00");
		});
	});

	describe("a typed timed repeat shows its time", () => {
		it("the chip label says 'every Mon at 17:00'", () => {
			const chip = {
				id: "c",
				kind: "recurrence",
				status: "applied",
				text: "every monday at 5pm",
				span: { start: 0, end: 19 },
				rule: { freq: "weekly", interval: 1, weekdays: ["MO"], monthly: null, afterCompletion: false, time: "17:00", tz: "Europe/Berlin" },
			} as unknown as Chip;
			expect(chipLabel(chip, { zone: "Europe/Berlin", today: "2026-10-01", categories: [], tags: new Map() })).toBe("Repeat: every Mon at 17:00");
		});
	});

	describe("calendar occurrences of an overdue series", () => {
		it("the generated past dates after the current one are missed: faded and dashed with the overdue tint, named as missed", async () => {
			const m = await mount();
			// Daily from Monday Sep 28; today is Thursday Oct 1: Sep 28 is current (overdue), Sep 29 and 30 are missed.
			await m.h.app.tasks.create({ title: "Chore", scheduled: { kind: "date", date: "2026-09-28" }, repeat: { rule: { ...weeklyFriday.rule, freq: "daily" } } } as never);
			await openCalendar(m);
			const week = cal(m.root);
			const on = (date: string) => entries(cell(week, "allday-cell", date), "Chore")[0]!;
			expect([...on("2026-09-28").classList]).not.toContain("is-future");
			for (const date of ["2026-09-29", "2026-09-30"]) {
				const e = on(date);
				expect([...e.classList]).toEqual(expect.arrayContaining(["is-future", "is-past", "is-repeat"]));
				expect(entryName(e)).toContain("missed occurrence");
				expect(entryName(e)).not.toContain("overdue");
			}
			// Today and later are plain future occurrences.
			expect([...on("2026-10-01").classList]).toContain("is-future");
			expect([...on("2026-10-01").classList]).not.toContain("is-past");
			expect(entryName(on("2026-10-01"))).toContain("future occurrence");
		});

		it("a filtered calendar follows the series after an occurrence is skipped (the memo depends on the records)", async () => {
			const m = await mount();
			const work = await m.h.app.categories.create("Work");
			const t = (await m.h.app.tasks.create({ title: "Review", categoryId: work.id, scheduled: { kind: "date", date: "2026-10-01" }, repeat: { rule: { ...weeklyFriday.rule, freq: "daily" } } } as never)).task;
			await openCalendar(m);
			const lists = (await pickItem(m, await openViewMenu(m, cal(m.root)), "Lists…"))!;
			expect(checkedOf(lists, "Work")).toBeFalsy();
			await pickItem(m, lists, "Work");
			expect(entry(cal(m.root), "Review", `.cp-cal-allday-cell[data-date="2026-10-01"]`)).toBeDefined();
			await m.h.app.recurrence.skip(t.id);
			await settle();
			expect(entries(cell(cal(m.root), "allday-cell", "2026-10-01"), "Review")[0]?.classList.contains("is-skipped") ?? false).toBe(false);
			expect([...entry(cal(m.root), "Review", `.cp-cal-allday-cell[data-date="2026-10-02"]`).classList]).not.toContain("is-future");
		});
	});
});

describe("the Yearly preset and the years unit", () => {
	// The Yearly preset and the "years" unit of the repeat picker (#12, Repeating tasks rule 20).
	// Friday 2026-10-09 is the picked date.

	const ANCHOR = "2026-10-09";
	const TODAY = "2026-10-05";
	const never = { kind: "never" } as const;
	const rule = (patch: Partial<RepeatRule> = {}): RepeatRule => ({
		freq: "yearly",
		interval: 1,
		weekdays: null,
		monthly: null,
		afterCompletion: false,
		time: null,
		tz: null,
		...patch,
	});

	let container: HTMLElement | null = null;
	afterEach(() => {
		if (container !== null) render(null, container);
		container?.remove();
		container = null;
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

	const q = <T extends HTMLElement = HTMLElement>(root: ParentNode, sel: string): T => {
		const el = root.querySelector<T>(sel);
		if (el === null) throw new Error(`no ${sel}`);
		return el;
	};

	describe("the Yearly preset (#12)", () => {
		it("#12: is the sixth of seven presets, with the date's month and day as its hint", () => {
			const root = mount(
				<div>
					<span id="lbl">Repeat</span>
					<RepeatPresets value={null} anchor={ANCHOR} labelledBy="lbl" onPick={vi.fn()} onCustom={vi.fn()} />
				</div>,
			);
			const labels = [...root.querySelectorAll('[role="option"]')].map((o) => o.querySelector(".cp-repeat-opt-label")?.textContent);
			expect(labels).toEqual(["Never", "Daily", "Every weekday", "Weekly", "Monthly", "Yearly", "Custom…"]);
			expect(q(root, '[data-preset="yearly"] small').textContent).toBe("on Oct 9");
			expect(presetHint("yearly", "2028-02-29")).toBe("on Feb 29");
		});

		it("#12: picks a yearly rule on the date, keeping the end", async () => {
			const onPick = vi.fn();
			const root = mount(<RepeatPresets value={{ rule: rule({ freq: "daily" }), end: { kind: "count", count: 4 } }} anchor={ANCHOR} labelledBy="lbl" onPick={onPick} onCustom={vi.fn()} />);
			q<HTMLButtonElement>(root, '[data-preset="yearly"]').click();
			await settle();
			const got = onPick.mock.calls[0]![0] as RepeatChoice;
			expect(got.rule).toEqual(rule());
			expect(got.end).toEqual({ kind: "count", count: 4 });
		});

		it("#12: is the preset of an every-year rule; every 2 years or after completion is Custom", () => {
			const c = presetChoice("yearly", null)!;
			expect(repeatRuleProblem(c.rule)).toBeNull();
			expect(presetOf(c, ANCHOR)).toBe("yearly");
			expect(presetChoice("yearly", null, "2026-10-09")!.rule).toEqual(rule());
			expect(presetOf({ rule: rule({ interval: 2 }), end: never }, ANCHOR)).toBe("custom");
			expect(presetOf({ rule: rule({ afterCompletion: true }), end: never }, ANCHOR)).toBe("custom");
		});

		it("#12: names the series' first date for yearly only, when one is given", () => {
			expect(presetHint("yearly", ANCHOR, "2026-01-15")).toBe("on Jan 15");
			expect(presetHint("monthly", ANCHOR, "2026-01-15")).toBe("on the 9th");
			expect(presetHint("weekly", ANCHOR, "2026-01-15")).toBe("on Friday");
			expect(repeatLine({ rule: rule(), end: never }, ANCHOR, TODAY, false, "2026-01-15")).toBe("yearly on Jan 15");
			expect(repeatLine({ rule: rule({ freq: "monthly" }), end: never }, ANCHOR, TODAY, false, "2026-01-15")).toBe("monthly on the 9th");
			expect(ruleText({ rule: rule({ interval: 2 }), end: never }, ANCHOR, "2028-02-29")).toBe("every 2 years on Feb 29");
			expect(ruleText({ rule: rule({ freq: "weekly" }), end: never }, ANCHOR, "2026-01-15")).toBe("every Fri");
		});

		it("#12: words the Repeat line, and the summary notes the Feb 28 fallback of Feb 29", () => {
			expect(repeatLine({ rule: rule(), end: never }, ANCHOR, TODAY)).toBe("yearly on Oct 9");
			expect(repeatLine({ rule: rule(), end: never }, ANCHOR, TODAY, true)).toBe("yearly on Oct 9");
			expect(repeatLine({ rule: rule(), end: never }, "2028-02-29", TODAY)).toBe("yearly on Feb 29");
			expect(repeatLine({ rule: rule(), end: never }, "2028-02-29", TODAY, true)).toBe("yearly on Feb 29 (or Feb 28)");
			expect(repeatLine({ rule: rule({ interval: 4 }), end: never }, "2028-02-29", TODAY, true)).toBe("every 4 years on Feb 29 (or Feb 28)");
			expect(repeatLine({ rule: rule({ afterCompletion: true }), end: never }, "2028-02-29", TODAY, true)).toBe("1 year after done");
		});
	});

	describe("the years unit of the custom editor (#12)", () => {
		it("#12: offers years, has no On row for it, and builds every 2 years", async () => {
			const onDone = vi.fn();
			const root = mount(<RepeatCustom anchor={ANCHOR} today={TODAY} weekStart="MO" value={null} onBack={vi.fn()} onDone={onDone} />);
			const unit = q<HTMLSelectElement>(root, 'select[aria-label="Unit"]');
			expect([...unit.options].map((o) => o.textContent)).toEqual(["days", "weeks", "months", "years"]);
			const interval = q<HTMLInputElement>(root, 'input[aria-label="Interval"]');
			interval.value = "2";
			interval.dispatchEvent(new Event("input", { bubbles: true }));
			unit.value = "yearly";
			unit.dispatchEvent(new Event("change", { bubbles: true }));
			await settle();
			expect(root.querySelector(".cp-repeat-days")).toBeNull();
			expect(root.querySelector('[role="radiogroup"]')).toBeNull();
			expect(q(root, ".cp-repeat-summary").textContent).toBe("Every 2 years on Oct 9");
			q<HTMLButtonElement>(root, ".cp-repeat-done").click();
			await settle();
			expect((onDone.mock.calls[0]![0] as RepeatChoice).rule).toEqual(rule({ interval: 2 }));
		});

		it("#12: opens a stored yearly rule on the years unit", () => {
			expect(draftOf({ rule: rule({ interval: 3 }), end: never }, ANCHOR)).toMatchObject({ freq: "yearly", interval: "3" });
		});

		it("#12: the after-completion hint keeps its wording in every month and across a year end", () => {
			const d = { ...draftOf(null, ANCHOR), freq: "daily" as const, interval: "1" };
			expect(afterCompletionHint(d, "2026-12-31")).toBe("Done on Dec 31 → next Jan 1. Done late on Jan 5 → next Jan 6.");
			expect(afterCompletionHint({ ...d, freq: "monthly" }, "2026-05-01")).toBe("Done on May 1 → next Jun 1. Done late on May 6 → next Jun 6.");
			expect(afterCompletionHint({ ...d, freq: "weekly" }, "2026-08-27")).toBe("Done on Aug 27 → next Sep 3. Done late on Sep 1 → next Sep 8.");
			expect(afterCompletionHint({ ...d, freq: "yearly" }, "2026-12-31")).toBe("Done on Dec 31 → next Dec 31, 2027. Done late on Jan 5 → next Jan 5, 2028.");
		});

		it("#12: the after-completion hint counts whole years and shows the year", () => {
			const d = { ...draftOf(null, ANCHOR), freq: "yearly" as const, interval: "1" };
			expect(afterCompletionHint(d, TODAY)).toBe("Done on Oct 5 → next Oct 5, 2027. Done late on Oct 10 → next Oct 10, 2027.");
			expect(afterCompletionHint(d, "2028-02-29")).toBe("Done on Feb 29 → next Feb 28, 2029. Done late on Mar 5 → next Mar 5, 2029.");
		});
	});
});

describe("Yearly in the details pane", () => {
	// The details pane names a yearly rule from the series' first date (#12, Repeating tasks rule 10: a rule change
	// keeps the anchor). A monthly series anchored Jan 15 whose current occurrence is Oct 15 (today is Oct 1) becomes
	// "yearly on Jan 15", exactly as the engine schedules it, not "on Oct 15".

	const ANCHOR = "2026-01-15";
	const monthly: RepeatRule = { freq: "monthly", interval: 1, weekdays: null, monthly: null, afterCompletion: false, time: null, tz: null };

	const mounted: M7Mount[] = [];
	afterEach(() => {
		for (const m of mounted.splice(0)) m.unmount();
	});

	async function monthlySeries(): Promise<{ m: M7Mount; id: string; pane: HTMLElement }> {
		const m = await mountM7();
		mounted.push(m);
		const { task } = await m.h.app.tasks.create({ title: "Pay rent", scheduled: { kind: "date", date: ANCHOR }, repeat: { rule: monthly } } as never);
		// Overdue since Jan 15: completing marks Jan 15 done and skips Feb to Sep, so the current occurrence is Oct 15.
		await m.h.app.recurrence.complete(task.id);
		await settle();
		const pane = await openDetails(m, "Pay rent");
		expect(q<HTMLInputElement>(pane, 'input[aria-label="Scheduled date"]').value).toBe("2026-10-15");
		return { m, id: task.id, pane };
	}

	const field = (pane: HTMLElement) => q(pane, ".cp-repeat-field");
	const button = (pane: HTMLElement) => q<HTMLButtonElement>(field(pane), ".cp-repeat-button");

	describe("Yearly on an existing series in the details pane (#12)", () => {
		it("#12: the preset hint, the field and the notice name the series' Jan 15; the anchor stays", async () => {
			const { m, id, pane } = await monthlySeries();
			await click(button(pane));
			expect(q(field(pane), '[data-preset="yearly"] small').textContent).toBe("on Jan 15");
			// Other presets keep naming the current occurrence.
			expect(q(field(pane), '[data-preset="monthly"] small').textContent).toBe("on the 15th");
			expect(q(field(pane), '[data-preset="weekly"] small').textContent).toBe("on Thursday");
			await click(q(field(pane), '[data-preset="yearly"]'));
			const rec = taskById(m, id).recurrence!;
			expect(rec.anchor).toBe(ANCHOR);
			expect(rec.versions.at(-1)?.rule).toMatchObject({ freq: "yearly", interval: 1, weekdays: null, monthly: null });
			expect(lastNotice(m)?.message).toBe('"Pay rent" repeats yearly on Jan 15.');
			expect(button(pane).textContent).toBe("yearly on Jan 15");
		});

		it("#12: Custom with the years unit: the summary and the notice name Jan 15", async () => {
			const { m, id, pane } = await monthlySeries();
			await click(button(pane));
			await click(q(field(pane), '[data-preset="custom"]'));
			const interval = q<HTMLInputElement>(field(pane), 'input[aria-label="Interval"]');
			interval.value = "2";
			interval.dispatchEvent(new Event("input", { bubbles: true }));
			const unit = q<HTMLSelectElement>(field(pane), 'select[aria-label="Unit"]');
			unit.value = "yearly";
			unit.dispatchEvent(new Event("change", { bubbles: true }));
			await settle();
			expect(q(field(pane), ".cp-repeat-summary").textContent).toBe("Every 2 years on Jan 15");
			await click(q(field(pane), ".cp-repeat-done"));
			const rec = taskById(m, id).recurrence!;
			expect(rec.anchor).toBe(ANCHOR);
			expect(rec.versions.at(-1)?.rule).toMatchObject({ freq: "yearly", interval: 2 });
			expect(lastNotice(m)?.message).toBe('"Pay rent" repeats every 2 years on Jan 15.');
			expect(button(pane).textContent).toBe("every 2 years on Jan 15");
		});
	});
});

describe("the details date chip and the Repeat field", () => {
	// The details pane's Repeat field and its date chip.

	const mounted: M7Mount[] = [];
	afterEach(() => {
		for (const m of mounted.splice(0)) m.unmount();
	});
	async function mount(): Promise<M7Mount> {
		const m = await mountM7();
		mounted.push(m);
		return m;
	}

	const create = async (m: M7Mount, title: string, extra: Record<string, unknown> = {}) =>
		(await m.h.app.tasks.create({ title, scheduled: { kind: "date", date: FRIDAY }, repeat: weeklyFriday, ...extra } as never)).task;
	const field = (pane: HTMLElement) => q(pane, ".cp-repeat-field");
	const button = (pane: HTMLElement) => q<HTMLButtonElement>(field(pane), ".cp-repeat-button");
	const opt = (pane: HTMLElement, id: string) => q<HTMLButtonElement>(field(pane), `[data-preset="${id}"]`);
	const labelOf = (pane: HTMLElement, text: string) => [...pane.querySelectorAll<HTMLElement>(".cp-field")].find((f) => f.textContent?.startsWith(text));

	describe("the details date chip", () => {
		it("shows the current occurrence and the rule: Fri, Oct 9 · every Fri", async () => {
			const m = await mount();
			await create(m, "Weekly review");
			const pane = await openDetails(m, "Weekly review", false);
			expect(q(pane, ".cp-due-chip").textContent).toContain("Fri, Oct 9 · every Fri");
			expect(q(pane, ".cp-due-chip").getAttribute("aria-label")).toBe("Date and details: Fri, Oct 9 · every Fri");
		});

		it("keeps the plain text for a task that does not repeat", () => {
			expect(detailsDateText({ scheduled: { kind: "date", date: FRIDAY }, deadline: null, plannedDurationMin: null }, "Europe/Berlin", "2026-10-01")).toBe("Fri, Oct 9");
			expect(
				detailsDateText({ scheduled: null, deadline: null, plannedDurationMin: 30 }, "Europe/Berlin", "2026-10-01", {
					schedule: { kind: "date", date: FRIDAY },
					repeat: "every Fri",
				}),
			).toBe("Fri, Oct 9 · every Fri · 30m");
		});
	});

	describe("the Repeat field", () => {
		it("sits next to the Scheduled field with the rule on its button, and the Deadline field is gone", async () => {
			const m = await mount();
			await create(m, "Weekly review");
			const pane = await openDetails(m, "Weekly review");
			const labels = [...pane.querySelectorAll(".cp-details-fields > .cp-field")].map((f) => f.firstElementChild?.textContent);
			expect(labels.slice(0, 2)).toEqual(["Scheduled", "Repeat"]);
			expect(labels).not.toContain("Deadline");
			expect(button(pane).textContent).toBe("every Fri");
			// The Scheduled field shows the current occurrence and cannot be cleared.
			expect(q<HTMLInputElement>(pane, 'input[aria-label="Scheduled date"]').value).toBe(FRIDAY);
			expect(pane.querySelector('[aria-label="Clear scheduled"]')).toBeNull();
		});

		it("shows Never on a task that repeats nothing, with its Deadline field", async () => {
			const m = await mount();
			await m.h.app.tasks.create({ title: "Plain" });
			const pane = await openDetails(m, "Plain");
			expect(button(pane).textContent).toBe("Never");
			expect(labelOf(pane, "Deadline")).toBeDefined();
		});

		it("a subtask has no Repeat field (D10)", async () => {
			const m = await mount();
			const parent = await create(m, "Weekly review");
			await m.h.app.tasks.create({ title: "Inbox zero", parentId: parent.id });
			const pane = await openDetails(m, "Weekly review");
			await click(q(pane, ".cp-subtasks .cp-link-button"));
			const sub = q(m.root, ".cp-tasks .cp-details");
			expect(sub.querySelector(".cp-details-fields")).not.toBeNull();
			expect(sub.querySelector(".cp-repeat-field")).toBeNull();
		});

		it("round trip: a preset changes the rule, the Undo notice carries the label and the store undoes it", async () => {
			const m = await mount();
			const t = await create(m, "Weekly review");
			const pane = await openDetails(m, "Weekly review");
			await click(button(pane));
			await click(opt(pane, "daily"));
			expect(field(pane).querySelector(".cp-repeat-pop")).toBeNull();
			expect(taskById(m, t.id).recurrence?.versions.at(-1)?.rule).toMatchObject({ freq: "daily", interval: 1 });
			expect(button(pane).textContent).toBe("every day");
			expect(lastNotice(m)).toEqual({ message: '"Weekly review" repeats every day.', label: EDIT_REPEAT_LABEL });
			expect(lastNotice(m)?.label).toBe(m.h.app.store.undoLabel);
			await m.h.app.store.undo();
			await settle();
			expect(taskById(m, t.id).recurrence?.versions.at(-1)?.rule.freq).toBe("weekly");
		});

		it("Custom: weekly on Monday, Wednesday and Friday through the editor, with an end", async () => {
			const m = await mount();
			const t = await create(m, "Weekly review");
			const pane = await openDetails(m, "Weekly review");
			// Done with nothing changed is no edit: no new version (the stored rule carries a weekStart the editor does not build), no notice.
			const stored = JSON.stringify(taskById(m, t.id).recurrence);
			expect(taskById(m, t.id).recurrence?.versions.at(-1)?.rule.weekStart).toBeDefined();
			const setRepeat = vi.spyOn(m.h.app.recurrence, "setRepeat");
			await click(button(pane));
			await click(opt(pane, "custom"));
			await click(q(field(pane), ".cp-repeat-done"));
			expect(setRepeat).not.toHaveBeenCalled();
			expect(JSON.stringify(taskById(m, t.id).recurrence)).toBe(stored);
			expect(m.notices).toEqual([]);
			await click(button(pane));
			await click(opt(pane, "custom"));
			// Friday is already pressed: the series' own weekday is spelled out in the editor.
			for (const d of ["MO", "WE"]) await click(q(field(pane), `.cp-repeat-day[data-day="${d}"]`));
			await click(q(field(pane), '.cp-repeat-seg [data-end="count"]'));
			const times = q<HTMLInputElement>(field(pane), 'input[aria-label="Times"]');
			times.value = "8";
			times.dispatchEvent(new Event("input", { bubbles: true }));
			await settle();
			await click(q(field(pane), ".cp-repeat-done"));
			const rec = taskById(m, t.id).recurrence!;
			expect(rec.versions.at(-1)?.rule.weekdays).toEqual(["MO", "WE", "FR"]);
			expect(rec.end).toEqual({ kind: "count", count: 8 });
			expect(lastNotice(m)?.message).toBe('"Weekly review" repeats every Mon, Wed, Fri.');
			expect(button(pane).textContent).toBe("every Mon, Wed, Fri · ends after 8 times");
		});

		it("Never stops it repeating: a plain task on its current date", async () => {
			const m = await mount();
			const t = await create(m, "Weekly review");
			const pane = await openDetails(m, "Weekly review");
			await click(button(pane));
			await click(opt(pane, "never"));
			const after = taskById(m, t.id);
			expect(after.recurrence).toBeNull();
			expect(after.scheduled).toEqual({ kind: "date", date: FRIDAY });
			expect(lastNotice(m)).toEqual({ message: '"Weekly review" no longer repeats.', label: EDIT_REPEAT_LABEL });
		});

		it("makes a plain task repeat; its deadline is cleared and the notice says so (decision 9)", async () => {
			const m = await mount();
			const t = (await m.h.app.tasks.create({ title: "Report", scheduled: { kind: "date", date: FRIDAY }, deadline: { kind: "date", date: "2026-10-12" } })).task;
			const pane = await openDetails(m, "Report");
			await click(button(pane));
			await click(opt(pane, "weekly"));
			const after = taskById(m, t.id);
			expect(after.deadline).toBeNull();
			expect(after.scheduled).toBeNull();
			expect(after.recurrence?.anchor).toBe(FRIDAY);
			expect(lastNotice(m)?.message).toBe(`"Report" repeats every Fri. ${DEADLINE_CLEARED_TEXT}`);
			expect(DEADLINE_CLEARED_TEXT).toBe("The deadline was cleared: a repeating task has no deadline.");
			expect(pane.querySelector('input[aria-label="Deadline date"]')).toBeNull();
		});

		it("shows no notice when the write changed nothing", async () => {
			const m = await mount();
			await create(m, "Weekly review");
			const pane = await openDetails(m, "Weekly review");
			await click(button(pane));
			await click(opt(pane, "weekly"));
			expect(m.notices).toEqual([]);
		});

		it("opens its picker when a row menu asks for it (Edit repeat…)", async () => {
			const m = await mount();
			const t = await create(m, "Weekly review");
			const pane = await openDetails(m, "Weekly review", false);
			expect(pane.querySelector(".cp-details-fields")).toBeNull();
			requestRepeatEdit(t.id);
			await settle();
			expect(pane.querySelector(".cp-details-fields")).not.toBeNull();
			expect(field(pane).querySelector(".cp-repeat-pop")).not.toBeNull();
		});

		it("refuses to clear the date of a repeating task", async () => {
			const m = await mount();
			const t = await create(m, "Weekly review");
			const pane = await openDetails(m, "Weekly review");
			const date = q<HTMLInputElement>(pane, 'input[aria-label="Scheduled date"]');
			date.value = "";
			date.dispatchEvent(new Event("change", { bubbles: true }));
			await settle();
			expect(taskById(m, t.id).recurrence).not.toBeNull();
			expect(m.host.messages).toContain("Change the repeat instead of clearing the date.");
			expect(q<HTMLInputElement>(pane, 'input[aria-label="Scheduled date"]').value).toBe(FRIDAY);
		});
	});
});

// Tasks and Quick Add rules 23 and 37, Repeating tasks rule 19 (#12): a value picked by hand wins and never leaves
// saving blocked; the date popover's Clear dismisses every typed repeat end; the pill of a repeat picked by hand shows
// the end that will be saved; the picker keeps a stored end it did not change. Europe/Berlin, Wednesday 2026-10-07.

async function model() {
	const h = await appHarness();
	h.clock.set("2026-10-07T08:00:00.000Z");
	const m = new QuickAddModel(
		{
			app: h.app,
			preset: {},
			locale: () => "en",
			resolveNote: () => [],
			onSaved: () => undefined,
			onError: (e) => {
				throw e;
			},
			keepOpen: () => true,
			onClose: () => undefined,
		},
		() => undefined,
	);
	return { h, m };
}

const friday = { freq: "weekly" as const, interval: 1, weekdays: ["FR" as const], monthly: null, afterCompletion: false, time: null, tz: null };

describe("a hand-picked date over a typed yearly start (#12)", () => {
	it("#12: saves at once on the picked date; the typed start is a 'Replace date?' offer, not a block", async () => {
		const { h, m } = await model();
		m.setInput("Birthday every year on May 5 at 7");
		m.setDate("2026-11-01");
		expect(m.result.blocking).toEqual([]);
		expect(m.result.chips.find((c) => c.kind === "scheduled")).toMatchObject({ status: "choice", notice: "Replace date?" });
		expect(await m.submit()).toBe("saved");
		await vi.waitFor(() => expect([...h.app.store.state.tasks.values()]).toHaveLength(1));
		const task = [...h.app.store.state.tasks.values()][0]!;
		expect(task.recurrence).toMatchObject({ anchor: "2026-11-01", versions: [{ rule: { freq: "yearly" } }] });
		// The typed start stays an offer, so its text stays in the title (Tasks and Quick Add rule 23).
		expect(task.title).toBe("Birthday May 5 at 7");
	});
});

describe("Clear in the date popover (#12)", () => {
	it("#12: dismisses an invalid repeat end too, so the date never comes back as a deadline", async () => {
		const { m } = await model();
		m.setInput("Gym every friday until Oct 8");
		expect(m.result.chips.map((c) => `${c.kind}/${c.status}`)).toEqual(["recurrence/applied", "repeatEnd/invalid"]);
		m.clearDateFields();
		expect(m.result.chips).toEqual([]);
		expect(m.result.fields.deadline).toBeUndefined();
		expect(m.result.blocking).toEqual([]);
		expect(m.result.title).toBe("Gym every friday until Oct 8");
	});

	it("#12: dismisses an end that waits for the repeat's time", async () => {
		const { m } = await model();
		m.setInput("Gym every monday at 9 until Dec 1");
		expect(m.result.chips.find((c) => c.kind === "repeatEnd")?.status).toBe("suggestion");
		m.clearDateFields();
		expect(m.result.chips.filter((c) => c.kind === "repeatEnd" || c.kind === "deadline")).toEqual([]);
	});
});

describe("the pill of a repeat picked by hand (#12)", () => {
	it("#12: shows the typed end that will be saved, not only the picked value", async () => {
		const { m } = await model();
		m.setRepeat({ rule: friday, end: { kind: "never" } });
		m.setInput("Gym until Dec 1");
		expect(m.repeatValue()).toEqual({ rule: friday, end: { kind: "date", date: "2026-12-01" } });
		const pill = manualPills(m).find((p) => p.kind === "recurrence")!;
		expect(pill.label).toBe("Repeat: every Fri · ends Dec 1");
	});
});

describe("the repeat picker and a stored end (#12)", () => {
	it("#12: keeps a stored count above 999 while it is unchanged, as the services do", () => {
		const stored = { rule: friday, end: { kind: "count" as const, count: 1500 } };
		const d = draftOf(stored, "2026-10-07");
		expect(draftProblem(d, "2026-10-07", "MO", stored.end)).toBeNull();
		expect(draftProblem({ ...d, endCount: "1501" }, "2026-10-07", "MO", stored.end)).toBe("End after 1 to 999 times.");
		expect(draftProblem(d, "2026-10-07", "MO")).toBe("End after 1 to 999 times.");
	});
});

describe("choosing a typed repeat's hour (#12)", () => {
	it("#12: blocks saving: Enter opens the choice, and the pick saves with the chosen hour", async () => {
		const { h, m } = await model();
		m.setInput("Gym every monday at 9");
		const chip = m.result.chips.find((c) => c.kind === "recurrence")!;
		expect(m.result.blocking).toEqual([chip.id]);
		expect(await m.submit()).toBe("blocked");
		expect(m.openChipId).toBe(chip.id);
		expect([...h.app.store.state.tasks.values()]).toHaveLength(0);
		m.setChipRule(chip, chip.alternatives![1]!.rule!);
		await vi.waitFor(() => expect([...h.app.store.state.tasks.values()]).toHaveLength(1));
		const task = [...h.app.store.state.tasks.values()][0]!;
		expect(task.title).toBe("Gym");
		expect(task.recurrence?.versions[0]?.rule).toMatchObject({ freq: "weekly", weekdays: ["MO"], time: "21:00" });
	});

	it("#12: the end typed after it waits for the hour and saves with it", async () => {
		const { h, m } = await model();
		m.setInput("Gym every day at 7 until Dec 1");
		expect(await m.submit()).toBe("blocked");
		const chip = m.result.chips.find((c) => c.kind === "recurrence")!;
		m.setChipRule(chip, chip.alternatives![0]!.rule!);
		await vi.waitFor(() => expect([...h.app.store.state.tasks.values()]).toHaveLength(1));
		expect([...h.app.store.state.tasks.values()][0]!.recurrence).toMatchObject({ end: { kind: "date", date: "2026-12-01" }, versions: [{ rule: { freq: "daily", time: "07:00" } }] });
	});

	it("#12: a pick made without Enter only applies the hour: nothing saves by itself", async () => {
		const { h, m } = await model();
		m.setInput("Gym every monday at 9");
		const chip = m.result.chips.find((c) => c.kind === "recurrence")!;
		m.activate(chip);
		m.setChipRule(chip, chip.alternatives![1]!.rule!);
		await Promise.resolve();
		expect([...h.app.store.state.tasks.values()]).toHaveLength(0);
		expect(m.repeatValue()?.rule.time).toBe("21:00");
	});
});
