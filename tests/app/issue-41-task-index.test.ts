import { describe, expect, it } from "vitest";
import { FEED_LIMIT } from "../../src/app/store";
import type { TaskIndex } from "../../src/app/taskIndex";
import type { Change } from "../../src/app/tx";
import { type SidebarCounts, type TaskView, buildBoard, buildList, sidebarCounts } from "../../src/app/views";
import { DomainError } from "../../src/domain/errors";
import { groupByOptions } from "../../src/domain/groupBy";
import { type TaskFilter, type TaskSort, emptyFilter } from "../../src/domain/queries";
import { tagPrefixes } from "../../src/domain/tags";
import { type SubtaskCount, compareTasksBySortKey, subtaskCounts } from "../../src/domain/tasks";
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
// sort and held set, the boards, the sidebar counts and the subtask counts come out the same with the index as
// without it (the full scan). It also checks that a parent whose subtask counts did not move keeps its count object
// (rows compare them), and that the store's `changesSince` lists exactly the changes its events carried, or nothing
// across a reload or a replacement. A run with one index update left out shows the check catches it.

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

/** A list's task ids as the index's candidates give them: its tasks in sort order. */
function indexOrder(index: TaskIndex, state: DbData, listId: ID): ID[] {
	const view: TaskView = listId === INBOX_ID ? { kind: "inbox" } : { kind: "category", id: listId };
	return (index.candidates(state, view) ?? []).map((t) => t.id);
}

/** The index's built orders, by list (a test reaches into it; the index itself only exposes candidates). */
function builtOrders(index: TaskIndex): Map<ID, Task[]> {
	return (index as unknown as { parts: { order: Map<ID, Task[]> } }).parts.order;
}

