// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { Modal } from "obsidian";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CheckpointApp } from "../../src/app/App";
import { DEFAULT_SETTINGS } from "../../src/app/settings";
import { INBOX_ID, INBOX_NAME } from "../../src/domain/types";
import { QuickAddModal } from "../../src/obsidian/QuickAddModal";
import { QuickAddModel } from "../../src/ui/quickadd/QuickAddModel";
import { manualPills } from "../../src/ui/quickadd/manualPills";
import { draftOf, draftProblem } from "../../src/ui/repeat";
import { DEADLINE_CLEARED_TEXT } from "../../src/ui/repeatActions";
import { FakeNotes, appHarness } from "../app/harness";
import { sequentialIds } from "../helpers";
import { harness as storeHarness } from "../persistence/fixtures";
import { click, dateTool, formTasks, keydown, mountApp, mountQuickForm, obsidianElement, type ObsidianElement, popDay, pressKey, q, type QuickFormOptions, quickModel, settle, titleInput, typeInto } from "./app-helpers";
import { WEDNESDAY_CLOCK } from "./repeat-helpers";

// Quick Add UI: real services, real parser, a fake host.
// The harness clock is 2026-10-01T10:00Z (Thursday); the zone is Europe/Berlin.

/** The form records its errors in `errors` here. */
const mountForm = (opts: QuickFormOptions = {}) => mountQuickForm({ recordErrors: true, ...opts });

const chips = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(".cp-qa-chip")];
const chipMain = (chip: HTMLElement) => chip.querySelector<HTMLButtonElement>(".cp-qa-chip-main")!;

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

	it("QA-07 (D8): a recurrence phrase is a repeat chip, out of the title; the task repeats", async () => {
		const m = await mountForm();
		await typeInto(titleInput(m.root), "Water plants every monday");
		expect(chips(m.root)[0]!.textContent).toContain("Repeat: every Mon");
		expect(chips(m.root)[0]!.dataset.status).toBe("applied");
		await pressKey(titleInput(m.root), "Enter");
		expect(formTasks(m)[0]!.title).toBe("Water plants");
		expect(formTasks(m)[0]!.recurrence?.versions[0]?.rule).toMatchObject({ freq: "weekly", weekdays: ["MO"] });
	});
});

describe("Dismiss to literal (AS-07, B3)", () => {
	it("AS-07: dismissing the date chip saves the full title and no schedule", async () => {
		const m = await mountForm();
		await typeInto(titleInput(m.root), "Call mom tomorrow");
		chips(m.root)[0]!.querySelector<HTMLButtonElement>(".cp-qa-chip-remove")!.click();
		await settle();
		expect(chips(m.root)).toHaveLength(0);
		await pressKey(titleInput(m.root), "Enter");
		const [task] = formTasks(m);
		expect(task!.title).toBe("Call mom tomorrow");
		expect(task!.scheduled).toBeNull();
	});

	it("B3: a dismissed span is not recognized again while more text is typed after it", async () => {
		const m = await mountForm();
		const input = titleInput(m.root);
		await typeInto(input, "Call mom tomorrow");
		chips(m.root)[0]!.querySelector<HTMLButtonElement>(".cp-qa-chip-remove")!.click();
		await settle();
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
		await pressKey(chipMain(chips(m.root)[0]!), "Delete");
		expect(chips(m.root)).toHaveLength(0);
		expect(document.activeElement).toBe(titleInput(m.root));
	});
});

describe("Unresolved category (AS-08, B2, CAT-04)", () => {
	it("AS-08: Enter does not save; focus goes to the picker with Inbox selected; the second Enter saves into Inbox", async () => {
		const m = await mountForm();
		const before = m.app.categories.list().length;
		const input = titleInput(m.root);
		await typeInto(input, "Read #Hobbies");
		expect(chips(m.root)[0]!.getAttribute("data-status")).toBe("unresolved");
		await pressKey(input, "Enter");
		expect(formTasks(m)).toHaveLength(0);
		expect(m.closed.n).toBe(0);
		const select = m.root.querySelector<HTMLSelectElement>(".cp-qa-panel select")!;
		expect(select).not.toBeNull();
		expect(document.activeElement).toBe(select);
		expect(select.value).toBe(INBOX_ID);
		await pressKey(select, "Enter");
		expect(formTasks(m)).toHaveLength(1);
		expect(formTasks(m)[0]!.title).toBe("Read");
		expect(formTasks(m)[0]!.categoryId).toBe(INBOX_ID);
		expect(m.app.categories.list()).toHaveLength(before);
		expect(m.closed.n).toBe(1);
	});

	it("the picker shows list names only, never Lucide icon names as text", async () => {
		const m = await mountForm();
		await m.app.categories.create("Study", "book-open");
		const input = titleInput(m.root);
		await typeInto(input, "Read #Hobbies");
		await pressKey(input, "Enter");
		const select = m.root.querySelector<HTMLSelectElement>(".cp-qa-panel select")!;
		const labels = [...select.options].map((o) => o.textContent);
		expect(labels).toContain("Study");
		expect(labels.some((l) => l?.includes("book-open"))).toBe(false);
	});

	it("M3: with a manual category, the picker preselects it and Enter, Enter saves into it", async () => {
		const m = await mountForm();
		const study = await m.app.categories.create("Study");
		await settle();
		const catSelect = [...m.root.querySelectorAll<HTMLSelectElement>(".cp-quick-add-fields select")].find((s) =>
			[...s.options].some((o) => o.value === study.id),
		)!;
		catSelect.value = study.id;
		catSelect.dispatchEvent(new Event("change", { bubbles: true }));
		await settle();
		await typeInto(titleInput(m.root), "x #Hobbies");
		await pressKey(titleInput(m.root), "Enter");
		const select = m.root.querySelector<HTMLSelectElement>(".cp-qa-panel select")!;
		expect(select.value).toBe(study.id);
		await pressKey(select, "Enter");
		expect(formTasks(m)[0]!.categoryId).toBe(study.id);
	});

	it("M4: a subtask with an unknown category is not blocked; the text stays in the title", async () => {
		const m = await mountForm();
		const study = await m.app.categories.create("Study");
		const parent = (await m.app.tasks.create({ title: "Parent", categoryId: study.id })).task;
		m.unmount();
		const m2 = await mountForm({ app: m.app, preset: { parentId: parent.id } });
		await typeInto(titleInput(m2.root), "sub #Typo");
		expect(chips(m2.root)[0]!.textContent).toContain("A subtask stays in its parent's list");
		await pressKey(titleInput(m2.root), "Enter");
		expect(m2.root.querySelector(".cp-qa-panel")).toBeNull();
		const child = formTasks(m2).find((t) => t.parentId === parent.id)!;
		expect(child.title).toBe("sub #Typo");
		expect(child.categoryId).toBe(study.id);
	});

	it("B2: picking an existing category from the picker applies it", async () => {
		const m = await mountForm();
		const study = await m.app.categories.create("Study");
		await typeInto(titleInput(m.root), "Read #Hobbies");
		await pressKey(titleInput(m.root), "Enter");
		const select = m.root.querySelector<HTMLSelectElement>(".cp-qa-panel select")!;
		select.value = study.id;
		select.dispatchEvent(new Event("change", { bubbles: true }));
		await pressKey(select, "Enter");
		expect(formTasks(m)[0]!.categoryId).toBe(study.id);
		expect(formTasks(m)[0]!.title).toBe("Read");
	});

	it("B2: a known category resolves without a prompt (CAT-04 matching ignores case and spaces)", async () => {
		const m = await mountForm();
		const c = await m.app.categories.create("Deep Work");
		await typeInto(titleInput(m.root), "Plan #deepwork");
		await pressKey(titleInput(m.root), "Enter");
		expect(formTasks(m)[0]!.categoryId).toBe(c.id);
	});
});

