import { describe, expect, it } from "vitest";
import { mergeCollections } from "../../src/app/DataService";
import type { Checkin, Habit } from "../../src/domain/types";
import { loadText } from "../../src/persistence/CpbaseStore";
import { CURRENT_SCHEMA_VERSION } from "../../src/persistence/schema";
import { serializeDb } from "../../src/persistence/serializer";
import { emptyDbText, load } from "./fixtures";

// Habits and check-ins are typed and validated.

const habit = (id: string, patch: Partial<Habit> = {}): Habit => ({
	id,
	name: "Read",
	icon: "book",
	color: "purple",
	timeOfDay: "evening",
	reminder: { time: "20:00" },
	archivedAt: null,
	sortKey: "a0",
	createdAt: "2026-09-01T07:00:00.000Z",
	modifiedAt: "2026-10-01T07:00:00.000Z",
	versions: [
		{
			effectiveFrom: "2026-09-01",
			goal: { type: "quantity", target: 30, unit: "min", period: "day" },
			schedule: { kind: "weekdays", days: ["MO", "TU", "WE", "TH", "FR"] },
			weekStart: "MO",
		},
		{ effectiveFrom: "2026-10-01", goal: { type: "quantity", target: 20, unit: "min", period: "day" }, schedule: { kind: "daily" }, weekStart: "MO" },
	],
	...patch,
});

const checkin = (id: string, patch: Partial<Checkin> = {}): Checkin => ({
	id,
	habitId: "h-1",
	date: "2026-10-01",
	value: 20,
	note: null,
	createdAt: "2026-10-01T20:15:00.000Z",
	modifiedAt: "2026-10-01T20:15:00.000Z",
	deletedAt: null,
	...patch,
});

/** The empty database with `habits` and `checkins` written raw. */
function withRaw(habits: unknown[], checkins: unknown[] = []): string {
	const raw = JSON.parse(emptyDbText()) as Record<string, unknown>;
	raw.habits = habits;
	raw.checkins = checkins;
	return JSON.stringify(raw);
}

function loaded(text: string) {
	const r = loadText(text, "2026-10-01T10:00:00.000Z");
	if (r.kind !== "ok") throw new Error(`load failed: ${r.kind}`);
	return r;
}

const lineOf = (text: string, id: string) => text.split("\n").find((l) => l.includes(`"id":"${id}"`))!;

