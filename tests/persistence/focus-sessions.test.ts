import { describe, expect, it } from "vitest";
import type { FocusSession } from "../../src/domain/types";
import { loadText } from "../../src/persistence/CpbaseStore";
import { CURRENT_SCHEMA_VERSION } from "../../src/persistence/schema";
import { serializeDb } from "../../src/persistence/serializer";
import { emptyDbText, load } from "./fixtures";

// Focus sessions are typed and validated, and add no schema version of their own.

const session = (id: string, patch: Partial<FocusSession> = {}): FocusSession => ({
	id,
	deviceId: "d-a81",
	taskId: "0b9f",
	taskTitleSnapshot: "Study Python",
	plannedSec: 1500,
	status: "recovered",
	segments: [
		{ start: "2026-10-01T18:00:00.000Z", end: "2026-10-01T18:12:30.000Z" },
		{ start: "2026-10-01T18:15:00.000Z", end: "2026-10-01T18:21:10.000Z" },
	],
	unobserved: [{ start: "2026-10-01T18:21:10.000Z", end: "2026-10-01T18:40:00.000Z", resolution: "excluded" }],
	splitFrom: null,
	startedAt: "2026-10-01T18:00:00.000Z",
	endedAt: "2026-10-01T18:40:00.000Z",
	finalizedAt: "2026-10-01T18:41:02.000Z",
	...patch,
});

/** The empty database with `records` written raw into focusSessions. */
function withRaw(records: unknown[]): string {
	const raw = JSON.parse(emptyDbText()) as Record<string, unknown>;
	raw.focusSessions = records;
	return JSON.stringify(raw);
}

function loaded(text: string) {
	const r = loadText(text, "2026-10-01T10:00:00.000Z");
	if (r.kind !== "ok") throw new Error(`load failed: ${r.kind}`);
	return r;
}

