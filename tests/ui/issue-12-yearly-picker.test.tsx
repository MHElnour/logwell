// @vitest-environment happy-dom
import { type VNode, render } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { repeatRuleProblem } from "../../src/domain/recurrence";
import type { RepeatRule } from "../../src/domain/types";
import { RepeatCustom, RepeatPresets } from "../../src/ui/RepeatPicker";
import { type RepeatChoice, afterCompletionHint, draftOf, presetChoice, presetHint, presetOf, repeatLine, ruleText } from "../../src/ui/repeat";

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
	it("is the sixth of seven presets, with the date's month and day as its hint", () => {
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

	it("picks a yearly rule on the date, keeping the end", async () => {
		const onPick = vi.fn();
		const root = mount(<RepeatPresets value={{ rule: rule({ freq: "daily" }), end: { kind: "count", count: 4 } }} anchor={ANCHOR} labelledBy="lbl" onPick={onPick} onCustom={vi.fn()} />);
		q<HTMLButtonElement>(root, '[data-preset="yearly"]').click();
		await settle();
		const got = onPick.mock.calls[0]![0] as RepeatChoice;
		expect(got.rule).toEqual(rule());
		expect(got.end).toEqual({ kind: "count", count: 4 });
	});

	it("is the preset of an every-year rule; every 2 years or after completion is Custom", () => {
		const c = presetChoice("yearly", null)!;
		expect(repeatRuleProblem(c.rule)).toBeNull();
		expect(presetOf(c, ANCHOR)).toBe("yearly");
		expect(presetChoice("yearly", null, "2026-10-09")!.rule).toEqual(rule());
		expect(presetOf({ rule: rule({ interval: 2 }), end: never }, ANCHOR)).toBe("custom");
		expect(presetOf({ rule: rule({ afterCompletion: true }), end: never }, ANCHOR)).toBe("custom");
	});

	it("names the series' first date for yearly only, when one is given", () => {
		expect(presetHint("yearly", ANCHOR, "2026-01-15")).toBe("on Jan 15");
		expect(presetHint("monthly", ANCHOR, "2026-01-15")).toBe("on the 9th");
		expect(presetHint("weekly", ANCHOR, "2026-01-15")).toBe("on Friday");
		expect(repeatLine({ rule: rule(), end: never }, ANCHOR, TODAY, false, "2026-01-15")).toBe("yearly on Jan 15");
		expect(repeatLine({ rule: rule({ freq: "monthly" }), end: never }, ANCHOR, TODAY, false, "2026-01-15")).toBe("monthly on the 9th");
		expect(ruleText({ rule: rule({ interval: 2 }), end: never }, ANCHOR, "2028-02-29")).toBe("every 2 years on Feb 29");
		expect(ruleText({ rule: rule({ freq: "weekly" }), end: never }, ANCHOR, "2026-01-15")).toBe("every Fri");
	});

	it("words the Repeat line, and the summary notes the Feb 28 fallback of Feb 29", () => {
		expect(repeatLine({ rule: rule(), end: never }, ANCHOR, TODAY)).toBe("yearly on Oct 9");
		expect(repeatLine({ rule: rule(), end: never }, ANCHOR, TODAY, true)).toBe("yearly on Oct 9");
		expect(repeatLine({ rule: rule(), end: never }, "2028-02-29", TODAY)).toBe("yearly on Feb 29");
		expect(repeatLine({ rule: rule(), end: never }, "2028-02-29", TODAY, true)).toBe("yearly on Feb 29 (or Feb 28)");
		expect(repeatLine({ rule: rule({ interval: 4 }), end: never }, "2028-02-29", TODAY, true)).toBe("every 4 years on Feb 29 (or Feb 28)");
		expect(repeatLine({ rule: rule({ afterCompletion: true }), end: never }, "2028-02-29", TODAY, true)).toBe("1 year after done");
	});
});

describe("the years unit of the custom editor (#12)", () => {
	it("offers years, has no On row for it, and builds every 2 years", async () => {
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

	it("opens a stored yearly rule on the years unit", () => {
		expect(draftOf({ rule: rule({ interval: 3 }), end: never }, ANCHOR)).toMatchObject({ freq: "yearly", interval: "3" });
	});

	it("the after-completion hint keeps its wording in every month and across a year end", () => {
		const d = { ...draftOf(null, ANCHOR), freq: "daily" as const, interval: "1" };
		expect(afterCompletionHint(d, "2026-12-31")).toBe("Done on Dec 31 → next Jan 1. Done late on Jan 5 → next Jan 6.");
		expect(afterCompletionHint({ ...d, freq: "monthly" }, "2026-05-01")).toBe("Done on May 1 → next Jun 1. Done late on May 6 → next Jun 6.");
		expect(afterCompletionHint({ ...d, freq: "weekly" }, "2026-08-27")).toBe("Done on Aug 27 → next Sep 3. Done late on Sep 1 → next Sep 8.");
		expect(afterCompletionHint({ ...d, freq: "yearly" }, "2026-12-31")).toBe("Done on Dec 31 → next Dec 31, 2027. Done late on Jan 5 → next Jan 5, 2028.");
	});

	it("the after-completion hint counts whole years and shows the year", () => {
		const d = { ...draftOf(null, ANCHOR), freq: "yearly" as const, interval: "1" };
		expect(afterCompletionHint(d, TODAY)).toBe("Done on Oct 5 → next Oct 5, 2027. Done late on Oct 10 → next Oct 10, 2027.");
		expect(afterCompletionHint(d, "2028-02-29")).toBe("Done on Feb 29 → next Feb 28, 2029. Done late on Mar 5 → next Mar 5, 2029.");
	});
});
