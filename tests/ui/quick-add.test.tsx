// @vitest-environment happy-dom
import { render } from "preact";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { CheckpointApp } from "../../src/app/App";
import { INBOX_ID } from "../../src/domain/types";
import type { SpanDecision } from "../../src/parsing";
import { QuickAddForm } from "../../src/ui/QuickAddForm";
import type { QuickAddPreset } from "../../src/ui/host";
import { harness as storeHarness } from "../persistence/fixtures";
import { sequentialIds } from "../helpers";
import { FakeNotes, appHarness } from "../app/harness";

// Quick Add UI: real services, real parser, a fake host.
// The harness clock is 2026-10-01T10:00Z (Thursday); the zone is Europe/Berlin.

beforeAll(() => {
	(HTMLElement.prototype as unknown as { empty: () => void }).empty = function (this: HTMLElement) {
		this.replaceChildren();
	};
});

async function settleUi(): Promise<void> {
	for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
	input.value = value;
	input.dispatchEvent(new Event("input", { bubbles: true }));
	await settleUi();
}

async function press(el: HTMLElement, key: string, extra: KeyboardEventInit = {}): Promise<KeyboardEvent> {
	const evt = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra });
	el.dispatchEvent(evt);
	await settleUi();
	return evt;
}

let container: HTMLElement | null = null;
afterEach(() => {
	if (container !== null) render(null, container);
	container?.remove();
	container = null;
});

interface Suggest {
	open: boolean;
	input: HTMLInputElement | null;
	onBind: ((d: SpanDecision) => void) | null;
	disposed: number;
}

interface Mounted {
	h: { app: CheckpointApp };
	root: HTMLElement;
	saved: { title: string; warnings: string[] }[];
	errors: unknown[];
	closed: { n: number };
	suggest: Suggest;
}

async function mountForm(
	opts: {
		app?: CheckpointApp;
		preset?: QuickAddPreset;
		resolveNote?: (t: string) => string[];
		keepOpen?: boolean;
		locale?: "en" | "en-GB";
	} = {},
): Promise<Mounted> {
	const app = opts.app ?? (await appHarness()).app;
	const saved: Mounted["saved"] = [];
	const errors: unknown[] = [];
	const closed = { n: 0 };
	const suggest: Suggest = { open: false, input: null, onBind: null, disposed: 0 };
	container = document.createElement("div");
	document.body.appendChild(container);
	render(
		<QuickAddForm
			app={app}
			preset={opts.preset ?? {}}
			locale={() => opts.locale ?? "en"}
			weekStart={() => "MO"}
			setIcon={(el, icon) => el.setAttribute("data-icon", icon)}
			keepOpen={() => opts.keepOpen ?? false}
			pickNote={async () => null}
			resolveNote={opts.resolveNote ?? (() => [])}
			attachTokenSuggest={(input, onBind) => {
				suggest.input = input;
				suggest.onBind = onBind;
				return { isOpen: () => suggest.open, dispose: () => void suggest.disposed++ };
			}}
			onSaved={(title, warnings) => void saved.push({ title, warnings })}
			onError={(err) => void errors.push(err)}
			onClose={() => void closed.n++}
		/>,
		container,
	);
	await settleUi();
	return { h: { app }, root: container, saved, errors, closed, suggest };
}

const titleInput = (root: HTMLElement) => root.querySelector<HTMLInputElement>(".cp-quick-add-title")!;
const chips = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(".cp-qa-chip")];
const chipMain = (chip: HTMLElement) => chip.querySelector<HTMLButtonElement>(".cp-qa-chip-main")!;
const tasks = (m: Mounted) => [...m.h.app.store.state.tasks.values()];

async function berlinApp(zone = "Europe/Berlin", iso?: string): Promise<CheckpointApp> {
	const sh = storeHarness();
	await sh.store.open();
	if (iso !== undefined) sh.clock.set(iso);
	const notes = new FakeNotes();
	return new CheckpointApp(
		sh.store,
		sh.clock,
		sequentialIds("q"),
		{ zone: () => zone, noteFolder: () => "Task notes", upcomingDays: () => 14, weekStart: () => "MO" as const, eveningTime: () => "20:00" },
		notes,
	);
}

