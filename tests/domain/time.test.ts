import { describe, expect, it } from "vitest";
import {
	addDays,
	dateSpecDate,
	dateSpecDisplayLocal,
	isValidDateSpec,
	instantFromNow,
	isValidLocalDate,
	resolveWallTime,
	todayIn,
} from "../../src/domain/time";
import { FakeClock } from "../helpers";

describe("time (TIME-01..03)", () => {
	it("validates date-only and timed specs", () => {
		expect(isValidLocalDate("2026-10-02")).toBe(true);
		expect(isValidLocalDate("2026-02-30")).toBe(false);
		expect(isValidDateSpec({ kind: "date", date: "2026-10-02" })).toBe(true);
		expect(isValidDateSpec({ kind: "datetime", local: "2026-10-02T19:00", tz: "Europe/Berlin" })).toBe(true);
		expect(isValidDateSpec({ kind: "datetime", local: "2026-10-02T19:00", tz: "Mars/Base" })).toBe(false);
		expect(isValidDateSpec({ kind: "date", date: "2026-10-02T10:00" })).toBe(false);
	});

	it("computes today in the display zone", () => {
		const clock = new FakeClock("2026-10-01T23:30:00.000Z");
		expect(todayIn("UTC", clock)).toBe("2026-10-01");
		expect(todayIn("Europe/Berlin", clock)).toBe("2026-10-02");
		expect(todayIn("America/New_York", clock)).toBe("2026-10-01");
	});

	it("gives the instant some time from now, before or after", () => {
		const clock = new FakeClock("2026-10-01T23:30:00.000Z");
		expect(instantFromNow(clock, 10 * 60_000)).toBe("2026-10-01T23:40:00.000Z");
		expect(instantFromNow(clock, -30 * 24 * 3600 * 1000)).toBe("2026-09-01T23:30:00.000Z");
		expect(instantFromNow(clock, 0)).toBe("2026-10-01T23:30:00.000Z");
	});

	it("B17: a spring-forward gap time moves to the first valid time with a warning", () => {
		expect(resolveWallTime("2026-03-08T02:30", "America/New_York")).toEqual({
			local: "2026-03-08T03:30",
			warning: "dst-gap",
		});
		expect(resolveWallTime("2026-03-29T02:30", "Europe/Berlin")).toEqual({
			local: "2026-03-29T03:30",
			warning: "dst-gap",
		});
	});

	it("B18: a repeated fall-back time keeps the earlier offset with a warning", () => {
		const r = resolveWallTime("2026-11-01T01:30", "America/New_York");
		expect(r).toEqual({ local: "2026-11-01T01:30", warning: "dst-ambiguous" });
		expect(resolveWallTime("2026-10-25T02:30", "Europe/Berlin").warning).toBe("dst-ambiguous");
	});

	it("leaves ordinary times alone", () => {
		expect(resolveWallTime("2026-10-02T19:00", "Europe/Berlin")).toEqual({ local: "2026-10-02T19:00", warning: null });
	});

	it("B19: date-only values never move; timed values convert to the display zone", () => {
		const dateOnly = { kind: "date" as const, date: "2026-10-02" };
		expect(dateSpecDate(dateOnly, "Pacific/Auckland")).toBe("2026-10-02");
		expect(dateSpecDate(dateOnly, "America/Los_Angeles")).toBe("2026-10-02");
		const timed = { kind: "datetime" as const, local: "2026-10-02T19:00", tz: "Europe/Berlin" };
		expect(dateSpecDisplayLocal(timed, "Europe/Berlin")).toBe("2026-10-02T19:00");
		expect(dateSpecDisplayLocal(timed, "America/New_York")).toBe("2026-10-02T13:00");
		expect(dateSpecDate(timed, "Pacific/Auckland")).toBe("2026-10-03");
	});

	it("adds days across month ends", () => {
		expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
		expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
	});
});