describe("Manual precedence (QA-08, B4)", () => {
	it("B4: a manual date stays; typing 'friday' shows 'Replace date?'; accepting replaces it", async () => {
		const m = await mountForm();
		const date = m.root.querySelector<HTMLInputElement>('.cp-quick-add-fields input[type="date"]')!;
		date.value = "2026-10-20";
		date.dispatchEvent(new Event("input", { bubbles: true }));
		await settle();
		await typeInto(titleInput(m.root), "Meet friday");
		const chip = chips(m.root)[0]!;
		expect(chip.getAttribute("data-status")).toBe("suggestion");
		expect(chip.textContent).toContain("Replace date?");
		expect(date.value).toBe("2026-10-20");
		chipMain(chip).click();
		await settle();
		expect(chips(m.root)[0]!.getAttribute("data-status")).toBe("applied");
		expect(date.value).toBe("2026-10-02");
		await pressKey(titleInput(m.root), "Enter");
		expect(formTasks(m)[0]!.title).toBe("Meet");
		expect(formTasks(m)[0]!.scheduled).toEqual({ kind: "date", date: "2026-10-02" });
	});

	it("B4: without accepting, the manual date is saved and 'friday' stays in the title", async () => {
		const m = await mountForm();
		const date = m.root.querySelector<HTMLInputElement>('.cp-quick-add-fields input[type="date"]')!;
		date.value = "2026-10-20";
		date.dispatchEvent(new Event("input", { bubbles: true }));
		await settle();
		await typeInto(titleInput(m.root), "Meet friday");
		await pressKey(titleInput(m.root), "Enter");
		expect(formTasks(m)[0]!.title).toBe("Meet friday");
		expect(formTasks(m)[0]!.scheduled).toEqual({ kind: "date", date: "2026-10-20" });
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
		const study = await m.app.categories.create("Study");
		const parent = (await m.app.tasks.create({ title: "Parent", categoryId: study.id })).task;
		const other = await m.app.categories.create("Other");
		m.unmount();
		const m2 = await mountForm({ app: m.app, preset: { parentId: parent.id } });
		await typeInto(titleInput(m2.root), "Child #Other");
		const chip = chips(m2.root)[0]!;
		expect(chip.getAttribute("data-status")).toBe("suggestion");
		expect(chip.textContent).not.toContain("Replace list?");
		expect(chip.textContent).toContain("subtask");
		await pressKey(titleInput(m2.root), "Enter");
		const child = formTasks(m2).find((t) => t.parentId === parent.id)!;
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
		await pressKey(titleInput(m.root), "Enter");
		expect(formTasks(m)).toHaveLength(1);
		expect(formTasks(m)[0]!.descriptionNote).toBeNull();
		expect(formTasks(m)[0]!.title).toBe("Draft [[Plan]]");
	});

	it("B5: choosing a candidate links that path and removes the text from the title", async () => {
		const m = await mountForm({ resolveNote: resolve });
		await typeInto(titleInput(m.root), "Draft [[Plan]]");
		chipMain(chips(m.root)[0]!).click();
		await settle();
		const select = m.root.querySelector<HTMLSelectElement>(".cp-qa-panel select")!;
		expect([...select.options].map((o) => o.value)).toEqual(["A/Plan.md", "B/Plan.md"]);
		select.value = "B/Plan.md";
		select.dispatchEvent(new Event("change", { bubbles: true }));
		m.root.querySelector<HTMLButtonElement>(".cp-qa-panel .cp-qa-apply")!.click();
		await settle();
		await pressKey(titleInput(m.root), "Enter");
		expect(formTasks(m)[0]!.descriptionNote?.path).toBe("B/Plan.md");
		expect(formTasks(m)[0]!.title).toBe("Draft");
	});

	it("QA-09: a unique match links the note directly; a missing note stays in the title with a notice", async () => {
		const m = await mountForm({ resolveNote: resolve });
		await typeInto(titleInput(m.root), "See [[Solo]] and [[Ghost]]");
		expect(chips(m.root).map((c) => c.getAttribute("data-status"))).toEqual(["applied", "missing"]);
		await pressKey(titleInput(m.root), "Enter");
		expect(formTasks(m)[0]!.descriptionNote?.path).toBe("Notes/Solo.md");
		expect(formTasks(m)[0]!.title).toBe("See and [[Ghost]]");
	});
});

describe("Tags (TAG-02, B16)", () => {
	it("TAG-02: '@newtag' shows 'New tag: newtag'; saving creates the tag and one task", async () => {
		const m = await mountForm();
		await typeInto(titleInput(m.root), "Read @newtag");
		expect(chips(m.root)[0]!.textContent).toContain("New tag: newtag");
		await pressKey(titleInput(m.root), "Enter");
		expect(formTasks(m)).toHaveLength(1);
		expect(formTasks(m)[0]!.tagKeys).toEqual(["newtag"]);
		expect(formTasks(m)[0]!.title).toBe("Read");
		expect(m.app.tags.list().map((t) => t.key)).toEqual(["newtag"]);
	});

	it("TAG-03: a new tag keeps its typed name; the chip shows it; keys stay lowercase", async () => {
		const m = await mountForm();
		await typeInto(titleInput(m.root), "Do thing @NewTag @Other/Sub");
		expect(chips(m.root)[0]!.textContent).toContain("New tag: NewTag");
		await pressKey(titleInput(m.root), "Enter");
		expect(formTasks(m)[0]!.tagKeys).toEqual(["newtag", "other/sub"]);
		const tags = m.app.tags.list();
		// The new child's parent is made with it.
		expect(tags.map((t) => t.displayName).sort()).toEqual(["NewTag", "Other", "Other/Sub"]);
		expect(tags.map((t) => t.key).sort()).toEqual(["newtag", "other", "other/sub"]);
	});

	it("TAG-03: '@NewTag @newtag' creates one tag", async () => {
		const m = await mountForm();
		await typeInto(titleInput(m.root), "Do thing @NewTag @newtag");
		await pressKey(titleInput(m.root), "Enter");
		expect(m.app.tags.list().map((t) => t.displayName)).toEqual(["NewTag"]);
		expect(formTasks(m)[0]!.tagKeys).toEqual(["newtag"]);
	});

	it("TAG-02: dismissing the chip keeps '@newtag' in the title and creates no tag", async () => {
		const m = await mountForm();
		await typeInto(titleInput(m.root), "Read @newtag");
		chips(m.root)[0]!.querySelector<HTMLButtonElement>(".cp-qa-chip-remove")!.click();
		await settle();
		await pressKey(titleInput(m.root), "Enter");
		expect(formTasks(m)[0]!.title).toBe("Read @newtag");
		expect(formTasks(m)[0]!.tagKeys).toEqual([]);
		expect(m.app.tags.list()).toHaveLength(0);
	});

	it("B16: '@LEARNING' resolves the existing 'Learning' tag instead of creating one", async () => {
		const m = await mountForm();
		await m.app.tags.create("Learning");
		await typeInto(titleInput(m.root), "Study @LEARNING");
		expect(chips(m.root)[0]!.textContent).toContain("@Learning");
		expect(chips(m.root)[0]!.textContent).not.toContain("New tag");
		await pressKey(titleInput(m.root), "Enter");
		expect(formTasks(m)[0]!.tagKeys).toEqual(["learning"]);
		expect(m.app.tags.list()).toHaveLength(1);
	});

	it("QA-08: manual tags, preset tags and parsed tags are combined once", async () => {
		const app = (await appHarness()).app;
		await app.tags.create("work");
		await app.tags.create("home");
		const m = await mountForm({ app, preset: { tagKeys: ["work"] } });
		await typeInto(titleInput(m.root), "Mop @home @work");
		await pressKey(titleInput(m.root), "Enter");
		expect(formTasks(m)[0]!.tagKeys.slice().sort()).toEqual(["home", "work"]);
	});
});

describe("Choices and suggestions (A3, A4)", () => {
	it("a meridiem-less hour is a choice; picking 17:00 applies it", async () => {
		const m = await mountForm();
		await typeInto(titleInput(m.root), "Call at 5");
		const chip = chips(m.root)[0]!;
		expect(chip.getAttribute("data-status")).toBe("choice");
		chipMain(chip).click();
		await settle();
		const select = m.root.querySelector<HTMLSelectElement>(".cp-qa-panel select")!;
		const labels = [...select.options].map((o) => o.textContent);
		expect(labels).toEqual(expect.arrayContaining([expect.stringContaining("17:00")]));
		const idx = labels.findIndex((l) => l?.includes("17:00"));
		select.selectedIndex = idx;
		select.dispatchEvent(new Event("change", { bubbles: true }));
		await pressKey(select, "Enter");
		expect(chips(m.root)[0]!.getAttribute("data-status")).toBe("applied");
		await pressKey(titleInput(m.root), "Enter");
		const task = formTasks(m)[0]!;
		expect(task.title).toBe("Call");
		expect(task.scheduled).toMatchObject({ kind: "datetime", local: "2026-10-01T17:00" });
	});

	it("a low-confidence word is a suggestion and is not applied until accepted", async () => {
		const m = await mountForm();
		await typeInto(titleInput(m.root), "Fix next month");
		expect(chips(m.root)[0]!.getAttribute("data-status")).toBe("suggestion");
		await pressKey(titleInput(m.root), "Enter");
		expect(formTasks(m)[0]!.title).toBe("Fix next month");
		expect(formTasks(m)[0]!.scheduled).toBeNull();
	});
});

