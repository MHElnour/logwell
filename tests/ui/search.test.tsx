// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { type AppMount, click, mountApp, settle, typeInto } from "./app-helpers";
import { input as habitInput } from "./habits-helpers";

// Search's "Also search description notes" reads linked notes only while Search is shown: when the query or
// the toggle changes, when the set of tasks with notes or their paths changes, when a linked note changes
// in the vault (that note only), and once when Search is shown again. Results never use an earlier query's matches.


/** Past the 300 ms typing delay and the scan that follows it. */
const afterDelay = async () => {
	await new Promise((r) => setTimeout(r, 350));
	await settle();
};

const resultTitles = (m: AppMount) => [...m.root.querySelectorAll(".cp-search .cp-task-row")].map((r) => r.textContent ?? "");
const searchBox = (m: AppMount) => m.root.querySelector<HTMLInputElement>('.cp-search-box input[type="search"]')!;

const type = (m: AppMount, text: string) => typeInto(searchBox(m), text);

async function openSearch(m: AppMount) {
	await click(m.root.querySelector('.cp-rail [aria-label="Search"]'));
}
async function openTasks(m: AppMount) {
	await click(m.root.querySelector('.cp-rail [aria-label="Tasks"]'));
}

/** Makes every note read wait until it is released, so a scan can be held half way. Reads are still recorded in `reads`. */
function holdReads(m: AppMount) {
	const notes = m.h.notes;
	const waiting: (() => void)[] = [];
	let holding = true;
	notes.read = async (path: string) => {
		notes.reads.push(path);
		if (holding) await new Promise<void>((resolve) => waiting.push(resolve));
		return notes.files.get(path) ?? null;
	};
	return {
		get waiting() {
			return waiting.length;
		},
		/** Lets the oldest waiting read finish. */
		async releaseOne() {
			waiting.shift()?.();
			await settle();
		},
		/** Lets every read finish, also the ones that start after a release. */
		async releaseAll() {
			holding = false;
			for (const r of waiting.splice(0)) r();
			await settle();
		},
	};
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Alpha links a.md (has the needle), Beta links b.md (does not), Gamma has no note. Search is open with the toggle on. */
async function setup() {
	const m = await mountApp();
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

describe("#16: Search note reads", () => {
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

	it("a task that gets another note path causes one full scan of the new set, and no scan after an unrelated commit", async () => {
		const { m, beta, gamma } = await setup();
		await m.h.app.tasks.linkNote(beta.id, "c.md");
		await afterDelay();
		expect([...m.h.notes.reads].sort()).toEqual(["a.md", "c.md"]);
		expect(resultTitles(m).some((t) => t.includes("Beta"))).toBe(true);
		m.h.notes.reads.length = 0;
		await m.h.app.tasks.update(gamma.id, { title: "Gamma 2" });
		await afterDelay();
		expect(m.h.notes.reads).toEqual([]);
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

	it("a change of a note no task links, or of the database file, reads nothing; a linked one reads exactly that note", async () => {
		const { m, gamma } = await setup();
		m.host.noteEvents.emit("note", "elsewhere.md");
		m.host.noteEvents.emit("note", "tasks.cpbase");
		await settle();
		expect(m.h.notes.reads).toEqual([]);
		m.host.noteEvents.emit("note", "a.md");
		await settle();
		expect(m.h.notes.reads).toEqual(["a.md"]);
		await m.h.app.tasks.update(gamma.id, { title: "Gamma 2" });
		await afterDelay();
		expect(m.h.notes.reads).toEqual(["a.md"]);
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

	it("a note event before the scan starts changes nothing; a burst during the scan does not restart it, and the note is read once afterwards", async () => {
		const { m } = await setup();
		const held = holdReads(m);
		await type(m, "stuff");
		m.host.noteEvents.emit("note", "b.md");
		await sleep(100);
		// The scan has not started; it reads that note anyway.
		expect(m.h.notes.reads).toEqual([]);
		await sleep(300);
		await settle();
		expect(m.h.notes.reads).toEqual(["a.md"]);
		for (let i = 0; i < 10; i++) m.host.noteEvents.emit("note", "b.md");
		await sleep(400);
		await settle();
		// A restarted scan would have read a.md again.
		expect(m.h.notes.reads).toEqual(["a.md"]);
		await held.releaseOne();
		expect(m.h.notes.reads).toEqual(["a.md", "b.md"]);
		await held.releaseOne();
		// The scan is done; the note that changed meanwhile is read again, once.
		expect(m.h.notes.reads).toEqual(["a.md", "b.md", "b.md"]);
		await held.releaseAll();
		expect(m.h.notes.reads).toEqual(["a.md", "b.md", "b.md"]);
		expect(resultTitles(m)).toEqual([expect.stringContaining("Beta")]);
	});

	it("leaving Search or closing the app with a scan in flight stops the reads and shows nothing from it", async () => {
		const { m } = await setup();
		const held = holdReads(m);
		await type(m, "stuff");
		await sleep(350);
		expect(m.h.notes.reads).toEqual(["a.md"]);
		await openTasks(m);
		await held.releaseAll();
		await sleep(50);
		expect(m.h.notes.reads).toEqual(["a.md"]);
		expect(resultTitles(m).some((t) => t.includes("Beta"))).toBe(false);

		await openSearch(m);
		await sleep(350);
		await settle();
		expect(m.h.notes.reads.length).toBeGreaterThan(1);
		const held2 = holdReads(m);
		await type(m, "needle");
		await sleep(350);
		const before = m.h.notes.reads.length;
		m.unmount();
		await held2.releaseAll();
		await sleep(50);
		expect(m.h.notes.reads.length).toBe(before);
	});

	it("a newer scan stops an older one, whose result is never shown", async () => {
		const { m } = await setup();
		const held = holdReads(m);
		await type(m, "stuff");
		await sleep(350);
		expect(m.h.notes.reads).toEqual(["a.md"]);
		await type(m, "needle");
		await held.releaseOne();
		// The older scan stops after the read in flight: b.md is not read, and Beta is not shown.
		expect(m.h.notes.reads).toEqual(["a.md"]);
		expect(resultTitles(m).some((t) => t.includes("Beta"))).toBe(false);
		await sleep(350);
		expect(m.h.notes.reads).toEqual(["a.md", "a.md"]);
		await held.releaseAll();
		expect(m.h.notes.reads).toEqual(["a.md", "a.md", "b.md"]);
		expect(resultTitles(m)).toEqual([expect.stringContaining("Alpha")]);
	});

	it("a renamed note: its old path is read once, the new path is read by the full scan", async () => {
		const { m } = await setup();
		m.h.notes.files.delete("b.md");
		m.h.notes.files.set("d.md", "moved, with the needle");
		m.host.noteEvents.emit("note", "b.md");
		m.host.noteEvents.emit("note", "d.md");
		await m.h.app.noteRenames.rewriteNotePaths("b.md", "d.md", false);
		await afterDelay();
		expect(m.h.notes.reads).toContain("d.md");
		expect(resultTitles(m).some((t) => t.includes("Beta"))).toBe(true);
	});

	it("a read error is reported once per scan", async () => {
		const { m } = await setup();
		m.h.notes.read = async () => {
			throw new Error("disk gone");
		};
		await type(m, "stuff");
		await afterDelay();
		expect(m.host.messages.filter((x) => x === "disk gone")).toHaveLength(1);
	});
});