describe("Quick Add chips (C1, C2, C9)", () => {
	it("C1: highlights recognized spans in the input mirror and shows a chip", async () => {
		const m = await mountForm();
		await typeInto(titleInput(m.root), "Call mom tomorrow");
		const marks = [...m.root.querySelectorAll(".cp-qa-mirror mark.cp-qa-span")];
		expect(marks.map((e) => e.textContent)).toEqual(["tomorrow"]);
		expect(marks[0]!.classList.contains("cp-qa-span-applied")).toBe(true);
		expect(m.root.querySelector(".cp-qa-mirror")!.getAttribute("aria-hidden")).toBe("true");
		expect(chips(m.root)).toHaveLength(1);
		expect(chips(m.root)[0]!.textContent).toContain("Tomorrow");
	});

	it("C9: the chip row is labeled and every chip is a button with an ARIA label", async () => {
		const m = await mountForm();
		await typeInto(titleInput(m.root), "Call mom tomorrow for 45m");
		const row = m.root.querySelector(".cp-qa-chips")!;
		expect(row.getAttribute("role")).toBe("list");
		// A list is a container: it is named with aria-labelledby, not aria-label (which Obsidian tooltips).
		expect(row.hasAttribute("aria-label")).toBe(false);
		expect(document.getElementById(row.getAttribute("aria-labelledby")!)!.textContent).toBe("Recognized items");
		expect(chips(m.root)).toHaveLength(2);
		for (const chip of chips(m.root)) {
			expect(chipMain(chip).tagName).toBe("BUTTON");
			expect(chipMain(chip).getAttribute("aria-label")).toMatch(/Press Delete to keep as text/);
			expect(chip.querySelector(".cp-qa-chip-remove")!.getAttribute("aria-label")).toMatch(/Keep .* as text/);
		}
	});

	it("QA-07 (M7 D8): a recurrence phrase is a repeat chip, out of the title; the task repeats", async () => {
		const m = await mountForm();
		await typeInto(titleInput(m.root), "Water plants every monday");
		expect(chips(m.root)[0]!.textContent).toContain("Repeat: every Mon");
		expect(chips(m.root)[0]!.dataset.status).toBe("applied");
		await press(titleInput(m.root), "Enter");
		expect(tasks(m)[0]!.title).toBe("Water plants");
		expect(tasks(m)[0]!.recurrence?.versions[0]?.rule).toMatchObject({ freq: "weekly", weekdays: ["MO"] });
	});
});

describe("Dismiss to literal (AS-07, B3)", () => {
	it("AS-07: dismissing the date chip saves the full title and no schedule", async () => {
		const m = await mountForm();
		await typeInto(titleInput(m.root), "Call mom tomorrow");
		chips(m.root)[0]!.querySelector<HTMLButtonElement>(".cp-qa-chip-remove")!.click();
		await settleUi();
		expect(chips(m.root)).toHaveLength(0);
		await press(titleInput(m.root), "Enter");
		const [task] = tasks(m);
		expect(task!.title).toBe("Call mom tomorrow");
		expect(task!.scheduled).toBeNull();
	});

	it("B3: a dismissed span is not recognized again while more text is typed after it", async () => {
		const m = await mountForm();
		const input = titleInput(m.root);
		await typeInto(input, "Call mom tomorrow");
		chips(m.root)[0]!.querySelector<HTMLButtonElement>(".cp-qa-chip-remove")!.click();
		await settleUi();
		await typeInto(input, "Call mom tomorrow ");
		await typeInto(input, "Call mom tomorrow please");
		expect(chips(m.root)).toHaveLength(0);
		await typeInto(input, "Call mom tomorrow please call");
		expect(chips(m.root)).toHaveLength(0);
	});

	it("QA-03: Delete on a focused chip dismisses it and moves focus to the input", async () => {
		const m = await mountForm();
		await typeInto(titleInput(m.root), "Call mom tomorrow");
		chipMain(chips(m.root)[0]!).focus();
		await press(chipMain(chips(m.root)[0]!), "Delete");
		expect(chips(m.root)).toHaveLength(0);
		expect(document.activeElement).toBe(titleInput(m.root));
	});
});