describe("DST (B17, B18)", () => {
	it("B17: a time in the spring-forward gap shows the warning on the chip and in the saved notice once", async () => {
		const app = await berlinApp("America/New_York", "2026-03-01T15:00:00.000Z");
		const m = await mountForm({ app });
		await typeInto(titleInput(m.root), "Standup 2026-03-08 2:30am");
		const chip = chips(m.root)[0]!;
		expect(chip.textContent).toContain("Adjusted for daylight saving");
		await pressKey(titleInput(m.root), "Enter");
		expect(m.saved).toHaveLength(1);
		expect(m.warnings[0]).toEqual(["Adjusted for daylight saving"]);
		expect(formTasks(m)[0]!.scheduled).toMatchObject({ kind: "datetime", local: "2026-03-08T03:30", tz: "America/New_York" });
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
		await pressKey(titleInput(m.root), "Enter");
		expect(m.warnings[0]).toEqual(["Adjusted for daylight saving"]);
		expect(formTasks(m)[0]!.scheduled).toMatchObject({ kind: "datetime", local: "2026-03-08T03:30", tz: "America/New_York" });
	});
});

describe("Save (C7)", () => {
	it("a title that is only recognized text is kept in full with one warning (A13)", async () => {
		const m = await mountForm();
		await typeInto(titleInput(m.root), "tomorrow");
		await pressKey(titleInput(m.root), "Enter");
		expect(formTasks(m)[0]!.title).toBe("tomorrow");
		expect(m.warnings[0]).toEqual(["Title was empty after removing recognized items; kept the full text"]);
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
		await pressKey(titleInput(m.root), "Enter");
		expect(m.warnings[0]).toEqual(["Adjusted for daylight saving"]);
	});

	it("details stay plain text: saved titles are never parsed again (QA-10)", async () => {
		const m = await mountForm();
		await typeInto(titleInput(m.root), "Call mom tomorrow");
		await pressKey(titleInput(m.root), "Enter");
		expect(formTasks(m)[0]!.title).toBe("Call mom");
		expect(formTasks(m)[0]!.scheduled).toEqual({ kind: "date", date: "2026-10-02" });
	});

	it("parsed duration, deadline and flags reach the task", async () => {
		const m = await mountForm();
		await typeInto(titleInput(m.root), "Write report for 1h30m by friday");
		await pressKey(titleInput(m.root), "Enter");
		const t = formTasks(m)[0]!;
		expect(t.title).toBe("Write report");
		expect(t.plannedDurationMin).toBe(90);
		expect(t.deadline).toEqual({ kind: "date", date: "2026-10-02" });
	});

	it("an error shows once and nothing is retried", async () => {
		const m = await mountForm();
		await typeInto(titleInput(m.root), "x".repeat(10));
		const original = m.app.tasks.create.bind(m.app.tasks);
		let calls = 0;
		m.app.tasks.create = () => {
			calls++;
			return Promise.reject(new Error("boom"));
		};
		await pressKey(titleInput(m.root), "Enter");
		expect(calls).toBe(1);
		expect(m.errors).toHaveLength(1);
		expect(m.closed.n).toBe(0);
		m.app.tasks.create = original;
	});

	it("keep open: saving resets the input, decisions and manual fields", async () => {
		const m = await mountForm({ keepOpen: true });
		const date = m.root.querySelector<HTMLInputElement>('.cp-quick-add-fields input[type="date"]')!;
		date.value = "2026-10-20";
		date.dispatchEvent(new Event("input", { bubbles: true }));
		await typeInto(titleInput(m.root), "Call mom tomorrow");
		chips(m.root)[0]!.querySelector<HTMLButtonElement>(".cp-qa-chip-remove")!.click();
		await settle();
		await pressKey(titleInput(m.root), "Enter");
		expect(formTasks(m)).toHaveLength(1);
		expect(m.closed.n).toBe(0);
		expect(titleInput(m.root).value).toBe("");
		expect(date.value).toBe("");
		await typeInto(titleInput(m.root), "Call mom tomorrow");
		expect(chips(m.root)).toHaveLength(1);
		expect(chips(m.root)[0]!.getAttribute("data-status")).toBe("applied");
	});

	it("#130: text typed while a task saves is kept for the next task; the field clears only when it still holds the saved text", async () => {
		for (const keepOpen of [true, false]) {
			const { h, m, saved, warnings, closed } = await quickModel({ keepOpen });
			const create = h.app.tasks.create.bind(h.app.tasks);
			let release!: () => void;
			const gate = new Promise<void>((r) => (release = r));
			h.app.tasks.create = async (input) => {
				await gate;
				return create(input);
			};
			m.setDate("2026-10-20");
			m.setInput("Task one");
			const first = m.submit();
			m.setInput("tomorrow");
			release();
			expect(await first).toBe("saved");
			// The notice describes the task that was saved, not the text typed since.
			expect(saved).toEqual(["Task one"]);
			expect(warnings).toEqual([[]]);
			expect(closed.n).toBe(0);
			expect(m.input).toBe("tomorrow");
			// The date picked for the saved task does not carry over.
			expect(m.dateInputs().date).toBe("2026-10-02");
			h.app.tasks.create = create;
			m.setInput("Task two tomorrow");
			expect(await m.submit()).toBe("saved");
			expect([...h.app.store.state.tasks.values()].map((t) => [t.title, t.scheduled])).toEqual([
				["Task one", { kind: "date", date: "2026-10-20" }],
				["Task two", { kind: "date", date: "2026-10-02" }],
			]);
			expect(m.input).toBe(keepOpen ? "" : "Task two tomorrow");
			expect(closed.n).toBe(keepOpen ? 0 : 1);
		}
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
		await pressKey(mains[0]!, "ArrowRight");
		expect(document.activeElement).toBe(chipMain(chips(m.root)[1]!));
		await pressKey(document.activeElement as HTMLElement, "ArrowLeft");
		expect(document.activeElement).toBe(chipMain(chips(m.root)[0]!));
		await pressKey(document.activeElement as HTMLElement, "ArrowLeft");
		expect(document.activeElement).toBe(chipMain(chips(m.root)[0]!));
	});

	it("Delete on a chip dismisses it; Backspace does too", async () => {
		const m = await mountForm();
		await typeInto(titleInput(m.root), "Call tomorrow for 45m");
		chipMain(chips(m.root)[0]!).focus();
		await pressKey(chipMain(chips(m.root)[0]!), "Backspace");
		expect(chips(m.root)).toHaveLength(1);
		await pressKey(chipMain(chips(m.root)[0]!), "Delete");
		expect(chips(m.root)).toHaveLength(0);
	});

	it("Enter in the input saves exactly once, even when pressed twice quickly", async () => {
		const m = await mountForm({ keepOpen: true });
		await typeInto(titleInput(m.root), "Buy milk");
		const input = titleInput(m.root);
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		await settle();
		expect(formTasks(m)).toHaveLength(1);
	});

	it("Enter is ignored while the suggester is open", async () => {
		const m = await mountForm();
		await typeInto(titleInput(m.root), "Buy milk");
		m.suggest.open = true;
		await pressKey(titleInput(m.root), "Enter");
		expect(formTasks(m)).toHaveLength(0);
		m.suggest.open = false;
		await pressKey(titleInput(m.root), "Enter");
		expect(formTasks(m)).toHaveLength(1);
	});

	it("Enter is ignored when the suggester just closed in the same key press", async () => {
		const m = await mountForm();
		await typeInto(titleInput(m.root), "Read #Study");
		m.suggest.onBind!({ span: { start: 5, end: 11 }, text: "#Study", kind: "category", categoryId: INBOX_ID });
		await pressKey(titleInput(m.root), "Enter");
		expect(formTasks(m)).toHaveLength(0);
	});

	it("Enter inside the title with a composition in progress does not save", async () => {
		const m = await mountForm();
		await typeInto(titleInput(m.root), "Buy milk");
		await pressKey(titleInput(m.root), "Enter", { isComposing: true });
		expect(formTasks(m)).toHaveLength(0);
	});

	it("Escape in a chip picker closes the picker and leaves the form open", async () => {
		const m = await mountForm();
		await typeInto(titleInput(m.root), "Read #Hobbies");
		await pressKey(titleInput(m.root), "Enter");
		const select = m.root.querySelector<HTMLSelectElement>(".cp-qa-panel select")!;
		const evt = await pressKey(select, "Escape");
		expect(m.root.querySelector(".cp-qa-panel")).toBeNull();
		expect(evt.defaultPrevented).toBe(true);
		expect(formTasks(m)).toHaveLength(0);
	});
});

