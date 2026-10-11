import { describe, expect, it } from "vitest";
import { type BlockQueryState, compileBlockQuery } from "../../src/domain/blockQuery";
import { type QueryContext, type TaskFilter, emptyFilter, filterTasks, isDeadlineMissed, isScheduleMissed, matchesTaskDate } from "../../src/domain/queries";
import type { Category, DateSpec, Task } from "../../src/domain/types";
import { parseBlockQuery } from "../../src/parsing/blockQuery";

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
