import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classify, LIMITS } from "../../e2e/limits/classify";
import { type Cell, formatCsv, parseCsv } from "../../e2e/limits/csv";
import { generateDb } from "../../e2e/limits/generate";
import { loadText } from "../../src/persistence/CpbaseStore";
import { INBOX_ID } from "../../src/domain/types";
import type { DbData } from "../../src/persistence/schema";

// The limits harness (docs/development/performance.md): its generator must produce valid current-schema (v5) databases, and its CSV
// and result helpers must keep the matrix file intact. The e2e run itself is local only (e2e/limits).

const TODAY = "2026-10-06";
const OPTS = { today: TODAY, zone: "Europe/Berlin", dbId: "limits-test-db" };
const NOW = "2026-10-06T08:00:00.000Z";

function load(text: string): { data: DbData; issues: string[] } {
	const r = loadText(text, NOW);
	if (r.kind !== "ok") throw new Error(`load failed: ${JSON.stringify(r)}`);
	return { data: r.data, issues: r.issues };
}

const matrixText = readFileSync(new URL("./limits-matrix.csv", import.meta.url), "utf8");
const matrix = parseCsv(matrixText);
const header = matrix[0]!.map((c) => c.v);
const col = (row: Cell[], name: string): string => row[header.indexOf(name)]!.v;
const rows = matrix.slice(1).map((r) => ({ dimension: col(r, "dimension"), step: Number(col(r, "step")), count: Number(col(r, "count")) }));

describe("limits matrix", () => {
	it("has 13 dimensions of 5 steps", () => {
		expect(rows).toHaveLength(65);
		expect(new Set(rows.map((r) => r.dimension)).size).toBe(13);
	});

	it("round-trips through the CSV helpers byte for byte", () => {
		expect(formatCsv(matrix)).toBe(matrixText);
	});
});

describe("generateDb: every dimension at step 1 is a valid v5 database", () => {
	for (const row of rows.filter((r) => r.step === 1)) {
		it(`${row.dimension} = ${row.count}`, () => {
			const g = generateDb(row.dimension, row.count, OPTS);
			const { data, issues } = load(g.text);
			expect(issues).toEqual([]);
			expect(data.meta.schemaVersion).toBe(5);
			expect(data.meta.dbId).toBe(OPTS.dbId);
			expect(g.sizeKb).toBeGreaterThan(0);
			// Every marker the harness clicks exists.
			expect(data.categories.get(g.markers.bigListId)?.name).toBe(g.markers.bigListName);
			for (const id of g.markers.completeTaskIds) expect(data.tasks.get(id)?.status).toBe("open");
			expect(g.markers.completeTaskIds.length).toBeGreaterThanOrEqual(3);
		});
	}
});

