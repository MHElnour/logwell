import { describe, expect, it } from "vitest";
import type { TaskIndex } from "../../src/app/taskIndex";
import type { Change } from "../../src/app/tx";
import { type SidebarCounts, type TaskView, buildBoard, buildList, sidebarCounts } from "../../src/app/views";
import { DomainError } from "../../src/domain/errors";
import { groupByOptions } from "../../src/domain/groupBy";
import { type TaskFilter, type TaskSort, emptyFilter } from "../../src/domain/queries";
import { tagPrefixes } from "../../src/domain/tags";
import { addDays } from "../../src/domain/time";
import { type DateSpec, type ID, INBOX_ID, type Task } from "../../src/domain/types";
import type { JournalOp } from "../../src/persistence/journal";
import { type DbData, collectionsOf } from "../../src/persistence/schema";
import type { AppHarness } from "./harness";
import { seededRandom, seededState } from "./issue-41-seed";

// Issue 41: the task index (which tasks can be in each Tasks view, and the open counts) is kept up to date from the
// store's change events. A seeded run of service commands (every kind of task edit, completion, repeating
// completion, delete, restore, Undo, list, section and tag deletion, a reload, a replacement of all records, the
// next day, a save, a write that skips the store followed by a command) checks after every step that the index equals one built from the state, and that every view, grouping,
// sort and held set, the boards and the sidebar counts come out the same with the index as without it (the full
// scan). A run with one index update left out shows the check catches it.

const SORTS: TaskSort[] = ["manual", "date", "priority"];
const FILTERS: { filter: TaskFilter; text: string }[] = [
	{ filter: emptyFilter(), text: "" },
	{ filter: { ...emptyFilter("open"), date: "next7" }, text: "call" },
];
const DAY_MS = 24 * 60 * 60_000;

/** A stable text of a result: tasks by id. */
function serialize(value: unknown): string {
	return JSON.stringify(value, (_key, v: unknown) => {
		if (typeof v === "object" && v !== null && "sortKey" in v && "status" in v && "categoryId" in v && "id" in v) return `#${String(v.id)}`;
		if (v instanceof Map) return [...v].sort(([a], [b]) => (String(a) < String(b) ? -1 : 1));
		return v;
	});
}

const counted = (c: SidebarCounts) => serialize(c);

/** Every view of the state: Inbox, each list, Today, Upcoming, each tag (implicit parents too), Completed, Trash. */
function viewsOf(state: DbData): TaskView[] {
	const tags = new Set<string>(state.tags.keys());
	for (const t of state.tasks.values()) for (const k of t.tagKeys) for (const p of tagPrefixes(k)) tags.add(p);
	return [
		{ kind: "inbox" },
		...[...state.categories.keys()].filter((id) => id !== INBOX_ID).map((id) => ({ kind: "category" as const, id })),
		{ kind: "today" },
		{ kind: "upcoming" },
		...[...tags].sort().map((key) => ({ kind: "tag" as const, key })),
		{ kind: "completed" },
		{ kind: "trash" },
	];
}

/** Where the index and the full scan disagree for the store's current state (empty when they agree). */
function differences(h: AppHarness, index: TaskIndex, held: ReadonlySet<ID>): string[] {
	const state = h.app.store.state;
	const ctx = h.app.queryContext();
	const out = index.verify(state).map((d) => `index: ${d}`);
	if (counted(sidebarCounts(state, ctx, index)) !== counted(sidebarCounts(state, ctx))) out.push("sidebar counts");
	for (const view of viewsOf(state)) {
		const name = serialize(view);
		for (const sort of SORTS) {
			for (const f of FILTERS) {
				const filter = { ...f.filter, sort };
				for (const hs of [new Set<ID>(), held]) {
					for (const groupBy of [undefined, ...groupByOptions(view.kind)]) {
						const a = buildList(state, view, ctx, filter, f.text, hs, { groupBy, index });
						const b = buildList(state, view, ctx, filter, f.text, hs, { groupBy });
						if (serialize(a) !== serialize(b)) out.push(`${name} ${sort} ${f.text} ${hs.size} ${groupBy ?? "default"}`);
					}
					if (serialize(buildBoard(state, view, ctx, filter, f.text, hs, index)) !== serialize(buildBoard(state, view, ctx, filter, f.text, hs))) {
						out.push(`board ${name} ${sort} ${f.text} ${hs.size}`);
					}
				}
			}
		}
	}
	return out;
}