describe("Unresolved category (AS-08, B2, CAT-04)", () => {
	it("AS-08: Enter does not save; focus goes to the picker with Inbox selected; the second Enter saves into Inbox", async () => {
		const m = await mountForm();
		const before = m.h.app.categories.list().length;
		const input = titleInput(m.root);
		await typeInto(input, "Read #Hobbies");
		expect(chips(m.root)[0]!.getAttribute("data-status")).toBe("unresolved");
		await press(input, "Enter");
		expect(tasks(m)).toHaveLength(0);
		expect(m.closed.n).toBe(0);
		const select = m.root.querySelector<HTMLSelectElement>(".cp-qa-panel select")!;
		expect(select).not.toBeNull();
		expect(document.activeElement).toBe(select);
		expect(select.value).toBe(INBOX_ID);
		await press(select, "Enter");
		expect(tasks(m)).toHaveLength(1);
		expect(tasks(m)[0]!.title).toBe("Read");
		expect(tasks(m)[0]!.categoryId).toBe(INBOX_ID);
		expect(m.h.app.categories.list()).toHaveLength(before);
		expect(m.closed.n).toBe(1);
	});

	it("the picker shows list names only, never Lucide icon names as text", async () => {
		const m = await mountForm();
		await m.h.app.categories.create("Study", "book-open");
		const input = titleInput(m.root);
		await typeInto(input, "Read #Hobbies");
		await press(input, "Enter");
		const select = m.root.querySelector<HTMLSelectElement>(".cp-qa-panel select")!;
		const labels = [...select.options].map((o) => o.textContent);
		expect(labels).toContain("Study");
		expect(labels.some((l) => l?.includes("book-open"))).toBe(false);
	});

	it("M3: with a manual category, the picker preselects it and Enter, Enter saves into it", async () => {
		const m = await mountForm();
		const study = await m.h.app.categories.create("Study");
		await settleUi();
		const catSelect = [...m.root.querySelectorAll<HTMLSelectElement>(".cp-quick-add-fields select")].find((s) =>
			[...s.options].some((o) => o.value === study.id),
		)!;
		catSelect.value = study.id;
		catSelect.dispatchEvent(new Event("change", { bubbles: true }));
		await settleUi();
		await typeInto(titleInput(m.root), "x #Hobbies");
		await press(titleInput(m.root), "Enter");
		const select = m.root.querySelector<HTMLSelectElement>(".cp-qa-panel select")!;
		expect(select.value).toBe(study.id);
		await press(select, "Enter");
		expect(tasks(m)[0]!.categoryId).toBe(study.id);
	});

	it("M4: a subtask with an unknown category is not blocked; the text stays in the title", async () => {
		const m = await mountForm();
		const study = await m.h.app.categories.create("Study");
		const parent = (await m.h.app.tasks.create({ title: "Parent", categoryId: study.id })).task;
		render(null, container!);
		const m2 = await mountForm({ app: m.h.app, preset: { parentId: parent.id } });
		await typeInto(titleInput(m2.root), "sub #Typo");
		expect(chips(m2.root)[0]!.textContent).toContain("A subtask stays in its parent's list");
		await press(titleInput(m2.root), "Enter");
		expect(m2.root.querySelector(".cp-qa-panel")).toBeNull();
		const child = tasks(m2).find((t) => t.parentId === parent.id)!;
		expect(child.title).toBe("sub #Typo");
		expect(child.categoryId).toBe(study.id);
	});

	it("B2: picking an existing category from the picker applies it", async () => {
		const m = await mountForm();
		const study = await m.h.app.categories.create("Study");
		await typeInto(titleInput(m.root), "Read #Hobbies");
		await press(titleInput(m.root), "Enter");
		const select = m.root.querySelector<HTMLSelectElement>(".cp-qa-panel select")!;
		select.value = study.id;
		select.dispatchEvent(new Event("change", { bubbles: true }));
		await press(select, "Enter");
		expect(tasks(m)[0]!.categoryId).toBe(study.id);
		expect(tasks(m)[0]!.title).toBe("Read");
	});

	it("B2: a known category resolves without a prompt (CAT-04 matching ignores case and spaces)", async () => {
		const m = await mountForm();
		const c = await m.h.app.categories.create("Deep Work");
		await typeInto(titleInput(m.root), "Plan #deepwork");
		await press(titleInput(m.root), "Enter");
		expect(tasks(m)[0]!.categoryId).toBe(c.id);
	});
});

