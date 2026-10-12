import { describe, expect, it } from "vitest";
import { occurrencesBetween, restartedSeries } from "../../src/domain/recurrence";
import type { Recurrence, Task } from "../../src/domain/types";
import { done, repeating, rule, series } from "./recurrence-fixtures";

// Duplicating a yearly series (#12, Repeating tasks rule 17). The copy starts on the source's current occurrence
// and takes its month and day from there. A copy of a Feb 29 series is anchored on Feb 28 (the clamped date), so
// it falls on Feb 28 in leap years too: one day before the original.

const TODAY = "2025-01-10";
const yearly = (patch: Parameters<typeof rule>[0] = {}) => rule({ freq: "yearly", ...patch });
const withSeries = (rec: Recurrence) => repeating(rec) as Task & { recurrence: Recurrence };

function copyOf(rec: Recurrence, records = [done(rec.anchor)]): Recurrence {
	return restartedSeries(withSeries(rec), records, TODAY, "MO");
}

describe("Duplicate of a yearly series (#12)", () => {
	it("a Feb 29 source: the copy is anchored on Feb 28 and stays there in leap years", () => {
		const source = series("2024-02-29", yearly());
		const copy = copyOf(source);
		expect(copy.anchor).toBe("2025-02-28");
		expect(occurrencesBetween(copy, "2025-01-01", "2028-12-31", "MO")).toEqual(["2025-02-28", "2026-02-28", "2027-02-28", "2028-02-28"]);
		expect(occurrencesBetween(source, "2028-01-01", "2028-12-31", "MO")).toEqual(["2028-02-29"]);
	});

	it("a Feb 29 source every 3 years: the copy keeps the interval from Feb 28", () => {
		const copy = copyOf(series("2024-02-29", yearly({ interval: 3 })));
		expect(copy.anchor).toBe("2027-02-28");
		expect(occurrencesBetween(copy, "2025-01-01", "2036-12-31", "MO")).toEqual(["2027-02-28", "2030-02-28", "2033-02-28", "2036-02-28"]);
	});

	it("a source on another day keeps its dates", () => {
		const source = series("2024-03-14", yearly());
		const copy = copyOf(source);
		expect(copy.anchor).toBe("2025-03-14");
		expect(occurrencesBetween(copy, "2025-01-01", "2032-12-31", "MO")).toEqual(occurrencesBetween(source, copy.anchor, "2032-12-31", "MO"));
	});

	it("a Feb 29 source counting from completion starts on its current occurrence (it counts from the completion)", () => {
		const copy = copyOf(series("2024-02-29", yearly({ afterCompletion: true })));
		expect(copy.anchor).toBe("2025-02-28");
	});
});