/** Where the index and the full scan disagree for the store's current state (empty when they agree). */
function differences(h: AppHarness, index: TaskIndex, held: ReadonlySet<ID>): string[] {
	const state = h.app.store.state;
	const ctx = h.app.queryContext();
	const out = index.verify(state).map((d) => `index: ${d}`);
	// Each list's ids in sort order equal a fresh sort of its tasks (Inbox, every list, and an id that is no list).
	for (const listId of new Set<ID>([INBOX_ID, ...state.categories.keys()])) {
		const fresh = [...state.tasks.values()].filter((t) => t.categoryId === listId).sort(compareTasksBySortKey).map((t) => t.id);
		if (indexOrder(index, state, listId).join() !== fresh.join()) out.push(`order of ${listId}`);
	}
	if (counted(sidebarCounts(state, ctx, index)) !== counted(sidebarCounts(state, ctx))) out.push("sidebar counts");
	if (serialize(index.subtaskCounts()) !== serialize(subtaskCounts(state.tasks.values()))) out.push("subtask counts");
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
		[
			"move",
			async () => {
				// A drop among the siblings of a list (a new sort key inside the same list, sometimes new keys for all of them).
				const t = need(task());
				const siblings = tasks()
					.filter((s) => s.categoryId === t.categoryId && s.parentId === t.parentId && s.id !== t.id)
					.sort(compareTasksBySortKey)
					.map((s) => s.id);
				siblings.splice(Math.floor(rnd() * (siblings.length + 1)), 0, t.id);
				return app.tasks.place(t.id, siblings);
			},
		],
		["parent", async () =>app.tasks.setParent(need(task()).id, rnd() < 0.3 ? null : need(pick(tasks().filter((t) => t.parentId === null))).id)],
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
	// Every change event, in order: what `changesSince` must list.
	const events: (readonly Change[] | undefined)[] = [];
	app.store.bus.on("changed", (e) => events.push(e.changes));
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
		const version = app.store.version;
		const seen = events.length;
		const counts = index.subtaskCounts();
		// What the handed-out map holds now: it must still hold exactly this after the command.
		const handedOut = [...counts].map(([id, c]) => [id, c.total, c.done] as const);
		try {
			await command();
		} catch (err) {
			// A command the services refuse (a task with subtasks made a subtask, an undo of a changed record), or nothing to act on.
			if (!(err instanceof DomainError) && !(err instanceof Skip)) throw err;
		}
		if (app.store.state !== state || app.queryContext().today !== today) run.ran.set(name, (run.ran.get(name) ?? 0) + 1);
		run.steps = step;
		if (!check(step, name)) return run;
		const feed = feedProblem(app.store.changesSince(version), events.slice(seen), app.store.version - version);
		const kept = untouchedProblem(counts, handedOut) ?? (index.rebuilds === rebuilds ? keptProblem(counts, index.subtaskCounts()) : null);
		if (feed !== null || kept !== null) {
			run.failure = { step, command: name, diffs: [feed ?? kept ?? ""] };
			return run;
		}
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

/** What is wrong with `changesSince` after `events`, which raised the version by `raised` (null when nothing). */
function feedProblem(since: readonly Change[] | undefined, events: readonly (readonly Change[] | undefined)[], raised: number): string | null {
	if (raised !== events.length) return `version raised by ${raised} for ${events.length} events`;
	if (events.some((e) => e === undefined)) return since === undefined ? null : "changesSince listed changes across a reload";
	const all = events.flatMap((e) => e ?? []);
	if (since === undefined) return "changesSince gave nothing for changes it holds";
	if (since.length !== all.length || since.some((ch, i) => ch !== all[i])) return "changesSince differs from the events";
	return null;
}

/** A subtask count map once handed out must never change (null when it did not). */
function untouchedProblem(map: ReadonlyMap<ID, SubtaskCount>, held: readonly (readonly [ID, number, number])[]): string | null {
	if (map.size !== held.length) return `a handed-out subtask count map changed size: ${held.length} to ${map.size}`;
	for (const [id, total, done] of held) {
		const c = map.get(id);
		if (c?.total !== total || c?.done !== done) return `a handed-out subtask count map changed for ${id}`;
	}
	return null;
}

/** A parent whose counts did not move must keep its object, and the map its identity when none moved (null when so). */
function keptProblem(prev: ReadonlyMap<ID, SubtaskCount>, next: ReadonlyMap<ID, SubtaskCount>): string | null {
	let moved = prev.size !== next.size;
	for (const [id, c] of next) {
		const old = prev.get(id);
		if (old === undefined) moved = true;
		else if (old.total === c.total && old.done === c.done) {
			if (old !== c) return `subtask counts of ${id} did not move but are a new object`;
		} else {
			if (old === c) return `subtask counts of ${id} moved in place`;
			moved = true;
		}
	}
	if (!moved && prev !== next) return "no subtask count moved but the map is new";
	return null;
}

describe("the task index (issue 41)", () => {
	it("stays equal to a fresh build, and every view and count reads the same with it as without, over 300 commands", async () => {
		const run = await fuzz(41, 300);
		const ran = Object.fromEntries([...run.ran].sort());
		if (process.env.CHECKPOINT_PERF_LOG) process.stderr.write(`issue-41 index fuzz: ${run.steps} steps, commands that wrote: ${JSON.stringify(ran)}\n`);
		expect(run.failure, JSON.stringify(ran)).toBeNull();
		expect(run.steps).toBe(300);
		// Every kind of command wrote at least once.
		for (const name of ["create", "title", "schedule", "deadline", "list", "section", "move", "parent", "tags", "complete", "reopen", "repeat complete", "repeat set", "delete", "restore", "undo", "section delete", "list delete", "tag delete", "reload", "replace all", "next day", "save", "skip the store"]) {
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

	it("catches an index that does not put a task in its new place when its sort key changes", async () => {
		// The index sees every task with its old sort key: a moved task stays where it was in its list's order.
		const keepSortKeys = (index: TaskIndex) => {
			const target = index as unknown as { onChanged: (changes: readonly Change[] | undefined, base: DbData | undefined) => void };
			const original = target.onChanged.bind(index);
			const stale = (ch: Change): Change => {
				const before = ch.before as Task | undefined;
				const after = ch.after as Task | undefined;
				if (ch.c !== "tasks" || before === undefined || after === undefined) return ch;
				return { ...ch, after: { ...after, sortKey: before.sortKey } };
			};
			target.onChanged = (changes, base) => original(changes?.map(stale), base);
		};
		const run = await fuzz(41, 300, keepSortKeys);
		if (process.env.CHECKPOINT_PERF_LOG) process.stderr.write(`issue-41 index fuzz with sort key changes skipped: caught at step ${run.failure?.step} (${run.failure?.command}): ${run.failure?.diffs.slice(0, 4).join("; ")}\n`);
		expect(run.failure).not.toBeNull();
		expect(run.failure!.diffs.some((d) => d.startsWith("order of"))).toBe(true);
		// The rows built from the stale order differ from the full scan's too, not only the order itself: the Inbox
		// with its first top-level task dropped last.
		const { h } = await seededState(41, 40);
		const index = h.app.tasks.lists;
		keepSortKeys(index);
		const inbox: TaskView = { kind: "inbox" };
		const build = (withIndex: boolean) => buildList(h.app.store.state, inbox, h.app.queryContext(), emptyFilter(), "", undefined, withIndex ? { index } : {});
		expect(serialize(build(true))).toBe(serialize(build(false)));
		const tops = indexOrder(index, h.app.store.state, INBOX_ID).filter((id) => h.app.store.state.tasks.get(id)?.parentId === null);
		await h.app.tasks.place(tops[0] as ID, [...tops.slice(1), tops[0] as ID]);
		expect(serialize(build(true))).not.toBe(serialize(build(false)));
	}, 300_000);

	it("moves a task in a built order for a small change, and sorts a list again after a bulk change", async () => {
		const { h } = await seededState(41, 40);
		const index = h.app.tasks.lists;
		const state = () => h.app.store.state;
		const big = (await h.app.categories.create("Big")).id;
		for (let i = 0; i < 100; i++) await h.app.tasks.create({ title: `Bulk ${i}`, categoryId: big });
		const sorted = (listId: ID) =>
			[...state().tasks.values()]
				.filter((t) => t.categoryId === listId)
				.sort(compareTasksBySortKey)
				.map((t) => t.id);
		expect(indexOrder(index, state(), INBOX_ID)).toEqual(sorted(INBOX_ID));
		expect(indexOrder(index, state(), big)).toEqual(sorted(big));
		expect([...builtOrders(index).keys()].sort()).toEqual([big, INBOX_ID].sort());
		// A small change moves the task and keeps the order.
		await h.app.tasks.update(sorted(big)[0] as ID, { categoryId: INBOX_ID });
		expect(builtOrders(index).has(big) && builtOrders(index).has(INBOX_ID)).toBe(true);
		expect(index.verify(state())).toEqual([]);
		expect(indexOrder(index, state(), INBOX_ID)).toEqual(sorted(INBOX_ID));
		// Deleting the list moves its 99 tasks to the Inbox in one event: both orders are dropped and sorted again.
		await h.app.categories.delete(big);
		expect(builtOrders(index).has(INBOX_ID)).toBe(false);
		expect(index.verify(state())).toEqual([]);
		expect(indexOrder(index, state(), INBOX_ID)).toEqual(sorted(INBOX_ID));
		// Undo puts them back in one event again.
		await h.app.store.undo();
		expect(index.verify(state())).toEqual([]);
		expect(indexOrder(index, state(), big)).toEqual(sorted(big));
		expect(indexOrder(index, state(), INBOX_ID)).toEqual(sorted(INBOX_ID));
		expect(index.verify(state())).toEqual([]);
	}, 60_000);

	it("sorts a list again when its built order does not hold the task a change takes out", async () => {
		const { h } = await seededState(41, 40);
		const index = h.app.tasks.lists;
		const inbox = () => indexOrder(index, h.app.store.state, INBOX_ID);
		const tops = inbox().filter((id) => h.app.store.state.tasks.get(id)?.parentId === null);
		expect(tops.length).toBeGreaterThan(2);
		// Damage the order: the task about to be dropped at the end of the Inbox is missing from it.
		const moved = tops[0] as ID;
		const order = builtOrders(index).get(INBOX_ID)!;
		order.splice(
			order.findIndex((t) => t.id === moved),
			1,
		);
		await h.app.tasks.place(moved, [...tops.slice(1), moved]);
		const fresh = [...h.app.store.state.tasks.values()]
			.filter((t) => t.categoryId === INBOX_ID)
			.sort(compareTasksBySortKey)
			.map((t) => t.id);
		expect(builtOrders(index).has(INBOX_ID)).toBe(false);
		expect(inbox()).toEqual(fresh);
		expect(index.verify(h.app.store.state)).toEqual([]);
	});

	it("catches subtask counts that miss a change of parent", async () => {
		// Parent changes never reach the counts (the index sees the old parent).
		const skipParents = (index: TaskIndex) => {
			const target = index as unknown as { onChanged: (changes: readonly Change[] | undefined, base: DbData | undefined) => void };
			const original = target.onChanged.bind(index);
			const stale = (ch: Change): Change => {
				const before = ch.before as Task | undefined;
				const after = ch.after as Task | undefined;
				if (ch.c !== "tasks" || before === undefined || after === undefined) return ch;
				return { ...ch, after: { ...after, parentId: before.parentId } };
			};
			target.onChanged = (changes, base) => original(changes?.map(stale), base);
		};
		const run = await fuzz(41, 300, skipParents);
		if (process.env.CHECKPOINT_PERF_LOG) process.stderr.write(`issue-41 index fuzz with parent changes skipped: caught at step ${run.failure?.step} (${run.failure?.command}): ${run.failure?.diffs.join("; ")}\n`);
		expect(run.failure).not.toBeNull();
		expect(run.failure!.diffs.some((d) => d.startsWith("index: subtasks"))).toBe(true);
		expect(run.failure!.diffs).toContain("subtask counts");
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

describe("the store's change feed (issue 41)", () => {
	it(`lists the changes of the last ${FEED_LIMIT} events, and nothing past them or across a reload`, async () => {
		const { h } = await seededState(7, 40);
		const store = h.app.store;
		const t = (await h.app.tasks.create({ title: "Call the bank" })).task;
		const start = store.version;
		expect(store.changesSince(start)).toEqual([]);
		const seen: Change[] = [];
		store.bus.on("changed", (e) => seen.push(...(e.changes ?? [])));
		for (let i = 0; i < FEED_LIMIT + 6; i++) await h.app.tasks.update(t.id, { title: `Call the bank ${i}` });
		expect(store.version).toBe(start + FEED_LIMIT + 6);
		// The last 64 events, oldest first, the records themselves.
		const last = store.changesSince(store.version - FEED_LIMIT)!;
		expect(last).toHaveLength(seen.slice(-FEED_LIMIT).length);
		last.forEach((ch, i) => expect(ch).toBe(seen.slice(-FEED_LIMIT)[i]));
		expect(store.changesSince(store.version - FEED_LIMIT - 1)).toBeUndefined();
		expect(store.changesSince(start)).toBeUndefined();
		expect(store.changesSince(store.version + 1)).toBeUndefined();
		// A reload in between: nothing, never a partial list; after it, the changes again.
		const before = store.version;
		await h.app.tasks.update(t.id, { title: "Pay rent" });
		store.notifyReloaded();
		await h.app.tasks.update(t.id, { title: "Buy milk" });
		expect(store.changesSince(before)).toBeUndefined();
		expect(store.changesSince(before + 1)).toBeUndefined();
		expect(store.changesSince(before + 2)?.map((ch) => (ch.after as Task).title)).toEqual(["Buy milk"]);
		// A replacement of all records likewise.
		const v = store.version;
		await store.replaceAll(collectionsOf(store.state), null);
		expect(store.changesSince(v)).toBeUndefined();
		expect(store.changesSince(store.version)).toEqual([]);
	});
});