describe("Manual precedence (QA-08, B4)", () => {
	it("B4: a manual date stays; typing 'friday' shows 'Replace date?'; accepting replaces it", async () => {
		const m = await mountForm();
		const date = m.root.querySelector<HTMLInputElement>('.cp-quick-add-fields input[type="date"]')!;
		date.value = "2026-10-20";
		date.dispatchEvent(new Event("input", { bubbles: true }));
		await settleUi();
		await typeInto(titleInput(m.root), "Meet friday");
		const chip = chips(m.root)[0]!;
		expect(chip.getAttribute("data-status")).toBe("suggestion");
		expect(chip.textContent).toContain("Replace date?");
		expect(date.value).toBe("2026-10-20");
		chipMain(chip).click();
		await settleUi();
		expect(chips(m.root)[0]!.getAttribute("data-status")).toBe("applied");
		expect(date.value).toBe("2026-10-02");
		await press(titleInput(m.root), "Enter");
		expect(tasks(m)[0]!.title).toBe("Meet");
		expect(tasks(m)[0]!.scheduled).toEqual({ kind: "date", date: "2026-10-02" });
	});

	it("B4: without accepting, the manual date is saved and 'friday' stays in the title", async () => {
		const m = await mountForm();
		const date = m.root.querySelector<HTMLInputElement>('.cp-quick-add-fields input[type="date"]')!;
		date.value = "2026-10-20";
		date.dispatchEvent(new Event("input", { bubbles: true }));
		await settleUi();
		await typeInto(titleInput(m.root), "Meet friday");
		await press(titleInput(m.root), "Enter");
		expect(tasks(m)[0]!.title).toBe("Meet friday");
		expect(tasks(m)[0]!.scheduled).toEqual({ kind: "date", date: "2026-10-20" });
	});

	it("QA-08: a parsed date fills the date field when nothing is manual, and the preset date is only a default", async () => {
		const m = await mountForm({ preset: { date: "2026-10-05" } });
		const date = m.root.querySelector<HTMLInputElement>('.cp-quick-add-fields input[type="date"]')!;
		expect(date.value).toBe("2026-10-05");
		await typeInto(titleInput(m.root), "Meet tomorrow");
		expect(date.value).toBe("2026-10-02");
		await typeInto(titleInput(m.root), "Meet");
		expect(date.value).toBe("2026-10-05");
	});

	it("subtask: the category is fixed, so '#Study' never replaces it", async () => {
		const m = await mountForm();
		const study = await m.h.app.categories.create("Study");
		const parent = (await m.h.app.tasks.create({ title: "Parent", categoryId: study.id })).task;
		const other = await m.h.app.categories.create("Other");
		render(null, container!);
		const m2 = await mountForm({ app: m.h.app, preset: { parentId: parent.id } });
		await typeInto(titleInput(m2.root), "Child #Other");
		const chip = chips(m2.root)[0]!;
		expect(chip.getAttribute("data-status")).toBe("suggestion");
		expect(chip.textContent).not.toContain("Replace list?");
		expect(chip.textContent).toContain("subtask");
		await press(titleInput(m2.root), "Enter");
		const child = tasks(m2).find((t) => t.parentId === parent.id)!;
		expect(child.categoryId).toBe(study.id);
		expect(child.categoryId).not.toBe(other.id);
	});
});

describe("Notes (B5, QA-09)", () => {
	const resolve = (t: string) => (t === "Plan" ? ["A/Plan.md", "B/Plan.md"] : t === "Solo" ? ["Notes/Solo.md"] : []);

	it("B5: two matches show '2 matches'; saving without choosing links no note and keeps the text", async () => {
		const m = await mountForm({ resolveNote: resolve });
		await typeInto(titleInput(m.root), "Draft [[Plan]]");
		const chip = chips(m.root)[0]!;
		expect(chip.getAttribute("data-status")).toBe("collision");
		expect(chip.textContent).toContain("2 matches");
		await press(titleInput(m.root), "Enter");
		expect(tasks(m)).toHaveLength(1);
		expect(tasks(m)[0]!.descriptionNote).toBeNull();
		expect(tasks(m)[0]!.title).toBe("Draft [[Plan]]");
	});

	it("B5: choosing a candidate links that path and removes the text from the title", async () => {
		const m = await mountForm({ resolveNote: resolve });
		await typeInto(titleInput(m.root), "Draft [[Plan]]");
		chipMain(chips(m.root)[0]!).click();
		await settleUi();
		const select = m.root.querySelector<HTMLSelectElement>(".cp-qa-panel select")!;
		expect([...select.options].map((o) => o.value)).toEqual(["A/Plan.md", "B/Plan.md"]);
		select.value = "B/Plan.md";
		select.dispatchEvent(new Event("change", { bubbles: true }));
		m.root.querySelector<HTMLButtonElement>(".cp-qa-panel .cp-qa-apply")!.click();
		await settleUi();
		await press(titleInput(m.root), "Enter");
		expect(tasks(m)[0]!.descriptionNote?.path).toBe("B/Plan.md");
		expect(tasks(m)[0]!.title).toBe("Draft");
	});

	it("QA-09: a unique match links the note directly; a missing note stays in the title with a notice", async () => {
		const m = await mountForm({ resolveNote: resolve });
		await typeInto(titleInput(m.root), "See [[Solo]] and [[Ghost]]");
		expect(chips(m.root).map((c) => c.getAttribute("data-status"))).toEqual(["applied", "missing"]);
		await press(titleInput(m.root), "Enter");
		expect(tasks(m)[0]!.descriptionNote?.path).toBe("Notes/Solo.md");
		expect(tasks(m)[0]!.title).toBe("See and [[Ghost]]");
	});
});

