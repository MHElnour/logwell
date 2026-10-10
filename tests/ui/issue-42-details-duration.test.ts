import { describe, expect, it } from "vitest";
import { detailsDateText } from "../../src/ui/format";

// Issue 42: the details line writes a planned duration like a row does ("1h 30m"), not as raw minutes.

const task = (plannedDurationMin: number | null) => ({ scheduled: null, deadline: null, plannedDurationMin });

describe("details line duration", () => {
	it("writes 90 minutes as 1h 30m", () => {
		expect(detailsDateText(task(90), "UTC", "2026-10-10")).toBe("No date · 1h 30m");
	});

	it("writes whole hours and short durations the way formatDuration does", () => {
		expect(detailsDateText(task(120), "UTC", "2026-10-10")).toBe("No date · 2h");
		expect(detailsDateText(task(45), "UTC", "2026-10-10")).toBe("No date · 45m");
	});

	it("puts a repeat before the duration", () => {
		expect(detailsDateText(task(60), "UTC", "2026-10-10", { repeat: "every Fri" })).toBe("No date · every Fri · 1h");
	});

	it("shows nothing for a task without a duration", () => {
		expect(detailsDateText(task(null), "UTC", "2026-10-10")).toBe("No date");
	});
});
