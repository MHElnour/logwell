// @vitest-environment happy-dom
import { render } from "preact";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { CheckpointApp } from "../../src/app/App";
import { QuickAddForm } from "../../src/ui/QuickAddForm";
import { DEADLINE_CLEARED_TEXT } from "../../src/ui/repeatActions";
import { appHarness } from "../app/harness";

// The repeat in Quick Add: the date popover's Repeat row, the "All fields" Repeat field,
// the pills and chips, and the save. Real services and parser, a fake host. The harness clock is 2026-10-01T10:00Z
// (Thursday), zone Europe/Berlin.

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

async function click(el: Element | null | undefined): Promise<void> {
	if (el === null || el === undefined) throw new Error("element not found");
	(el as HTMLElement).click();
	await settle();
}

async function setValue(el: HTMLInputElement | HTMLSelectElement, value: string, event: "input" | "change" = "input"): Promise<void> {
	el.value = value;
	el.dispatchEvent(new Event(event, { bubbles: true }));
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
	/** The warnings each save reported (the text after "Added" in the notice). */
	warnings: string[][];
	errors: unknown[];
	/** What the modal's Escape calls first (QuickAddForm's registerEscape). */
	closeOverlay: () => boolean;
}

async function mountForm(preset: { parentId?: string; date?: string | null } = {}, app?: CheckpointApp): Promise<Mounted> {
	const a = app ?? (await appHarness()).app;
	const saved: string[] = [];
	const warnings: string[][] = [];
	const errors: unknown[] = [];
	const root = document.createElement("div");
	const m: Mounted = { app: a, root, saved, warnings, errors, closeOverlay: () => false };
	container = root;
	document.body.appendChild(root);
	render(
		<QuickAddForm
			app={a}
			preset={preset}
			locale={() => "en"}
			weekStart={() => "MO"}
			eveningTime={() => "20:00"}
			keepOpen={() => false}
			pickNote={async () => null}
			resolveNote={() => []}
			setIcon={(el, icon) => el.setAttribute("data-icon", icon)}
			attachTokenSuggest={() => ({ isOpen: () => false, dispose: () => undefined })}
			onSaved={(title, w) => {
				saved.push(title);
				warnings.push(w);
			}}
			onError={(err) => void errors.push(err)}
			onClose={() => undefined}
			registerEscape={(fn) => {
				m.closeOverlay = fn;
			}}
		/>,
		root,
	);
	await settle();
	return m;
}

const q = <T extends HTMLElement = HTMLElement>(root: ParentNode, sel: string): T => {
	const el = root.querySelector<T>(sel);
	if (el === null) throw new Error(`no ${sel}`);
	return el;
};
const input = (root: HTMLElement) => q<HTMLInputElement>(root, ".cp-quick-add-title");
const dateTool = (root: HTMLElement) => q<HTMLButtonElement>(root, '.cp-qa-tool[aria-label="Date"]');
const repeatRow = (root: HTMLElement) => q<HTMLButtonElement>(root, '.cp-pop-row[data-row="repeat"]');
const day = (root: HTMLElement, date: string) => q<HTMLButtonElement>(root, `.cp-cal-day[data-date="${date}"]`);
const opt = (root: ParentNode, id: string) => q<HTMLButtonElement>(root, `[data-preset="${id}"]`);
const pills = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(".cp-qa-manual-label")].map((p) => p.textContent);
const tasks = (m: Mounted) => [...m.app.store.state.tasks.values()];
const key = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

