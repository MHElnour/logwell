import { describe, expect, it } from "vitest";
import { FEED_LIMIT } from "../../src/app/store";
import type { TaskIndex } from "../../src/app/taskIndex";
import type { Change } from "../../src/app/tx";
import { buildBoard, buildList, calendarTasks, menuTasks, type SidebarCounts, sidebarCounts, type TaskView, unscheduledRows, unscheduledTasks } from "../../src/app/views";
import { type CalendarContext, layoutMonth, layoutWeek, monthGrid, weekDays } from "../../src/domain/calendar";
import { DomainError } from "../../src/domain/errors";
import { groupByOptions } from "../../src/domain/groupBy";
import { matrixQuadrants } from "../../src/domain/matrix";
import { emptyFilter, entryOf, filterTasks, type QueryContext, type TaskFilter, type TaskSort } from "../../src/domain/queries";
import { indexOccurrenceRecords } from "../../src/domain/recurrence";
import { tagPrefixes } from "../../src/domain/tags";
import { compareTasksBySortKey, type SubtaskCount, subtaskCounts } from "../../src/domain/tasks";
import { addDays } from "../../src/domain/time";
import { type DateSpec, type ID, INBOX_ID, type Task } from "../../src/domain/types";
import type { JournalOp } from "../../src/persistence/journal";
import { collectionsOf, type DbData } from "../../src/persistence/schema";
import { type AppHarness, appHarness } from "./harness";
import { seededRandom, seededState } from "./task-index-seed";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