describe("Tags (TAG-02, B16)", () => {
	it("TAG-02: '@newtag' shows 'New tag: newtag'; saving creates the tag and one task", async () => {
		const m = await mountForm();
		await typeInto(titleInput(m.root), "Read @newtag");
		expect(chips(m.root)[0]!.textContent).toContain("New tag: newtag");
		await press(titleInput(m.root), "Enter");
		expect(tasks(m)).toHaveLength(1);
		expect(tasks(m)[0]!.tagKeys).toEqual(["newtag"]);
		expect(tasks(m)[0]!.title).toBe("Read");
		expect(m.h.app.tags.list().map((t) => t.key)).toEqual(["newtag"]);
	});

	it("TAG-03: a new tag keeps its typed name; the chip shows it; keys stay lowercase", async () => {
		const m = await mountForm();
		await typeInto(titleInput(m.root), "Do thing @NewTag @Other/Sub");
		expect(chips(m.root)[0]!.textContent).toContain("New tag: NewTag");
		await press(titleInput(m.root), "Enter");
		expect(tasks(m)[0]!.tagKeys).toEqual(["newtag", "other/sub"]);
		const tags = m.h.app.tags.list();
		expect(tags.map((t) => t.displayName).sort()).toEqual(["NewTag", "Other/Sub"]);
		expect(tags.map((t) => t.key).sort()).toEqual(["newtag", "other/sub"]);
	});

	it("TAG-03: '@NewTag @newtag' creates one tag", async () => {
		const m = await mountForm();
		await typeInto(titleInput(m.root), "Do thing @NewTag @newtag");
		await press(titleInput(m.root), "Enter");
		expect(m.h.app.tags.list().map((t) => t.displayName)).toEqual(["NewTag"]);
		expect(tasks(m)[0]!.tagKeys).toEqual(["newtag"]);
	});

	it("TAG-02: dismissing the chip keeps '@newtag' in the title and creates no tag", async () => {
		const m = await mountForm();
		await typeInto(titleInput(m.root), "Read @newtag");
		chips(m.root)[0]!.querySelector<HTMLButtonElement>(".cp-qa-chip-remove")!.click();
		await settleUi();
		await press(titleInput(m.root), "Enter");
		expect(tasks(m)[0]!.title).toBe("Read @newtag");
		expect(tasks(m)[0]!.tagKeys).toEqual([]);
		expect(m.h.app.tags.list()).toHaveLength(0);
	});

	it("B16: '@LEARNING' resolves the existing 'Learning' tag instead of creating one", async () => {
		const m = await mountForm();
		await m.h.app.tags.create("Learning");
		await typeInto(titleInput(m.root), "Study @LEARNING");
		expect(chips(m.root)[0]!.textContent).toContain("@Learning");
		expect(chips(m.root)[0]!.textContent).not.toContain("New tag");
		await press(titleInput(m.root), "Enter");
		expect(tasks(m)[0]!.tagKeys).toEqual(["learning"]);
		expect(m.h.app.tags.list()).toHaveLength(1);
	});

	it("QA-08: manual tags, preset tags and parsed tags are combined once", async () => {
		const app = (await appHarness()).app;
		await app.tags.create("work");
		await app.tags.create("home");
		const m = await mountForm({ app, preset: { tagKeys: ["work"] } });
		await typeInto(titleInput(m.root), "Mop @home @work");
		await press(titleInput(m.root), "Enter");
		expect(tasks(m)[0]!.tagKeys.slice().sort()).toEqual(["home", "work"]);
	});
});

