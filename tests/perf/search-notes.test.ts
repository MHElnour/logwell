// @vitest-environment happy-dom
import { createElement, render } from "preact";
import { beforeAll, describe, expect, it } from "vitest";
import { linkedNotes } from "../../src/app/views";
import { emptyFilter } from "../../src/domain/queries";
import type { Task } from "../../src/domain/types";
import type { JournalOp } from "../../src/persistence/journal";
import type { UiHost } from "../../src/ui/host";
import { SearchSection, initialSearchState } from "../../src/ui/SearchSection";
import { appHarness } from "../app/harness";
import { makeTask } from "../persistence/fixtures";
import { input as habitInput } from "../ui/habits-helpers";
import { countBigPasses, elapsed, perfLog, tally } from "./measure";

// Search with "Also search description notes" on, 50,000 tasks of which 5,000 link a note. Commits that do not
// change which tasks link which notes (a habit check-in here) read no note at all, and finding the linked notes
// is one pass over the tasks (its time is logged, CHECKPOINT_PERF_LOG=1). Spec: App shell and views rule 24.

const TASKS = 50_000;
const LINKED = 5_000;
const COMMITS = 20;

beforeAll(() => {
	(HTMLElement.prototype as unknown as { empty: () => void }).empty = function (this: HTMLElement) {
		this.replaceChildren();
	};
});

const taskId = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

async function bigState() {
	const h = await appHarness();
	const data = h.store.data;
	const tasks = new Map(data.tasks);
	const ops: JournalOp[] = [];
	for (let i = 0; i < TASKS; i++) {
		const patch: Partial<Task> = { title: `Task ${i}`, sortKey: `V${i.toString(36).padStart(4, "0")}` };
		if (i < LINKED) {
			const path = `Notes/n${i}.md`;
			patch.descriptionNote = { path, linkedAt: "2026-10-01T09:00:00.000Z" };
			h.notes.files.set(path, `note ${i}`);
		}
		const t = makeTask(taskId(i + 1), patch);
		tasks.set(t.id, t);
		ops.push({ c: "tasks", id: t.id, v: t });
	}
	h.store.commit({ ...data, tasks }, ops);
	expect(h.app.store.state.tasks.size).toBe(TASKS);
	return h;
}

describe(`Search note reads at ${TASKS} tasks, ${LINKED} linked`, () => {
	it(`${COMMITS} commits that change no note link read no note`, async () => {
		const h = await bigState();
		const host = { app: h.app, setIcon: () => undefined, onNotesChanged: () => () => undefined } as unknown as UiHost;
		const container = document.createElement("div");
		document.body.appendChild(container);
		const ui = { ...initialSearchState(), query: "note 4", includeNotes: true, filter: emptyFilter("all") };
		const draw = () =>
			render(
				createElement(SearchSection, {
					host,
					state: h.app.store.state,
					ctx: h.app.queryContext(),
					ui,
					setUi: () => undefined,
					onOpenCategory: () => undefined,
					onOpenHabit: () => undefined,
					visible: true,
				}),
				container,
			);
		try {
			draw();
			await new Promise((r) => setTimeout(r, 400));
			await new Promise((r) => setTimeout(r, 0));
			// The first scan reads every linked note once.
			expect(h.notes.reads.length).toBeGreaterThan(0);
			h.notes.reads.length = 0;
			const habit = await h.app.habits.create(habitInput({ name: "Walk" }));
			for (let i = 0; i < COMMITS; i++) {
				await h.app.habits.add(habit.id, "2026-10-01", i + 1);
				draw();
			}
			await new Promise((r) => setTimeout(r, 400));
			expect(h.notes.reads).toEqual([]);
		} finally {
			render(null, container);
			container.remove();
		}
	}, 120_000);

	it("finding the linked notes is one pass over the tasks, and an unchanged result keeps its identity", async () => {
		const h = await bigState();
		const tasks = h.app.store.state.tasks;
		const ms = elapsed(() => linkedNotes(tasks));
		perfLog(`linkedNotes ${TASKS}/${LINKED}: ${ms.toFixed(1)} ms`);
		const { result: first, passes } = await countBigPasses(() => linkedNotes(tasks));
		expect(passes, tally(passes)).toHaveLength(1);
		expect(first.size).toBe(LINKED);
		expect(linkedNotes(new Map(tasks), first)).toBe(first);
	});
});