describe("the date popover's Repeat row", () => {
	it("is one row after Time and Deadline, showing Never; it opens the presets in place", async () => {
		const m = await mountForm();
		await click(dateTool(m.root));
		const rows = [...m.root.querySelectorAll<HTMLElement>(".cp-pop-row")].map((r) => r.dataset.row);
		expect(rows).toEqual(["time", "deadline", "repeat"]);
		expect(repeatRow(m.root).querySelector(".cp-pop-val")?.textContent).toBe("Never");
		expect(repeatRow(m.root).querySelector('[data-icon="repeat"]')).not.toBeNull();
		expect(repeatRow(m.root).getAttribute("aria-expanded")).toBe("false");
		await click(repeatRow(m.root));
		expect(repeatRow(m.root).getAttribute("aria-expanded")).toBe("true");
		const list = q(m.root, '.cp-date-pop [role="listbox"]');
		expect(list.querySelectorAll('[role="option"]')).toHaveLength(6);
		expect(document.activeElement).toBe(opt(m.root, "never"));
	});

	it("picks a preset: the row shows it, a purple pill names it, and the task is saved repeating from the picked date", async () => {
		const m = await mountForm();
		await click(dateTool(m.root));
		await click(day(m.root, "2026-10-05"));
		await click(repeatRow(m.root));
		expect(opt(m.root, "weekly").querySelector("small")?.textContent).toBe("on Monday");
		await click(opt(m.root, "weekday"));
		expect(m.root.querySelector(".cp-repeat-opts")).toBeNull();
		expect(repeatRow(m.root).querySelector(".cp-pop-val")?.textContent).toBe("every weekday");
		expect(pills(m.root)).toContain("Repeat: every weekday");
		expect(q(m.root, '.cp-qa-manual[data-kind="recurrence"]').querySelector('[data-icon="repeat"]')).not.toBeNull();
		await typeInto(input(m.root), "Standup");
		input(m.root).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		await settle();
		const [t] = tasks(m);
		expect(t?.title).toBe("Standup");
		expect(t?.scheduled).toBeNull();
		expect(t?.recurrence?.anchor).toBe("2026-10-05");
		expect(t?.recurrence?.versions[0]?.rule).toMatchObject({ freq: "weekly", interval: 1, weekdays: ["MO", "TU", "WE", "TH", "FR"] });
		expect(t?.recurrence?.end).toEqual({ kind: "never" });
	});

	it("repeats from today when no date was picked", async () => {
		const m = await mountForm();
		await click(dateTool(m.root));
		await click(repeatRow(m.root));
		await click(opt(m.root, "daily"));
		await typeInto(input(m.root), "Water plants");
		input(m.root).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		await settle();
		expect(tasks(m)[0]?.recurrence?.anchor).toBe("2026-10-01");
	});

	it("Custom… swaps the popover for the editor; Done returns to the date face with the rule set, with its end", async () => {
		const m = await mountForm();
		await click(dateTool(m.root));
		await click(day(m.root, "2026-10-05"));
		await click(repeatRow(m.root));
		await click(opt(m.root, "custom"));
		const pop = q(m.root, ".cp-date-pop");
		expect(pop.classList.contains("is-repeat")).toBe(true);
		expect(pop.textContent).toContain("Custom repeat");
		expect(m.root.querySelector(".cp-cal-day")).toBeNull();
		for (const d of ["MO", "WE"]) await click(q(pop, `.cp-repeat-day[data-day="${d}"]`));
		await click(q(pop, '.cp-repeat-seg [data-end="count"]'));
		await setValue(q<HTMLInputElement>(pop, 'input[aria-label="Times"]'), "6");
		await click(q(pop, ".cp-repeat-done"));
		expect(m.root.querySelector(".cp-repeat-custom")).toBeNull();
		expect(m.root.querySelector(".cp-cal-day")).not.toBeNull();
		expect(repeatRow(m.root).querySelector(".cp-pop-val")?.textContent).toBe("every Mon, Wed · ends after 6 times");
		expect(document.activeElement).toBe(repeatRow(m.root));
		await typeInto(input(m.root), "Gym");
		input(m.root).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		await settle();
		const rec = tasks(m)[0]?.recurrence;
		expect(rec?.versions[0]?.rule).toMatchObject({ weekdays: ["MO", "WE"] });
		expect(rec?.end).toEqual({ kind: "count", count: 6 });
	});

	it("Back from the editor returns to the date face unchanged", async () => {
		const m = await mountForm();
		await click(dateTool(m.root));
		await click(repeatRow(m.root));
		await click(opt(m.root, "custom"));
		await click(q(m.root, ".cp-repeat-back"));
		expect(m.root.querySelector(".cp-cal-day")).not.toBeNull();
		expect(repeatRow(m.root).querySelector(".cp-pop-val")?.textContent).toBe("Never");
		expect(pills(m.root)).toEqual([]);
	});

	it("Clear in the popover removes the repeat with the date", async () => {
		const m = await mountForm();
		await click(dateTool(m.root));
		await click(repeatRow(m.root));
		await click(opt(m.root, "daily"));
		expect(pills(m.root)).toContain("Repeat: every day");
		await click(q(m.root, ".cp-pop-clear"));
		expect(pills(m.root)).toEqual([]);
		expect(repeatRow(m.root).querySelector(".cp-pop-val")?.textContent).toBe("Never");
	});

	it("removing the pill drops the manual repeat", async () => {
		const m = await mountForm();
		await click(dateTool(m.root));
		await click(repeatRow(m.root));
		await click(opt(m.root, "monthly"));
		await click(q(m.root, '.cp-qa-manual[data-kind="recurrence"] .cp-qa-manual-remove'));
		expect(pills(m.root)).toEqual([]);
	});

	it("Escape closes the popover and nothing else", async () => {
		const m = await mountForm();
		await click(dateTool(m.root));
		await click(repeatRow(m.root));
		key(opt(m.root, "never"), "Escape");
		await settle();
		expect(m.root.querySelector(".cp-date-pop")).toBeNull();
	});

	it("a subtask's bar has no Repeat row (D10)", async () => {
		const m0 = await mountForm();
		const parent = (await m0.app.tasks.create({ title: "Parent" })).task;
		render(null, m0.root);
		m0.root.remove();
		const m = await mountForm({ parentId: parent.id }, m0.app);
		await click(dateTool(m.root));
		expect(m.root.querySelector('.cp-pop-row[data-row="repeat"]')).toBeNull();
		expect(m.root.querySelector(".cp-pop-row[data-row=deadline]")).not.toBeNull();
	});
});