describe("Choices and suggestions (A3, A4)", () => {
	it("a meridiem-less hour is a choice; picking 17:00 applies it", async () => {
		const m = await mountForm();
		await typeInto(titleInput(m.root), "Call at 5");
		const chip = chips(m.root)[0]!;
		expect(chip.getAttribute("data-status")).toBe("choice");
		chipMain(chip).click();
		await settleUi();
		const select = m.root.querySelector<HTMLSelectElement>(".cp-qa-panel select")!;
		const labels = [...select.options].map((o) => o.textContent);
		expect(labels).toEqual(expect.arrayContaining([expect.stringContaining("17:00")]));
		const idx = labels.findIndex((l) => l?.includes("17:00"));
		select.selectedIndex = idx;
		select.dispatchEvent(new Event("change", { bubbles: true }));
		await press(select, "Enter");
		expect(chips(m.root)[0]!.getAttribute("data-status")).toBe("applied");
		await press(titleInput(m.root), "Enter");
		const task = tasks(m)[0]!;
		expect(task.title).toBe("Call");
		expect(task.scheduled).toMatchObject({ kind: "datetime", local: "2026-10-01T17:00" });
	});

	it("a low-confidence word is a suggestion and is not applied until accepted", async () => {
		const m = await mountForm();
		await typeInto(titleInput(m.root), "Fix next month");
		expect(chips(m.root)[0]!.getAttribute("data-status")).toBe("suggestion");
		await press(titleInput(m.root), "Enter");
		expect(tasks(m)[0]!.title).toBe("Fix next month");
		expect(tasks(m)[0]!.scheduled).toBeNull();
	});
});

describe("DST (B17, B18)", () => {
	it("B17: a time in the spring-forward gap shows the warning on the chip and in the saved notice once", async () => {
		const app = await berlinApp("America/New_York", "2026-03-01T15:00:00.000Z");
		const m = await mountForm({ app });
		await typeInto(titleInput(m.root), "Standup 2026-03-08 2:30am");
		const chip = chips(m.root)[0]!;
		expect(chip.textContent).toContain("Adjusted for daylight saving");
		await press(titleInput(m.root), "Enter");
		expect(m.saved).toHaveLength(1);
		expect(m.saved[0]!.warnings).toEqual(["Adjusted for daylight saving"]);
		expect(tasks(m)[0]!.scheduled).toMatchObject({ kind: "datetime", local: "2026-03-08T03:30", tz: "America/New_York" });
	});
});

describe("DST with a 24-hour time (L1)", () => {
	it("a leading-zero '02:30' on the spring-forward day applies with the gap warning", async () => {
		const app = await berlinApp("America/New_York", "2026-03-01T15:00:00.000Z");
		const m = await mountForm({ app });
		await typeInto(titleInput(m.root), "Standup 2026-03-08 02:30");
		const chip = chips(m.root)[0]!;
		expect(chip.getAttribute("data-status")).toBe("applied");
		expect(chip.textContent).toContain("Adjusted for daylight saving");
		await press(titleInput(m.root), "Enter");
		expect(m.saved[0]!.warnings).toEqual(["Adjusted for daylight saving"]);
		expect(tasks(m)[0]!.scheduled).toMatchObject({ kind: "datetime", local: "2026-03-08T03:30", tz: "America/New_York" });
	});
});