describe("generateDb: counts", () => {
	const count = (data: DbData, pred: (t: DbData["tasks"] extends ReadonlyMap<string, infer T> ? T : never) => boolean): number => [...data.tasks.values()].filter(pred).length;

	it("is deterministic for the same input and differs for another size", () => {
		expect(generateDb("tasks_total", 1000, OPTS).text).toBe(generateDb("tasks_total", 1000, OPTS).text);
		expect(generateDb("tasks_total", 1000, OPTS).text).not.toBe(generateDb("tasks_total", 1001, OPTS).text);
	});

	it("baseline is 500 tasks, 10 lists, 20 tags, 5 habits, 200 focus records", () => {
		// habits is the only dimension whose step 1 equals the baseline, and it also fixes the check-ins.
		const { data } = load(generateDb("habits", 5, OPTS).text);
		expect(data.tasks.size).toBe(500);
		expect([...data.categories.values()].filter((c) => !c.isInbox)).toHaveLength(10);
		expect(data.tags.size).toBe(20);
		expect(data.habits.size).toBe(5);
		expect(data.focusSessions.size).toBe(200);
		expect(data.checkins.size).toBe(5 * 60);
	});

	it("tasks_total sets the total, subtasks included", () => {
		const { data } = load(generateDb("tasks_total", 1000, OPTS).text);
		expect(data.tasks.size).toBe(1000);
		expect(count(data, (t) => t.parentId !== null)).toBeGreaterThan(0);
	});

	it("tasks_in_one_list puts N tasks in Big list on top of the baseline elsewhere", () => {
		const g = generateDb("tasks_in_one_list", 200, OPTS);
		const { data } = load(g.text);
		expect(count(data, (t) => t.categoryId === g.markers.bigListId)).toBe(200);
		expect(data.tasks.size).toBe(700);
	});

	it("lists makes N named lists", () => {
		const { data } = load(generateDb("lists", 50, OPTS).text);
		expect([...data.categories.values()].filter((c) => !c.isInbox)).toHaveLength(50);
		expect(data.tasks.size).toBe(500);
	});

	it("sections_per_list makes N sections in Big list, each used", () => {
		const g = generateDb("sections_per_list", 20, OPTS);
		const { data } = load(g.text);
		const sections = [...data.sections.values()].filter((s) => s.categoryId === g.markers.bigListId);
		expect(sections).toHaveLength(20);
		const used = new Set([...data.tasks.values()].map((t) => t.sectionId));
		for (const s of sections) expect(used.has(s.id)).toBe(true);
	});

	it("tags makes N tags, and tag_depth a chain of N levels", () => {
		expect(load(generateDb("tags", 100, OPTS).text).data.tags.size).toBe(100);
		const { data } = load(generateDb("tag_depth", 12, OPTS).text);
		const deepest = [...data.tags.keys()].sort((a, b) => b.split("/").length - a.split("/").length)[0]!;
		expect(deepest.split("/")).toHaveLength(12);
		expect(count(data, (t) => t.tagKeys.includes(deepest))).toBeGreaterThan(0);
	});

	it("subtasks_per_task gives one parent N subtasks", () => {
		const g = generateDb("subtasks_per_task", 50, OPTS);
		const { data } = load(g.text);
		expect(count(data, (t) => t.parentId === g.markers.parentTaskId!)).toBe(50);
		expect(data.tasks.get(g.markers.parentTaskId!)?.parentId).toBeNull();
	});

	it("repeating_tasks makes N series with valid rules, some with history", () => {
		const { data } = load(generateDb("repeating_tasks", 100, OPTS).text);
		expect(count(data, (t) => t.recurrence !== null)).toBe(100);
		expect(data.occurrenceRecords.size).toBeGreaterThan(0);
	});

	it("calendar_month puts N timed tasks inside the current month", () => {
		const { data } = load(generateDb("calendar_month", 100, OPTS).text);
		const inMonth = count(data, (t) => t.scheduled?.kind === "datetime" && t.scheduled.local.startsWith("2026-10"));
		expect(inMonth).toBeGreaterThanOrEqual(100);
		expect(count(data, (t) => t.scheduled?.kind === "datetime" && t.scheduled.local.startsWith("2026-10") && t.completedAt !== null)).toBeLessThan(inMonth);
	});

	it("checkins and focus_sessions spread records over the past", () => {
		const c = load(generateDb("checkins", 1000, OPTS).text).data;
		expect(c.checkins.size).toBe(1000);
		const dates = [...c.checkins.values()].map((x) => x.date).sort();
		expect(dates[0]! < "2026-08-01").toBe(true);
		expect(dates[dates.length - 1]! <= TODAY).toBe(true);
		const f = load(generateDb("focus_sessions", 1000, OPTS).text).data;
		expect(f.focusSessions.size).toBe(1000);
		const days = new Set([...f.focusSessions.values()].map((s) => s.startedAt.slice(0, 10)));
		expect(days.size).toBeGreaterThan(30);
	});

	it("title_length adds one task with exactly N characters", () => {
		const g = generateDb("title_length", 10000, OPTS);
		const { data } = load(g.text);
		expect(data.tasks.get(g.markers.longTaskId!)?.title).toHaveLength(10000);
		expect(data.tasks.get(g.markers.longTaskId!)?.categoryId).toBe(INBOX_ID);
	});

	it("today, overdue and upcoming all have content", () => {
		const { data } = load(generateDb("tasks_total", 1000, OPTS).text);
		const on = (pred: (d: string) => boolean) => count(data, (t) => t.status === "open" && t.scheduled !== null && pred(t.scheduled.kind === "date" ? t.scheduled.date : t.scheduled.local.slice(0, 10)));
		expect(on((d) => d === TODAY)).toBeGreaterThan(10);
		expect(on((d) => d < TODAY)).toBeGreaterThan(10);
		expect(on((d) => d > TODAY)).toBeGreaterThan(10);
	});

	it("rejects an unknown dimension", () => {
		expect(() => generateDb("nope", 1, OPTS)).toThrow(/unknown dimension/i);
	});
});

describe("classify", () => {
	const m = (open_ms: number | null, save_ms: number | null, render_ms: number | null, failed = false) => classify({ open_ms, save_ms, render_ms, failed });

	it("passes when every time is under its limit", () => {
		expect(m(999, 199, 299)).toBe("pass");
	});
	it("a time at its limit is slow, not pass", () => {
		expect(m(LIMITS.open, 10, 10)).toBe("slow");
	});
	it("is slow up to three times a limit", () => {
		expect(m(3000, 10, 10)).toBe("slow");
		expect(m(10, 600, 10)).toBe("slow");
		expect(m(10, 10, 900)).toBe("slow");
	});
	it("is broke over three times a limit", () => {
		expect(m(3001, 10, 10)).toBe("broke");
		expect(m(10, 601, 10)).toBe("broke");
		expect(m(10, 10, 901)).toBe("broke");
	});
	it("is broke on a failure, even with good times", () => {
		expect(m(10, 10, 10, true)).toBe("broke");
	});
	it("ignores a metric that was not measured", () => {
		expect(m(500, null, null)).toBe("pass");
	});
});