describe("Suggester binding (B4)", () => {
	it("a bound multi-word category applies after the input event, without being dropped", async () => {
		const m = await mountForm();
		const c = await m.app.categories.create("Deep work");
		const input = titleInput(m.root);
		await typeInto(input, "Plan #Deep");
		// What QuickAddSuggest does: replace the token, dispatch input, then report the binding.
		input.value = "Plan #Deep work";
		input.dispatchEvent(new Event("input", { bubbles: true }));
		m.suggest.onBind!({ span: { start: 5, end: 15 }, text: "#Deep work", kind: "category", categoryId: c.id });
		await settle();
		expect(chips(m.root)[0]!.getAttribute("data-status")).toBe("applied");
		await pressKey(input, "Enter");
		expect(formTasks(m)[0]!.categoryId).toBe(c.id);
		expect(formTasks(m)[0]!.title).toBe("Plan");
	});

	it("attaches the suggester to the input and disposes it on unmount", async () => {
		const m = await mountForm();
		expect(m.suggest.input).toBe(titleInput(m.root));
		m.unmount();
		expect(m.suggest.disposed).toBe(1);
	});
});

describe("Inline add bar (C8)", () => {
	it("C8: 'Buy milk tomorrow' in the Inbox view saves 'Buy milk' scheduled for tomorrow", async () => {
		const { h, root } = await mountApp();
		root.querySelector<HTMLElement>(".cp-sidebar")!;
		const inbox = [...root.querySelectorAll<HTMLElement>(".cp-sidebar-item")].find((e) => e.textContent?.includes("Inbox"))!;
		inbox.click();
		await settle();
		const input = root.querySelector<HTMLInputElement>('.cp-add-bar input[aria-label="Add task"]')!;
		await typeInto(input, "Buy milk tomorrow");
		expect(root.querySelectorAll(".cp-add-bar .cp-qa-chip")).toHaveLength(1);
		await pressKey(input, "Enter");
		const [task] = [...h.app.store.state.tasks.values()];
		expect(task!.title).toBe("Buy milk");
		expect(task!.scheduled).toEqual({ kind: "date", date: "2026-10-02" });
		expect(task!.categoryId).toBe(INBOX_ID);
		expect(input.value).toBe("");
	});

	it("C8: the view's preset is a default, a parsed value wins, and an unresolved category blocks Enter", async () => {
		const { h, root } = await mountApp();
		const input = root.querySelector<HTMLInputElement>('.cp-add-bar input[aria-label="Add task"]')!;
		// Default view is Today: the preset date is today.
		await typeInto(input, "Plain");
		await pressKey(input, "Enter");
		expect([...h.app.store.state.tasks.values()][0]!.scheduled).toEqual({ kind: "date", date: "2026-10-01" });
		await typeInto(input, "Later #Nowhere");
		await pressKey(input, "Enter");
		expect(h.app.store.state.tasks.size).toBe(1);
		const select = root.querySelector<HTMLSelectElement>(".cp-add-bar .cp-qa-panel select")!;
		expect(document.activeElement).toBe(select);
		await pressKey(select, "Enter");
		expect(h.app.store.state.tasks.size).toBe(2);
	});
});

// Priority in the Quick Add model: the typed token, the manual setter (the "more menu"), and
// the manual-value rule: a manual value turns a typed token into a suggestion, accepting replaces it.

describe("QuickAddModel priority", () => {
	it("exposes the typed priority and a priority chip; none by default", async () => {
		const { m } = await quickModel();
		expect(m.priorityValue()).toBe(0);
		m.setInput("Pay rent !2");
		expect(m.priorityValue()).toBe(2);
		expect(m.result.chips.map((c) => `${c.kind}:${c.status}`)).toEqual(["priority:applied"]);
	});

	it("saves the typed priority and removes the accepted span from the title", async () => {
		const { h, m, saved } = await quickModel();
		m.setInput("Pay rent !high");
		expect(await m.submit()).toBe("saved");
		expect(saved).toEqual(["Pay rent"]);
		const task = [...h.app.store.state.tasks.values()][0]!;
		expect(task).toMatchObject({ title: "Pay rent", priority: 1 });
	});

	it("a task without a token saves with priority 0", async () => {
		const { h, m } = await quickModel();
		m.setInput("Pay rent");
		await m.submit();
		expect([...h.app.store.state.tasks.values()][0]!.priority).toBe(0);
	});

	it("dismissing the chip keeps the text and saves no priority", async () => {
		const { h, m } = await quickModel();
		m.setInput("Pay rent !1");
		m.dismiss(m.result.chips[0]!);
		expect(m.priorityValue()).toBe(0);
		await m.submit();
		expect([...h.app.store.state.tasks.values()][0]).toMatchObject({ title: "Pay rent !1", priority: 0 });
	});

	it("the last typed token wins and the earlier one stays in the title", async () => {
		const { h, m } = await quickModel();
		m.setInput("Pay !1 rent !3");
		expect(m.priorityValue()).toBe(3);
		await m.submit();
		expect([...h.app.store.state.tasks.values()][0]).toMatchObject({ title: "Pay !1 rent", priority: 3 });
	});

	it("a manual priority is saved when nothing is typed", async () => {
		const { h, m } = await quickModel();
		m.setInput("Pay rent");
		m.setPriority(2);
		expect(m.priorityValue()).toBe(2);
		await m.submit();
		expect([...h.app.store.state.tasks.values()][0]!.priority).toBe(2);
	});

	it("B4 pattern: a manual priority wins over a typed token, which becomes a suggestion; accepting replaces the manual value", async () => {
		const { h, m } = await quickModel();
		m.setInput("Pay rent !1");
		m.setPriority(3);
		expect(m.priorityValue()).toBe(3);
		const chip = m.result.chips[0]!;
		expect(chip).toMatchObject({ kind: "priority", status: "suggestion", notice: "Replace priority?" });
		m.accept(chip);
		expect(m.priorityValue()).toBe(1);
		expect(m.result.chips[0]).toMatchObject({ status: "applied" });
		await m.submit();
		expect([...h.app.store.state.tasks.values()][0]).toMatchObject({ title: "Pay rent", priority: 1 });
	});

	it("a manual none overrides a typed token and is saved as none", async () => {
		const { h, m } = await quickModel();
		m.setInput("Pay rent !1");
		m.setPriority(0);
		expect(m.priorityValue()).toBe(0);
		await m.submit();
		expect([...h.app.store.state.tasks.values()][0]).toMatchObject({ priority: 0 });
	});

	it("reset after a save clears the manual priority", async () => {
		const { m } = await quickModel();
		m.setInput("A");
		m.setPriority(1);
		await m.submit();
		expect(m.priorityValue()).toBe(0);
		expect(m.manual.has("priority")).toBe(false);
	});

	it("rejects an invalid manual priority", async () => {
		const { m } = await quickModel();
		expect(() => m.setPriority(9 as never)).toThrow();
	});
});

describe("the Quick Add modal", () => {
	// The modal's Escape rules. Obsidian's own Escape handler runs before anything registered
	// on the modal scope and calls close(), so close() itself must close an open popover first
	// (found by e2e for chip pickers). `obsidian` is the stub from tests/app/obsidian-stub.ts.

	const superClose = vi.fn();
	beforeAll(() => {
		(Modal as unknown as { prototype: { close: () => void } }).prototype.close = superClose;
	});
	afterEach(() => {
		superClose.mockClear();
		document.body.replaceChildren();
	});

	async function openModal(accent: "theme" | "purple" = "theme", eveningTime = DEFAULT_SETTINGS.eveningTime) {
		const h = await appHarness();
		const plugin = { app: {}, settings: { ...DEFAULT_SETTINGS, accent, eveningTime } };
		const modal = new QuickAddModal(plugin as never, { app: h.app } as never, {});
		const m = modal as unknown as { modalEl: ObsidianElement; contentEl: ObsidianElement; scope: { register: () => void }; setTitle: () => void };
		m.modalEl = obsidianElement();
		m.contentEl = obsidianElement();
		m.modalEl.appendChild(m.contentEl);
		document.body.appendChild(m.modalEl);
		m.scope = { register: () => undefined };
		m.setTitle = () => undefined;
		modal.onOpen();
		await settle();
		return { modal, modalEl: m.modalEl };
	}

	describe("QuickAddModal", () => {
		it("puts the accent class on the modal element next to its own class", async () => {
			const { modalEl } = await openModal("purple");
			expect(modalEl.classList.contains("checkpoint-quick-add-modal")).toBe(true);
			expect(modalEl.classList.contains("cp-accent-purple")).toBe(true);
		});

		it("close() with a popover open closes the popover and keeps the modal open", async () => {
			const { modal, modalEl } = await openModal();
			modalEl.querySelector<HTMLButtonElement>('.cp-qa-tool[aria-label="Date"]')!.click();
			await new Promise((r) => setTimeout(r, 0));
			expect(modalEl.querySelector(".cp-date-pop")).not.toBeNull();
			modal.close();
			await new Promise((r) => setTimeout(r, 0));
			expect(modalEl.querySelector(".cp-date-pop")).toBeNull();
			expect(superClose).not.toHaveBeenCalled();
			modal.close();
			expect(superClose).toHaveBeenCalledTimes(1);
		});

		it("a capture-phase Escape on the modal closes only the popover", async () => {
			const { modalEl } = await openModal();
			modalEl.querySelector<HTMLButtonElement>('.cp-qa-tool[aria-label="Priority, list, tags and note"]')!.click();
			await new Promise((r) => setTimeout(r, 0));
			const evt = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
			modalEl.querySelector(".cp-quick-add-title")!.dispatchEvent(evt);
			await new Promise((r) => setTimeout(r, 0));
			expect(modalEl.querySelector(".cp-more-pop")).toBeNull();
			expect(evt.defaultPrevented).toBe(true);
			expect(superClose).not.toHaveBeenCalled();
		});

		it("the Tonight quick pick uses the evening time setting", async () => {
			const { modalEl } = await openModal("theme", "17:10");
			modalEl.querySelector<HTMLButtonElement>('.cp-qa-tool[aria-label="Date"]')!.click();
			await new Promise((r) => setTimeout(r, 0));
			const tonight = [...modalEl.querySelectorAll<HTMLButtonElement>(".cp-quick button")].find((b) => b.textContent?.includes("Tonight"))!;
			tonight.click();
			await new Promise((r) => setTimeout(r, 0));
			expect(modalEl.querySelector('.cp-pop-row[data-row="time"] .cp-pop-val')!.textContent).toBe("17:10");
		});
	});
});