describe("Save (C7)", () => {
	it("a title that is only recognized text is kept in full with one warning (A13)", async () => {
		const m = await mountForm();
		await typeInto(titleInput(m.root), "tomorrow");
		await press(titleInput(m.root), "Enter");
		expect(tasks(m)[0]!.title).toBe("tomorrow");
		expect(m.saved[0]!.warnings).toEqual(["Title was empty after removing recognized items; kept the full text"]);
	});

	it("C7: a warning reported on the chip and again by create shows once in the Added notice", async () => {
		const app = await berlinApp("America/New_York", "2026-03-01T15:00:00.000Z");
		const m = await mountForm({ app });
		await typeInto(titleInput(m.root), "Standup 2026-03-08 2:30am");
		expect(chips(m.root)[0]!.textContent).toContain("Adjusted for daylight saving");
		const original = app.tasks.create.bind(app.tasks);
		app.tasks.create = async (input) => {
			const r = await original(input);
			return { ...r, warnings: ["dst-gap", "dst-gap"] };
		};
		await press(titleInput(m.root), "Enter");
		expect(m.saved[0]!.warnings).toEqual(["Adjusted for daylight saving"]);
	});

	it("details stay plain text: saved titles are never parsed again (QA-10)", async () => {
		const m = await mountForm();
		await typeInto(titleInput(m.root), "Call mom tomorrow");
		await press(titleInput(m.root), "Enter");
		expect(tasks(m)[0]!.title).toBe("Call mom");
		expect(tasks(m)[0]!.scheduled).toEqual({ kind: "date", date: "2026-10-02" });
	});

	it("parsed duration, deadline and flags reach the task", async () => {
		const m = await mountForm();
		await typeInto(titleInput(m.root), "Write report for 1h30m by friday");
		await press(titleInput(m.root), "Enter");
		const t = tasks(m)[0]!;
		expect(t.title).toBe("Write report");
		expect(t.plannedDurationMin).toBe(90);
		expect(t.deadline).toEqual({ kind: "date", date: "2026-10-02" });
	});

	it("an error shows once and nothing is retried", async () => {
		const m = await mountForm();
		await typeInto(titleInput(m.root), "x".repeat(10));
		const original = m.h.app.tasks.create.bind(m.h.app.tasks);
		let calls = 0;
		m.h.app.tasks.create = () => {
			calls++;
			return Promise.reject(new Error("boom"));
		};
		await press(titleInput(m.root), "Enter");
		expect(calls).toBe(1);
		expect(m.errors).toHaveLength(1);
		expect(m.closed.n).toBe(0);
		m.h.app.tasks.create = original;
	});

	it("keep open: saving resets the input, decisions and manual fields", async () => {
		const m = await mountForm({ keepOpen: true });
		const date = m.root.querySelector<HTMLInputElement>('.cp-quick-add-fields input[type="date"]')!;
		date.value = "2026-10-20";
		date.dispatchEvent(new Event("input", { bubbles: true }));
		await typeInto(titleInput(m.root), "Call mom tomorrow");
		chips(m.root)[0]!.querySelector<HTMLButtonElement>(".cp-qa-chip-remove")!.click();
		await settleUi();
		await press(titleInput(m.root), "Enter");
		expect(tasks(m)).toHaveLength(1);
		expect(m.closed.n).toBe(0);
		expect(titleInput(m.root).value).toBe("");
		expect(date.value).toBe("");
		await typeInto(titleInput(m.root), "Call mom tomorrow");
		expect(chips(m.root)).toHaveLength(1);
		expect(chips(m.root)[0]!.getAttribute("data-status")).toBe("applied");
	});
});

describe("Keyboard (C3)", () => {
	it("the first chip is the Tab stop after the input; arrows move between chips", async () => {
		const m = await mountForm();
		await typeInto(titleInput(m.root), "Call tomorrow for 45m");
		const mains = chips(m.root).map(chipMain);
		expect(mains).toHaveLength(2);
		expect(mains.map((b) => b.tabIndex)).toEqual([0, -1]);
		mains[0]!.focus();
		await press(mains[0]!, "ArrowRight");
		expect(document.activeElement).toBe(chipMain(chips(m.root)[1]!));
		await press(document.activeElement as HTMLElement, "ArrowLeft");
		expect(document.activeElement).toBe(chipMain(chips(m.root)[0]!));
		await press(document.activeElement as HTMLElement, "ArrowLeft");
		expect(document.activeElement).toBe(chipMain(chips(m.root)[0]!));
	});

	it("Delete on a chip dismisses it; Backspace does too", async () => {
		const m = await mountForm();
		await typeInto(titleInput(m.root), "Call tomorrow for 45m");
		chipMain(chips(m.root)[0]!).focus();
		await press(chipMain(chips(m.root)[0]!), "Backspace");
		expect(chips(m.root)).toHaveLength(1);
		await press(chipMain(chips(m.root)[0]!), "Delete");
		expect(chips(m.root)).toHaveLength(0);
	});

	it("Enter in the input saves exactly once, even when pressed twice quickly", async () => {
		const m = await mountForm({ keepOpen: true });
		await typeInto(titleInput(m.root), "Buy milk");
		const input = titleInput(m.root);
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		await settleUi();
		expect(tasks(m)).toHaveLength(1);
	});

	it("Enter is ignored while the suggester is open", async () => {
		const m = await mountForm();
		await typeInto(titleInput(m.root), "Buy milk");
		m.suggest.open = true;
		await press(titleInput(m.root), "Enter");
		expect(tasks(m)).toHaveLength(0);
		m.suggest.open = false;
		await press(titleInput(m.root), "Enter");
		expect(tasks(m)).toHaveLength(1);
	});

	it("Enter is ignored when the suggester just closed in the same key press", async () => {
		const m = await mountForm();
		await typeInto(titleInput(m.root), "Read #Study");
		m.suggest.onBind!({ span: { start: 5, end: 11 }, text: "#Study", kind: "category", categoryId: INBOX_ID });
		await press(titleInput(m.root), "Enter");
		expect(tasks(m)).toHaveLength(0);
	});

	it("Enter inside the title with a composition in progress does not save", async () => {
		const m = await mountForm();
		await typeInto(titleInput(m.root), "Buy milk");
		await press(titleInput(m.root), "Enter", { isComposing: true });
		expect(tasks(m)).toHaveLength(0);
	});

	it("Escape in a chip picker closes the picker and leaves the form open", async () => {
		const m = await mountForm();
		await typeInto(titleInput(m.root), "Read #Hobbies");
		await press(titleInput(m.root), "Enter");
		const select = m.root.querySelector<HTMLSelectElement>(".cp-qa-panel select")!;
		const evt = await press(select, "Escape");
		expect(m.root.querySelector(".cp-qa-panel")).toBeNull();
		expect(evt.defaultPrevented).toBe(true);
		expect(tasks(m)).toHaveLength(0);
	});
});