describe("a typed repeat", () => {
	it("applies as a purple chip and saves the task repeating, with the words out of the title", async () => {
		const m = await mountForm();
		await typeInto(input(m.root), "Water plants every day");
		const chip = q(m.root, '.cp-qa-chip[data-kind="recurrence"]');
		expect(chip.dataset.status).toBe("applied");
		expect(chip.textContent).toContain("Repeat: every day");
		input(m.root).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		await settle();
		const [t] = tasks(m);
		expect(t?.title).toBe("Water plants");
		expect(t?.recurrence?.versions[0]?.rule).toMatchObject({ freq: "daily", interval: 1 });
		expect(t?.recurrence?.anchor).toBe("2026-10-01");
	});

	it("the date popover shows it, and picking Never by hand overrides the chip like the other manual fields (B4)", async () => {
		const m = await mountForm();
		await typeInto(input(m.root), "Water plants every day");
		await click(dateTool(m.root));
		expect(repeatRow(m.root).querySelector(".cp-pop-val")?.textContent).toBe("every day");
		await click(repeatRow(m.root));
		await click(opt(m.root, "never"));
		expect(repeatRow(m.root).querySelector(".cp-pop-val")?.textContent).toBe("Never");
		await click(dateTool(m.root));
		input(m.root).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		await settle();
		expect(tasks(m)[0]?.recurrence).toBeNull();
	});

	it("x on the chip keeps the words as the title and does not repeat", async () => {
		const m = await mountForm();
		await typeInto(input(m.root), "Water plants every day");
		await click(q(m.root, '.cp-qa-chip[data-kind="recurrence"] .cp-qa-chip-remove'));
		input(m.root).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		await settle();
		expect(tasks(m)[0]?.title).toBe("Water plants every day");
		expect(tasks(m)[0]?.recurrence).toBeNull();
	});

	it("a deadline on a repeating task is dropped on save: the task repeats, the notice says so", async () => {
		const m = await mountForm();
		await typeInto(input(m.root), "Report every week");
		await click(dateTool(m.root));
		await click(repeatRow(m.root));
		await click(opt(m.root, "daily"));
		await click(q(m.root, '.cp-pop-row[data-row="deadline"]'));
		await setValue(q<HTMLInputElement>(m.root, 'input[aria-label="Deadline"]'), "2026-10-12");
		expect(q(m.root, ".cp-date-pop .cp-pop-empty").textContent).toBe("A repeating task has no deadline.");
		await click(dateTool(m.root));
		input(m.root).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		await settle();
		expect(m.errors).toEqual([]);
		expect(tasks(m)).toHaveLength(1);
		expect(tasks(m)[0]?.title).toBe("Report every week");
		expect(tasks(m)[0]?.recurrence).not.toBeNull();
		expect(tasks(m)[0]?.deadline).toBeNull();
		expect(m.warnings).toEqual([[DEADLINE_CLEARED_TEXT]]);
	});

	it("a typed deadline with a typed repeat saves the repeating task without the deadline", async () => {
		const m = await mountForm();
		await typeInto(input(m.root), "Pay rent every month by friday");
		input(m.root).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		await settle();
		expect(m.errors).toEqual([]);
		expect(tasks(m)).toHaveLength(1);
		expect(tasks(m)[0]?.title).toBe("Pay rent");
		expect(tasks(m)[0]?.recurrence?.versions[0]?.rule).toMatchObject({ freq: "monthly" });
		expect(tasks(m)[0]?.deadline).toBeNull();
		expect(m.warnings).toEqual([[DEADLINE_CLEARED_TEXT]]);
	});

	it("a repeat without a deadline adds no notice", async () => {
		const m = await mountForm();
		await typeInto(input(m.root), "Water plants every day");
		input(m.root).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		await settle();
		expect(tasks(m)).toHaveLength(1);
		expect(m.warnings).toEqual([[]]);
	});

	it("a failed write keeps what was typed and the deadline", async () => {
		const m = await mountForm();
		await typeInto(input(m.root), "Report every week by friday");
		const create = m.app.tasks.create.bind(m.app.tasks);
		m.app.tasks.create = () => Promise.reject(new Error("disk full"));
		input(m.root).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		await settle();
		m.app.tasks.create = create;
		expect(m.errors).toHaveLength(1);
		expect(tasks(m)).toHaveLength(0);
		expect(input(m.root).value).toBe("Report every week by friday");
		expect(m.warnings).toEqual([]);
	});

	it("a subtask still cannot repeat: it says so and writes nothing", async () => {
		const { app } = await appHarness();
		const parent = (await app.tasks.create({ title: "Parent" })).task;
		const m = await mountForm({ parentId: parent.id }, app);
		await typeInto(input(m.root), "Child every day");
		input(m.root).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		await settle();
		expect(tasks(m).filter((t) => t.parentId !== null)).toHaveLength(0);
		expect(q(m.root, ".cp-form-message").textContent).toContain("A subtask cannot repeat");
	});
});