describe("repeats in Quick Add", () => {
	// The repeat in Quick Add: the date popover's Repeat row, the "All fields" Repeat field,
	// the pills and chips, and the save. Real services and parser, a fake host. The harness clock is 2026-10-01T10:00Z
	// (Thursday), zone Europe/Berlin.

	const repeatRow = (root: HTMLElement) => q<HTMLButtonElement>(root, '.cp-pop-row[data-row="repeat"]');
	const opt = (root: ParentNode, id: string) => q<HTMLButtonElement>(root, `[data-preset="${id}"]`);
	const pills = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(".cp-qa-manual-label")].map((p) => p.textContent);

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
			expect(list.querySelectorAll('[role="option"]')).toHaveLength(7);
			expect(document.activeElement).toBe(opt(m.root, "never"));
		});

		it("picks a preset: the row shows it, a purple pill names it, and the task is saved repeating from the picked date", async () => {
			const m = await mountForm();
			await click(dateTool(m.root));
			await click(popDay(m.root, "2026-10-05"));
			await click(repeatRow(m.root));
			expect(opt(m.root, "weekly").querySelector("small")?.textContent).toBe("on Monday");
			await click(opt(m.root, "weekday"));
			expect(m.root.querySelector(".cp-repeat-opts")).toBeNull();
			expect(repeatRow(m.root).querySelector(".cp-pop-val")?.textContent).toBe("every weekday");
			expect(pills(m.root)).toContain("Repeat: every weekday");
			expect(q(m.root, '.cp-qa-manual[data-kind="recurrence"]').querySelector('[data-icon="repeat"]')).not.toBeNull();
			await typeInto(titleInput(m.root), "Standup");
			titleInput(m.root).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
			await settle();
			const [t] = formTasks(m);
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
			await typeInto(titleInput(m.root), "Water plants");
			titleInput(m.root).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
			await settle();
			expect(formTasks(m)[0]?.recurrence?.anchor).toBe("2026-10-01");
		});

		it("Custom… swaps the popover for the editor; Done returns to the date face with the rule set, with its end", async () => {
			const m = await mountForm();
			await click(dateTool(m.root));
			await click(popDay(m.root, "2026-10-05"));
			await click(repeatRow(m.root));
			await click(opt(m.root, "custom"));
			const pop = q(m.root, ".cp-date-pop");
			expect(pop.classList.contains("is-repeat")).toBe(true);
			expect(pop.textContent).toContain("Custom repeat");
			expect(m.root.querySelector(".cp-cal-day")).toBeNull();
			for (const d of ["MO", "WE"]) await click(q(pop, `.cp-repeat-day[data-day="${d}"]`));
			await click(q(pop, '.cp-repeat-seg [data-end="count"]'));
			await typeInto(q<HTMLInputElement>(pop, 'input[aria-label="Times"]'), "6");
			await click(q(pop, ".cp-repeat-done"));
			expect(m.root.querySelector(".cp-repeat-custom")).toBeNull();
			expect(m.root.querySelector(".cp-cal-day")).not.toBeNull();
			expect(repeatRow(m.root).querySelector(".cp-pop-val")?.textContent).toBe("every Mon, Wed · ends after 6 times");
			expect(document.activeElement).toBe(repeatRow(m.root));
			await typeInto(titleInput(m.root), "Gym");
			titleInput(m.root).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
			await settle();
			const rec = formTasks(m)[0]?.recurrence;
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
			keydown(opt(m.root, "never"), "Escape");
			await settle();
			expect(m.root.querySelector(".cp-date-pop")).toBeNull();
		});

		it("a subtask's bar has no Repeat row (D10)", async () => {
			const m0 = await mountForm();
			const parent = (await m0.app.tasks.create({ title: "Parent" })).task;
			m0.unmount();
			const m = await mountForm({ preset: { parentId: parent.id }, app: m0.app });
			await click(dateTool(m.root));
			expect(m.root.querySelector('.cp-pop-row[data-row="repeat"]')).toBeNull();
			expect(m.root.querySelector(".cp-pop-row[data-row=deadline]")).not.toBeNull();
		});
	});

	describe("a typed repeat", () => {
		it("applies as a purple chip and saves the task repeating, with the words out of the title", async () => {
			const m = await mountForm();
			await typeInto(titleInput(m.root), "Water plants every day");
			const chip = q(m.root, '.cp-qa-chip[data-kind="recurrence"]');
			expect(chip.dataset.status).toBe("applied");
			expect(chip.textContent).toContain("Repeat: every day");
			titleInput(m.root).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
			await settle();
			const [t] = formTasks(m);
			expect(t?.title).toBe("Water plants");
			expect(t?.recurrence?.versions[0]?.rule).toMatchObject({ freq: "daily", interval: 1 });
			expect(t?.recurrence?.anchor).toBe("2026-10-01");
		});

		it("the date popover shows it, and picking Never by hand overrides the chip like the other manual fields (B4)", async () => {
			const m = await mountForm();
			await typeInto(titleInput(m.root), "Water plants every day");
			await click(dateTool(m.root));
			expect(repeatRow(m.root).querySelector(".cp-pop-val")?.textContent).toBe("every day");
			await click(repeatRow(m.root));
			await click(opt(m.root, "never"));
			expect(repeatRow(m.root).querySelector(".cp-pop-val")?.textContent).toBe("Never");
			await click(dateTool(m.root));
			titleInput(m.root).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
			await settle();
			expect(formTasks(m)[0]?.recurrence).toBeNull();
		});

		it("x on the chip keeps the words as the title and does not repeat", async () => {
			const m = await mountForm();
			await typeInto(titleInput(m.root), "Water plants every day");
			await click(q(m.root, '.cp-qa-chip[data-kind="recurrence"] .cp-qa-chip-remove'));
			titleInput(m.root).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
			await settle();
			expect(formTasks(m)[0]?.title).toBe("Water plants every day");
			expect(formTasks(m)[0]?.recurrence).toBeNull();
		});

		it("a deadline on a repeating task is dropped on save: the task repeats, the notice says so", async () => {
			const m = await mountForm();
			await typeInto(titleInput(m.root), "Report every week");
			await click(dateTool(m.root));
			await click(repeatRow(m.root));
			await click(opt(m.root, "daily"));
			await click(q(m.root, '.cp-pop-row[data-row="deadline"]'));
			await typeInto(q<HTMLInputElement>(m.root, 'input[aria-label="Deadline"]'), "2026-10-12");
			expect(q(m.root, ".cp-date-pop .cp-pop-empty").textContent).toBe("A repeating task has no deadline.");
			await click(dateTool(m.root));
			titleInput(m.root).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
			await settle();
			expect(m.errors).toEqual([]);
			expect(formTasks(m)).toHaveLength(1);
			expect(formTasks(m)[0]?.title).toBe("Report every week");
			expect(formTasks(m)[0]?.recurrence).not.toBeNull();
			expect(formTasks(m)[0]?.deadline).toBeNull();
			expect(m.warnings).toEqual([[DEADLINE_CLEARED_TEXT]]);
		});

		it("a typed deadline with a typed repeat saves the repeating task without the deadline", async () => {
			const m = await mountForm();
			await typeInto(titleInput(m.root), "Pay rent every month by friday");
			titleInput(m.root).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
			await settle();
			expect(m.errors).toEqual([]);
			expect(formTasks(m)).toHaveLength(1);
			expect(formTasks(m)[0]?.title).toBe("Pay rent");
			expect(formTasks(m)[0]?.recurrence?.versions[0]?.rule).toMatchObject({ freq: "monthly" });
			expect(formTasks(m)[0]?.deadline).toBeNull();
			expect(m.warnings).toEqual([[DEADLINE_CLEARED_TEXT]]);
		});

		it("a repeat without a deadline adds no notice", async () => {
			const m = await mountForm();
			await typeInto(titleInput(m.root), "Water plants every day");
			titleInput(m.root).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
			await settle();
			expect(formTasks(m)).toHaveLength(1);
			expect(m.warnings).toEqual([[]]);
		});

		it("a failed write keeps what was typed and the deadline", async () => {
			const m = await mountForm();
			await typeInto(titleInput(m.root), "Report every week by friday");
			const create = m.app.tasks.create.bind(m.app.tasks);
			m.app.tasks.create = () => Promise.reject(new Error("disk full"));
			titleInput(m.root).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
			await settle();
			m.app.tasks.create = create;
			expect(m.errors).toHaveLength(1);
			expect(formTasks(m)).toHaveLength(0);
			expect(titleInput(m.root).value).toBe("Report every week by friday");
			expect(m.warnings).toEqual([]);
		});

		it("a subtask still cannot repeat: it says so and writes nothing", async () => {
			const { app } = await appHarness();
			const parent = (await app.tasks.create({ title: "Parent" })).task;
			const m = await mountForm({ preset: { parentId: parent.id }, app });
			await typeInto(titleInput(m.root), "Child every day");
			titleInput(m.root).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
			await settle();
			expect(formTasks(m).filter((t) => t.parentId !== null)).toHaveLength(0);
			expect(q(m.root, ".cp-form-message").textContent).toContain("A subtask cannot repeat");
		});
	});

	describe("a typed repeat with a bare hour", () => {
		const chipOf = (root: HTMLElement) => q(root, '.cp-qa-chip[data-kind="recurrence"]');
		const panelOptions = (root: HTMLElement) => [...q<HTMLSelectElement>(root, ".cp-qa-panel select").options].map((o) => o.textContent);

		it("asks 09:00 or 21:00 in the same picker a date's bare hour uses", async () => {
			const m = await mountForm();
			await typeInto(titleInput(m.root), "Gym tomorrow at 9");
			await click(q(m.root, '.cp-qa-chip[data-kind="scheduled"] .cp-qa-chip-main'));
			const forDate = panelOptions(m.root);
			await typeInto(titleInput(m.root), "Gym every monday at 9");
			expect(chipOf(m.root).dataset.status).toBe("choice");
			await click(q(chipOf(m.root), ".cp-qa-chip-main"));
			expect(forDate).toEqual(["09:00", "21:00"]);
			expect(panelOptions(m.root)).toEqual(forDate);
			expect(q(m.root, ".cp-qa-panel-title").textContent).toBe('Choose a value for "every monday at 9"');
		});

		it("choosing 21:00 repeats at 21:00 in the zone and takes the words out of the title", async () => {
			const m = await mountForm();
			await typeInto(titleInput(m.root), "Gym every monday at 9");
			await click(q(chipOf(m.root), ".cp-qa-chip-main"));
			await typeInto(q<HTMLSelectElement>(m.root, ".cp-qa-panel select"), "1", "change");
			await click(q(m.root, ".cp-qa-panel .cp-qa-apply"));
			expect(chipOf(m.root).dataset.status).toBe("applied");
			expect(chipOf(m.root).textContent).toContain("Repeat: every Mon");
			await pressKey(titleInput(m.root), "Enter");
			expect(formTasks(m)[0]?.title).toBe("Gym");
			expect(formTasks(m)[0]?.recurrence?.versions[0]?.rule).toMatchObject({ freq: "weekly", weekdays: ["MO"], time: "21:00", tz: "Europe/Berlin" });
		});

		it("the first option is preselected, so Apply alone gives 09:00", async () => {
			const m = await mountForm();
			await typeInto(titleInput(m.root), "Gym every day at 9");
			await click(q(chipOf(m.root), ".cp-qa-chip-main"));
			await click(q(m.root, ".cp-qa-panel .cp-qa-apply"));
			await pressKey(titleInput(m.root), "Enter");
			expect(formTasks(m)[0]?.recurrence?.versions[0]?.rule).toMatchObject({ freq: "daily", time: "09:00" });
		});

		it("Enter without choosing saves nothing and opens the choice; Apply there saves with the chosen hour", async () => {
			const m = await mountForm();
			await typeInto(titleInput(m.root), "Gym every monday at 9");
			await pressKey(titleInput(m.root), "Enter");
			expect(formTasks(m)).toHaveLength(0);
			expect(q(m.root, ".cp-qa-panel-title").textContent).toBe('Choose a value for "every monday at 9"');
			await click(q(m.root, ".cp-qa-panel .cp-qa-apply"));
			await settle();
			expect(formTasks(m)[0]?.title).toBe("Gym");
			expect(formTasks(m)[0]?.recurrence?.versions[0]?.rule).toMatchObject({ freq: "weekly", weekdays: ["MO"], time: "09:00" });
		});

		it("a chosen reading replaces a repeat picked by hand, like a chosen date does", async () => {
			const m = await mountForm();
			await typeInto(titleInput(m.root), "Gym every monday at 9");
			await click(dateTool(m.root));
			await click(repeatRow(m.root));
			await click(opt(m.root, "daily"));
			await click(dateTool(m.root));
			expect(chipOf(m.root).textContent).toContain("Replace repeat?");
			await click(q(chipOf(m.root), ".cp-qa-chip-main"));
			await click(q(m.root, ".cp-qa-panel .cp-qa-apply"));
			await pressKey(titleInput(m.root), "Enter");
			expect(formTasks(m)[0]?.recurrence?.versions[0]?.rule).toMatchObject({ freq: "weekly", weekdays: ["MO"], time: "09:00" });
		});

		it("explicit hours never ask", async () => {
			for (const [text, time] of [["9am", "09:00"], ["9pm", "21:00"], ["21:00", "21:00"], ["09:00", "09:00"]] as const) {
				const m = await mountForm();
				await typeInto(titleInput(m.root), `Gym every day at ${text}`);
				expect(chipOf(m.root).dataset.status, text).toBe("applied");
				expect(m.root.querySelector(".cp-qa-panel")).toBeNull();
				await pressKey(titleInput(m.root), "Enter");
				expect(formTasks(m)[0]?.recurrence?.versions[0]?.rule, text).toMatchObject({ time });
				m.unmount();
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
			await typeInto(titleInput(m.root), "Review");
			titleInput(m.root).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
			await settle();
			expect(formTasks(m)[0]?.recurrence?.versions[0]?.rule).toMatchObject({ freq: "weekly", weekdays: null });
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
			m0.unmount();
			const m = await mountForm({ preset: { parentId: parent.id }, app: m0.app });
			const button = q<HTMLButtonElement>(m.root, ".cp-repeat-button");
			expect(button.disabled).toBe(true);
			expect(button.title).toBe("A subtask cannot repeat");
		});
	});
});

