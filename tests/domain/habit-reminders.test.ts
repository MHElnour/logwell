import { describe, expect, it } from "vitest";
import {
	checkReminders,
	emptyReminderState,
	markFired,
	parseReminderState,
	type ReminderState,
	SNOOZE_MIN,
	snooze,
} from "../../src/domain/habitReminders";
import { ci, habit, idx, ver } from "./habit-fixtures";

// The reminder due rule, pure. 2026-10-14 is a Wednesday; Berlin is UTC+2 then.

const DAY = "2026-10-14";
const at = (time: string, date = DAY) => {
	const [h, m] = time.split(":").map(Number) as [number, number];
	const instant = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), h - 2, m)).toISOString();
	return { date, time, instant };
};
const read = habit("r", [ver("2026-09-01", { type: "quantity", target: 30, unit: "min" })], { name: "Read", reminder: { time: "20:00" } });
/** A state that has already seen the reminder times, so nothing is armed by the check. */
const seen = (date = DAY, times: Record<string, string> = { r: "20:00" }): ReminderState => ({ ...emptyReminderState(date), times });

describe("checkReminders", () => {
	it("is due at the minute and not before", () => {
		expect(checkReminders([read], idx(), seen(), at("19:59")).due).toEqual([]);
		expect(checkReminders([read], idx(), seen(), at("20:00")).due).toEqual([read]);
		expect(checkReminders([read], idx(), seen(), at("23:59")).due).toEqual([read]);
	});

	it("is not due when the goal is met, but is while it is only partly done", () => {
		expect(checkReminders([read], idx(ci("r", DAY, 30)), seen(), at("20:00")).due).toEqual([]);
		expect(checkReminders([read], idx(ci("r", DAY, 20)), seen(), at("20:00")).due).toEqual([read]);
	});

	it("weekly rule: due while the week is not met and today has no check-in", () => {
		const gym = habit("g", [ver("2026-09-01", { target: 3, period: "week" }, { kind: "weekly" })], { reminder: { time: "18:00" } });
		const s = seen(DAY, { g: "18:00" });
		expect(checkReminders([gym], idx(ci("g", "2026-10-12")), s, at("18:00")).due).toEqual([gym]);
		expect(checkReminders([gym], idx(ci("g", "2026-10-12"), ci("g", DAY)), s, at("18:00")).due).toEqual([]);
		const lastWeekToo = idx(ci("g", "2026-10-12"), ci("g", "2026-10-13"), ci("g", "2026-10-11"), ci("g", "2026-10-10"));
		// MO weeks: Oct 12 and 13 are this week; 10 and 11 the week before. Still 2 of 3.
		expect(checkReminders([gym], lastWeekToo, s, at("18:00")).due).toEqual([gym]);
		const metWeek = idx(ci("g", "2026-10-12"), ci("g", "2026-10-13"), ci("g", "2026-10-14"));
		expect(checkReminders([gym], metWeek, s, at("18:00")).due).toEqual([]);
		const three = idx(ci("g", "2026-10-12"), ci("g", "2026-10-13"), ci("g", "2026-10-12", 1, { createdAt: "2026-10-12T21:00:00.000Z" }));
		// A binary day counts once: still 2 of 3 days.
		expect(checkReminders([gym], three, s, at("18:00")).due).toEqual([gym]);
		const gymCount = habit("g", [ver("2026-09-01", { type: "count", target: 3, period: "week" }, { kind: "weekly" })], { reminder: { time: "18:00" } });
		expect(checkReminders([gymCount], three, s, at("18:00")).due).toEqual([]);
	});

	it("is not due on an unscheduled day, for an archived habit, or without a reminder", () => {
		const mwf = { ...read, versions: [ver("2026-09-01", {}, { kind: "weekdays", days: ["MO", "FR"] })] };
		expect(checkReminders([mwf], idx(), seen(), at("20:00")).due).toEqual([]);
		expect(checkReminders([{ ...read, archivedAt: "2026-10-01T00:00:00.000Z" }], idx(), seen(), at("20:00")).due).toEqual([]);
		expect(checkReminders([{ ...read, reminder: null }], idx(), seen(), at("20:00")).due).toEqual([]);
	});

	it("fires once a day: markFired keeps it quiet until the date changes", () => {
		const first = checkReminders([read], idx(), seen(), at("20:00"));
		const fired = markFired(first.state, ["r"]);
		expect(checkReminders([read], idx(), fired, at("20:30")).due).toEqual([]);
		const next = checkReminders([read], idx(), fired, at("20:00", "2026-10-15"));
		expect(next.due).toEqual([read]);
		expect(next.state).toMatchObject({ date: "2026-10-15", fired: {}, snoozedUntil: {}, times: { r: "20:00" } });
	});

	it("a date change resets fired and snoozed but keeps the times, so a reminder missed while closed catches up", () => {
		const old: ReminderState = { v: 1, date: "2026-10-13", fired: { r: true }, snoozedUntil: { r: "2026-10-13T18:10:00.000Z" }, times: { r: "20:00" } };
		const r = checkReminders([read], idx(), old, at("21:00"));
		expect(r.due).toEqual([read]);
		expect(r.state).toEqual({ v: 1, date: DAY, fired: {}, snoozedUntil: {}, times: { r: "20:00" } });
	});

	it(`snooze: quiet for ${SNOOZE_MIN} minutes, then due again while not met`, () => {
		const shown = markFired(checkReminders([read], idx(), seen(), at("20:00")).state, ["r"]);
		const snoozed = snooze(shown, "r", at("20:10").instant);
		expect(snoozed.fired).toEqual({});
		expect(checkReminders([read], idx(), snoozed, at("20:09")).due).toEqual([]);
		expect(checkReminders([read], idx(), snoozed, at("20:10")).due).toEqual([read]);
		expect(markFired(snoozed, ["r"])).toMatchObject({ fired: { r: true }, snoozedUntil: {} });
	});

	it("a check-in during a snooze clears it for the day", () => {
		const snoozed = snooze(seen(), "r", at("20:10").instant);
		const met = checkReminders([read], idx(ci("r", DAY, 30)), snoozed, at("20:05"));
		expect(met.due).toEqual([]);
		expect(met.state.snoozedUntil).toEqual({});
		expect(met.state.fired).toEqual({ r: true });
		// The check-in is undone later: the reminder stays quiet today.
		expect(checkReminders([read], idx(), met.state, at("20:30")).due).toEqual([]);
	});

	it("a new reminder time already past is armed for tomorrow, not fired", () => {
		const first = checkReminders([read], idx(), null, at("21:00"));
		expect(first.due).toEqual([]);
		expect(first.state).toEqual({ v: 1, date: DAY, fired: { r: true }, snoozedUntil: {}, times: { r: "20:00" } });
		expect(checkReminders([read], idx(), first.state, at("20:00", "2026-10-15")).due).toEqual([read]);
		// Not yet past: it fires today at its minute.
		const early = checkReminders([read], idx(), null, at("19:00"));
		expect(early.state.fired).toEqual({});
		expect(checkReminders([read], idx(), early.state, at("20:00")).due).toEqual([read]);
	});

	it("a changed time is armed when already past, and fires again today when it moves later", () => {
		const moved = { ...read, reminder: { time: "20:30" } };
		const past = checkReminders([moved], idx(), seen(DAY, { r: "08:00" }), at("21:00"));
		expect(past.due).toEqual([]);
		expect(past.state.fired).toEqual({ r: true });
		const fired = markFired(seen(), ["r"]);
		const later = { ...read, reminder: { time: "22:00" } };
		const r = checkReminders([later], idx(), fired, at("21:00"));
		expect(r.state.fired).toEqual({});
		expect(r.state.times).toEqual({ r: "22:00" });
		expect(checkReminders([later], idx(), r.state, at("22:00")).due).toEqual([later]);
	});

	it("drops the times of habits whose reminder is gone, and returns the same state when nothing changed", () => {
		const s = seen(DAY, { r: "20:00", gone: "07:00" });
		const r = checkReminders([read], idx(), s, at("10:00"));
		expect(r.state.times).toEqual({ r: "20:00" });
		const again = checkReminders([read], idx(), r.state, at("10:01"));
		expect(again.state).toBe(r.state);
	});

	it("orders several due reminders by time, then by list order", () => {
		const a = habit("a", [ver("2026-09-01")], { sortKey: "b", reminder: { time: "19:00" } });
		const b = habit("b", [ver("2026-09-01")], { sortKey: "a", reminder: { time: "19:00" } });
		const c = habit("c", [ver("2026-09-01")], { sortKey: "0", reminder: { time: "20:00" } });
		const s = seen(DAY, { a: "19:00", b: "19:00", c: "20:00" });
		expect(checkReminders([c, a, b], idx(), s, at("21:00")).due.map((h) => h.id)).toEqual(["b", "a", "c"]);
	});
});