describe("a typed repeat with a bare hour", () => {
	const chipOf = (root: HTMLElement) => q(root, '.cp-qa-chip[data-kind="recurrence"]');
	const panelOptions = (root: HTMLElement) => [...q<HTMLSelectElement>(root, ".cp-qa-panel select").options].map((o) => o.textContent);
	const save = async (m: Mounted) => {
		input(m.root).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		await settle();
	};

	it("asks 09:00 or 21:00 in the same picker a date's bare hour uses", async () => {
		const m = await mountForm();
		await typeInto(input(m.root), "Gym tomorrow at 9");
		await click(q(m.root, '.cp-qa-chip[data-kind="scheduled"] .cp-qa-chip-main'));
		const forDate = panelOptions(m.root);
		await typeInto(input(m.root), "Gym every monday at 9");
		expect(chipOf(m.root).dataset.status).toBe("choice");
		await click(q(chipOf(m.root), ".cp-qa-chip-main"));
		expect(forDate).toEqual(["09:00", "21:00"]);
		expect(panelOptions(m.root)).toEqual(forDate);
		expect(q(m.root, ".cp-qa-panel-title").textContent).toBe('Choose a value for "every monday at 9"');
	});

	it("choosing 21:00 repeats at 21:00 in the zone and takes the words out of the title", async () => {
		const m = await mountForm();
		await typeInto(input(m.root), "Gym every monday at 9");
		await click(q(chipOf(m.root), ".cp-qa-chip-main"));
		await setValue(q<HTMLSelectElement>(m.root, ".cp-qa-panel select"), "1", "change");
		await click(q(m.root, ".cp-qa-panel .cp-qa-apply"));
		expect(chipOf(m.root).dataset.status).toBe("applied");
		expect(chipOf(m.root).textContent).toContain("Repeat: every Mon");
		await save(m);
		expect(tasks(m)[0]?.title).toBe("Gym");
		expect(tasks(m)[0]?.recurrence?.versions[0]?.rule).toMatchObject({ freq: "weekly", weekdays: ["MO"], time: "21:00", tz: "Europe/Berlin" });
	});

	it("the first option is preselected, so Apply alone gives 09:00", async () => {
		const m = await mountForm();
		await typeInto(input(m.root), "Gym every day at 9");
		await click(q(chipOf(m.root), ".cp-qa-chip-main"));
		await click(q(m.root, ".cp-qa-panel .cp-qa-apply"));
		await save(m);
		expect(tasks(m)[0]?.recurrence?.versions[0]?.rule).toMatchObject({ freq: "daily", time: "09:00" });
	});

	it("saving without choosing keeps the words in the title and does not repeat", async () => {
		const m = await mountForm();
		await typeInto(input(m.root), "Gym every monday at 9");
		await save(m);
		expect(tasks(m)[0]?.title).toBe("Gym every monday at 9");
		expect(tasks(m)[0]?.recurrence).toBeNull();
	});

	it("a chosen reading replaces a repeat picked by hand, like a chosen date does", async () => {
		const m = await mountForm();
		await typeInto(input(m.root), "Gym every monday at 9");
		await click(dateTool(m.root));
		await click(repeatRow(m.root));
		await click(opt(m.root, "daily"));
		await click(dateTool(m.root));
		expect(chipOf(m.root).textContent).toContain("Replace repeat?");
		await click(q(chipOf(m.root), ".cp-qa-chip-main"));
		await click(q(m.root, ".cp-qa-panel .cp-qa-apply"));
		await save(m);
		expect(tasks(m)[0]?.recurrence?.versions[0]?.rule).toMatchObject({ freq: "weekly", weekdays: ["MO"], time: "09:00" });
	});

	it("explicit hours never ask", async () => {
		for (const [text, time] of [["9am", "09:00"], ["9pm", "21:00"], ["21:00", "21:00"], ["09:00", "09:00"]] as const) {
			const m = await mountForm();
			await typeInto(input(m.root), `Gym every day at ${text}`);
			expect(chipOf(m.root).dataset.status, text).toBe("applied");
			expect(m.root.querySelector(".cp-qa-panel")).toBeNull();
			await save(m);
			expect(tasks(m)[0]?.recurrence?.versions[0]?.rule, text).toMatchObject({ time });
			render(null, m.root);
			m.root.remove();
		}
	});
});

