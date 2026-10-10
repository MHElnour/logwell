import { Settings } from "luxon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeEnd } from "../../src/domain/recurrence";
import type { Recurrence } from "../../src/domain/types";
import { fmtDay, fmtDow, monthTitle, weekTitle } from "../../src/ui/calendar/format";
import { formatDate, formatInstant } from "../../src/ui/format";
import { cellLabel, notScheduledText, stripDays, subText } from "../../src/ui/habits/format";
import { afterCompletionHint } from "../../src/ui/repeat";
import { dayLabel } from "../../src/ui/quickadd/calendar";

// Issue 25: month and weekday names are English everywhere, whatever language the device is set to.

const original = Settings.defaultLocale;
beforeAll(() => {
	Settings.defaultLocale = "fr";
});
afterAll(() => {
	Settings.defaultLocale = original;
});

describe("month and weekday names on a French device", () => {
	it("rows and details", () => {
		expect(formatDate("2026-10-09", "2026-01-01")).toBe("Fri, Oct 9");
		expect(formatDate("2025-03-02", "2026-01-01")).toBe("Mar 2, 2025");
		expect(formatInstant("2026-10-09T10:05:00.000Z", "UTC")).toBe("Oct 9, 2026, 10:05");
	});

	it("the calendar", () => {
		expect(monthTitle("2026-10-14")).toBe("October 2026");
		expect(weekTitle(["2026-09-28", "2026-10-04"])).toBe("Sep 28 – Oct 4, 2026");
		expect(fmtDay("2026-10-08")).toBe("Thu Oct 8");
		expect(fmtDow("2026-10-08")).toBe("Thu");
	});

	it("the Habits page", () => {
		expect(monthTitle("2026-10")).toBe("October 2026");
		expect(notScheduledText("2026-10-10", "2026-10-09")).toBe("Not scheduled Saturday");
		expect(subText("2026-10-04", "2026-10-04", 2, 5)).toBe("Sunday, Oct 4 · 2 of 5 done today");
		expect(cellLabel("2026-10-04", "met")).toBe("Oct 4, goal met");
		const strip = stripDays("2026-10-09", () => ({ met: 1, scheduled: 2 }));
		expect(strip[5]!.name).toBe("Thu");
		expect(strip[5]!.label).toBe("Thu 8, 50% of habits done");
	});

	it("the repeat dialog hint and a repeat end", () => {
		const draft = { freq: "daily", interval: "3", days: [], monthKind: "day" } as never;
		expect(afterCompletionHint(draft, "2026-10-05")).toContain("Done on Oct 5 → next Oct 8.");
		const rec = { end: { kind: "date", date: "2026-12-31" } } as unknown as Recurrence;
		expect(describeEnd(rec)).toBe("ends Dec 31");
	});

	it("the Quick Add date popover", () => {
		expect(dayLabel("2026-10-01")).toBe("Thursday, October 1");
	});
});