describe("a repeat's end", () => {
	// Repeating tasks rule 19 (#12): a typed repeat end is saved with the repeat, follows it under a repeat picked by hand,
	// and goes with the date popover's Clear. Europe/Berlin, Wednesday 2026-10-07.

	const weekly = { freq: "weekly" as const, interval: 1, weekdays: null, monthly: null, afterCompletion: false, time: null, tz: null };

	describe("Quick Add repeat end (#12)", () => {
		it("#12: saves the typed end with the repeat", async () => {
			const { h, m } = await quickModel({ at: WEDNESDAY_CLOCK });
			m.setInput("Pills every day until Dec 1");
			expect(m.repeatValue()?.end).toEqual({ kind: "date", date: "2026-12-01" });
			expect(await m.submit()).toBe("saved");
			const task = [...h.app.store.state.tasks.values()][0]!;
			expect(task.title).toBe("Pills");
			expect(task.recurrence).toMatchObject({ anchor: "2026-10-07", end: { kind: "date", date: "2026-12-01" } });
		});

		it("#12: saves a count end", async () => {
			const { h, m } = await quickModel({ at: WEDNESDAY_CLOCK });
			m.setInput("Pills every day for 5 times");
			expect(await m.submit()).toBe("saved");
			expect([...h.app.store.state.tasks.values()][0]!.recurrence?.end).toEqual({ kind: "count", count: 5 });
		});

		it("#12: using the end chip under a repeat picked by hand brings back the typed repeat with its end", async () => {
			const { m } = await quickModel({ at: WEDNESDAY_CLOCK });
			m.setInput("Pills every day until Dec 1");
			m.setRepeat({ rule: weekly, end: { kind: "never" } });
			expect(m.repeatValue()?.rule.freq).toBe("weekly");
			const end = m.result.chips.find((c) => c.kind === "repeatEnd")!;
			expect(end.status).toBe("suggestion");
			m.accept(end);
			expect(m.repeatValue()).toMatchObject({ rule: { freq: "daily" }, end: { kind: "date", date: "2026-12-01" } });
		});

		it("#12: an invalid end blocks saving with the shared message", async () => {
			const { h, m } = await quickModel({ at: WEDNESDAY_CLOCK });
			m.setInput("Gym every friday until Oct 8");
			expect(await m.submit()).toBe("invalid");
			expect(m.message).toBe("The repeat ends before its first date.");
			expect(h.app.store.state.tasks.size).toBe(0);
		});

		it("#12: `for N …` counts from a date picked by hand", async () => {
			const { h, m } = await quickModel({ at: WEDNESDAY_CLOCK });
			m.setDate("2026-10-20");
			m.setInput("Stretch daily for 2 weeks");
			expect(m.repeatValue()?.end).toEqual({ kind: "date", date: "2026-11-02" });
			expect(await m.submit()).toBe("saved");
			expect([...h.app.store.state.tasks.values()][0]!.recurrence).toMatchObject({ anchor: "2026-10-20", end: { kind: "date", date: "2026-11-02" } });
		});

		it("#12: a typed end applies to a repeat picked by hand that has none", async () => {
			const { h, m } = await quickModel({ at: WEDNESDAY_CLOCK });
			m.setRepeat({ rule: { ...weekly, freq: "daily" }, end: { kind: "never" } });
			m.setInput("Pills until Dec 1");
			expect(m.result.fields.deadline).toBeUndefined();
			expect(await m.submit()).toBe("saved");
			const task = [...h.app.store.state.tasks.values()][0]!;
			expect(task).toMatchObject({ title: "Pills", deadline: null, recurrence: { end: { kind: "date", date: "2026-12-01" } } });
		});

		it("#105: after Never is picked, a typed end left without its typed repeat is a deadline, as with no repeat", async () => {
			const { h, m } = await quickModel({ at: WEDNESDAY_CLOCK });
			m.setInput("Water plants every day until Dec 1");
			m.setRepeat(null);
			m.dismiss(m.result.chips.find((c) => c.kind === "recurrence")!);
			const end = m.result.chips.find((c) => c.text === "until Dec 1")!;
			expect(end).toMatchObject({ kind: "deadline", status: "applied" });
			expect(m.result.title).toBe("Water plants every day");
			expect(m.repeatValue()).toBeNull();
			expect(await m.submit()).toBe("saved");
			const task = [...h.app.store.state.tasks.values()][0]!;
			expect(task).toMatchObject({ title: "Water plants every day", recurrence: null, deadline: { kind: "date", date: "2026-12-01" } });
		});

		it("#12: the picker refuses an end before the first occurrence (a Monday task, weekly on Friday, ending Wednesday)", () => {
			const d = { ...draftOf(null, "2026-10-05"), freq: "weekly" as const, days: ["FR" as const], endKind: "date" as const, endDate: "2026-10-07" };
			expect(draftProblem(d, "2026-10-05", "MO")).toBe("The repeat ends before its first date.");
			expect(draftProblem({ ...d, endDate: "2026-10-09" }, "2026-10-05", "MO")).toBeNull();
		});

		it("#12: a typed end over a repeat picked by hand with its own end is a suggestion; using it replaces the end", async () => {
			const { h, m } = await quickModel({ at: WEDNESDAY_CLOCK });
			m.setRepeat({ rule: { ...weekly, freq: "daily" }, end: { kind: "count", count: 5 } });
			m.setInput("Pills until Dec 1");
			const end = m.result.chips.find((c) => c.kind === "repeatEnd")!;
			expect(end).toMatchObject({ status: "suggestion", notice: "Replace repeat end?" });
			expect(m.result.title).toBe("Pills until Dec 1");
			expect(m.repeatValue()?.end).toEqual({ kind: "count", count: 5 });
			m.accept(end);
			expect(m.repeatValue()).toMatchObject({ rule: { freq: "daily" }, end: { kind: "date", date: "2026-12-01" } });
			expect(m.result.title).toBe("Pills");
			expect(await m.submit()).toBe("saved");
			expect([...h.app.store.state.tasks.values()][0]!.recurrence?.end).toEqual({ kind: "date", date: "2026-12-01" });
		});

		it("#12: picking a repeat again after using a typed end forgets that use: the new pick's end wins", async () => {
			const { m } = await quickModel({ at: WEDNESDAY_CLOCK });
			m.setRepeat({ rule: { ...weekly, freq: "daily" }, end: { kind: "count", count: 5 } });
			m.setInput("Pills until Dec 1");
			m.accept(m.result.chips.find((c) => c.kind === "repeatEnd")!);
			expect(m.repeatValue()?.end).toEqual({ kind: "date", date: "2026-12-01" });
			m.setRepeat({ rule: { ...weekly, freq: "daily" }, end: { kind: "count", count: 10 } });
			expect(m.repeatValue()?.end).toEqual({ kind: "count", count: 10 });
			expect(m.result.chips.find((c) => c.kind === "repeatEnd")).toMatchObject({ status: "suggestion", notice: "Replace repeat end?" });
		});

		it("#12: picking a date again after using a typed date makes it a suggestion again", async () => {
			const { m } = await quickModel({ at: WEDNESDAY_CLOCK });
			m.setInput("Call tomorrow");
			m.setDate("2026-10-20");
			const chip = m.result.chips.find((c) => c.kind === "scheduled")!;
			expect(chip.status).toBe("suggestion");
			m.accept(chip);
			expect(m.result.chips.find((c) => c.kind === "scheduled")?.status).toBe("applied");
			m.setDate("2026-10-21");
			expect(m.result.chips.find((c) => c.kind === "scheduled")).toMatchObject({ status: "suggestion", notice: "Replace date?" });
			expect(m.result.title).toBe("Call tomorrow");
		});

		it("#12: a cleared date in a view with a preset counts from today, as the save does", async () => {
			for (const [input, end] of [
				["Stretch daily for 2 weeks", { kind: "date", date: "2026-10-20" }],
				["Stretch daily until Oct 15", { kind: "date", date: "2026-10-15" }],
			] as const) {
				const { h, m } = await quickModel({ at: WEDNESDAY_CLOCK, preset: { date: "2026-10-20" } });
				m.setDate("");
				m.setInput(input);
				expect(m.repeatValue()?.end, input).toEqual(end);
				expect(await m.submit(), input).toBe("saved");
				expect([...h.app.store.state.tasks.values()][0]!.recurrence, input).toMatchObject({ anchor: "2026-10-07", end });
			}
		});

		it("#12: a typed end before the first date of a repeat picked by hand is refused and blocks saving", async () => {
			const { h, m } = await quickModel({ at: WEDNESDAY_CLOCK });
			m.setRepeat({ rule: { ...weekly, weekdays: ["FR"] }, end: { kind: "never" } });
			m.setInput("Gym until Oct 8");
			expect(m.result.chips.find((c) => c.kind === "repeatEnd")).toMatchObject({ status: "invalid", notice: "The repeat ends before its first date." });
			expect(await m.submit()).toBe("invalid");
			expect(h.app.store.state.tasks.size).toBe(0);
			m.setInput("Gym until Oct 9");
			expect(await m.submit()).toBe("saved");
			expect([...h.app.store.state.tasks.values()][0]!.recurrence?.end).toEqual({ kind: "date", date: "2026-10-09" });
		});

		it("#12: a date picked by hand after choosing a typed date's hour wins: the chip is offered again and its text stays", async () => {
			const { h, m } = await quickModel({ at: WEDNESDAY_CLOCK });
			m.setInput("Call tomorrow at 5");
			const chip = m.result.chips.find((c) => c.kind === "scheduled")!;
			m.setChipDate(chip, chip.alternatives![1]!.value!);
			expect(m.result.chips.find((c) => c.kind === "scheduled")?.status).toBe("applied");
			m.setDate("2026-10-20");
			expect(m.result.chips.find((c) => c.kind === "scheduled")).toMatchObject({ status: "choice", notice: "Replace date?" });
			expect(m.result.title).toBe("Call tomorrow at 5");
			expect(await m.submit()).toBe("saved");
			// The popover showed the chosen 17:00 when the date was picked, so the hand pick keeps that time.
			expect([...h.app.store.state.tasks.values()][0]).toMatchObject({ title: "Call tomorrow at 5", scheduled: { kind: "datetime", local: "2026-10-20T17:00" } });
		});

		it("#12: a repeat picked by hand after choosing a typed repeat's hour wins: the chip is offered again and its text stays", async () => {
			const { h, m } = await quickModel({ at: WEDNESDAY_CLOCK });
			m.setInput("Gym every monday at 7");
			const chip = m.result.chips.find((c) => c.kind === "recurrence")!;
			m.setChipRule(chip, chip.alternatives![0]!.rule!);
			expect(m.result.chips.find((c) => c.kind === "recurrence")?.status).toBe("applied");
			m.setRepeat({ rule: { ...weekly, freq: "daily" }, end: { kind: "never" } });
			expect(m.result.chips.find((c) => c.kind === "recurrence")).toMatchObject({ status: "choice", notice: "Replace repeat?" });
			expect(m.result.title).toBe("Gym every monday at 7");
			expect(m.repeatValue()?.rule.freq).toBe("daily");
			expect(await m.submit()).toBe("saved");
			const task = [...h.app.store.state.tasks.values()][0]!;
			expect(task.title).toBe("Gym every monday at 7");
			expect(task.recurrence?.versions[0]?.rule).toMatchObject({ freq: "daily", time: null });
		});

		it("#12: Clear in the date popover keeps the end as text too", async () => {
			const { m } = await quickModel({ at: WEDNESDAY_CLOCK });
			m.setInput("Pills every day until Dec 1");
			m.clearDateFields();
			expect(m.result.chips.filter((c) => c.status === "applied")).toEqual([]);
			expect(m.result.fields.deadline).toBeUndefined();
			expect(m.repeatValue()).toBeNull();
		});
	});
});

