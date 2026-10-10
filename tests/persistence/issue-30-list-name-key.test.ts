import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadText } from "../../src/persistence/CpbaseStore";
import { serializeDb } from "../../src/persistence/serializer";

// A list's stored name key is never trusted: it is recomputed from the name on load, like a section's (#30).

const V5 = readFileSync(join(import.meta.dirname, "..", "fixtures", "schema-v5.cpbase"), "utf8");
const WORK = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const NOW = "2026-10-02T10:00:00.000Z";

type Raw = { categories: Record<string, unknown>[] } & Record<string, unknown>;

function loadMutated(mutate: (raw: Raw) => void) {
	const raw = JSON.parse(V5) as Raw;
	mutate(raw);
	const r = loadText(JSON.stringify(raw), NOW);
	if (r.kind !== "ok") throw new Error(`did not load: ${JSON.stringify(r)}`);
	return r;
}

const work = (raw: Raw) => raw.categories.find((c) => c.id === WORK)!;

describe("list name key repair on load (#30)", () => {
	it("a stored key that differs from the name is recomputed, with one issue naming the list; the repaired file loads clean", () => {
		const r = loadMutated((raw) => (work(raw).nameKey = "stale"));
		expect(r.data.categories.get(WORK)?.nameKey).toBe("work");
		expect(r.issues).toHaveLength(1);
		expect(r.issues[0]).toContain("Work");
		const again = loadText(serializeDb(r.data), NOW);
		expect(again.kind === "ok" && again.issues).toEqual([]);
	});

	it("a missing key is computed without an issue", () => {
		const r = loadMutated((raw) => delete work(raw).nameKey);
		expect(r.data.categories.get(WORK)?.nameKey).toBe("work");
		expect(r.issues).toEqual([]);
	});

	it("a clean file loads with no issues", () => {
		expect(loadMutated(() => {}).issues).toEqual([]);
	});
});
