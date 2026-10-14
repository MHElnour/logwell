import { describe, expect, it } from "vitest";
import { moveSameMoment, moveTimed, moveToDate, resizedDuration, slotRange, slotSpec } from "../../src/domain/calendar";
import { resolveWallTime } from "../../src/domain/time";
import type { DateSpec } from "../../src/domain/types";
import { day } from "../persistence/fixtures";

// Pure drag helpers.

const Z = "Europe/Berlin";
const at = (local: string, tz = Z): DateSpec => ({ kind: "datetime", local, tz });


describe("slotSpec", () => {
	it("snaps to 15 minutes in the display zone", () => {
		expect(slotSpec("2026-10-05", 10 * 60 + 7, Z)).toEqual(at("2026-10-05T10:00"));
		expect(slotSpec("2026-10-05", 10 * 60 + 8, Z)).toEqual(at("2026-10-05T10:15"));
	});
	it("clamps to 00:00 and 23:45", () => {
		expect(slotSpec("2026-10-05", -30, Z)).toEqual(at("2026-10-05T00:00"));
		expect(slotSpec("2026-10-05", 1439, Z)).toEqual(at("2026-10-05T23:45"));
		expect(slotSpec("2026-10-05", 5000, Z)).toEqual(at("2026-10-05T23:45"));
	});
});

describe("moveTimed", () => {
	it("moves by days and minutes, snapped", () => {
		expect(moveTimed(at("2026-10-05T10:00"), Z, 2, 62)).toEqual(at("2026-10-07T11:00"));
		expect(moveTimed(at("2026-10-05T10:00"), Z, -1, -37)).toEqual(at("2026-10-04T09:30"));
		expect(moveTimed(at("2026-10-05T10:00"), Z, 0, 0)).toEqual(at("2026-10-05T10:00"));
	});
	it("clamps inside the target day", () => {
		expect(moveTimed(at("2026-10-05T23:00"), Z, 1, 120)).toEqual(at("2026-10-06T23:45"));
		expect(moveTimed(at("2026-10-05T01:00"), Z, -1, -120)).toEqual(at("2026-10-04T00:00"));
	});
	it("re-anchors a task stored in another zone to the display zone", () => {
		// 09:00 in New York on 2026-10-05 (EDT, UTC-4) is 15:00 in Berlin (CEST, UTC+2).
		expect(moveTimed(at("2026-10-05T09:00", "America/New_York"), Z, 0, 0)).toEqual(at("2026-10-05T15:00"));
		expect(moveTimed(at("2026-10-05T09:00", "America/New_York"), Z, 1, 30)).toEqual(at("2026-10-06T15:30"));
	});
	it("crosses a date line after re-anchoring", () => {
		// 23:00 in Los Angeles (PDT) is 08:00 next day in Berlin.
		expect(moveTimed(at("2026-10-05T23:00", "America/Los_Angeles"), Z, 0, 0)).toEqual(at("2026-10-06T08:00"));
	});
	it("a date-only spec is not a timed move", () => {
		expect(moveTimed(day("2026-10-05"), Z, 1, 0)).toBeNull();
	});
	it("a drop in a spring-forward gap resolves with the existing DST warning", () => {
		const NY = "America/New_York";
		const next = moveTimed(at("2026-03-07T02:30", NY), NY, 1, 0);
		expect(next).toEqual(at("2026-03-08T02:30", NY));
		if (next?.kind !== "datetime") throw new Error("expected a datetime");
		const r = resolveWallTime(next.local, next.tz);
		expect(r.warning).toBe("dst-gap");
		expect(r.local).toBe("2026-03-08T03:30");
	});
	it("a drop in the repeated fall-back hour warns as ambiguous", () => {
		const NY = "America/New_York";
		const next = moveTimed(at("2026-10-31T01:30", NY), NY, 1, 0);
		expect(next).toEqual(at("2026-11-01T01:30", NY));
		if (next?.kind !== "datetime") throw new Error("expected a datetime");
		expect(resolveWallTime(next.local, next.tz).warning).toBe("dst-ambiguous");
	});
});

describe("moveToDate", () => {
	it("moves a date-only spec and keeps it date-only", () => {
		expect(moveToDate(day("2026-10-05"), "2026-10-09", Z)).toEqual(day("2026-10-09"));
	});
	it("keeps the time of day of a timed spec (display zone, re-anchored)", () => {
		expect(moveToDate(at("2026-10-05T10:20"), "2026-10-09", Z)).toEqual(at("2026-10-09T10:20"));
		expect(moveToDate(at("2026-10-05T09:00", "America/New_York"), "2026-10-09", Z)).toEqual(at("2026-10-09T15:00"));
	});
});

describe("moveSameMoment", () => {
	it("is true for the same date or the same display wall time", () => {
		expect(moveSameMoment(day("2026-10-05"), day("2026-10-05"), Z)).toBe(true);
		expect(moveSameMoment(day("2026-10-05"), day("2026-10-06"), Z)).toBe(false);
		expect(moveSameMoment(at("2026-10-05T10:00"), at("2026-10-05T10:00"), Z)).toBe(true);
		expect(moveSameMoment(at("2026-10-05T09:00", "America/New_York"), at("2026-10-05T15:00"), Z)).toBe(true);
		expect(moveSameMoment(at("2026-10-05T10:00"), at("2026-10-05T10:15"), Z)).toBe(false);
	});
	it("is false across kinds and for null", () => {
		expect(moveSameMoment(null, day("2026-10-05"), Z)).toBe(false);
		expect(moveSameMoment(day("2026-10-05"), at("2026-10-05T10:00"), Z)).toBe(false);
	});
});

describe("resizedDuration", () => {
	it("is snapped end minus start", () => {
		expect(resizedDuration(600, 690)).toBe(90);
		expect(resizedDuration(600, 697)).toBe(90);
		expect(resizedDuration(600, 698)).toBe(105);
	});
	it("is at least 15 minutes", () => {
		expect(resizedDuration(600, 600)).toBe(15);
		expect(resizedDuration(600, 500)).toBe(15);
		expect(resizedDuration(600, 607)).toBe(15);
	});
	it("clamps at 24:00 of the start day", () => {
		expect(resizedDuration(1320, 5000)).toBe(120);
		expect(resizedDuration(1425, 1500)).toBe(15);
	});
	it("a no-duration block gains a duration from its start", () => {
		expect(resizedDuration(600, 600 + 30)).toBe(30);
		expect(resizedDuration(600, 600 + 45)).toBe(45);
	});
});

describe("slotRange", () => {
	it("is start to end, or just the start without a duration", () => {
		expect(slotRange("2026-10-05T10:15", 45, Z)).toBe("10:15–11:00");
		expect(slotRange("2026-10-05T10:15", null, Z)).toBe("10:15");
		expect(slotRange("2026-10-05T23:30", 60, Z)).toBe("23:30–00:30");
	});
	it("uses elapsed time across a DST change", () => {
		// 2026-03-29 in Berlin: 02:00 jumps to 03:00, so 01:30 plus 60 elapsed minutes is 03:30.
		expect(slotRange("2026-03-29T01:30", 60, Z)).toBe("01:30–03:30");
	});
});
