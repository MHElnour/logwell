import { Settings } from "luxon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeEnd } from "../../src/domain/recurrence";
import type { Recurrence } from "../../src/domain/types";
import { fmtDay, fmtDow, monthTitle, weekTitle } from "../../src/ui/calendar/format";
import { formatDate, formatInstant } from "../../src/ui/format";
import { cellLabel, checkinWhen, monthOf, notScheduledText, stripDays, subText } from "../../src/ui/habits/format";
import { monthStart, shiftMonth, yearMonthOf } from "../../src/domain/time";
import { timeRange } from "../../src/ui/focus/format";
import { slotRange } from "../../src/domain/calendar";
import { exportFolderName } from "../../src/app/DataService";
import type { Checkin } from "../../src/domain/types";
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

describe("digits on a device whose language writes other digits", () => {
	// Arabic (Egypt) writes numbers with its own digits by default; Logwell always writes 0 to 9.

	let before: string;
	beforeAll(() => {
		before = Settings.defaultLocale;
		Settings.defaultLocale = "ar-EG";
	});
	afterAll(() => {
		Settings.defaultLocale = before;
	});

	it("#100: the Habits page steps months with the digits 0 to 9", () => {
		const step = (month: string, by: number) => monthOf(monthStart(shiftMonth(yearMonthOf(month), by)));
		expect(step("2026-10", 1)).toBe("2026-11");
		expect(step("2026-01", -1)).toBe("2025-12");
		expect(step("2026-12", 1)).toBe("2027-01");
		expect(step("0001-01", -1)).toBe("0000-12");
	});

	it("#100: times and dates shown on the Habits page, the focus timer, the calendar, rows and an export folder use the digits 0 to 9", () => {
		const c = { date: "2026-10-09", createdAt: "2026-10-09T08:05:00.000Z" } as Checkin;
		expect(checkinWhen(c, "Europe/Berlin")).toBe("10:05");
		expect(timeRange({ startedAt: "2026-10-09T08:05:00.000Z", endedAt: "2026-10-09T08:30:00.000Z" }, "Europe/Berlin")).toBe("10:05–10:30");
		expect(slotRange("2026-10-05T10:15", 45, "Europe/Berlin")).toBe("10:15–11:00");
		expect(exportFolderName(new Date("2026-10-05T12:34:00.000Z"), "Europe/Berlin")).toBe("Logwell export 2026-10-05 1434");
		expect(formatDate("2025-03-02", "2026-01-01")).toBe("Mar 2, 2025");
		expect(formatInstant("2026-10-09T10:05:00.000Z", "UTC")).toBe("Oct 9, 2026, 10:05");
		expect(weekTitle(["2026-09-28", "2026-10-04"])).toBe("Sep 28 – Oct 4, 2026");
	});
});
