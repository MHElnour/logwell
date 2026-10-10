import { describe, expect, it } from "vitest";
import type { SyncLink } from "../../src/domain/types";
import { createEmptyDb } from "../../src/persistence/schema";
import { serializeDb } from "../../src/persistence/serializer";
import { load } from "./fixtures";

// `pendingDelete` and `mode` on a sync link. Optional, left out on write when false or "sync", so a file
// without them (the frozen v5 fixture) reads and writes back unchanged; no schema bump.

const link = (patch: Partial<SyncLink>): SyncLink => ({
	kind: "task",
	logwellId: "t1",
	ttId: "tt1",
	ttProjectId: "p1",
	etag: "e1",
	base: { title: "abcd1234" },
	noteBySync: false,
	lastPulledAt: null,
	modifiedAt: "2026-10-01T10:00:00.000Z",
	...patch,
});

function text(l: SyncLink): string {
	const db = createEmptyDb({ dbId: "db-1", revision: "r-000000000000", deviceId: "d-1", now: "2026-10-01T10:00:00.000Z" });
	return serializeDb({ ...db, syncLinks: new Map([["task:t1", l]]) });
}

describe("sync link flags (issue #6)", () => {
	it("omits false and the default mode, and reads them back unset, exactly as a link without them", () => {
		const t = text(link({ pendingDelete: false, mode: "sync" }));
		expect(t).not.toContain("pendingDelete");
		expect(t).not.toContain('"mode"');
		expect(load(t).syncLinks.get("task:t1")).toEqual(link({}));
	});

	it("writes pendingDelete and the mode before modifiedAt and reads them back", () => {
		const t = text(link({ pendingDelete: true, mode: "excluded" }));
		expect(t).toContain('"pendingDelete":true,"mode":"excluded","modifiedAt"');
		expect(load(t).syncLinks.get("task:t1")).toMatchObject({ pendingDelete: true, mode: "excluded" });
		expect(serializeDb(load(t))).toBe(t);
	});

	it("round-trips the localOnly mode", () => {
		const t = text(link({ mode: "localOnly" }));
		expect(t).toContain('"mode":"localOnly","modifiedAt"');
		expect(load(t).syncLinks.get("task:t1")).toEqual(link({ mode: "localOnly" }));
		expect(serializeDb(load(t))).toBe(t);
	});

	it("refuses a pendingDelete that is not a boolean", () => {
		const t = text(link({ pendingDelete: true })).replace('"pendingDelete":true', '"pendingDelete":"yes"');
		expect(() => load(t)).toThrow();
	});

	it("refuses an unknown mode or one that is not a string", () => {
		const t = text(link({ mode: "excluded" }));
		expect(() => load(t.replace('"mode":"excluded"', '"mode":"paused"'))).toThrow();
		expect(() => load(t.replace('"mode":"excluded"', '"mode":true'))).toThrow();
		expect(() => load(t.replace('"mode":"excluded"', '"mode":null'))).toThrow();
	});
});