describe("focus sessions in the file (D1)", () => {
	it("adds no schema version of its own (v4 is M7's, v5 issue #6's)", () => {
		expect(CURRENT_SCHEMA_VERSION).toBe(5); // other features bumped it; focus sessions added none
	});

	it("round-trips byte for byte, defaults included", () => {
		const base = load(emptyDbText());
		const sessions = new Map<string, FocusSession>([
			["f-1", session("f-1")],
			["f-2", session("f-2", { taskId: null, splitFrom: null, unobserved: [], status: "stopped" })],
			["f-3", session("f-3", { splitFrom: "f-1", status: "split", unobserved: [] })],
		]);
		const text = serializeDb({ ...base, focusSessions: sessions });
		expect(text).toContain('"taskId":"0b9f"');
		const f2 = text.split("\n").find((l) => l.includes('"id":"f-2"'))!;
		expect(f2).not.toContain("taskId");
		expect(f2).not.toContain("splitFrom");
		expect(f2).not.toContain("unobserved");
		const r = loaded(text);
		expect(r.issues).toEqual([]);
		expect(r.data.focusSessions.get("f-2")).toEqual(session("f-2", { taskId: null, unobserved: [], status: "stopped" }));
		expect(serializeDb(r.data)).toBe(text);
	});

	it("orders the keys of a record as in spec §17.2", () => {
		const base = load(emptyDbText());
		const text = serializeDb({ ...base, focusSessions: new Map([["f-1", session("f-1")]]) });
		const line = text.split("\n").find((l) => l.includes('"id":"f-1"'))!;
		const keys = [...line.matchAll(/"(id|deviceId|taskId|taskTitleSnapshot|plannedSec|status|segments|unobserved|startedAt|endedAt|finalizedAt)":/g)].map((m) => m[1]);
		expect(keys).toEqual([
			"id",
			"deviceId",
			"taskId",
			"taskTitleSnapshot",
			"plannedSec",
			"status",
			"segments",
			"unobserved",
			"startedAt",
			"endedAt",
			"finalizedAt",
		]);
	});

	it("repairs an unknown status to stopped and reports it", () => {
		const r = loaded(withRaw([{ ...session("f-1"), status: "paused-forever" }]));
		expect(r.data.focusSessions.get("f-1")?.status).toBe("stopped");
		expect(r.issues.join(" ")).toMatch(/status/);
	});

	it("repairs an unknown gap resolution to pending and reports it", () => {
		const bad = session("f-1");
		const r = loaded(withRaw([{ ...bad, unobserved: [{ ...bad.unobserved[0], resolution: "maybe" }] }]));
		expect(r.data.focusSessions.get("f-1")?.unobserved[0]?.resolution).toBe("pending");
		expect(r.issues.join(" ")).toMatch(/resolution|gap/i);
	});

	it("drops a record whose segments cannot be read, with an issue, and keeps the rest", () => {
		const r = loaded(withRaw([{ ...session("f-1"), segments: "nope" }, session("f-2"), { ...session("f-3"), segments: [{ start: 5 }] }]));
		expect([...r.data.focusSessions.keys()]).toEqual(["f-2"]);
		expect(r.issues.filter((i) => /focus/i.test(i))).toHaveLength(2);
	});

	it("drops a gap that cannot be read, with an issue", () => {
		const bad = session("f-1");
		const r = loaded(withRaw([{ ...bad, unobserved: [{ start: "x" }, bad.unobserved[0]] }]));
		expect(r.data.focusSessions.get("f-1")?.unobserved).toEqual(bad.unobserved);
		expect(r.issues.length).toBeGreaterThan(0);
	});

	it("drops a record without an id, with an issue", () => {
		const { id: _id, ...noId } = session("x");
		const r = loaded(withRaw([noId]));
		expect(r.data.focusSessions.size).toBe(0);
		expect(r.issues.length).toBe(1);
	});

	it("loads a 0.1.1-style opaque record with extra fields and writes them back unchanged", () => {
		const opaque = { ...session("f-9"), futureField: { a: 1 }, note: "from a newer build" };
		const text = withRaw([opaque]);
		const r = loaded(text);
		expect(r.issues).toEqual([]);
		const rec = r.data.focusSessions.get("f-9") as unknown as Record<string, unknown>;
		expect(rec.futureField).toEqual({ a: 1 });
		expect(rec.note).toBe("from a newer build");
		const out = serializeDb(r.data);
		const again = loaded(out);
		expect(serializeDb(again.data)).toBe(out);
		expect(out).toContain('"futureField":{"a":1}');
	});

	it("fills defaults for fields an older writer left out", () => {
		const { taskId: _t, splitFrom: _s, unobserved: _u, ...lean } = session("f-1");
		const r = loaded(withRaw([lean]));
		expect(r.data.focusSessions.get("f-1")).toMatchObject({ taskId: null, splitFrom: null, unobserved: [] });
	});

	it("keeps extra fields on segments, like gaps (A7)", () => {
		const s0 = session("f-1");
		const seg = { ...s0.segments[0], device: "d-future" };
		const r = loaded(withRaw([{ ...s0, segments: [seg] }]));
		expect(r.data.focusSessions.get("f-1")?.segments[0]).toEqual(seg);
		expect(serializeDb(r.data)).toContain('"device":"d-future"');
	});

	it("reads an empty taskId as no task (A7)", () => {
		const r = loaded(withRaw([{ ...session("f-1"), taskId: "" }]));
		expect(r.data.focusSessions.get("f-1")?.taskId).toBeNull();
	});

	it("P3: a record with setId and setRounds round-trips byte for byte, next to splitFrom", () => {
		const base = load(emptyDbText());
		const text = serializeDb({ ...base, focusSessions: new Map([["f-1", session("f-1", { setId: "set-1", setRounds: 4, status: "completed" })]]) });
		const line = text.split("\n").find((l) => l.includes('"id":"f-1"'))!;
		expect(line).toContain('"setId":"set-1","setRounds":4');
		const r = loaded(text);
		expect(r.issues).toEqual([]);
		expect(r.data.focusSessions.get("f-1")).toMatchObject({ setId: "set-1", setRounds: 4 });
		expect(serializeDb(r.data)).toBe(text);
	});

	it("P2: setRound round-trips after setRounds; an unreadable one is dropped with an issue", () => {
		const base = load(emptyDbText());
		const text = serializeDb({ ...base, focusSessions: new Map([["f-1", session("f-1", { setId: "set-1", setRounds: 4, setRound: 3, status: "completed" })]]) });
		expect(text.split("\n").find((l) => l.includes('"id":"f-1"'))).toContain('"setRounds":4,"setRound":3');
		const ok = loaded(text);
		expect(ok.issues).toEqual([]);
		expect(ok.data.focusSessions.get("f-1")?.setRound).toBe(3);
		expect(serializeDb(ok.data)).toBe(text);
		const bad = loaded(withRaw([{ ...session("f-1"), setRound: 0 }]));
		expect(bad.data.focusSessions.get("f-1")!.setRound).toBeUndefined();
		expect(bad.issues.length).toBe(1);
	});

	it("P2: a round number above the set size is dropped with an issue (hand-edited files)", () => {
		const r = loaded(withRaw([{ ...session("f-1"), setId: "s", setRounds: 4, setRound: 1000000000 }]));
		expect(r.data.focusSessions.get("f-1")!.setRound).toBeUndefined();
		expect(r.data.focusSessions.get("f-1")!.setRounds).toBe(4);
		expect(r.issues.length).toBe(1);
	});

	it("P3: an old record without them loads without the keys and writes back byte for byte", () => {
		const base = load(emptyDbText());
		const text = serializeDb({ ...base, focusSessions: new Map([["f-1", session("f-1")]]) });
		expect(text).not.toContain("setId");
		expect(text).not.toContain("setRounds");
		const r = loaded(text);
		const rec = r.data.focusSessions.get("f-1")!;
		expect(Object.keys(rec)).not.toContain("setId");
		expect(Object.keys(rec)).not.toContain("setRounds");
		expect(serializeDb(r.data)).toBe(text);
		expect(CURRENT_SCHEMA_VERSION).toBe(5); // other features bumped it; focus sessions added none
	});

	it("P3: an unreadable setId or setRounds is dropped with an issue", () => {
		const r = loaded(withRaw([{ ...session("f-1"), setId: 7, setRounds: "four" }]));
		const rec = r.data.focusSessions.get("f-1")!;
		expect(rec.setId).toBeUndefined();
		expect(rec.setRounds).toBeUndefined();
		expect(r.issues.length).toBe(2);
	});

	it("clean-up 3: modifiedAt round-trips byte for byte after finalizedAt; records without it stay without", () => {
		const base = load(emptyDbText());
		const withIt = session("f-1", { modifiedAt: "2026-10-02T09:00:00.000Z" });
		const text = serializeDb({ ...base, focusSessions: new Map([["f-1", withIt], ["f-2", session("f-2")]]) });
		const l1 = text.split("\n").find((l) => l.includes('"id":"f-1"'))!;
		expect(l1).toContain('"finalizedAt":"2026-10-01T18:41:02.000Z","modifiedAt":"2026-10-02T09:00:00.000Z"');
		expect(text.split("\n").find((l) => l.includes('"id":"f-2"'))!).not.toContain("modifiedAt");
		const r = loaded(text);
		expect(r.issues).toEqual([]);
		expect(r.data.focusSessions.get("f-1")?.modifiedAt).toBe("2026-10-02T09:00:00.000Z");
		expect(Object.keys(r.data.focusSessions.get("f-2")!)).not.toContain("modifiedAt");
		expect(serializeDb(r.data)).toBe(text);
	});

	it("clean-up 3: an unreadable modifiedAt is dropped with an issue", () => {
		const r = loaded(withRaw([{ ...session("f-1"), modifiedAt: 5 }]));
		expect(r.data.focusSessions.get("f-1")!.modifiedAt).toBeUndefined();
		expect(r.issues.length).toBe(1);
		const r2 = loaded(withRaw([{ ...session("f-1"), modifiedAt: "yesterday" }]));
		expect(r2.data.focusSessions.get("f-1")!.modifiedAt).toBeUndefined();
		expect(r2.issues.length).toBe(1);
	});
});