/** A command with nothing to act on (no open task to complete, nothing in the trash). */
class Skip extends Error {}

function need<T>(value: T | undefined): T {
	if (value === undefined) throw new Skip();
	return value;
}

interface Run {
	steps: number;
	/** The kinds of command that ran (and wrote), by name. */
	ran: Map<string, number>;
	/** The first step whose results differed, and how. */
	failure: { step: number; command: string; diffs: string[] } | null;
}

/**
 * `steps` seeded commands through the real services and store; the check after each. `tamper` replaces the index's
 * change handling, to show a missed update is caught.
 */
async function fuzz(seed: number, steps: number, tamper?: (index: TaskIndex) => void): Promise<Run> {
	const { h, held: seededHeld } = await seededState(seed, 120);
	const app = h.app;
	const index = app.tasks.lists;
	const rnd = seededRandom(seed * 7919);
	const pick = <T>(xs: readonly T[]): T | undefined => (xs.length === 0 ? undefined : xs[Math.floor(rnd() * xs.length)]);
	const tasks = () => [...app.store.state.tasks.values()];
	const task = () => pick(tasks());
	const lists = () => [...app.store.state.categories.keys()];
	const sectionsOf = (list: ID) => [...app.store.state.sections.values()].filter((s) => s.categoryId === list).map((s) => s.id);
	const tagKeys = () => [...app.store.state.tags.keys(), "garden/roses", "work/new"];
	const dateSpec = (): DateSpec | null => {
		const r = rnd();
		if (r < 0.3) return null;
		const date = addDays(app.queryContext().today, Math.floor(rnd() * 24) - 5);
		return r < 0.85 ? { kind: "date", date } : { kind: "datetime", local: `${date}T09:30`, tz: "Europe/Berlin" };
	};
	const trashed: ID[] = [];
	let snapshot: DbData | null = null;
	const commands: [string, () => Promise<unknown>][] = [
		[
			"create",
			async () => {
				const list = pick(lists()) ?? INBOX_ID;
				const parent = rnd() < 0.3 ? pick(tasks().filter((t) => t.parentId === null)) : undefined;
				return app.tasks.create({
					title: `${pick(["Call the bank", "Buy milk", "Pay rent", "Walk the dog"])} ${Math.floor(rnd() * 1000)}`,
					categoryId: parent?.categoryId ?? list,
					parentId: parent?.id ?? null,
					sectionId: parent === undefined ? (pick(sectionsOf(list)) ?? null) : undefined,
					tagKeys: rnd() < 0.5 ? [need(pick(tagKeys()))] : [],
					scheduled: dateSpec(),
					deadline: rnd() < 0.2 ? dateSpec() : null,
				});
			},
		],
		["title", async () => app.tasks.update(need(task()).id, { title: `Call the plumber ${Math.floor(rnd() * 100)}` })],
		["schedule", async () => app.tasks.update(need(task()).id, { scheduled: dateSpec() })],
		["deadline", async () => app.tasks.update(need(task()).id, { deadline: dateSpec() })],
		["list", async () => app.tasks.update(need(task()).id, { categoryId: need(pick(lists())) })],
		[
			"section",
			async () => {
				const t = need(task());
				return app.tasks.update(t.id, { sectionId: pick([...sectionsOf(t.categoryId), null]) ?? null });
			},
		],
		["parent", async () => app.tasks.setParent(need(task()).id, rnd() < 0.3 ? null : need(pick(tasks().filter((t) => t.parentId === null))).id)],
		["tags", async () => app.tasks.update(need(task()).id, { tagKeys: rnd() < 0.3 ? [] : [...new Set([need(pick(tagKeys())), need(pick(tagKeys()))])] })],
		["complete", async () => app.tasks.complete(need(pick(tasks().filter((t) => t.status === "open"))).id, { includeSubtasks: rnd() < 0.5 })],
		["reopen", async () => app.tasks.reopen(need(pick(tasks().filter((t) => t.status === "completed"))).id)],
		["repeat complete", async () => app.recurrence.complete(need(pick(tasks().filter((t) => t.recurrence !== null && t.status === "open"))).id)],
		[
			"repeat set",
			async () => {
				const t = need(pick(tasks().filter((x) => x.status === "open" && x.parentId === null)));
				const rule = { freq: "daily" as const, interval: 1 + Math.floor(rnd() * 3), weekdays: null, monthly: null, afterCompletion: false, time: null, tz: null };
				return app.recurrence.setRepeat(t.id, rnd() < 0.3 ? null : rule, app.queryContext().today);
			},
		],
		["delete", async () => trashed.push((await app.tasks.delete(need(task()).id)).batchId)],
		["restore", async () => app.tasks.restore(need(trashed.splice(Math.floor(rnd() * trashed.length), 1)[0]))],
		["undo", async () => app.store.undo()],
		["section delete", async () => app.sections.delete(need(pick([...app.store.state.sections.keys()])))],
		["list delete", async () => app.categories.delete(need(pick(lists().filter((id) => id !== INBOX_ID))))],
		["list create", async () => app.categories.create(`Home ${Math.floor(rnd() * 100)}`)],
		["tag delete", async () => app.tags.delete(need(pick([...app.store.state.tags.keys()])))],
		[
			"reload",
			async () => {
				// The file changed outside: persistence swaps the state, then the store says it reloaded.
				const data = h.store.data;
				const next = new Map(data.tasks);
				const ops: JournalOp[] = [];
				for (const t of tasks().slice(0, 3)) {
					const changed: Task = { ...t, title: `${t.title} (synced)`, scheduled: dateSpec(), tagKeys: t.tagKeys.slice(1) };
					next.set(t.id, changed);
					ops.push({ c: "tasks", id: t.id, v: changed });
				}
				const gone = pick(tasks());
				if (gone !== undefined && ![...next.values()].some((t) => t.parentId === gone.id)) {
					next.delete(gone.id);
					ops.push({ c: "tasks", id: gone.id, v: null });
				}
				h.store.commit({ ...data, tasks: next }, ops);
				app.store.notifyReloaded();
			},
		],
		[
			"replace all",
			async () => {
				const before = snapshot ?? app.store.state;
				snapshot = app.store.state;
				return app.store.replaceAll(collectionsOf(before), null);
			},
		],
		["next day", async () => h.clock.advance(DAY_MS)],
		// A save gives the state a new revision and keeps its task map.
		["save", async () => h.store.flush()],
		[
			"skip the store",
			async () => {
				// A write straight to persistence (no change event), then a command before any read.
				const data = h.store.data;
				const t = need(pick(tasks()));
				const changed: Task = { ...t, title: `${t.title} (outside)`, scheduled: rnd() < 0.5 ? null : { kind: "date", date: app.queryContext().today } };
				h.store.commit({ ...data, tasks: new Map(data.tasks).set(t.id, changed) }, [{ c: "tasks", id: t.id, v: changed }]);
				return app.tasks.create({ title: `Buy bread ${Math.floor(rnd() * 100)}` });
			},
		],
	];
	// Edits more often than the rare whole-state commands.
	const weights = new Map<string, number>([
		["reload", 0.3],
		["save", 0.5],
		["skip the store", 0.3],
		["replace all", 0.3],
		["next day", 0.3],
		["list delete", 0.3],
		["list create", 0.4],
		["tag delete", 0.3],
		["section delete", 0.3],
	]);
	const total = commands.reduce((n, [name]) => n + (weights.get(name) ?? 1), 0);
	const choose = (): [string, () => Promise<unknown>] => {
		let r = rnd() * total;
		for (const c of commands) {
			r -= weights.get(c[0]) ?? 1;
			if (r <= 0) return c;
		}
		return commands[0]!;
	};

	tamper?.(index);
	const run: Run = { steps: 0, ran: new Map(), failure: null };
	const check = (step: number, command: string): boolean => {
		const held = new Set<ID>([...seededHeld].filter((id) => app.store.state.tasks.has(id)));
		for (const t of tasks().slice(-3)) held.add(t.id);
		const diffs = differences(h, index, held);
		if (diffs.length > 0) run.failure = { step, command, diffs: diffs.slice(0, 5) };
		return diffs.length === 0;
	};
	if (!check(0, "seed")) return run;
	for (let step = 1; step <= steps; step++) {
		const [name, command] = choose();
		const state = app.store.state;
		const today = app.queryContext().today;
		const { drops, rebuilds } = index;
		try {
			await command();
		} catch (err) {
			// A command the services refuse (a task with subtasks made a subtask, an undo of a changed record), or nothing to act on.
			if (!(err instanceof DomainError) && !(err instanceof Skip)) throw err;
		}
		if (app.store.state !== state || app.queryContext().today !== today) run.ran.set(name, (run.ran.get(name) ?? 0) + 1);
		run.steps = step;
		if (!check(step, name)) return run;
		// Only a write that skipped the store puts the index out of step, and a save never rebuilds it.
		const unexpected =
			name === "skip the store"
				? index.drops === drops
					? "the index was patched over a write it never saw"
					: null
				: index.drops !== drops
					? "the index fell out of step"
					: name === "save" && index.rebuilds !== rebuilds
						? "a save rebuilt the index"
						: null;
		if (unexpected !== null) {
			run.failure = { step, command: name, diffs: [unexpected] };
			return run;
		}
	}
	return run;
}