describe("habits and check-ins in the file (D1)", () => {
	it("adds no schema version of its own (v4 is M7's, v5 issue #6's), and the empty database is unchanged", () => {
		expect(CURRENT_SCHEMA_VERSION).toBe(5);
		expect(emptyDbText()).toBe(
			'{"format":"checkpoint-db","schemaVersion":5,"dbId":"db-1","revision":"r-000000000000","baseRevision":null,"history":[],"writtenBy":"d-other","writtenAt":"2026-10-01T08:00:00.000Z",\n' +
				'"categories":[\n{"id":"inbox","name":"Inbox","icon":"📥","nameKey":"inbox","isInbox":true,"sortKey":"0V","createdAt":"2026-10-01T08:00:00.000Z","modifiedAt":"2026-10-01T08:00:00.000Z"}\n],\n' +
				'"sections":[],\n"tags":[],\n"tasks":[],\n"occurrenceRecords":[],\n"habits":[],\n"checkins":[],\n"focusSessions":[],\n"savedFilters":[],\n"trash":[],\n"syncLinks":[]\n}\n',
		);
	});

	it("round-trips byte for byte in the documented key order, defaults left out", () => {
		const base = load(emptyDbText());
		const plain = habit("h-2", { icon: null, color: null, timeOfDay: "anytime", reminder: null, archivedAt: null });
		const text = serializeDb({
			...base,
			habits: new Map([
				["h-1", habit("h-1", { archivedAt: "2026-10-02T09:00:00.000Z" })],
				["h-2", plain],
			]),
			checkins: new Map([
				["c-1", checkin("c-1", { note: "on the train", deletedAt: "2026-10-02T08:00:00.000Z" })],
				["c-2", checkin("c-2")],
			]),
		});
		const h1 = lineOf(text, "h-1");
		const keys = (line: string, names: string[]) => [...line.matchAll(new RegExp(`"(${names.join("|")})":`, "g"))].map((m) => m[1]);
		const habitKeys = ["id", "name", "icon", "color", "timeOfDay", "reminder", "archivedAt", "sortKey", "createdAt", "modifiedAt", "versions"];
		expect(keys(h1, habitKeys)).toEqual(habitKeys);
		const h2 = lineOf(text, "h-2");
		for (const k of ["icon", "color", "timeOfDay", "reminder", "archivedAt"]) expect(h2).not.toContain(`"${k}"`);
		const checkinKeys = ["id", "habitId", "date", "value", "note", "createdAt", "modifiedAt", "deletedAt"];
		expect(keys(lineOf(text, "c-1"), checkinKeys)).toEqual(checkinKeys);
		const c2 = lineOf(text, "c-2");
		expect(c2).not.toContain('"note"');
		expect(c2).not.toContain('"deletedAt"');
		const r = loaded(text);
		expect(r.issues).toEqual([]);
		expect(r.data.habits.get("h-2")).toEqual(plain);
		expect(r.data.checkins.get("c-2")).toEqual(checkin("c-2"));
		expect(serializeDb(r.data)).toBe(text);
	});

	it("keeps a 0.3.0-style record with unknown fields, at the top and inside the versions", () => {
		const h = { ...habit("h-9"), futureField: { a: 1 }, versions: [{ ...habit("h-9").versions[0]!, future: true, goal: { ...habit("h-9").versions[0]!.goal, step: 5 } }] };
		const c = { ...checkin("c-9"), mood: "good" };
		const r = loaded(withRaw([h], [c]));
		expect(r.issues).toEqual([]);
		const rec = r.data.habits.get("h-9") as unknown as Record<string, unknown>;
		expect(rec.futureField).toEqual({ a: 1 });
		expect((rec.versions as Record<string, unknown>[])[0]!.future).toBe(true);
		expect(((rec.versions as Record<string, unknown>[])[0]!.goal as Record<string, unknown>).step).toBe(5);
		expect((r.data.checkins.get("c-9") as unknown as Record<string, unknown>).mood).toBe("good");
		const out = serializeDb(r.data);
		expect(out).toContain('"futureField":{"a":1}');
		expect(out).toContain('"mood":"good"');
		expect(serializeDb(loaded(out).data)).toBe(out);
	});

	it("keeps an orphan check-in silently (its habit may arrive with a later sync)", () => {
		const r = loaded(withRaw([], [checkin("c-1", { habitId: "h-not-yet" })]));
		expect(r.issues).toEqual([]);
		expect(r.data.checkins.get("c-1")?.habitId).toBe("h-not-yet");
	});

	it("an import merge keeps the newer modifiedAt for habits and check-ins", () => {
		const base = load(emptyDbText());
		const mine = {
			...base,
			habits: new Map([["h-1", habit("h-1", { name: "Mine", modifiedAt: "2026-10-03T00:00:00.000Z" })]]),
			checkins: new Map([["c-1", checkin("c-1", { value: 5, modifiedAt: "2026-10-01T20:15:00.000Z" })]]),
		};
		const theirs = {
			...base,
			habits: new Map([["h-1", habit("h-1", { name: "Theirs", modifiedAt: "2026-10-02T00:00:00.000Z" })]]),
			checkins: new Map([["c-1", checkin("c-1", { value: 7, deletedAt: "2026-10-04T00:00:00.000Z", modifiedAt: "2026-10-04T00:00:00.000Z" })]]),
		};
		const merged = mergeCollections(mine, theirs, "2026-10-05T00:00:00.000Z");
		expect(merged.habits.get("h-1")?.name).toBe("Mine");
		expect(merged.checkins.get("c-1")).toMatchObject({ value: 7, deletedAt: "2026-10-04T00:00:00.000Z" });
	});
});