describe("the task index", () => {
	// Issue 41: the task index (which tasks can be in each Tasks view, and the open counts) is kept up to date from the
	// store's change events. A seeded run of service commands (every kind of task edit, completion, repeating
	// completion, delete, restore, Undo, list, section and tag deletion, a reload, a replacement of all records, the
	// next day, a save, a write that skips the store followed by a command) checks after every step that the index equals one built from the state, and that each list's
	// order, the sidebar counts and the subtask counts come out the same with the index as without it (the full scan).
	// Every view, grouping, sort and held set, the boards, the calendar and the matrix are compared every 10th step, on
	// the last step and on a step that fails. It also checks that a parent whose subtask counts did not move keeps its
	// count object (rows compare them), and that the store's `changesSince` lists exactly the changes its events carried,
	// or nothing across a reload or a replacement.
	// Runs with one index update left out show the check catches it. They test the check, not Logwell, and take about
	// 6 s: CHECKPOINT_TAMPER_CHECKS=1 runs them; do that after changing the fuzz, its checks or the index's `verify`.

	const TAMPER = Boolean(process.env.CHECKPOINT_TAMPER_CHECKS);
	/** How often the fuzz compares every view with the full scan (the index, the orders and the counts: every step). */
	const VIEWS_EVERY = 10;

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

	/** Every view of the state: Inbox, each list, Today, Upcoming, each tag and every path prefix of a task's tags, Completed, Trash. */
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

	/**
	 * The view menus of the calendar and the matrix: the defaults (open; all), completed only, lists (the Inbox and one
	 * more), tags (any of two, all of two), and lists with tags.
	 */
	function menuFilters(state: DbData): TaskFilter[] {
		const list = [...state.categories.keys()].find((id) => id !== INBOX_ID);
		const lists = list === undefined ? [INBOX_ID] : [INBOX_ID, list];
		return [
			emptyFilter("open"),
			emptyFilter("all"),
			emptyFilter("completed"),
			{ ...emptyFilter("open"), categoryIds: lists },
			{ ...emptyFilter("all"), tagKeys: ["work", "home"] },
			{ ...emptyFilter("open"), tagKeys: ["work", "work/meetings"], tagMode: "all" },
			{ ...emptyFilter("all"), categoryIds: lists.slice(1), tagKeys: ["errands", "garden/roses"] },
		];
	}

	const ids = (tasks: readonly Task[]) => tasks.map((t) => t.id).sort();

	/**
	 * Where the calendar and the matrix built from the index disagree with what they built before it: every task through
	 * the view menu (`filterTasks` over the task map), placed by the same layouts, the Unscheduled drawer as it was made.
	 */
	function menuViewDifferences(state: DbData, ctx: QueryContext, index: TaskIndex, held: ReadonlySet<ID>, now: string): string[] {
		const out: string[] = [];
		const records = indexOccurrenceRecords(state.occurrenceRecords);
		const calCtx: CalendarContext = { zone: ctx.zone, today: ctx.today, now, weekStart: ctx.weekStart, records };
		const week = weekDays(ctx.today, ctx.weekStart);
		const nextWeek = weekDays(addDays(ctx.today, 7), ctx.weekStart);
		const grid = monthGrid(ctx.today, ctx.weekStart);
		const month = ctx.today.slice(0, 7);
		for (const filter of menuFilters(state)) {
			const name = serialize({ ...filter, sort: undefined });
			// Before the index: the calendar passed every task through the menu to the layouts.
			const before = filterTasks(state.tasks.values(), filter, "", ctx);
			const cal = calendarTasks(state, ctx, filter, index);
			const scan = calendarTasks(state, ctx, filter);
			if (ids(cal.dated).join() !== ids(scan.dated).join()) out.push(`calendar dated ${name}`);
			for (const days of [week, nextWeek]) {
				if (serialize(layoutWeek(cal.dated, days, calCtx)) !== serialize(layoutWeek(before, days, calCtx))) out.push(`calendar week of ${days[0]} ${name}`);
			}
			if (serialize(layoutMonth(cal.dated, grid, month, calCtx)) !== serialize(layoutMonth(before, grid, month, calCtx))) out.push(`calendar month ${name}`);
			// Before the index: the drawer's rows were the open tasks without a schedule or repeat rule, sorted; the count theirs.
			const drawer = (tasks: readonly Task[]) => [...tasks].sort(compareTasksBySortKey).map((t) => entryOf(t, state.tasks, ctx));
			const drawerBefore = drawer(before.filter((t) => t.scheduled === null && t.recurrence === null && t.status === "open"));
			const unscheduled = unscheduledTasks(state, ctx, filter, index);
			if (ids(unscheduled).join() !== ids(unscheduledTasks(state, ctx, filter)).join()) out.push(`calendar unscheduled ${name}`);
			if (serialize(drawer(unscheduled)) !== serialize(drawerBefore)) out.push(`calendar unscheduled drawer ${name}`);
			if (serialize(unscheduledRows(state, ctx, filter, index)) !== serialize(drawerBefore)) out.push(`calendar unscheduled rows ${name}`);
			if (cal.unscheduledCount !== drawerBefore.length || scan.unscheduledCount !== drawerBefore.length) out.push(`calendar unscheduled count ${name}: ${cal.unscheduledCount}, ${scan.unscheduledCount} ≠ ${drawerBefore.length}`);
			for (const hs of [new Set<ID>(), held]) {
				const matrix = matrixQuadrants(menuTasks(state, ctx, filter, { index }), state.tasks, ctx, hs);
				if (serialize(matrix) !== serialize(matrixQuadrants(before, state.tasks, ctx, hs))) out.push(`matrix ${name} ${hs.size}`);
			}
			for (const within of ["dated", "open"] as const) {
				if (ids(menuTasks(state, ctx, filter, { index, within })).join() !== ids(menuTasks(state, ctx, filter, { within })).join()) out.push(`menu tasks ${within} ${name}`);
			}
		}
		return out;
	}

	/**
	 * Where the index and the full scan disagree for the store's current state (empty when they agree): the index, each
	 * list's order and the counts always; every view only with `views`, or when one of those already differs.
	 */
	function differences(h: AppHarness, index: TaskIndex, held: () => ReadonlySet<ID>, views: boolean): string[] {
		const state = h.app.store.state;
		const ctx = h.app.queryContext();
		const checked = index.verify(state).map((d) => `index: ${d}`);
		const counts: string[] = [];
		// Each list's ids in sort order equal a fresh sort of its tasks (Inbox, every list, and an id that is no list).
		for (const listId of new Set<ID>([INBOX_ID, ...state.categories.keys()])) {
			const fresh = [...state.tasks.values()].filter((t) => t.categoryId === listId).sort(compareTasksBySortKey).map((t) => t.id);
			if (indexOrder(index, state, listId).join() !== fresh.join()) counts.push(`order of ${listId}`);
		}
		if (counted(sidebarCounts(state, ctx, index)) !== counted(sidebarCounts(state, ctx))) counts.push("sidebar counts");
		if (serialize(index.subtaskCounts()) !== serialize(subtaskCounts(state.tasks.values()))) counts.push("subtask counts");
		if (!views && checked.length === 0 && counts.length === 0) return [];
		const heldNow = held();
		const out = [...checked, ...menuViewDifferences(state, ctx, index, heldNow, h.app.clock.now().toISOString()), ...counts];
		for (const view of viewsOf(state)) {
			const name = serialize(view);
			for (const sort of SORTS) {
				for (const f of FILTERS) {
					const filter = { ...f.filter, sort };
					for (const hs of [new Set<ID>(), heldNow]) {
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
		// The view menus read the index's sets however many tasks they hold, so the fuzz checks them (by default a set
		// that holds most tasks is not read).
		index.candidatesMaxShare = 1;
		const rnd = seededRandom(seed * 7919);
		// The Eisenhower flags a title edit also sets: a stream of their own, so every other command stays as it was.
		const flagRnd = seededRandom(seed * 104_729);
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
			["title", async () => app.tasks.update(need(task()).id, { title: `Call the plumber ${Math.floor(rnd() * 100)}`, urgent: flagRnd() < 0.5, important: flagRnd() < 0.5 })],
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
			const held = () => {
				const out = new Set<ID>([...seededHeld].filter((id) => app.store.state.tasks.has(id)));
				for (const t of tasks().slice(-3)) out.add(t.id);
				return out;
			};
			const diffs = differences(h, index, held, step % VIEWS_EVERY === 0 || step === steps);
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

	describe("#41: the task index", () => {
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

		/** The index's change handling, given every task change with `field` as it was before (the index sees the old value). */
		const keepOld = (field: "scheduled" | "sortKey" | "parentId") => (index: TaskIndex) => {
			const target = index as unknown as { onChanged: (changes: readonly Change[] | undefined, base: DbData | undefined) => void };
			const original = target.onChanged.bind(index);
			const stale = (ch: Change): Change => {
				const before = ch.before as Task | undefined;
				const after = ch.after as Task | undefined;
				if (ch.c !== "tasks" || before === undefined || after === undefined) return ch;
				return { ...ch, after: { ...after, [field]: before[field] } };
			};
			target.onChanged = (changes, base) => original(changes?.map(stale), base);
		};

		/** A task that becomes open (created, reopened, restored) never reaches the index's open tasks. */
		const missOpened = (index: TaskIndex) => {
			const target = index as unknown as { onChanged: (changes: readonly Change[] | undefined, base: DbData | undefined) => void; parts: { openTasks: Set<ID> } };
			const original = target.onChanged.bind(index);
			target.onChanged = (changes, base) => {
				original(changes, base);
				for (const ch of changes ?? []) {
					if (ch.c === "tasks" && (ch.after as Task | undefined)?.status === "open" && (ch.before as Task | undefined)?.status !== "open") target.parts.openTasks.delete(ch.id);
				}
			};
		};

		interface Tamper {
			name: string;
			tamper: (index: TaskIndex) => void;
			/** What the step that catches it reports: each entry starts one of its differences. */
			caught: string[];
			/** Without the index's own check, a difference of the views or counts read with it (one must match). */
			unchecked?: (diff: string) => boolean;
			/** A check of the rows built with the tampered index. */
			rows?: (tamper: (index: TaskIndex) => void) => Promise<void>;
		}

		const TAMPERS: Tamper[] = [
			// A task scheduled for today is missing from Today's candidates.
			{ name: "an index that misses one kind of update (schedule edits)", tamper: keepOld("scheduled"), caught: ["index: dated"], unchecked: (d) => !d.startsWith("index:") },
			{ name: "open tasks the index does not list: the calendar and the matrix miss them", tamper: missOpened, caught: ["index: openTasks"], unchecked: (d) => d.startsWith("calendar") || d.startsWith("matrix") },
			{
				name: "an index that does not put a task in its new place when its sort key changes",
				tamper: keepOld("sortKey"),
				caught: ["order of"],
				// The rows built from the stale order differ from the full scan's too, not only the order itself: the Inbox
				// with its first top-level task dropped last.
				rows: async (tamper) => {
					const { h } = await seededState(41, 40);
					const index = h.app.tasks.lists;
					tamper(index);
					const inbox: TaskView = { kind: "inbox" };
					const build = (withIndex: boolean) => buildList(h.app.store.state, inbox, h.app.queryContext(), emptyFilter(), "", undefined, withIndex ? { index } : {});
					expect(serialize(build(true))).toBe(serialize(build(false)));
					const tops = indexOrder(index, h.app.store.state, INBOX_ID).filter((id) => h.app.store.state.tasks.get(id)?.parentId === null);
					await h.app.tasks.place(tops[0] as ID, [...tops.slice(1), tops[0] as ID]);
					expect(serialize(build(true))).not.toBe(serialize(build(false)));
				},
			},
			{ name: "subtask counts that miss a change of parent", tamper: keepOld("parentId"), caught: ["index: subtasks", "subtask counts"] },
		];

		it.runIf(TAMPER).each(TAMPERS)("catches $name", async ({ name, tamper, caught, unchecked, rows }) => {
			const run = await fuzz(41, 300, tamper);
			if (process.env.CHECKPOINT_PERF_LOG) process.stderr.write(`issue-41 index fuzz with ${name}: caught at step ${run.failure?.step} (${run.failure?.command}): ${run.failure?.diffs.join("; ")}\n`);
			expect(run.failure).not.toBeNull();
			for (const start of caught) expect(run.failure!.diffs.some((d) => d.startsWith(start)), start).toBe(true);
			if (unchecked !== undefined) {
				// Without the index's own check, the views and counts read with it differ from the full scan.
				const views = await fuzz(41, 300, (index) => {
					tamper(index);
					index.verify = () => [];
				});
				if (process.env.CHECKPOINT_PERF_LOG) process.stderr.write(`issue-41 same, views only: caught at step ${views.failure?.step} (${views.failure?.command}): ${views.failure?.diffs.join("; ")}\n`);
				expect(views.failure).not.toBeNull();
				expect(views.failure!.diffs.some(unchecked)).toBe(true);
			}
			await rows?.(tamper);
		}, 300_000);

		it("keeps each list's order through a small change, a bulk change and its Undo", async () => {
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
			// A small change: the task moves from one list to the other.
			await h.app.tasks.update(sorted(big)[0] as ID, { categoryId: INBOX_ID });
			expect(index.verify(state())).toEqual([]);
			expect(indexOrder(index, state(), INBOX_ID)).toEqual(sorted(INBOX_ID));
			expect(indexOrder(index, state(), big)).toEqual(sorted(big));
			// Deleting the list moves its 99 tasks to the Inbox in one event.
			await h.app.categories.delete(big);
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

		it("gives a view menu the smallest set its lists, tags, status or subset allow, and none that holds most tasks", async () => {
			const h = await appHarness();
			const app = h.app;
			const index = app.tasks.lists;
			const work = (await app.categories.create("Work")).id;
			const make = async (title: string, extra: { categoryId?: ID; newTags?: string[]; scheduled?: DateSpec; done?: boolean } = {}) => {
				const t = (await app.tasks.create({ title, categoryId: extra.categoryId, newTags: extra.newTags, scheduled: extra.scheduled ?? null })).task;
				if (extra.done === true) await app.tasks.complete(t.id);
				return t.id;
			};
			const today: DateSpec = { kind: "date", date: app.queryContext().today };
			const call = await make("Call the bank", { categoryId: work, newTags: ["Home", "Errands"], scheduled: today });
			const milk = await make("Buy milk", { newTags: ["Errands"] });
			const rent = await make("Pay rent", { categoryId: work, newTags: ["Home"], done: true });
			const plants = await make("Water the plants", { done: true });
			const dentist = await make("Book the dentist", { done: true });
			const trip = await make("Plan the trip", { done: true });
			const state = app.store.state;
			const pick = (filter: Partial<TaskFilter>, within?: "dated" | "open") => index.filterCandidates(state, { ...emptyFilter(), ...filter }, within)?.map((t) => t.id).sort();
			const sorted = (...xs: ID[]) => [...xs].sort();
			// Nothing narrows: every task is read.
			expect(pick({})).toBeUndefined();
			// The open tasks (2 of 6); the completed ones are 4 of 6, more than half: every task is read.
			expect(pick({ status: "open" })).toEqual(sorted(call, milk));
			expect(pick({}, "open")).toEqual(sorted(call, milk));
			expect(pick({ status: "completed" })).toBeUndefined();
			// The dated task, the tasks of a list, of either tag (each once), of both tags (the smaller set).
			expect(pick({}, "dated")).toEqual([call]);
			expect(pick({ categoryIds: [work, work] })).toEqual(sorted(call, rent));
			expect(pick({ tagKeys: ["home", "errands"] })).toBeUndefined();
			expect(pick({ tagKeys: ["home"] })).toEqual(sorted(call, rent));
			expect(pick({ tagKeys: ["home", "errands"], tagMode: "all" })).toEqual(sorted(call, rent));
			// The smallest of several: the list (2) over the completed tasks (4); the dated task (1) over the list and the open tasks.
			expect(pick({ status: "completed", categoryIds: [work] })).toEqual(sorted(call, rent));
			expect(pick({ status: "open", categoryIds: [work] }, "dated")).toEqual([call]);
			// A list or tag without tasks: nothing to read.
			expect(pick({ categoryIds: ["no-such-list"] })).toEqual([]);
			expect(pick({ tagKeys: ["garden"], tagMode: "all" })).toEqual([]);
			// With no limit on the share, the completed tasks are read through their set.
			index.candidatesMaxShare = 1;
			expect(pick({ status: "completed" })).toEqual(sorted(rent, plants, dentist, trip));
			expect(pick({ tagKeys: ["home", "errands"] })).toEqual(sorted(call, milk, rent));
			// Another state than the store's: undefined, the caller reads every task.
			expect(index.filterCandidates({ ...state, tasks: new Map(state.tasks) }, emptyFilter("open"))).toBeUndefined();
		});

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

	describe("#41: the store's change feed", () => {
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
});

describe("buildList", () => {
	// Issue 41: the Tasks section builds a view's open rows and its Completed group with one `buildList`, reading only
	// the view's candidates from the task index. On the seeded state it must give exactly what it gives without the index
	// (every task read; pinned by the golden results in this file), and leaving the Completed group out changes no row.

	const SORTS: TaskSort[] = ["manual", "date", "priority"];
	const FILTERS: { filter: TaskFilter; text: string }[] = [
		{ filter: emptyFilter(), text: "" },
		{ filter: emptyFilter("open"), text: "" },
		{ filter: emptyFilter(), text: "call" },
		{ filter: { ...emptyFilter(), date: "next7" }, text: "" },
	];

	describe("#41: buildList", () => {
		it("gives the same rows and Completed group with the index as without, for every view, grouping, sort, filter and held set", async () => {
			const { h, lists, tagKeys, held } = await seededState();
			const state = h.app.store.state;
			const ctx = h.app.queryContext();
			const index = h.app.tasks.lists;
			const views: TaskView[] = [
				{ kind: "inbox" },
				...lists.map((id) => ({ kind: "category" as const, id })),
				{ kind: "today" },
				{ kind: "upcoming" },
				...tagKeys.map((key) => ({ kind: "tag" as const, key })),
				{ kind: "completed" },
				{ kind: "trash" },
			];
			let compared = 0;
			for (const view of views) {
				for (const sort of SORTS) {
					for (const f of FILTERS) {
						const filter = { ...f.filter, sort };
						for (const hs of [new Set<ID>(), held]) {
							for (const groupBy of [undefined, ...groupByOptions(view.kind)]) {
								const list = buildList(state, view, ctx, filter, f.text, hs, { groupBy });
								expect(buildList(state, view, ctx, filter, f.text, hs, { groupBy, index })).toEqual(list);
								expect(buildList(state, view, ctx, filter, f.text, hs, { groupBy, completed: false, index })).toEqual({ groups: list.groups, completed: [] });
								compared++;
							}
						}
					}
				}
			}
			expect(compared).toBeGreaterThan(500);
		}, 60_000);
	});
});

describe("golden results", () => {
	// Issue 41: the Tasks view's rows, Completed group and board, pinned to what they were before the views were
	// rebuilt from one pass. For a seeded state, every view (Inbox, each list, Today, Upcoming, each tag, Completed,
	// Trash) is built with every grouping, sort and a set of filters, with and without held (just completed) tasks,
	// and each result is compared by hash with `tests/fixtures/task-views.golden.json`.
	// CHECKPOINT_UPDATE_GOLDEN=1 rewrites the fixture; only do that on code whose output is known to be right.

	const FIXTURE = new URL("../fixtures/task-views.golden.json", import.meta.url);
	const UPDATE = Boolean(process.env.CHECKPOINT_UPDATE_GOLDEN);
	const SORTS: TaskSort[] = ["manual", "date", "priority"];

	const FILTERS: { name: string; filter: TaskFilter; text: string }[] = [
		{ name: "all", filter: emptyFilter(), text: "" },
		{ name: "open", filter: emptyFilter("open"), text: "" },
		{ name: "completed", filter: emptyFilter("completed"), text: "" },
		// Text and date filters pass some subtasks without their parent (and parents without some subtasks).
		{ name: "text", filter: emptyFilter(), text: "call" },
		{ name: "next7", filter: { ...emptyFilter(), date: "next7" }, text: "" },
		{ name: "priority", filter: { ...emptyFilter(), priorities: [1, 2] }, text: "" },
	];

	/** A stable text of a result: tasks by id, everything else as built. */
	function serialize(value: unknown): string {
		return JSON.stringify(value, (_key, v: unknown) => {
			if (typeof v === "object" && v !== null && "sortKey" in v && "status" in v && "categoryId" in v && "id" in v) return `#${String(v.id)}`;
			return v;
		});
	}

	const digest = (value: unknown, rows: number) => `${createHash("sha256").update(serialize(value)).digest("hex").slice(0, 16)}:${rows}`;

	describe("#41: Tasks views match the golden results", () => {
		it("builds every view, grouping, sort, filter and held set as before", async () => {
			const { h, lists, tagKeys, held } = await seededState();
			const state = h.app.store.state;
			const ctx = h.app.queryContext();
			const views: TaskView[] = [
				{ kind: "inbox" },
				...lists.map((id) => ({ kind: "category" as const, id })),
				{ kind: "today" },
				{ kind: "upcoming" },
				...tagKeys.map((key) => ({ kind: "tag" as const, key })),
				{ kind: "completed" },
				{ kind: "trash" },
			];
			const actual: Record<string, string> = {};
			for (const view of views) {
				const v = view.kind === "category" ? `list:${lists.indexOf(view.id)}` : view.kind === "tag" ? `tag:${view.key}` : view.kind;
				for (const sort of SORTS) {
					for (const f of FILTERS) {
						const filter = { ...f.filter, sort };
						for (const [heldName, hs] of [["none", new Set<ID>()], ["held", held]] as const) {
							const at = `${v}|${sort}|${f.name}|${heldName}`;
							for (const groupBy of [undefined, ...groupByOptions(view.kind)]) {
								const groups = buildList(state, view, ctx, filter, f.text, hs, { groupBy }).groups;
								actual[`view|${at}|${groupBy ?? "default"}`] = digest(groups, groups.reduce((n, g) => n + g.entries.length, 0));
							}
							const completed = buildList(state, view, ctx, filter, f.text, hs).completed;
							actual[`completed|${at}`] = digest(completed, completed.length);
							const board = buildBoard(state, view, ctx, filter, f.text, hs);
							actual[`board|${at}`] = digest(board, board.reduce((n, c) => n + c.cards.length + c.completed.length, 0));
						}
					}
				}
			}
			if (UPDATE) writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 1)}\n`);
			expect(existsSync(FIXTURE), "the golden fixture is missing").toBe(true);
			const expected = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, string>;
			// Not empty by accident: the seeded state fills the views.
			expect(Object.values(expected).filter((d) => !d.endsWith(":0")).length).toBeGreaterThan(Object.keys(expected).length / 2);
			const differing = Object.keys({ ...expected, ...actual }).filter((k) => expected[k] !== actual[k]);
			expect(differing).toEqual([]);
		}, 60_000);
	});
});