describe("the task index (issue 41)", () => {
	it("stays equal to a fresh build, and every view and count reads the same with it as without, over 300 commands", async () => {
		const run = await fuzz(41, 300);
		const ran = Object.fromEntries([...run.ran].sort());
		if (process.env.CHECKPOINT_PERF_LOG) process.stderr.write(`issue-41 index fuzz: ${run.steps} steps, commands that wrote: ${JSON.stringify(ran)}\n`);
		expect(run.failure, JSON.stringify(ran)).toBeNull();
		expect(run.steps).toBe(300);
		// Every kind of command wrote at least once.
		for (const name of ["create", "title", "schedule", "deadline", "list", "section", "parent", "tags", "complete", "reopen", "repeat complete", "repeat set", "delete", "restore", "undo", "section delete", "list delete", "tag delete", "reload", "replace all", "next day", "save", "skip the store"]) {
			expect(run.ran.get(name) ?? 0, `${name} in ${JSON.stringify(ran)}`).toBeGreaterThan(0);
		}
	}, 300_000);

	it("catches an index that misses one kind of update", async () => {
		// Schedule edits never reach the index (it sees the old schedule): a task scheduled for today is missing from
		// Today's candidates.
		const skipSchedules = (index: TaskIndex) => {
			const target = index as unknown as { onChanged: (changes: readonly Change[] | undefined, base: DbData | undefined) => void };
			const original = target.onChanged.bind(index);
			const stale = (ch: Change): Change => {
				const before = ch.before as Task | undefined;
				const after = ch.after as Task | undefined;
				if (ch.c !== "tasks" || before === undefined || after === undefined) return ch;
				return { ...ch, after: { ...after, scheduled: before.scheduled } };
			};
			target.onChanged = (changes, base) => original(changes?.map(stale), base);
		};
		const run = await fuzz(41, 300, skipSchedules);
		if (process.env.CHECKPOINT_PERF_LOG) process.stderr.write(`issue-41 index fuzz with schedule edits skipped: caught at step ${run.failure?.step} (${run.failure?.command}): ${run.failure?.diffs.join("; ")}\n`);
		expect(run.failure).not.toBeNull();
		expect(run.failure!.diffs.some((d) => d.startsWith("index: dated"))).toBe(true);
		// Without the index's own check, the views and counts read with it differ from the full scan.
		const unchecked = await fuzz(41, 300, (index) => {
			skipSchedules(index);
			index.verify = () => [];
		});
		if (process.env.CHECKPOINT_PERF_LOG) process.stderr.write(`issue-41 same, views only: caught at step ${unchecked.failure?.step} (${unchecked.failure?.command}): ${unchecked.failure?.diffs.join("; ")}\n`);
		expect(unchecked.failure).not.toBeNull();
		expect(unchecked.failure!.diffs.some((d) => !d.startsWith("index:"))).toBe(true);
	}, 300_000);

	it("reads every task again after a write that bypassed the store, and only for the store's current state", async () => {
		const { h } = await seededState(7, 40);
		const index = h.app.tasks.lists;
		const ctx = h.app.queryContext();
		const today: TaskView = { kind: "today" };
		expect(buildList(h.app.store.state, today, ctx, emptyFilter(), "", undefined, { index })).toEqual(buildList(h.app.store.state, today, ctx, emptyFilter(), ""));
		const before = h.app.store.state;
		await h.app.tasks.create({ title: "Pay rent", scheduled: { kind: "date", date: ctx.today } });
		// An older state is not the one the index describes: no candidates, so the caller reads every task.
		expect(index.candidates(before, today)).toBeUndefined();
		expect(index.counts(before)).toBeUndefined();
		// A write straight to persistence, with no change event: the next read builds the index again.
		const data = h.store.data;
		const t = [...data.tasks.values()].find((x) => x.title === "Pay rent")!;
		const moved: Task = { ...t, scheduled: null };
		h.store.commit({ ...data, tasks: new Map(data.tasks).set(t.id, moved) }, [{ c: "tasks", id: t.id, v: moved }]);
		expect(index.candidates(h.app.store.state, today)?.some((x) => x.id === t.id)).toBe(false);
		expect(index.verify(h.app.store.state)).toEqual([]);
	});

	it("stays current through a save, which replaces the state but not its tasks", async () => {
		const { h } = await seededState(8, 40);
		const index = h.app.tasks.lists;
		const ctx = h.app.queryContext();
		const today: TaskView = { kind: "today" };
		buildList(h.app.store.state, today, ctx, emptyFilter(), "", undefined, { index });
		const open = [...h.app.store.state.tasks.values()].find((t) => t.status === "open" && t.recurrence === null)!;
		await h.app.tasks.complete(open.id);
		const edited = h.app.store.state;
		await h.store.flush();
		// The save gave the state a new revision: a new object, with the same tasks.
		expect(h.app.store.state).not.toBe(edited);
		expect(h.app.store.state.tasks).toBe(edited.tasks);
		const rebuilds = index.rebuilds;
		expect(buildList(h.app.store.state, today, ctx, emptyFilter(), "", undefined, { index })).toEqual(buildList(h.app.store.state, today, ctx, emptyFilter(), ""));
		expect(index.verify(h.app.store.state)).toEqual([]);
		expect(index.rebuilds).toBe(rebuilds);
	});

	it("is not patched over tasks written without a change event: the next command drops it", async () => {
		const { h } = await seededState(9, 40);
		const index = h.app.tasks.lists;
		const ctx = h.app.queryContext();
		const today: TaskView = { kind: "today" };
		const titles = () => buildList(h.app.store.state, today, ctx, emptyFilter(), "", undefined, { index }).groups.flatMap((g) => g.entries.map((e) => e.task.title));
		titles();
		// A write straight to persistence moves an undated task to today; then a command, before any read.
		const data = h.store.data;
		const t = [...data.tasks.values()].find((x) => x.status === "open" && x.scheduled === null && x.deadline === null && x.recurrence === null)!;
		const moved: Task = { ...t, title: "Water the plants today", scheduled: { kind: "date", date: ctx.today } };
		h.store.commit({ ...data, tasks: new Map(data.tasks).set(t.id, moved) }, [{ c: "tasks", id: t.id, v: moved }]);
		await h.app.tasks.create({ title: "Buy milk" });
		expect(titles()).toContain("Water the plants today");
		expect(index.verify(h.app.store.state)).toEqual([]);
	});
});