describe("All fields", () => {
	it("has a Repeat field: Never, then a pick shows a pill and saves", async () => {
		const m = await mountForm();
		const field = q(m.root, ".cp-quick-add-fields .cp-repeat-field");
		expect(q(field, ".cp-repeat-button").textContent).toBe("Never");
		await click(q(field, ".cp-repeat-button"));
		await click(opt(field, "weekly"));
		expect(q(m.root, ".cp-repeat-button").textContent).toBe("every Thu");
		expect(pills(m.root)).toContain("Repeat: every Thu");
		await typeInto(input(m.root), "Review");
		input(m.root).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		await settle();
		expect(tasks(m)[0]?.recurrence?.versions[0]?.rule).toMatchObject({ freq: "weekly", weekdays: null });
	});

	it("the modal's Escape closes the open repeat picker first, and puts focus back on its button", async () => {
		const m = await mountForm();
		const button = q<HTMLButtonElement>(m.root, ".cp-repeat-button");
		await click(button);
		expect(m.root.querySelector(".cp-repeat-pop")).not.toBeNull();
		expect(m.closeOverlay()).toBe(true);
		await settle();
		expect(m.root.querySelector(".cp-repeat-pop")).toBeNull();
		expect(document.activeElement).toBe(button);
		// Nothing left to close: the modal may close itself now.
		expect(m.closeOverlay()).toBe(false);
	});

	it("is disabled for a subtask", async () => {
		const m0 = await mountForm();
		const parent = (await m0.app.tasks.create({ title: "Parent" })).task;
		render(null, m0.root);
		m0.root.remove();
		const m = await mountForm({ parentId: parent.id }, m0.app);
		const button = q<HTMLButtonElement>(m.root, ".cp-repeat-button");
		expect(button.disabled).toBe(true);
		expect(button.title).toBe("A subtask cannot repeat");
	});
});