describe("a yearly start that is a choice", () => {
	// Repeating tasks rule 19 (#12): `every year on <date>` starts on that date. While the date's hour is still a choice,
	// Enter does not save: it opens the chip's alternatives (like an unknown list), and the choice saves the task anchored
	// on the chosen date, never on today. Europe/Berlin, Wednesday 2026-10-07.

	describe("a yearly repeat whose start is a choice (#12)", () => {
		it.each(["Birthday every year on May 5 at 7", "Birthday every year on Feb 29 at 9"])("#12: %s: Enter opens the choice, choosing saves on the chosen date", async (input) => {
			const { h, m } = await quickModel({ at: WEDNESDAY_CLOCK });
			m.setInput(input);
			const start = m.result.chips.find((c) => c.kind === "scheduled")!;
			expect(start.status).toBe("choice");
			expect(await m.submit()).toBe("blocked");
			expect(m.openChipId).toBe(start.id);
			expect(m.panelKind(start)).toBe("alternatives");
			expect([...h.app.store.state.tasks.values()]).toHaveLength(0);
			// The second choice (19:00 / 21:00) saves the task on that date and time.
			const value = start.alternatives![1]!.value!;
			m.setChipDate(start, value);
			await vi.waitFor(() => expect([...h.app.store.state.tasks.values()]).toHaveLength(1));
			const tasks = [...h.app.store.state.tasks.values()];
			expect(tasks[0]!.title).toBe("Birthday");
			expect(tasks[0]!.recurrence).toMatchObject({ anchor: value.kind === "datetime" ? value.local.slice(0, 10) : value.date, versions: [{ rule: { freq: "yearly", time: value.kind === "datetime" ? value.local.slice(11, 16) : null } }] });
		});

		it("#12: choosing from a chip the user opened does not save", async () => {
			const { h, m } = await quickModel({ at: WEDNESDAY_CLOCK });
			m.setInput("Birthday every year on May 5 at 7");
			const start = m.result.chips.find((c) => c.kind === "scheduled")!;
			m.activate(start);
			m.setChipDate(start, start.alternatives![0]!.value!);
			await Promise.resolve();
			expect([...h.app.store.state.tasks.values()]).toHaveLength(0);
			expect(m.result.blocking).toEqual([]);
			expect(await m.submit()).toBe("saved");
		});
	});
});

