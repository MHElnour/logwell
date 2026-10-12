import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type BlockQueryState, compileBlockQuery, runBlockQuery } from "../../src/domain/blockQuery";
import { emptyFilter, filterTasks, isDeadlineMissed, isScheduleMissed, type ListEntry, matchesTaskDate, quadrantOf, type QueryContext, type TaskFilter } from "../../src/domain/queries";
import { scheduleResolver } from "../../src/domain/recurrence";
import type { Category, DateSpec, ID, OccurrenceRecord, Priority, Section, Tag, Task, WeekStart } from "../../src/domain/types";
import { type BlockFilters, parseBlockQuery } from "../../src/parsing/blockQuery";
import { done, repeating, rule, series } from "./recurrence-fixtures";
import { blockOpenView } from "../../src/app/blockView";
import { resolveTagNames, TagNames } from "../../src/domain/tags";

describe("block matcher", () => {
	// The block matcher. 2026-10-14 is a Wednesday.

	const TODAY = "2026-10-14";
	const ZONE = "Europe/Berlin";
	const NOTE = "Projects/Plan.md";

	function ctxOf(weekStart: WeekStart = "MO", extra: Partial<QueryContext> = {}): QueryContext {
		return { today: TODAY, zone: ZONE, upcomingDays: 7, weekStart, ...extra };
	}

	const TS = "2026-09-01T09:00:00.000Z";

	function list(id: string, name: string): Category {
		return { id, name, icon: null, color: null, nameKey: name.toLowerCase(), isInbox: id === "inbox", sortKey: id, createdAt: TS, modifiedAt: TS };
	}
	function section(id: string, categoryId: string, name: string): Section {
		return { id, categoryId, name, nameKey: name.toLowerCase(), sortKey: id, createdAt: TS, modifiedAt: TS };
	}
	function tag(key: string, displayName = key): Tag {
		return { key, displayName, color: null, createdAt: TS, modifiedAt: TS };
	}
	function task(id: string, patch: Partial<Task> = {}): Task {
		return {
			id,
			title: `Task ${id}`,
			descriptionNote: null,
			categoryId: "inbox",
			tagKeys: [],
			parentId: null,
			sectionId: null,
			scheduled: null,
			deadline: null,
			plannedDurationMin: null,
			urgent: false,
			important: false,
			priority: 0,
			status: "open",
			completedAt: null,
			recurrence: null,
			sortKey: id,
			createdAt: TS,
			modifiedAt: TS,
			...patch,
		};
	}
	const day = (date: string): DateSpec => ({ kind: "date", date });
	const noteOf = (path: string) => ({ path, linkedAt: TS });

	interface Fixture {
		tasks?: Task[];
		lists?: Category[];
		sections?: Section[];
		tags?: Tag[];
		records?: OccurrenceRecord[];
	}

	function stateOf(f: Fixture = {}): BlockQueryState & { occurrenceRecords: ReadonlyMap<string, OccurrenceRecord> } {
		return {
			tasks: new Map((f.tasks ?? []).map((t) => [t.id, t])),
			categories: new Map([list("inbox", "Inbox"), list("work", "Work"), list("home", "Home"), ...(f.lists ?? [])].map((c) => [c.id, c])),
			sections: new Map([section("plan", "work", "Planning"), section("review", "work", "Review"), section("chores", "home", "Chores"), ...(f.sections ?? [])].map((s) => [s.id, s])),
			tags: new Map([tag("calls", "Calls"), tag("programming"), tag("programming/go", "programming/Go"), tag("programming/go/tools"), tag("programmingx"), ...(f.tags ?? [])].map((t) => [t.key, t])),
			occurrenceRecords: new Map((f.records ?? []).map((r) => [`${r.taskId}:${r.occurrenceDate}`, r])),
		};
	}

	function run(source: string | BlockFilters, f: Fixture = {}, ctx: QueryContext = ctxOf(), notePath = NOTE) {
		const filters = typeof source === "string" ? parseBlockQuery(source).filters : source;
		return runBlockQuery(filters, stateOf(f), ctx, notePath);
	}
	function ids(source: string | BlockFilters, f: Fixture = {}, ctx: QueryContext = ctxOf(), notePath = NOTE): ID[] {
		const r = run(source, f, ctx, notePath);
		if (r.kind === "error") throw new Error(r.message);
		return r.entries.map((e) => e.task.id);
	}
	function sorted(a: ID[]): ID[] {
		return [...a].sort();
	}

	describe("block matcher: no filters, status, order", () => {
		it("an empty query lists every open task", () => {
			expect(ids("", { tasks: [task("a"), task("b")] })).toEqual(["a", "b"]);
		});

		it("completed tasks are hidden", () => {
			expect(ids("", { tasks: [task("a"), task("b", { status: "completed", completedAt: TS })] })).toEqual(["a"]);
		});

		it("orders by sort key, not by insertion", () => {
			expect(ids("", { tasks: [task("a", { sortKey: "c" }), task("b", { sortKey: "a" }), task("c", { sortKey: "b" })] })).toEqual(["b", "c", "a"]);
		});

		it("returns entries in the shape the list renders", () => {
			const r = run("list: Work", { tasks: [task("a", { categoryId: "work", scheduled: day("2026-10-20") })] });
			const t = task("a", { categoryId: "work", scheduled: day("2026-10-20") });
			expect(r).toEqual({ kind: "ok", entries: [{ task: t, depth: 0, parentTitle: null, schedule: day("2026-10-20"), occurrence: null }] });
		});
	});

	describe("block matcher: list and section", () => {
		const tasks = [
			task("w1", { categoryId: "work" }),
			task("w2", { categoryId: "work", sectionId: "plan" }),
			task("w3", { categoryId: "work", sectionId: "review" }),
			task("h1", { categoryId: "home", sectionId: "chores" }),
			task("i1"),
		];

		it("list matches by name, case-insensitively", () => {
			expect(sorted(ids("list: work", { tasks }))).toEqual(["w1", "w2", "w3"]);
			expect(sorted(ids("list: WORK", { tasks }))).toEqual(["w1", "w2", "w3"]);
		});

		it("the Inbox is a list", () => {
			expect(ids("list: Inbox", { tasks })).toEqual(["i1"]);
		});

		it("a list name with trailing spaces still resolves", () => {
			expect(ids({ list: "  Work " }, { tasks })).toHaveLength(3);
		});

		it("an unknown list is an error naming it", () => {
			expect(run("list: Wrok", { tasks })).toEqual({ kind: "error", message: "No list named “Wrok”." });
		});

		it("an unknown list is an error even when no task would match", () => {
			expect(run("list: Wrok")).toEqual({ kind: "error", message: "No list named “Wrok”." });
		});

		it("section narrows the list", () => {
			expect(ids("list: Work\nsection: Planning", { tasks })).toEqual(["w2"]);
			expect(ids("list: Work\nsection: review", { tasks })).toEqual(["w3"]);
		});

		it("a section of another list is not found in this one", () => {
			expect(run("list: Work\nsection: Chores", { tasks })).toEqual({ kind: "error", message: "No section named “Chores” in Work." });
		});

		it("an unknown section is an error naming it and the list", () => {
			expect(run("list: Home\nsection: Nope", { tasks })).toEqual({ kind: "error", message: "No section named “Nope” in Home." });
		});

		it("section without a list is not an error in the matcher (the parser reports it) and is ignored", () => {
			expect(parseBlockQuery("section: Planning").errors).toEqual(["section needs a list filter."]);
			expect(sorted(ids({ section: "Planning" }, { tasks }))).toEqual(["h1", "i1", "w1", "w2", "w3"]);
		});

		it("a list error wins over a section error", () => {
			expect(run("list: Wrok\nsection: Nope")).toEqual({ kind: "error", message: "No list named “Wrok”." });
		});
	});

	describe("block matcher: tag", () => {
		const tasks = [
			task("calls", { tagKeys: ["calls"] }),
			task("prog", { tagKeys: ["programming"] }),
			task("go", { tagKeys: ["programming/go"] }),
			task("tools", { tagKeys: ["programming/go/tools"] }),
			task("px", { tagKeys: ["programmingx"] }),
			task("multi", { tagKeys: ["calls", "programming/go"] }),
			task("none"),
		];

		it("matches by name, with or without @, in any casing", () => {
			expect(sorted(ids("tag: Calls", { tasks }))).toEqual(["calls", "multi"]);
			expect(sorted(ids("tag: @CALLS", { tasks }))).toEqual(["calls", "multi"]);
		});

		it("a parent tag includes its children and grandchildren, not a sibling with the same prefix", () => {
			expect(sorted(ids("tag: programming", { tasks }))).toEqual(["go", "multi", "prog", "tools"]);
		});

		it("a child tag does not include its parent", () => {
			expect(sorted(ids("tag: programming/go", { tasks }))).toEqual(["go", "multi", "tools"]);
		});

		it("a parent resolves by its tag; a path prefix with no tag is an unknown tag", () => {
			const tasks = [task("a", { tagKeys: ["a/b"] })];
			expect(ids("tag: a", { tasks, tags: [tag("a"), tag("a/b")] })).toEqual(["a"]);
			expect(run("tag: a", { tasks, tags: [tag("a/b")] })).toEqual({ kind: "error", message: "No tag named “a”." });
		});

		it("an unknown tag is an error naming it", () => {
			expect(run("tag: Y", { tasks })).toEqual({ kind: "error", message: "No tag named “Y”." });
		});

		it("a name that cannot be a tag key is an unknown tag", () => {
			expect(run({ tags: ["two words"] }, { tasks })).toEqual({ kind: "error", message: "No tag named “two words”." });
		});
	});

	describe("block matcher: priority and quadrant", () => {
		const tasks = [
			task("none", { priority: 0 }),
			task("high", { priority: 1 }),
			task("med", { priority: 2 }),
			task("low", { priority: 3 }),
			task("q1", { urgent: true, important: true }),
			task("q2", { important: true }),
			task("q3", { urgent: true }),
		];

		it("a single priority", () => {
			expect(ids("priority: high", { tasks })).toEqual(["high"]);
			expect(sorted(ids("priority: none", { tasks }))).toEqual(["none", "q1", "q2", "q3"]);
		});

		it("comma means or", () => {
			expect(sorted(ids("priority: high, low", { tasks }))).toEqual(["high", "low"]);
		});

		it("quadrant by number and by name", () => {
			expect(ids("quadrant: 1", { tasks })).toEqual(["q1"]);
			expect(ids("quadrant: important not urgent", { tasks })).toEqual(["q2"]);
			expect(ids("quadrant: urgent not important", { tasks })).toEqual(["q3"]);
			expect(sorted(ids("quadrant: neither", { tasks }))).toEqual(["high", "low", "med", "none"]);
		});

		it("comma means or", () => {
			expect(sorted(ids("quadrant: 1, 3", { tasks }))).toEqual(["q1", "q3"]);
		});
	});

	describe("block matcher: linked", () => {
		const tasks = [
			task("here", { descriptionNote: noteOf("Projects/Plan.md") }),
			task("other", { descriptionNote: noteOf("Archive/Plan.md") }),
			task("none"),
		];

		it("matches the note that holds the block", () => {
			expect(ids("linked: this note", { tasks })).toEqual(["here"]);
			expect(ids("linked: this note", { tasks }, ctxOf(), "Archive/Plan.md")).toEqual(["other"]);
		});

		it("two notes with the same name in different folders do not collide", () => {
			expect(ids("linked: this note", { tasks }, ctxOf(), "Plan.md")).toEqual([]);
		});

		it("normalizes the block's path like the app does (slashes)", () => {
			expect(ids("linked: this note", { tasks }, ctxOf(), "/Projects//Plan.md")).toEqual(["here"]);
			expect(ids("linked: this note", { tasks }, ctxOf(), "Projects\\Plan.md")).toEqual(["here"]);
		});

		it("a block with no note path matches nothing", () => {
			expect(ids("linked: this note", { tasks }, ctxOf(), "")).toEqual([]);
		});

		it("is not applied when the filter is absent", () => {
			expect(sorted(ids("", { tasks }))).toEqual(["here", "none", "other"]);
		});
	});

	describe("block matcher: scheduled", () => {
		const at = (id: string, date: string | null, patch: Partial<Task> = {}) => task(id, { scheduled: date === null ? null : day(date), ...patch });
		const tasks = [
			at("old", "2026-10-01"),
			at("yest", "2026-10-13"),
			at("mon", "2026-10-12"),
			at("today", "2026-10-14"),
			at("sat", "2026-10-17"),
			at("sun", "2026-10-18"),
			at("d6", "2026-10-20"),
			at("d7", "2026-10-21"),
			at("nodate", null),
			at("done", "2026-10-14", { status: "completed", completedAt: TS }),
			task("timed", { scheduled: { kind: "datetime", local: "2026-10-14T08:00", tz: ZONE } }),
			task("deadline", { deadline: day("2026-10-14") }),
			task("dlOld", { deadline: day("2026-10-01") }),
			task("mix", { scheduled: day("2026-10-20"), deadline: day("2026-10-13") }),
		];

		// The schedule only: a task whose deadline falls in the range, but not its schedule, stays out.
		it("today: the schedule is today", () => {
			expect(sorted(ids("scheduled: today", { tasks }))).toEqual(["timed", "today"]);
		});

		it("overdue: open with a past schedule", () => {
			expect(sorted(ids("scheduled: overdue", { tasks }))).toEqual(["mon", "old", "yest"]);
		});

		it("a timed schedule earlier today is not overdue", () => {
			const f = { tasks: [task("t", { scheduled: { kind: "datetime", local: "2026-10-14T00:05", tz: ZONE } })] };
			expect(ids("scheduled: overdue", f)).toEqual([]);
			expect(ids("scheduled: today", f)).toEqual(["t"]);
		});

		it("a timed schedule is read in the display zone", () => {
			// 23:30 in Los Angeles on the 13th is 08:30 on the 14th in Berlin.
			const f = { tasks: [task("t", { scheduled: { kind: "datetime", local: "2026-10-13T23:30", tz: "America/Los_Angeles" } })] };
			expect(ids("scheduled: today", f)).toEqual(["t"]);
			expect(ids("scheduled: overdue", f)).toEqual([]);
		});

		it("next 7 days is today through today + 6", () => {
			expect(sorted(ids("scheduled: next 7 days", { tasks }))).toEqual(["d6", "mix", "sat", "sun", "timed", "today"]);
		});

		it("this week starts on Monday", () => {
			expect(sorted(ids("scheduled: this week", { tasks }, ctxOf("MO")))).toEqual(["mon", "sat", "sun", "timed", "today", "yest"]);
		});

		it("this week starts on Sunday", () => {
			// Sunday 2026-10-11 to Saturday 2026-10-17: the 18th is next week.
			expect(sorted(ids("scheduled: this week", { tasks }, ctxOf("SU")))).toEqual(["mon", "sat", "timed", "today", "yest"]);
		});

		it("this week starts on Saturday", () => {
			// Saturday 2026-10-10 to Friday 2026-10-16: Sat the 17th is next week.
			expect(sorted(ids("scheduled: this week", { tasks }, ctxOf("SA")))).toEqual(["mon", "timed", "today", "yest"]);
		});

		it("this week follows a week that crosses a month and year boundary", () => {
			const ctx: QueryContext = { ...ctxOf("MO"), today: "2026-12-31" }; // Thursday; week is 12-28 to 01-03
			const f = { tasks: [at("a", "2026-12-28"), at("b", "2027-01-03"), at("c", "2027-01-04"), at("d", "2026-12-27")] };
			expect(sorted(ids("scheduled: this week", f, ctx))).toEqual(["a", "b"]);
		});

		it("a task with only a deadline never matches a scheduled filter", () => {
			const f = { tasks: [task("d", { deadline: day("2026-10-14") }), task("o", { deadline: day("2026-10-01") })] };
			for (const value of ["today", "overdue", "this week", "next 7 days"]) expect(ids(`scheduled: ${value}`, f), value).toEqual([]);
		});

		it("a missed deadline does not make a future schedule overdue", () => {
			const f = { tasks: [task("a", { scheduled: day("2026-10-20"), deadline: day("2026-10-01") })] };
			expect(ids("scheduled: overdue", f)).toEqual([]);
		});

		it("a task without a date never matches a scheduled filter", () => {
			for (const value of ["today", "overdue", "this week", "next 7 days"]) expect(ids(`scheduled: ${value}`, { tasks: [task("n")] }), value).toEqual([]);
		});
	});

	describe("block matcher: due is the deadline", () => {
		const dl = (id: string, date: string | null, patch: Partial<Task> = {}) => task(id, { deadline: date === null ? null : day(date), ...patch });
		const tasks = [
			dl("old", "2026-10-01"),
			dl("yest", "2026-10-13"),
			dl("mon", "2026-10-12"),
			dl("today", "2026-10-14"),
			dl("sat", "2026-10-17"),
			dl("sun", "2026-10-18"),
			dl("d6", "2026-10-20"),
			dl("d7", "2026-10-21"),
			dl("nodate", null),
			dl("done", "2026-10-14", { status: "completed", completedAt: TS }),
			task("timed", { deadline: { kind: "datetime", local: "2026-10-14T08:00", tz: ZONE } }),
			task("sched", { scheduled: day("2026-10-14") }),
			task("schedOld", { scheduled: day("2026-10-01") }),
			task("mix", { scheduled: day("2026-10-14"), deadline: day("2026-10-20") }),
		];

		it("today: the deadline is today, a schedule of today does not count", () => {
			expect(sorted(ids("due: today", { tasks }))).toEqual(["timed", "today"]);
		});

		it("overdue: open with a missed deadline, a past schedule does not count", () => {
			expect(sorted(ids("due: overdue", { tasks }))).toEqual(["mon", "old", "yest"]);
		});

		it("a timed deadline earlier today is today and not overdue, as the deadline rule reads the day", () => {
			const f = { tasks: [task("t", { deadline: { kind: "datetime", local: "2026-10-14T00:05", tz: ZONE } })] };
			expect(ids("due: overdue", f)).toEqual([]);
			expect(ids("due: today", f)).toEqual(["t"]);
		});

		it("a timed deadline is read in the display zone", () => {
			const f = { tasks: [task("t", { deadline: { kind: "datetime", local: "2026-10-13T23:30", tz: "America/Los_Angeles" } })] };
			expect(ids("due: today", f)).toEqual(["t"]);
			expect(ids("due: overdue", f)).toEqual([]);
		});

		it("next 7 days is today through today + 6", () => {
			expect(sorted(ids("due: next 7 days", { tasks }))).toEqual(["d6", "mix", "sat", "sun", "timed", "today"]);
		});

		it("this week starts on Monday, Sunday or Saturday", () => {
			expect(sorted(ids("due: this week", { tasks }, ctxOf("MO")))).toEqual(["mon", "sat", "sun", "timed", "today", "yest"]);
			expect(sorted(ids("due: this week", { tasks }, ctxOf("SU")))).toEqual(["mon", "sat", "timed", "today", "yest"]);
			expect(sorted(ids("due: this week", { tasks }, ctxOf("SA")))).toEqual(["mon", "timed", "today", "yest"]);
		});

		it("a task with only a schedule never matches a due filter", () => {
			const f = { tasks: [task("s", { scheduled: day("2026-10-14") }), task("o", { scheduled: day("2026-10-01") })] };
			for (const value of ["today", "overdue", "this week", "next 7 days"]) expect(ids(`due: ${value}`, f), value).toEqual([]);
		});

		it("a task without a date never matches a due filter", () => {
			for (const value of ["today", "overdue", "this week", "next 7 days"]) expect(ids(`due: ${value}`, { tasks: [task("n")] }), value).toEqual([]);
		});

		it("a repeating task has no deadline, so due never matches it", () => {
			const r = repeating(series("2026-10-10", rule()), { id: "r" });
			const f = { tasks: [r] };
			const ctx = ctxOf("MO", { schedule: scheduleResolver(stateOf(f), ctxOf("MO")) });
			for (const value of ["today", "overdue", "this week", "next 7 days"]) expect(ids(`due: ${value}`, f, ctx), value).toEqual([]);
			expect(ids("scheduled: overdue", f, ctx)).toEqual(["r"]);
		});
	});

	describe("block matcher: due and scheduled together", () => {
		const tasks = [
			task("both", { scheduled: day("2026-10-14"), deadline: day("2026-10-13") }),
			task("schedOnly", { scheduled: day("2026-10-14") }),
			task("dlOnly", { deadline: day("2026-10-13") }),
			task("swapped", { scheduled: day("2026-10-13"), deadline: day("2026-10-14") }),
		];

		it("a task passes only when both keys accept their own date", () => {
			expect(ids("due: overdue\nscheduled: today", { tasks })).toEqual(["both"]);
			expect(ids("due: today\nscheduled: overdue", { tasks })).toEqual(["swapped"]);
		});

		it("each key alone lets in the tasks the other would have refused", () => {
			expect(sorted(ids("due: overdue", { tasks }))).toEqual(["both", "dlOnly"]);
			expect(sorted(ids("scheduled: today", { tasks }))).toEqual(["both", "schedOnly"]);
		});
	});

	describe("block matcher: repeating tasks use the current occurrence", () => {
		function resolved(f: Fixture, weekStart: WeekStart = "MO"): QueryContext {
			return ctxOf(weekStart, { schedule: scheduleResolver(stateOf(f), ctxOf(weekStart)) });
		}
		const daily = (id: string, anchor: string) => repeating(series(anchor, rule()), { id, sortKey: id });

		it("an overdue occurrence is overdue", () => {
			const f = { tasks: [daily("r", "2026-10-10")], records: [done("2026-10-10", "2026-10-10", "r")] };
			expect(ids("scheduled: overdue", f, resolved(f))).toEqual(["r"]);
			expect(ids("scheduled: today", f, resolved(f))).toEqual([]);
		});

		it("the occurrence of today is due today", () => {
			const f = { tasks: [daily("r", "2026-10-10")], records: ["10", "11", "12", "13"].map((d) => done(`2026-10-${d}`, `2026-10-${d}`, "r")) };
			expect(ids("scheduled: today", f, resolved(f))).toEqual(["r"]);
			expect(ids("scheduled: overdue", f, resolved(f))).toEqual([]);
		});

		it("completing today's occurrence moves the task to tomorrow", () => {
			const f = { tasks: [daily("r", "2026-10-14")], records: [done("2026-10-14", "2026-10-14", "r")] };
			expect(ids("scheduled: today", f, resolved(f))).toEqual([]);
			expect(ids("scheduled: next 7 days", f, resolved(f))).toEqual(["r"]);
			expect(ids("scheduled: this week", f, resolved(f))).toEqual(["r"]);
		});

		it("an occurrence in a future week is not this week", () => {
			const f = { tasks: [daily("r", "2026-10-19")] };
			expect(ids("scheduled: this week", f, resolved(f))).toEqual([]);
			expect(ids("scheduled: next 7 days", f, resolved(f))).toEqual(["r"]);
		});

		it("the occurrence entry carries the occurrence as its schedule", () => {
			const f = { tasks: [daily("r", "2026-10-16")] };
			const r = run("scheduled: this week", f, resolved(f));
			expect(r.kind === "ok" && r.entries[0]?.schedule).toEqual(day("2026-10-16"));
		});

		it("a series that ended has no date and never matches", () => {
			const ended = repeating(series("2026-10-10", rule(), { kind: "never" }, "2026-10-12T09:00:00.000Z"), { id: "e" });
			const f = { tasks: [ended] };
			expect(ids("scheduled: overdue", f, resolved(f))).toEqual([]); // completed status: hidden anyway
			expect(ids("", f, resolved(f))).toEqual([]);
		});

		it("without a resolver the stored schedule is read", () => {
			const f = { tasks: [task("p", { scheduled: day("2026-10-14") })] };
			expect(ids("scheduled: today", f)).toEqual(["p"]);
		});
	});

	describe("block matcher: filters combine with AND", () => {
		const tasks = [
			task("hit", { categoryId: "work", sectionId: "plan", tagKeys: ["calls"], scheduled: day("2026-10-15"), priority: 1, urgent: true, important: true, descriptionNote: noteOf(NOTE) }),
			task("wrongList", { categoryId: "home", tagKeys: ["calls"], scheduled: day("2026-10-15"), priority: 1, urgent: true, important: true, descriptionNote: noteOf(NOTE) }),
			task("wrongSection", { categoryId: "work", sectionId: "review", tagKeys: ["calls"], scheduled: day("2026-10-15"), priority: 1, urgent: true, important: true, descriptionNote: noteOf(NOTE) }),
			task("wrongTag", { categoryId: "work", sectionId: "plan", scheduled: day("2026-10-15"), priority: 1, urgent: true, important: true, descriptionNote: noteOf(NOTE) }),
			task("wrongDue", { categoryId: "work", sectionId: "plan", tagKeys: ["calls"], scheduled: day("2026-11-15"), priority: 1, urgent: true, important: true, descriptionNote: noteOf(NOTE) }),
			task("wrongPriority", { categoryId: "work", sectionId: "plan", tagKeys: ["calls"], scheduled: day("2026-10-15"), priority: 3, urgent: true, important: true, descriptionNote: noteOf(NOTE) }),
			task("wrongQuadrant", { categoryId: "work", sectionId: "plan", tagKeys: ["calls"], scheduled: day("2026-10-15"), priority: 1, descriptionNote: noteOf(NOTE) }),
			task("wrongNote", { categoryId: "work", sectionId: "plan", tagKeys: ["calls"], scheduled: day("2026-10-15"), priority: 1, urgent: true, important: true }),
			task("done", { categoryId: "work", sectionId: "plan", tagKeys: ["calls"], scheduled: day("2026-10-15"), priority: 1, urgent: true, important: true, descriptionNote: noteOf(NOTE), status: "completed", completedAt: TS }),
		];
		const source = "list: Work\nsection: Planning\ntag: Calls\nscheduled: this week\npriority: high, medium\nquadrant: 1\nlinked: this note";

		it("only the task that passes every filter is listed", () => {
			expect(ids(source, { tasks })).toEqual(["hit"]);
		});

		it("dropping any one line lets in exactly the tasks that failed only that line", () => {
			const lines = source.split("\n");
			// Dropping `list` also drops `section` (a section needs a list), so the wrong-list and wrong-section tasks pass.
			const extra: Record<string, string[]> = {
				"list: Work": ["wrongList", "wrongSection"],
				"section: Planning": ["wrongSection"],
				"tag: Calls": ["wrongTag"],
				"scheduled: this week": ["wrongDue"],
				"priority: high, medium": ["wrongPriority"],
				"quadrant: 1": ["wrongQuadrant"],
				"linked: this note": ["wrongNote"],
			};
			for (const line of lines) {
				const filters = parseBlockQuery(lines.filter((l) => l !== line).join("\n")).filters;
				expect(sorted(ids(filters, { tasks })), line).toEqual(sorted(["hit", ...extra[line]!]));
			}
		});

		it("an error in one reference reports it even when the others are fine", () => {
			expect(run("list: Work\ntag: Nope", { tasks })).toEqual({ kind: "error", message: "No tag named “Nope”." });
		});
	});

	describe("block matcher: subtasks", () => {
		it("a matching subtask is nested under its matching parent", () => {
			const tasks = [
				task("p", { categoryId: "work", sortKey: "a" }),
				task("c2", { categoryId: "work", parentId: "p", sortKey: "2" }),
				task("c1", { categoryId: "work", parentId: "p", sortKey: "1" }),
				task("q", { categoryId: "work", sortKey: "b" }),
			];
			const r = run("list: Work", { tasks });
			expect(r.kind === "ok" && r.entries.map((e) => [e.task.id, e.depth, e.parentTitle])).toEqual([
				["p", 0, null],
				["c1", 1, null],
				["c2", 1, null],
				["q", 0, null],
			]);
		});

		it("a matching subtask of a parent that does not match is shown alone with its parent's title", () => {
			const tasks = [task("p", { categoryId: "home", title: "Move house" }), task("c", { categoryId: "work", parentId: "p", priority: 1 })];
			const r = run("list: Work\npriority: high", { tasks });
			expect(r.kind === "ok" && r.entries.map((e) => [e.task.id, e.depth, e.parentTitle])).toEqual([["c", 0, "Move house"]]);
		});

		it("a subtask that does not match is not shown under a matching parent", () => {
			const tasks = [task("p", { priority: 1 }), task("c", { parentId: "p", priority: 0 })];
			expect(ids("priority: high", { tasks })).toEqual(["p"]);
		});

		it("an open subtask of a completed parent is shown alone", () => {
			const tasks = [task("p", { title: "Done parent", status: "completed", completedAt: TS }), task("c", { parentId: "p" })];
			const r = run("", { tasks });
			expect(r.kind === "ok" && r.entries.map((e) => [e.task.id, e.parentTitle])).toEqual([["c", "Done parent"]]);
		});

		it("a completed subtask is hidden even under an open parent", () => {
			const tasks = [task("p"), task("c", { parentId: "p", status: "completed", completedAt: TS })];
			expect(ids("", { tasks })).toEqual(["p"]);
		});
	});

	// ---- property: the result is "filter all open tasks by each rule independently" -----------------

	describe("block matcher: property", () => {
		const LISTS = ["inbox", "work", "home"] as const;
		const SECTION_OF: Record<string, string | null> = { work: "plan", home: "chores", inbox: null };
		const TAGS = ["calls", "programming", "programming/go", "programming/go/tools", "programmingx"];
		const DATES = ["2026-10-01", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-17", "2026-10-18", "2026-10-20", "2026-10-21", "2026-11-30"];

		const taskArb = fc.record({
			list: fc.constantFrom(...LISTS),
			section: fc.boolean(),
			tags: fc.subarray(TAGS, { maxLength: 3 }),
			date: fc.option(fc.constantFrom(...DATES), { nil: null }),
			deadline: fc.option(fc.constantFrom(...DATES), { nil: null }),
			timed: fc.boolean(),
			priority: fc.constantFrom<Priority>(0, 1, 2, 3),
			urgent: fc.boolean(),
			important: fc.boolean(),
			open: fc.boolean(),
			note: fc.constantFrom<string | null>(null, NOTE, "Other.md"),
		});
		const filtersArb = fc.record(
			{
				list: fc.constantFrom("Inbox", "work", "HOME"),
				section: fc.constantFrom("Planning", "chores"),
				tags: fc.subarray(["calls", "programming", "programming/go", "programmingx"], { minLength: 1 }),
				due: fc.constantFrom<"today" | "overdue" | "this-week" | "next-7-days">("today", "overdue", "this-week", "next-7-days"),
				scheduled: fc.constantFrom<"today" | "overdue" | "this-week" | "next-7-days">("today", "overdue", "this-week", "next-7-days"),
				priorities: fc.subarray<Priority>([0, 1, 2, 3], { minLength: 1 }),
				quadrants: fc.subarray(["urgent-important", "important", "urgent", "neither"] as const, { minLength: 1 }),
				linked: fc.constant(true),
			},
			{ requiredKeys: [] },
		).map((f): BlockFilters => (f.section === undefined || f.list === undefined ? f : { ...f, list: f.section === "Planning" ? "work" : "HOME" })); // a section exists only in its own list

		/** Independent day arithmetic (no Luxon, no domain helpers). */
		const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
		const msOf = (d: string) => Date.parse(`${d}T00:00:00Z`);
		function weekRange(weekStart: WeekStart): [string, string] {
			const dow = new Date(msOf(TODAY)).getUTCDay(); // 0 Sunday
			const first = { MO: 1, SU: 0, SA: 6 }[weekStart];
			const back = (dow - first + 7) % 7;
			return [ymd(msOf(TODAY) - back * 86_400_000), ymd(msOf(TODAY) + (6 - back) * 86_400_000)];
		}

		function reference(t: Task, f: BlockFilters, weekStart: WeekStart): boolean {
			if (t.status !== "open") return false;
			const listName = f.list?.toLowerCase();
			if (listName !== undefined && !(({ inbox: "inbox", work: "work", home: "home" } as Record<string, string>)[t.categoryId] === listName)) return false;
			if (f.section !== undefined && f.list !== undefined) {
				const want = { planning: "plan", chores: "chores" }[f.section.toLowerCase() as "planning" | "chores"];
				if (t.sectionId !== want) return false;
			}
			// Any of the listed tags, a parent including its children.
			if (f.tags !== undefined && !f.tags.some((tag) => t.tagKeys.some((k) => k === tag || k.startsWith(`${tag}/`)))) return false;
			if (f.priorities !== undefined && !f.priorities.includes(t.priority)) return false;
			if (f.quadrants !== undefined) {
				const q = t.urgent && t.important ? "urgent-important" : t.important ? "important" : t.urgent ? "urgent" : "neither";
				if (!f.quadrants.includes(q)) return false;
			}
			if (f.linked === true && t.descriptionNote?.path !== NOTE) return false;
			const [from, to] = weekRange(weekStart);
			const plus6 = ymd(msOf(TODAY) + 6 * 86_400_000);
			const test = {
				today: (x: string) => x === TODAY,
				overdue: (x: string) => x < TODAY,
				"this-week": (x: string) => x >= from && x <= to,
				"next-7-days": (x: string) => x >= TODAY && x <= plus6,
			};
			const dayOf = (spec: DateSpec | null) => (spec === null ? null : spec.kind === "date" ? spec.date : spec.local.slice(0, 10));
			// `due` reads the deadline day only, `scheduled` the schedule day only.
			const dueDay = dayOf(t.deadline);
			if (f.due !== undefined && !(dueDay !== null && test[f.due](dueDay))) return false;
			const schedDay = dayOf(t.scheduled);
			if (f.scheduled !== undefined && !(schedDay !== null && test[f.scheduled](schedDay))) return false;
			return true;
		}

		it("equals filtering every task by each rule on its own", () => {
			fc.assert(
				fc.property(fc.array(taskArb, { maxLength: 40 }), filtersArb, fc.constantFrom<WeekStart>("MO", "SU", "SA"), (specs, filters, weekStart) => {
					const tasks = specs.map((s, i) =>
						task(`t${String(i).padStart(2, "0")}`, {
							categoryId: s.list,
							sectionId: s.section ? SECTION_OF[s.list]! : null,
							tagKeys: s.tags,
							deadline: s.deadline === null ? null : day(s.deadline),
							scheduled: s.date === null ? null : s.timed ? { kind: "datetime", local: `${s.date}T12:00`, tz: ZONE } : day(s.date),
							priority: s.priority,
							urgent: s.urgent,
							important: s.important,
							status: s.open ? "open" : "completed",
							completedAt: s.open ? null : TS,
							descriptionNote: s.note === null ? null : noteOf(s.note),
						}),
					);
					const r = runBlockQuery(filters, stateOf({ tasks }), ctxOf(weekStart), NOTE);
					expect(r.kind).toBe("ok");
					if (r.kind !== "ok") return;
					const expected = tasks.filter((t) => reference(t, filters, weekStart)).map((t) => t.id);
					expect(sorted(r.entries.map((e: ListEntry) => e.task.id))).toEqual(sorted(expected));
					// Every row is a distinct open task and quadrantOf agrees with the flags.
					expect(new Set(r.entries.map((e) => e.task.id)).size).toBe(r.entries.length);
					for (const e of r.entries) expect(quadrantOf(e.task)).toBeDefined();
				}),
				{ numRuns: 300 },
			);
		});
	});

	describe("compileBlockQuery: the per-task test behind runBlockQuery", () => {
		const compile = (source: string, f: Fixture = {}, ctx: QueryContext = ctxOf(), notePath = NOTE) =>
			compileBlockQuery(parseBlockQuery(source).filters, stateOf(f), ctx, notePath);

		it("reports the same reference errors as runBlockQuery", () => {
			expect(compile("list: Wrok")).toEqual({ kind: "error", message: "No list named \u201cWrok\u201d." });
			expect(compile("tag: Nope")).toEqual({ kind: "error", message: "No tag named \u201cNope\u201d." });
		});

		it("tests one task at a time, open tasks only", () => {
			const m = compile("priority: high");
			if (m.kind !== "ok") throw new Error("expected ok");
			expect(m.matches(task("a", { priority: 1 }))).toBe(true);
			expect(m.matches(task("b", { priority: 3 }))).toBe(false);
			expect(m.matches(task("c", { priority: 1, status: "completed", completedAt: TS }))).toBe(false);
		});

		it("agrees with runBlockQuery on every task, for each kind of filter", () => {
			const tasks = [
				task("a", { categoryId: "work", priority: 1, tagKeys: ["programming/go"], urgent: true, important: true }),
				task("b", { categoryId: "work", sectionId: "plan", priority: 3, scheduled: day(TODAY) }),
				task("c", { categoryId: "home", deadline: day("2026-10-01"), descriptionNote: noteOf(NOTE) }),
				task("d", { status: "completed", completedAt: TS }),
				task("e"),
			];
			for (const source of ["", "list: Work", "list: Work\nsection: Planning", "tag: programming", "scheduled: today", "scheduled: overdue", "scheduled: this week", "due: today", "due: overdue", "due: this week", "tag: calls, programming/go", "priority: high, low", "quadrant: 1", "linked: this note"]) {
				const m = compile(source, { tasks });
				if (m.kind !== "ok") throw new Error(source);
				expect(tasks.filter((t) => m.matches(t)).map((t) => t.id)).toEqual(ids(source, { tasks }));
			}
		});
	});
});

describe("a tag by its own name", () => {
	// A task block's `tag:` filter finds a child tag by its own name (#11).

	const TS = "2026-09-01T09:00:00.000Z";
	const CTX: QueryContext = { today: "2026-10-14", zone: "Europe/Berlin", upcomingDays: 7, weekStart: "MO" };

	const tag = (key: string, displayName: string, createdAt = TS): Tag => ({ key, displayName, color: null, createdAt, modifiedAt: createdAt });
	const inbox: Category = { id: "inbox", name: "Inbox", icon: null, color: null, nameKey: "inbox", isInbox: true, sortKey: "inbox", createdAt: TS, modifiedAt: TS };
	const task = (id: string, tagKeys: string[]): Task => ({
		id,
		title: id,
		descriptionNote: null,
		categoryId: "inbox",
		tagKeys,
		parentId: null,
		sectionId: null,
		scheduled: null,
		deadline: null,
		plannedDurationMin: null,
		urgent: false,
		important: false,
		priority: 0,
		status: "open",
		completedAt: null,
		recurrence: null,
		sortKey: id,
		createdAt: TS,
		modifiedAt: TS,
	});

	const tags = [tag("home", "Home"), tag("home/calls", "Home/Calls"), tag("home/garden", "Home/Garden")];
	const tasks = [task("call", ["home/calls"]), task("garden", ["home/garden"]), task("none", [])];
	const state: BlockQueryState = {
		tasks: new Map(tasks.map((t) => [t.id, t])),
		categories: new Map([[inbox.id, inbox]]),
		sections: new Map(),
		tags: new Map(tags.map((t) => [t.key, t])),
	};
	const run = (source: string) => runBlockQuery(parseBlockQuery(source).filters, state, CTX, "Plan.md");
	const ids = (source: string): string[] => {
		const r = run(source);
		if (r.kind === "error") throw new Error(r.message);
		return r.entries.map((e) => e.task.id);
	};

	describe("task block: tag by its own name", () => {
		it("tag: calls finds the child tag", () => {
			expect(ids("tag: calls")).toEqual(["call"]);
		});

		it("tag: @Calls ignores case and the @", () => {
			expect(ids("tag: @Calls")).toEqual(["call"]);
		});

		it("tag: home/calls still works", () => {
			expect(ids("tag: home/calls")).toEqual(["call"]);
		});

		it("tag: home still includes every child", () => {
			expect(ids("tag: home").sort()).toEqual(["call", "garden"]);
		});

		it("a missing tag is the same error as before", () => {
			expect(run("tag: nope")).toEqual({ kind: "error", message: "No tag named “nope”." });
			expect(run("tag: work/calls")).toEqual({ kind: "error", message: "No tag named “work/calls”." });
		});
	});

	describe("blockOpenView: tag by its own name", () => {
		const view = (source: string) => blockOpenView(parseBlockQuery(source).filters, state);

		it("opens the child tag", () => {
			expect(view("tag: calls")).toEqual({ kind: "tag", key: "home/calls" });
			expect(view("tag: @Calls")).toEqual({ kind: "tag", key: "home/calls" });
		});

		it("still opens a parent and the full path", () => {
			expect(view("tag: home")).toEqual({ kind: "tag", key: "home" });
			expect(view("tag: home/calls")).toEqual({ kind: "tag", key: "home/calls" });
		});

		it("a tag that does not exist opens no view", () => {
			expect(view("tag: nope")).toBeNull();
		});
	});
});

describe("due and scheduled", () => {
	// `due:` is the deadline, `scheduled:` the schedule, in the shared date owner and in the block (#52).

	const TODAY = "2026-10-14";
	const ZONE = "Europe/Berlin";
	const TS = "2026-09-01T09:00:00.000Z";
	const CTX: QueryContext = { today: TODAY, zone: ZONE, upcomingDays: 7, weekStart: "MO" };

	const inbox: Category = { id: "inbox", name: "Inbox", icon: null, color: null, nameKey: "inbox", isInbox: true, sortKey: "inbox", createdAt: TS, modifiedAt: TS };
	const state: BlockQueryState = { tasks: new Map(), categories: new Map([["inbox", inbox]]), sections: new Map(), tags: new Map() };

	const day = (date: string): DateSpec => ({ kind: "date", date });
	const timed = (local: string, tz = ZONE): DateSpec => ({ kind: "datetime", local, tz });
	function task(id: string, patch: Partial<Task> = {}): Task {
		return {
			id,
			title: id,
			descriptionNote: null,
			categoryId: "inbox",
			tagKeys: [],
			parentId: null,
			sectionId: null,
			scheduled: null,
			deadline: null,
			plannedDurationMin: null,
			urgent: false,
			important: false,
			priority: 0,
			status: "open",
			completedAt: null,
			recurrence: null,
			sortKey: id,
			createdAt: TS,
			modifiedAt: TS,
			...patch,
		};
	}

	const filter = (date: TaskFilter["date"], from: string | null = null, to: string | null = null) => ({ date, from, to });
	const FILTERS = [filter("today"), filter("overdue"), filter("next7"), filter("range", "2026-10-12", "2026-10-18"), filter("range", null, "2026-10-13"), filter("none")];

	// A grid of every combination of a schedule day and a deadline day (or none), open or completed.
	const DAYS: (DateSpec | null)[] = [null, day("2026-10-01"), day("2026-10-13"), day(TODAY), day("2026-10-15"), day("2026-10-20"), day("2026-10-21"), timed("2026-10-14T23:30"), timed("2026-10-13T23:30", "America/Los_Angeles")];
	const GRID: Task[] = [];
	for (const [i, scheduled] of DAYS.entries())
		for (const [j, deadline] of DAYS.entries())
			for (const status of ["open", "completed"] as const)
				GRID.push(task(`g${i}-${j}-${status}`, { scheduled, deadline, status, completedAt: status === "open" ? null : TS }));

	const ymd = (spec: DateSpec | null): string | null => (spec === null ? null : spec.kind === "date" ? spec.date : spec.tz === ZONE ? spec.local.slice(0, 10) : null);

	describe("matchesTaskDate: the field parameter", () => {
		it("defaults to either side, as Search reads it", () => {
			const t = task("t", { scheduled: day("2026-10-20"), deadline: day(TODAY) });
			for (const f of FILTERS) expect(matchesTaskDate(t, f, CTX), f.date).toBe(matchesTaskDate(t, f, CTX, "either"));
			expect(matchesTaskDate(t, filter("today"), CTX)).toBe(true);
			expect(matchesTaskDate(task("s", { scheduled: day(TODAY) }), filter("today"), CTX)).toBe(true);
			expect(matchesTaskDate(task("d", { deadline: day(TODAY) }), filter("today"), CTX)).toBe(true);
		});

		it("deadline reads only the deadline day", () => {
			const schedOnly = task("s", { scheduled: day(TODAY) });
			const dlOnly = task("d", { deadline: day(TODAY) });
			expect(matchesTaskDate(schedOnly, filter("today"), CTX, "deadline")).toBe(false);
			expect(matchesTaskDate(dlOnly, filter("today"), CTX, "deadline")).toBe(true);
			expect(matchesTaskDate(schedOnly, filter("next7"), CTX, "deadline")).toBe(false);
			expect(matchesTaskDate(schedOnly, filter("range", "2026-10-12", "2026-10-18"), CTX, "deadline")).toBe(false);
		});

		it("schedule reads only the schedule day", () => {
			const schedOnly = task("s", { scheduled: day(TODAY) });
			const dlOnly = task("d", { deadline: day(TODAY) });
			expect(matchesTaskDate(schedOnly, filter("today"), CTX, "schedule")).toBe(true);
			expect(matchesTaskDate(dlOnly, filter("today"), CTX, "schedule")).toBe(false);
			expect(matchesTaskDate(dlOnly, filter("next7"), CTX, "schedule")).toBe(false);
			expect(matchesTaskDate(dlOnly, filter("range", "2026-10-12", "2026-10-18"), CTX, "schedule")).toBe(false);
		});

		it("any matches whatever the field", () => {
			for (const field of ["either", "schedule", "deadline"] as const) expect(matchesTaskDate(task("n"), filter("any"), CTX, field)).toBe(true);
		});

		it("overdue: the deadline field is isDeadlineMissed over a grid", () => {
			for (const t of GRID) expect(matchesTaskDate(t, filter("overdue"), CTX, "deadline"), t.id).toBe(isDeadlineMissed(t, CTX));
		});

		it("overdue: the schedule field is an open task with a schedule day before today", () => {
			for (const t of GRID) {
				const s = ymd(t.scheduled);
				const expected = t.status === "open" && s !== null && s < TODAY;
				// A schedule in another zone is read in the display zone: only compare the cases the oracle can read.
				if (t.scheduled !== null && t.scheduled.kind === "datetime" && t.scheduled.tz !== ZONE) continue;
				expect(matchesTaskDate(t, filter("overdue"), CTX, "schedule"), t.id).toBe(expected);
			}
		});

		it("either-side overdue is unchanged: the schedule or the deadline", () => {
			const t = task("t", { scheduled: day("2026-10-20"), deadline: day("2026-10-01") });
			expect(matchesTaskDate(t, filter("overdue"), CTX)).toBe(true);
			expect(matchesTaskDate(t, filter("overdue"), CTX, "schedule")).toBe(false);
			expect(matchesTaskDate(t, filter("overdue"), CTX, "deadline")).toBe(true);
		});

		it("either is the union of the two fields for every criterion over the grid, open tasks", () => {
			for (const t of GRID.filter((x) => x.status === "open"))
				for (const f of FILTERS) {
					if (f.date === "none" || f.date === "overdue") continue;
					const either = matchesTaskDate(t, f, CTX);
					expect(either, `${t.id} ${f.date}`).toBe(matchesTaskDate(t, f, CTX, "schedule") || matchesTaskDate(t, f, CTX, "deadline"));
				}
		});
	});

	describe("isScheduleMissed", () => {
		it("an open task scheduled before today, in the display zone", () => {
			expect(isScheduleMissed(task("a", { scheduled: day("2026-10-13") }), CTX)).toBe(true);
			expect(isScheduleMissed(task("b", { scheduled: day(TODAY) }), CTX)).toBe(false);
			expect(isScheduleMissed(task("c", { scheduled: timed("2026-10-14T00:05") }), CTX)).toBe(false);
			expect(isScheduleMissed(task("d", { scheduled: timed("2026-10-13T23:30", "America/Los_Angeles") }), CTX)).toBe(false);
		});

		it("a completed task, a task with no schedule and a missed deadline alone are not missed", () => {
			expect(isScheduleMissed(task("a", { scheduled: day("2026-10-01"), status: "completed", completedAt: TS }), CTX)).toBe(false);
			expect(isScheduleMissed(task("b"), CTX)).toBe(false);
			expect(isScheduleMissed(task("c", { deadline: day("2026-10-01") }), CTX)).toBe(false);
		});

		it("the schedule field of overdue is isScheduleMissed over the grid", () => {
			for (const t of GRID) expect(matchesTaskDate(t, filter("overdue"), CTX, "schedule"), t.id).toBe(isScheduleMissed(t, CTX));
		});
	});

	describe("Search keeps reading either date", () => {
		it("a date filter in filterTasks finds a schedule and a deadline", () => {
			const s = task("s", { scheduled: day(TODAY) });
			const d = task("d", { deadline: day(TODAY) });
			const other = task("o", { scheduled: day("2026-10-20"), deadline: day("2026-10-21") });
			const f: TaskFilter = { ...emptyFilter("open"), date: "today" };
			expect(filterTasks([s, d, other], f, "", CTX).map((t) => t.id)).toEqual(["s", "d"]);
		});
	});

	describe("block: due and scheduled over the grid", () => {
		const compiled = (source: string) => {
			const m = compileBlockQuery(parseBlockQuery(source).filters, state, CTX, "Note.md");
			if (m.kind !== "ok") throw new Error(source);
			return m;
		};

		it("due: overdue is exactly isDeadlineMissed", () => {
			const m = compiled("due: overdue");
			for (const t of GRID) expect(m.matches(t), t.id).toBe(isDeadlineMissed(t, CTX));
		});

		it("for an open task, due or scheduled with one value is the either-side rule of the shared owner", () => {
			const rule: [string, ReturnType<typeof filter>][] = [
				["today", filter("today")],
				["overdue", filter("overdue")],
				["this week", filter("range", "2026-10-12", "2026-10-18")],
				["next 7 days", filter("next7")],
			];
			for (const [value, f] of rule) {
				const due = compiled(`due: ${value}`);
				const scheduled = compiled(`scheduled: ${value}`);
				for (const t of GRID.filter((x) => x.status === "open")) {
					expect(due.matches(t) || scheduled.matches(t), `${value} ${t.id}`).toBe(matchesTaskDate(t, f, CTX));
				}
			}
		});

		it("a completed task never matches", () => {
			const done = task("c", { scheduled: day(TODAY), deadline: day(TODAY), status: "completed", completedAt: TS });
			expect(compiled("due: today").matches(done)).toBe(false);
			expect(compiled("scheduled: today").matches(done)).toBe(false);
		});

		it("a timed deadline of today stays today and is not overdue later the same day", () => {
			const m = compiled("due: overdue");
			const t = task("t", { deadline: timed("2026-10-14T08:00") });
			expect(m.matches(t)).toBe(false);
			expect(compiled("due: today").matches(t)).toBe(true);
		});
	});
});

describe("tag lists", () => {
	// `tag:` takes a comma list; a task with any of the tags shows (#52).

	const TS = "2026-09-01T09:00:00.000Z";
	const CTX: QueryContext = { today: "2026-10-14", zone: "Europe/Berlin", upcomingDays: 7, weekStart: "MO" };

	const tag = (key: string, displayName: string, createdAt = TS): Tag => ({ key, displayName, color: null, createdAt, modifiedAt: createdAt });
	const inbox: Category = { id: "inbox", name: "Inbox", icon: null, color: null, nameKey: "inbox", isInbox: true, sortKey: "inbox", createdAt: TS, modifiedAt: TS };
	const task = (id: string, tagKeys: string[]): Task => ({
		id,
		title: id,
		descriptionNote: null,
		categoryId: "inbox",
		tagKeys,
		parentId: null,
		sectionId: null,
		scheduled: null,
		deadline: null,
		plannedDurationMin: null,
		urgent: false,
		important: false,
		priority: 0,
		status: "open",
		completedAt: null,
		recurrence: null,
		sortKey: id,
		createdAt: TS,
		modifiedAt: TS,
	});

	const tags = [tag("home", "Home"), tag("home/calls", "Home/Calls"), tag("home/garden", "Home/Garden"), tag("work", "Work"), tag("errands", "Errands"), tag("homework", "Homework")];
	const tasks = [
		task("call", ["home/calls"]),
		task("garden", ["home/garden"]),
		task("work", ["work"]),
		task("errand", ["errands"]),
		task("both", ["home/calls", "work"]),
		task("homework", ["homework"]),
		task("none", []),
	];
	const state: BlockQueryState = {
		tasks: new Map(tasks.map((t) => [t.id, t])),
		categories: new Map([["inbox", inbox]]),
		sections: new Map(),
		tags: new Map(tags.map((t) => [t.key, t])),
	};

	const run = (source: string) => runBlockQuery(parseBlockQuery(source).filters, state, CTX, "Note.md");
	const ids = (source: string): string[] => {
		const r = run(source);
		if (r.kind === "error") throw new Error(r.message);
		return r.entries.map((e) => e.task.id).sort();
	};

	describe("block matcher: tag list", () => {
		it("a task with any of the tags shows", () => {
			expect(ids("tag: work, errands")).toEqual(["both", "errand", "work"]);
		});

		it("a task with several of the tags shows once", () => {
			const r = run("tag: calls, work");
			expect(r.kind === "ok" && r.entries.map((e) => e.task.id).sort()).toEqual(["both", "call", "work"]);
		});

		it("a parent tag includes its children, next to a second tag", () => {
			expect(ids("tag: home, errands")).toEqual(["both", "call", "errand", "garden"]);
		});

		it("a parent and its own child give the parent's tasks", () => {
			expect(ids("tag: home, home/calls")).toEqual(["both", "call", "garden"]);
		});

		it("a name alone finds the child tag, with or without @, in any casing", () => {
			expect(ids("tag: @Calls, ERRANDS")).toEqual(["both", "call", "errand"]);
		});

		it("a sibling that shares a prefix is not included", () => {
			expect(ids("tag: home, work")).toEqual(["both", "call", "garden", "work"]);
		});

		it("the same tag twice is the same as once", () => {
			expect(ids("tag: work, WORK, @work")).toEqual(ids("tag: work"));
		});

		it("one tag behaves as before", () => {
			expect(ids("tag: home")).toEqual(["both", "call", "garden"]);
		});

		it("an unknown tag in the list is an error naming it", () => {
			expect(run("tag: work, nope")).toEqual({ kind: "error", message: "No tag named “nope”." });
		});

		it("the first unknown tag in typed order is reported", () => {
			expect(run("tag: nope2, work, nope1")).toEqual({ kind: "error", message: "No tag named “nope2”." });
			expect(run("tag: work, nope1, nope2")).toEqual({ kind: "error", message: "No tag named “nope1”." });
		});

		it("a path that is no tag is unknown, even beside a good one", () => {
			expect(run("tag: work, work/calls")).toEqual({ kind: "error", message: "No tag named “work/calls”." });
		});

		it("an unknown tag is reported by compileBlockQuery too", () => {
			expect(compileBlockQuery(parseBlockQuery("tag: work, nope").filters, state, CTX, "Note.md")).toEqual({ kind: "error", message: "No tag named “nope”." });
		});

		it("the compiled test agrees with the run for every task, asked twice", () => {
			const m = compileBlockQuery(parseBlockQuery("tag: home/calls, work, errands").filters, state, CTX, "Note.md");
			if (m.kind !== "ok") throw new Error("expected ok");
			const first = tasks.filter((t) => m.matches(t)).map((t) => t.id);
			expect(first).toEqual(["call", "work", "errand", "both"]);
			expect(tasks.filter((t) => m.matches(t)).map((t) => t.id)).toEqual(first);
		});

		it("combines with the date keys by AND", () => {
			const dated = new Map(state.tasks);
			dated.set("work", { ...task("work", ["work"]), scheduled: { kind: "date", date: "2026-10-14" } });
			const s: BlockQueryState = { ...state, tasks: dated };
			const r = runBlockQuery(parseBlockQuery("tag: work, errands\nscheduled: today").filters, s, CTX, "Note.md");
			expect(r.kind === "ok" && r.entries.map((e) => e.task.id)).toEqual(["work"]);
		});
	});

	describe("resolveTagNames", () => {
		const names = TagNames.of(tags);

		it("resolves each typed name and drops a repeated key, keeping the typed order", () => {
			expect(resolveTagNames(names, ["Work", "calls", "home/calls", "@work"])).toEqual({ keys: ["work", "home/calls"] });
		});

		it("an empty list has no keys", () => {
			expect(resolveTagNames(names, [])).toEqual({ keys: [] });
		});

		it("reports the first name that is no tag, as typed", () => {
			expect(resolveTagNames(names, ["work", "Nope2", "nope1"])).toEqual({ unknown: "Nope2" });
			expect(resolveTagNames(names, ["work/calls", "nope"])).toEqual({ unknown: "work/calls" });
		});
	});
});
