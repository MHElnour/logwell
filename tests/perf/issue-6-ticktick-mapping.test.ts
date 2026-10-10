import { describe, expect, it } from "vitest";
import { dateFromTt, dateToTt, fieldHashes, type SyncFields } from "../../src/domain/ticktick/mapping";
import type { TtTask } from "../../src/domain/ticktick/types";
import type { DateSpec } from "../../src/domain/types";

// The field mapping runs once per linked task on every sync. 50,000 tasks (the target scale of
// docs/development/performance.md) must map within budget: a realistic spread of dates (two years of days, a
// quarter of them timed, three zones), deterministic.

const TASKS = 50_000;
// Same allowance as the other perf tests: CI runners are two to three times slower.
const CI_SLACK = process.env.CI ? 4 : 1;
const BUDGET_MS = 200 * CI_SLACK;
const ZONES = ["Europe/Moscow", "America/New_York", "UTC"];
const DISPLAY = "Europe/Berlin";

const pad = (n: number): string => String(n).padStart(2, "0");
const day = (n: number): string => new Date(Date.UTC(2026, 0, 1) + (n % 730) * 86_400_000).toISOString().slice(0, 10);

const specs: DateSpec[] = [];
for (let i = 0; i < TASKS; i++) {
	specs.push(
		i % 4 === 0
			? { kind: "datetime", local: `${day(i)}T${pad(i % 24)}:${pad((i * 7) % 4 * 15)}`, tz: ZONES[i % ZONES.length] ?? "UTC" }
			: { kind: "date", date: day(i) },
	);
}

/** Median of 5 runs after one warm-up run (as the other perf tests): `run` is called 6 times. */
const RUNS = 6;
function timeIt(run: () => void): number {
	const once = (): number => {
		const start = performance.now();
		run();
		return performance.now() - start;
	};
	once();
	const times = Array.from({ length: RUNS - 1 }, once).sort((a, b) => a - b);
	return times[Math.floor(times.length / 2)]!;
}

describe("TickTick mapping at 50,000 tasks (issue #6)", () => {
	it("dateToTt maps every task within budget", () => {
		let sink = 0;
		const ms = timeIt(() => {
			for (const spec of specs) sink += dateToTt(spec, DISPLAY).dueDate.length;
		});
		expect(sink).toBeGreaterThan(0);
		expect(ms).toBeLessThan(BUDGET_MS);
	});

	it("dateFromTt maps every task within budget", () => {
		const tasks: Pick<TtTask, "startDate" | "dueDate" | "isAllDay" | "timeZone">[] = specs.map((s) => dateToTt(s, DISPLAY));
		let sink = 0;
		const ms = timeIt(() => {
			for (const t of tasks) sink += dateFromTt(t, DISPLAY)?.kind.length ?? 0;
		});
		expect(sink).toBeGreaterThan(0);
		expect(ms).toBeLessThan(BUDGET_MS);
	});

	it("fieldHashes hashes every task within budget", () => {
		let sink = 0;
		const ms = timeIt(() => {
			for (let i = 0; i < TASKS; i++) {
				const fields: SyncFields = {
					title: `Task number ${i} with a title of ordinary length`,
					status: i % 2 === 0 ? "open" : "completed",
					priority: (i % 4) as 0 | 1 | 2 | 3,
					date: specs[i] ?? null,
					parent: i % 5 === 0 ? `parent-${i}` : null,
					section: i % 3 === 0 ? `section-${i % 9}` : null,
					tags: i % 4 === 0 ? ["calls", "errands"] : [],
				};
				sink += fieldHashes(fields).title?.length ?? 0;
			}
		});
		expect(sink).toBe(TASKS * 8 * RUNS);
		expect(ms).toBeLessThan(BUDGET_MS);
	});
});