describe("edge minutes and zero values", () => {
	it("a time set for the next minute fires when it is first seen at its own minute", () => {
		// Set at 19:59:45 for 20:00; the host's first check after the save is at 20:00:05.
		const r = checkReminders([read], idx(), seen(DAY, {}), at("20:00"));
		expect(r.due).toEqual([read]);
		expect(r.state.times).toEqual({ r: "20:00" });
		expect(r.state.fired).toEqual({});
	});

	it("a time first seen after its minute is armed, not fired", () => {
		const r = checkReminders([read], idx(), seen(DAY, {}), at("20:07"));
		expect(r.due).toEqual([]);
		expect(r.state.fired).toEqual({ r: true });
	});

	it("a check-in of value 0 does not silence the reminder", () => {
		const gym = habit("g", [ver("2026-09-01", { type: "quantity", target: 30, unit: "km", period: "week" }, { kind: "weekly" })], { reminder: { time: "18:00" } });
		expect(checkReminders([gym], idx(ci("g", DAY, 0)), seen(DAY, { g: "18:00" }), at("18:00")).due).toEqual([gym]);
		const med = habit("m", [ver("2026-09-01")], { reminder: { time: "18:00" } });
		expect(checkReminders([med], idx(ci("m", DAY, 0)), seen(DAY, { m: "18:00" }), at("18:00")).due).toEqual([med]);
	});
});

describe("parseReminderState", () => {
	const good: ReminderState = { v: 1, date: DAY, fired: { r: true }, snoozedUntil: { s: "2026-10-14T18:10:00.000Z" }, times: { r: "20:00" } };

	it("reads what it wrote", () => {
		expect(parseReminderState(JSON.parse(JSON.stringify(good)))).toEqual(good);
		expect(parseReminderState(emptyReminderState(DAY))).toEqual(emptyReminderState(DAY));
	});

	it.each([
		["null", null],
		["a string", "{}"],
		["a foreign version", { ...good, v: 2 }],
		["no version", { ...good, v: undefined }],
		["a bad date", { ...good, date: "14.10.2026" }],
		["a missing map", { ...good, times: undefined }],
		["a fired value that is not true", { ...good, fired: { r: false } }],
		["an unreadable snooze time", { ...good, snoozedUntil: { s: "soon" } }],
		["an unreadable reminder time", { ...good, times: { r: "8pm" } }],
	])("gives null for %s", (_label, raw) => {
		expect(parseReminderState(raw)).toBeNull();
	});
});