// Issue 27: a list that cannot be found is called "Inbox" everywhere, the Quick Add manual pill included.

function fakeModel(categoryId: string): QuickAddModel {
	return {
		manual: new Set(["category"]),
		parent: undefined,
		tagKeys: null,
		urgent: false,
		important: false,
		vals: { categoryId },
		env: { app: { settings: { zone: () => "UTC" }, queryContext: () => ({ today: "2026-01-01" }), categories: { list: () => [] }, tags: { list: () => [] } } },
		revertManual: () => undefined,
	} as unknown as QuickAddModel;
}

describe("missing list name", () => {
	it("#27: is Inbox in the manual category pill", () => {
		const pill = manualPills(fakeModel("deleted-list")).find((p) => p.kind === "category");
		expect(pill?.label).toBe(`List: ${INBOX_NAME}`);
		expect(pill?.label).toBe("List: Inbox");
	});
});

describe("All fields", () => {
	// Issue #85: Quick Add's "All fields" lines up: a deliberate grid, the flags on a row of their own,
	// the tag box and "Link existing note" spaced like the grid, the List select drawn like the inputs,
	// and Time says why it is disabled.

	const fields = (root: HTMLElement) => root.querySelector<HTMLElement>(".cp-quick-add-fields")!;
	const timeInput = (root: HTMLElement) => root.querySelector<HTMLInputElement>('.cp-quick-add-fields input[type="time"]')!;
	const dateInput = (root: HTMLElement) => root.querySelector<HTMLInputElement>('.cp-quick-add-fields input[type="date"]')!;

	describe("#85: All fields", () => {
		it("#85: Time is disabled until there is a date, says so in its label, and describes why", async () => {
			const { root } = await mountQuickForm();
			const time = timeInput(root);
			expect(time.disabled).toBe(true);
			const label = time.closest("label")!;
			const hint = label.querySelector<HTMLElement>(".cp-field-hint");
			expect(hint).not.toBeNull();
			expect(hint!.textContent).toContain("needs a date");
			expect(time.getAttribute("title")).toBe("Pick a date first");
			const describedBy = time.getAttribute("aria-describedby");
			expect(describedBy).not.toBeNull();
			expect(root.querySelector(`#${CSS.escape(describedBy!)}`)).toBe(hint);
		});

		it("#85: with a date, Time is enabled and the hint is gone", async () => {
			const { root } = await mountQuickForm();
			const date = dateInput(root);
			date.value = "2026-10-20";
			date.dispatchEvent(new Event("input", { bubbles: true }));
			await settle();
			const time = timeInput(root);
			expect(time.disabled).toBe(false);
			expect(time.closest("label")!.querySelector(".cp-field-hint")).toBeNull();
			expect(time.hasAttribute("aria-describedby")).toBe(false);
			// Preact clears an unset title to "", which shows no tooltip.
			expect(time.getAttribute("title") ?? "").toBe("");
		});

		it("#85: the Urgent and Important flags are one full-width row of the grid", async () => {
			const { root } = await mountQuickForm();
			const flags = fields(root).querySelector<HTMLElement>(".cp-flags")!;
			expect(flags.classList.contains("cp-field-row")).toBe(true);
			expect(flags.parentElement).toBe(fields(root));
		});

		it("#85: the tag box and Link existing note are full rows of the grid", async () => {
			const { root } = await mountQuickForm();
			const grid = fields(root);
			const tags = root.querySelector<HTMLElement>(".cp-tag-input")!;
			const note = root.querySelector<HTMLElement>(".cp-quick-add-note")!;
			expect(tags.parentElement?.classList.contains("cp-field-row")).toBe(true);
			expect(tags.parentElement?.parentElement).toBe(grid);
			expect(note.classList.contains("cp-field-row")).toBe(true);
			expect(note.parentElement).toBe(grid);
		});
	});

	describe("#85: All fields stylesheet", () => {
		const css = readFileSync("styles.css", "utf8");

		it("#85: the modal's field grid is three columns, two in a narrow window", () => {
			expect(css).toMatch(/\.checkpoint-quick-add-modal \.cp-quick-add-fields\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
			expect(css).toMatch(/@container cp-qa-fields \(max-width: [0-9]+px\)\s*\{[^}]*\.cp-quick-add-fields\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
		});

		it("#85: full rows span the grid", () => {
			expect(css).toMatch(/\.cp-field-row[^{]*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
		});

		it("#85: the flags row wraps and centers its checkboxes", () => {
			expect(css).toMatch(/\.checkpoint-quick-add-modal \.cp-flags\s*\{[^}]*flex-wrap:\s*wrap/);
			expect(css).toMatch(/\.checkpoint-quick-add-modal \.cp-flags\s*\{[^}]*align-items:\s*center/);
		});

		it("#85: a List select in a field is drawn like the other inputs", () => {
			const rule = css.match(/\.cp-field select\.dropdown\s*\{([^}]*)\}/);
			expect(rule).not.toBeNull();
			expect(rule![1]).toMatch(/background-color:\s*var\(--background-modifier-form-field\)/);
			expect(rule![1]).toMatch(/border:\s*var\(--input-border-width\) solid var\(--background-modifier-border\)/);
			expect(rule![1]).toMatch(/box-shadow:\s*none/);
		});
	});
});
