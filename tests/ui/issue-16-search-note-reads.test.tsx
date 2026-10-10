// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { type CalMount, click, mountCal, settle } from "./m3-helpers";
import { input as habitInput } from "./m6-helpers";

// Search's "Also search description notes" reads linked notes only while Search is shown: when the query or
// the toggle changes, when the set of tasks with notes or their paths changes, when a linked note changes
// in the vault (that note only), and once when Search is shown again. Results never use an earlier query's matches.
// Spec: App shell and views rule 24.

const mounted: CalMount[] = [];
afterEach(() => {
	for (const m of mounted.splice(0)) m.unmount();
});

/** Past the 300 ms typing delay and the scan that follows it. */
const afterDelay = async () => {
	await new Promise((r) => setTimeout(r, 350));
	await settle();
};

const resultTitles = (m: CalMount) => [...m.root.querySelectorAll(".cp-search .cp-task-row")].map((r) => r.textContent ?? "");
const searchBox = (m: CalMount) => m.root.querySelector<HTMLInputElement>('.cp-search-box input[type="search"]')!;

async function type(m: CalMount, text: string) {
	const box = searchBox(m);
	box.value = text;
	box.dispatchEvent(new Event("input", { bubbles: true }));
	await settle();
}

async function openSearch(m: CalMount) {
	await click(m.root.querySelector('.cp-rail [aria-label="Search"]'));
}
async function openTasks(m: CalMount) {
	await click(m.root.querySelector('.cp-rail [aria-label="Tasks"]'));
}

/** Alpha links a.md (has the needle), Beta links b.md (does not), Gamma has no note. Search is open with the toggle on. */
async function setup() {
	const m = await mountCal();
	mounted.push(m);
	m.h.notes.files.set("a.md", "text with the needle inside");
	m.h.notes.files.set("b.md", "other stuff");
	m.h.notes.files.set("c.md", "another needle");
	const alpha = (await m.h.app.tasks.create({ title: "Alpha", notePath: "a.md" })).task;
	const beta = (await m.h.app.tasks.create({ title: "Beta", notePath: "b.md" })).task;
	const gamma = (await m.h.app.tasks.create({ title: "Gamma" })).task;
	await openSearch(m);
	const toggle = m.root.querySelector<HTMLInputElement>('.cp-search-box input[type="checkbox"]')!;
	toggle.checked = true;
	toggle.dispatchEvent(new Event("change", { bubbles: true }));
	await settle();
	await type(m, "needle");
	await afterDelay();
	expect(resultTitles(m)).toEqual([expect.stringContaining("Alpha")]);
	m.h.notes.reads.length = 0;
	return { m, alpha, beta, gamma };
}

describe("issue 16: Search note reads", () => {
	it("a habit check-in, a list rename and a title edit read no note", async () => {
		const { m, alpha, gamma } = await setup();
		const cat = await m.h.app.categories.create("Home");
		const habit = await m.h.app.habits.create(habitInput({ name: "Walk" }));
		await m.h.app.habits.add(habit.id, "2026-10-01", 5);
		await m.h.app.categories.update(cat.id, { name: "House" });
		await m.h.app.tasks.update(gamma.id, { title: "Gamma 2" });
		await m.h.app.tasks.update(alpha.id, { title: "Alpha 2" });
		await afterDelay();
		expect(m.h.notes.reads).toEqual([]);
		expect(resultTitles(m)).toEqual([expect.stringContaining("Alpha 2")]);
	});

	it("a task that gets another note path reads the new path", async () => {
		const { m, beta } = await setup();
		await m.h.app.tasks.linkNote(beta.id, "c.md");
		await afterDelay();
		expect(m.h.notes.reads).toContain("c.md");
		expect(resultTitles(m).some((t) => t.includes("Beta"))).toBe(true);
	});

	it("a change of a linked note reads exactly that note and updates the match", async () => {
		const { m } = await setup();
		m.h.notes.files.set("b.md", "now with the needle");
		m.host.noteEvents.emit("note", "b.md");
		await settle();
		expect(m.h.notes.reads).toEqual(["b.md"]);
		expect(resultTitles(m).some((t) => t.includes("Beta"))).toBe(true);

		m.h.notes.files.set("a.md", "gone");
		m.host.noteEvents.emit("note", "a.md");
		await settle();
		expect(m.h.notes.reads).toEqual(["b.md", "a.md"]);
		expect(resultTitles(m).some((t) => t.includes("Alpha"))).toBe(false);
	});

	it("a change of a note no task links, or of the database file, reads nothing", async () => {
		const { m } = await setup();
		m.host.noteEvents.emit("note", "elsewhere.md");
		m.host.noteEvents.emit("note", "tasks.cpbase");
		await settle();
		expect(m.h.notes.reads).toEqual([]);
	});

	it("while another page is shown nothing is read; coming back does one scan", async () => {
		const { m, gamma } = await setup();
		await openTasks(m);
		await m.h.app.tasks.update(gamma.id, { title: "Gamma 2" });
		m.host.noteEvents.emit("note", "a.md");
		await m.h.app.tasks.linkNote(gamma.id, "c.md");
		await afterDelay();
		expect(m.h.notes.reads).toEqual([]);
		await openSearch(m);
		await afterDelay();
		expect([...m.h.notes.reads].sort()).toEqual(["a.md", "b.md", "c.md"]);
		m.h.notes.reads.length = 0;
		await openTasks(m);
		await openSearch(m);
		await afterDelay();
		expect(m.h.notes.reads.length).toBe(3);
	});

	it("a new query never shows the matches of the old one", async () => {
		const { m } = await setup();
		await type(m, "other");
		// Before the scan of the new query finishes, the old query's note matches are gone.
		expect(resultTitles(m)).toEqual([]);
		await afterDelay();
		expect(resultTitles(m)).toEqual([expect.stringContaining("Beta")]);
	});
});
