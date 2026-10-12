import { describe, expect, it } from "vitest";
import { occurrencesBetween, restartedSeries } from "../../src/domain/recurrence";
import type { Recurrence, Task } from "../../src/domain/types";
import { done, repeating, rule, series } from "./recurrence-fixtures";

// Duplicating a yearly series (#12, Repeating tasks rule 17). A copy keeps the source's dates: one anchored on
// Feb 29 starts on a Feb 29, so it does not fall on Feb 28 for good.

const TODAY = "2025-01-10";
const yearly = (patch: Parameters<typeof rule>[0] = {}) => rule({ freq: "yearly", ...patch });
const withSeries = (rec: Recurrence) => repeating(rec) as Task & { recurrence: Recurrence };

function copyOf(rec: Recurrence, records = [done(rec.anchor)]): Recurrence {
	return restartedSeries(withSeries(rec), records, TODAY, "MO");
}

describe("Duplicate of a yearly series (#12)", () => {
	it("a Feb 29 source: the copy starts on the next Feb 29 of the series and keeps its dates", () => {
		const source = series("2024-02-29", yearly());
		const copy = copyOf(source);
		expect(copy.anchor).toBe("2028-02-29");
		expect(occurrencesBetween(copy, "2025-01-01", "2036-12-31", "MO")).toEqual(occurrencesBetween(source, copy.anchor, "2036-12-31", "MO"));
		expect(occurrencesBetween(copy, "2028-01-01", "2029-12-31", "MO")).toEqual(["2028-02-29", "2029-02-28"]);
	});

	it("a Feb 29 source every 3 years: the copy starts on the first leap year of the series", () => {
		const source = series("2024-02-29", yearly({ interval: 3 }));
		const copy = copyOf(source);
		expect(copy.anchor).toBe("2036-02-29");
		expect(occurrencesBetween(copy, "2025-01-01", "2060-12-31", "MO")).toEqual(occurrencesBetween(source, copy.anchor, "2060-12-31", "MO"));
	});

	it("a source on another day is copied as before: from its current occurrence", () => {
		const source = series("2024-03-14", yearly());
		const copy = copyOf(source);
		expect(copy.anchor).toBe("2025-03-14");
		expect(occurrencesBetween(copy, "2025-01-01", "2032-12-31", "MO")).toEqual(occurrencesBetween(source, copy.anchor, "2032-12-31", "MO"));
	});

	it("a Feb 29 source counting from completion starts on its current occurrence, as before (it counts from the completion)", () => {
		const copy = copyOf(series("2024-02-29", yearly({ afterCompletion: true })));
		expect(copy.anchor).toBe("2025-02-28");
	});
});