describe("habit repairs on load (D1)", () => {
	it("drops a habit without an id, with an issue", () => {
		const { id: _id, ...noId } = habit("x");
		const r = loaded(withRaw([noId, habit("h-1")]));
		expect([...r.data.habits.keys()]).toEqual(["h-1"]);
		expect(r.issues).toHaveLength(1);
	});

	it("drops a habit whose name is not text, and names a blank one", () => {
		const r = loaded(withRaw([{ ...habit("h-1"), name: 5 }, { ...habit("h-2"), name: "  " }]));
		expect([...r.data.habits.keys()]).toEqual(["h-2"]);
		expect(r.data.habits.get("h-2")?.name).toBe("Untitled habit");
		expect(r.issues).toHaveLength(2);
	});

	it("drops a habit without a readable version", () => {
		const bad = habit("h-1").versions[0]!;
		const r = loaded(
			withRaw([
				{ ...habit("h-1"), versions: [] },
				{ ...habit("h-2"), versions: "daily" },
				{ ...habit("h-3"), versions: [{ ...bad, effectiveFrom: "2026-13-01" }] },
				{ ...habit("h-4"), versions: [{ ...bad, goal: { ...bad.goal, target: 0 } }] },
				{ ...habit("h-5"), versions: [{ ...bad, goal: { ...bad.goal, type: "timer" } }] },
				{ ...habit("h-6"), versions: [{ ...bad, schedule: { kind: "weekdays", days: [] } }] },
				{ ...habit("h-7"), versions: [{ ...bad, schedule: { kind: "weekdays", days: ["XX"] } }] },
				{ ...habit("h-8"), versions: [{ ...bad, goal: { ...bad.goal, period: "month" } }] },
			]),
		);
		expect(r.data.habits.size).toBe(0);
		expect(r.issues).toHaveLength(8);
	});

	it("removes an unreadable version and keeps the habit", () => {
		const [v1, v2] = habit("h-1").versions;
		const r = loaded(withRaw([{ ...habit("h-1"), versions: [v1, { ...v2, schedule: null }] }]));
		expect(r.data.habits.get("h-1")?.versions).toEqual([v1]);
		expect(r.issues).toHaveLength(1);
	});

	it("sorts versions by effectiveFrom", () => {
		const [v1, v2] = habit("h-1").versions;
		const r = loaded(withRaw([{ ...habit("h-1"), versions: [v2, v1] }]));
		expect(r.data.habits.get("h-1")?.versions.map((v) => v.effectiveFrom)).toEqual(["2026-09-01", "2026-10-01"]);
	});

	it("repairs an unknown week start to Monday, with an issue", () => {
		const [v1] = habit("h-1").versions;
		const r = loaded(withRaw([{ ...habit("h-1"), versions: [{ ...v1, weekStart: "TH" }] }]));
		expect(r.data.habits.get("h-1")?.versions[0]?.weekStart).toBe("MO");
		expect(r.issues).toHaveLength(1);
	});

	it("repairs an unknown time of day to anytime, with an issue", () => {
		const r = loaded(withRaw([{ ...habit("h-1"), timeOfDay: "noon" }]));
		expect(r.data.habits.get("h-1")?.timeOfDay).toBe("anytime");
		expect(r.issues).toHaveLength(1);
	});

	it.each([
		["reminder", { time: "8pm" }],
		["reminder", "20:00"],
		["icon", 7],
		["color", "teal"],
		["archivedAt", 12],
	] as const)("clears an unreadable %s, with an issue", (field, value) => {
		const r = loaded(withRaw([{ ...habit("h-1"), [field]: value }]));
		expect((r.data.habits.get("h-1") as unknown as Record<string, unknown>)[field]).toBeNull();
		expect(r.issues).toHaveLength(1);
	});
});

describe("check-in repairs on load (D1)", () => {
	it.each([
		["no id", { id: undefined }],
		["no habit", { habitId: "" }],
		["a bad date", { date: "2026-02-30" }],
		["a value that is not a number", { value: "20" }],
		["a negative value", { value: -1 }],
	])("drops a check-in with %s, with an issue", (_label, patch) => {
		const r = loaded(withRaw([], [{ ...checkin("c-1"), ...patch }, checkin("c-2")]));
		expect([...r.data.checkins.keys()]).toEqual(["c-2"]);
		expect(r.issues).toHaveLength(1);
	});

	it("keeps a zero value", () => {
		expect(loaded(withRaw([], [checkin("c-1", { value: 0 })])).data.checkins.get("c-1")?.value).toBe(0);
	});

	it("clears an unreadable note, with an issue", () => {
		const r = loaded(withRaw([], [{ ...checkin("c-1"), note: { text: "x" } }]));
		expect(r.data.checkins.get("c-1")?.note).toBeNull();
		expect(r.issues).toHaveLength(1);
	});

	it("keeps a check-in with an unreadable deletedAt deleted, with an issue", () => {
		const r = loaded(withRaw([], [{ ...checkin("c-1", { modifiedAt: "2026-10-02T00:00:00.000Z" }), deletedAt: 5 }]));
		expect(r.data.checkins.get("c-1")?.deletedAt).toBe("2026-10-02T00:00:00.000Z");
		expect(r.issues).toHaveLength(1);
	});

	it("review #4: keeps it deleted with a fixed instant when no time is readable", () => {
		const r = loaded(withRaw([], [{ ...checkin("c-1"), deletedAt: 5, modifiedAt: 5, createdAt: null }]));
		expect(r.data.checkins.get("c-1")?.deletedAt).toBe("1970-01-01T00:00:00.000Z");
	});
});