describe("Suggester binding (B4 of WP-B)", () => {
	it("a bound multi-word category applies after the input event, without being dropped", async () => {
		const m = await mountForm();
		const c = await m.h.app.categories.create("Deep work");
		const input = titleInput(m.root);
		await typeInto(input, "Plan #Deep");
		// What QuickAddSuggest does: replace the token, dispatch input, then report the binding.
		input.value = "Plan #Deep work";
		input.dispatchEvent(new Event("input", { bubbles: true }));
		m.suggest.onBind!({ span: { start: 5, end: 15 }, text: "#Deep work", kind: "category", categoryId: c.id });
		await settleUi();
		expect(chips(m.root)[0]!.getAttribute("data-status")).toBe("applied");
		await press(input, "Enter");
		expect(tasks(m)[0]!.categoryId).toBe(c.id);
		expect(tasks(m)[0]!.title).toBe("Plan");
	});

	it("attaches the suggester to the input and disposes it on unmount", async () => {
		const m = await mountForm();
		expect(m.suggest.input).toBe(titleInput(m.root));
		render(null, container!);
		expect(m.suggest.disposed).toBe(1);
	});
});

describe("Inline add bar (C8)", () => {
	it("C8: 'Buy milk tomorrow' in the Inbox view saves 'Buy milk' scheduled for tomorrow", async () => {
		const { mountApp } = await import("./quick-add.helpers");
		const { h, root } = await mountApp();
		root.querySelector<HTMLElement>(".cp-sidebar")!;
		const inbox = [...root.querySelectorAll<HTMLElement>(".cp-sidebar-item")].find((e) => e.textContent?.includes("Inbox"))!;
		inbox.click();
		await settleUi();
		const input = root.querySelector<HTMLInputElement>('.cp-add-bar input[aria-label="Add task"]')!;
		await typeInto(input, "Buy milk tomorrow");
		expect(root.querySelectorAll(".cp-add-bar .cp-qa-chip")).toHaveLength(1);
		await press(input, "Enter");
		const [task] = [...h.app.store.state.tasks.values()];
		expect(task!.title).toBe("Buy milk");
		expect(task!.scheduled).toEqual({ kind: "date", date: "2026-10-02" });
		expect(task!.categoryId).toBe(INBOX_ID);
		expect(input.value).toBe("");
	});

	it("C8: the view's preset is a default, a parsed value wins, and an unresolved category blocks Enter", async () => {
		const { mountApp } = await import("./quick-add.helpers");
		const { h, root } = await mountApp();
		const input = root.querySelector<HTMLInputElement>('.cp-add-bar input[aria-label="Add task"]')!;
		// Default view is Today: the preset date is today.
		await typeInto(input, "Plain");
		await press(input, "Enter");
		expect([...h.app.store.state.tasks.values()][0]!.scheduled).toEqual({ kind: "date", date: "2026-10-01" });
		await typeInto(input, "Later #Nowhere");
		await press(input, "Enter");
		expect(h.app.store.state.tasks.size).toBe(1);
		const select = root.querySelector<HTMLSelectElement>(".cp-add-bar .cp-qa-panel select")!;
		expect(document.activeElement).toBe(select);
		await press(select, "Enter");
		expect(h.app.store.state.tasks.size).toBe(2);
	});
});
