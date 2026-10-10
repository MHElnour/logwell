import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadText } from "../../src/persistence/CpbaseStore";
import { applyOps } from "../../src/persistence/journal";
import { CURRENT_SCHEMA_VERSION } from "../../src/persistence/schema";
import { serializeDb } from "../../src/persistence/serializer";

// Repairs on load for sections and Task.sectionId. Each one records an issue.

const V3 = readFileSync(join(import.meta.dirname, "..", "fixtures", "schema-v3.cpbase"), "utf8");
const STUDY = "5e0d1c2b-3a49-4f58-8e67-7d6c5b4a3921";
const WORK = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const WEEK1 = "a1b2c3d4-0001-4a00-8000-00000000a001";
const TRIAGE = "b2c3d4e5-0003-4b00-8000-00000000b003";
const PARENT = "0b9f6c1e-6a52-4c39-9a7c-5f2f0f4f8a11";
const SUB = "1c0a7d2f-7b63-4d4a-8b8d-6a3a1a5b9b22";
const INVOICE = "9c3d4e5f-6a7b-4c8d-ae9f-1a2b3c4d5e6f";
const NOW = "2026-10-02T10:00:00.000Z";

type Raw = { sections: Record<string, unknown>[]; tasks: Record<string, unknown>[] } & Record<string, unknown>;

function loadMutated(mutate: (raw: Raw) => void) {
	const raw = JSON.parse(V3) as Raw;
	mutate(raw);
	const r = loadText(JSON.stringify(raw), NOW);
	return r;
}

function ok(r: ReturnType<typeof loadText>) {
	if (r.kind !== "ok") throw new Error(`did not load: ${JSON.stringify(r)}`);
	return r;
}

const taskRow = (raw: Raw, id: string) => raw.tasks.find((t) => t.id === id)!;

describe("section repairs on load (K1b D3)", () => {
	it("a sectionId that names a missing section is cleared, with an issue", () => {
		const r = ok(loadMutated((raw) => (taskRow(raw, INVOICE).sectionId = "no-such-section")));
		expect(r.data.tasks.get(INVOICE)?.sectionId).toBeNull();
		expect(r.issues).toHaveLength(1);
		expect(r.issues[0]).toContain("Send invoice");
		expect(r.issues[0]).toContain("section");
	});

	it("a sectionId that names a section of another list is cleared, with an issue", () => {
		// Triage belongs to Inbox; Send invoice is in Work.
		const r = ok(loadMutated((raw) => (taskRow(raw, INVOICE).sectionId = TRIAGE)));
		expect(r.data.tasks.get(INVOICE)?.sectionId).toBeNull();
		expect(r.issues).toHaveLength(1);
		expect(r.issues[0]).toContain("Send invoice");
	});

	it("a section whose list is missing is dropped, its tasks are cleared, and each repair records an issue", () => {
		const r = ok(
			loadMutated((raw) => {
				raw.sections.find((s) => s.id === WEEK1)!.categoryId = "gone-list";
			}),
		);
		expect(r.data.sections.has(WEEK1)).toBe(false);
		expect(r.data.sections.size).toBe(2);
		expect(r.data.tasks.get(PARENT)?.sectionId).toBeNull();
		expect(r.data.tasks.get(SUB)?.sectionId).toBeNull();
		expect(r.issues.some((i) => i.includes("Week 1"))).toBe(true);
		expect(r.issues.length).toBeGreaterThanOrEqual(2);
	});

	it("a subtask whose sectionId differs from its parent's takes the parent's, with an issue", () => {
		const r = ok(loadMutated((raw) => (taskRow(raw, SUB).sectionId = null)));
		expect(r.data.tasks.get(SUB)?.sectionId).toBe(WEEK1);
		expect(r.issues).toHaveLength(1);
		expect(r.issues[0]).toContain("Read chapter 3");
	});

	it("a subtask in a section under a parent with none is cleared to match", () => {
		const r = ok(loadMutated((raw) => (taskRow(raw, PARENT).sectionId = null)));
		expect(r.data.tasks.get(SUB)?.sectionId).toBeNull();
		expect(r.issues).toHaveLength(1);
	});

	it("a subtask in another list is moved to the parent's list and then takes the parent's section", () => {
		const r = ok(
			loadMutated((raw) => {
				const sub = taskRow(raw, SUB);
				sub.categoryId = WORK;
				sub.sectionId = null;
			}),
		);
		const sub = r.data.tasks.get(SUB)!;
		expect(sub.categoryId).toBe(STUDY);
		expect(sub.sectionId).toBe(WEEK1);
	});

	it("a section with no nameKey gets one derived from its name, silently like a category", () => {
		const r = ok(loadMutated((raw) => delete raw.sections.find((s) => s.id === WEEK1)!.nameKey));
		expect(r.data.sections.get(WEEK1)?.nameKey).toBe("week 1");
	});

	it("a section with a bad or missing name is dropped with an issue, its tasks are cleared, and the load succeeds (#114)", () => {
		for (const bad of ["", 7, undefined]) {
			const r = ok(
				loadMutated((raw) => {
					const s = raw.sections.find((x) => x.id === WEEK1)!;
					if (bad === undefined) delete s.name;
					else s.name = bad;
				}),
			);
			expect(r.data.sections.has(WEEK1)).toBe(false);
			expect(r.data.sections.size).toBe(2);
			expect(r.data.tasks.get(PARENT)?.sectionId).toBeNull();
			expect(r.issues.some((i) => i.includes("section") && i.includes("removed"))).toBe(true);
		}
	});

	it("a section with a bad id, categoryId or sortKey is dropped with an issue (#114)", () => {
		const cases: [string, unknown][] = [
			["categoryId", 5],
			["categoryId", ""],
			["sortKey", 3],
			["sortKey", undefined],
			["id", ""],
		];
		for (const [field, bad] of cases) {
			const r = ok(
				loadMutated((raw) => {
					const s = raw.sections.find((x) => x.id === WEEK1)!;
					if (bad === undefined) delete s[field];
					else s[field] = bad;
				}),
			);
			expect(r.data.sections.size, `${field}=${String(bad)}`).toBe(2);
			expect(r.issues.length, `${field}=${String(bad)}`).toBeGreaterThan(0);
		}
	});

	it("a non-object section record and a duplicate section id still fail the load", () => {
		expect(loadMutated((raw) => raw.sections.push(5 as unknown as Record<string, unknown>)).kind).toBe("failed");
		expect(loadMutated((raw) => raw.sections.push({ ...raw.sections[0]! })).kind).toBe("failed");
	});

	it("a task whose sectionId is not a string or null gets null with an issue (#114)", () => {
		const r = ok(loadMutated((raw) => (taskRow(raw, INVOICE).sectionId = 12)));
		expect(r.data.tasks.get(INVOICE)?.sectionId).toBeNull();
		expect(r.issues).toHaveLength(1);
		expect(r.issues[0]).toContain("Send invoice");
	});

	it("a trashed task whose sectionId is not a string also gets null with an issue", () => {
		const TRASHED = "3e2c9f41-9d85-4f6c-ad0f-8c5c3c7dbd44";
		const r = ok(
			loadMutated((raw) => {
				const entries = raw.trash as { tasks: Record<string, unknown>[] }[];
				entries.flatMap((e) => e.tasks).find((t) => t.id === TRASHED)!.sectionId = {};
			}),
		);
		const trashed = [...r.data.trash.values()].flatMap((e) => e.tasks).find((t) => t.id === TRASHED);
		expect(trashed?.sectionId).toBeNull();
		expect(r.issues).toHaveLength(1);
	});

	it("nameKey is recomputed from the name on read; a stored key that differs records an issue (#115)", () => {
		const r = ok(loadMutated((raw) => (raw.sections.find((s) => s.id === WEEK1)!.nameKey = "stale")));
		expect(r.data.sections.get(WEEK1)?.nameKey).toBe("week 1");
		expect(r.issues).toHaveLength(1);
		expect(r.issues[0]).toContain("Week 1");
		expect(ok(loadText(serializeDb(r.data), NOW)).issues).toEqual([]);
	});

	it("duplicate nameKeys within a list stay as they are, with an issue", () => {
		const r = ok(
			loadMutated((raw) => {
				const w = raw.sections.find((s) => s.id === WEEK1)!;
				raw.sections.push({ ...w, id: "dup-sec", sortKey: "zz" });
			}),
		);
		expect(r.data.sections.has("dup-sec")).toBe(true);
		expect(r.issues.some((i) => i.includes("same name"))).toBe(true);
	});

	it("a valid file produces no issues and repaired data round-trips", () => {
		const clean = ok(loadText(V3, NOW));
		expect(clean.issues).toEqual([]);
		const repaired = ok(loadMutated((raw) => (taskRow(raw, INVOICE).sectionId = "no-such-section")));
		const again = ok(loadText(serializeDb(repaired.data), NOW));
		expect(again.issues).toEqual([]);
	});

	it("trashed tasks keep their sectionId even when the section is gone (restore decides)", () => {
		const r = ok(
			loadMutated((raw) => {
				raw.sections = raw.sections.filter((s) => s.id !== TRIAGE);
				taskRow(raw, "2d1b8e30-8c74-4e5b-9c9e-7b4b2b6cac33").sectionId = null;
			}),
		);
		const trashed = [...r.data.trash.values()].flatMap((e) => e.tasks);
		expect(trashed[0]?.sectionId).toBe(TRIAGE);
		expect(r.issues).toEqual([]);
	});
});

describe("sections in the journal and the seeds", () => {
	it("journal ops put and remove section records", () => {
		const data = ok(loadText(V3, NOW)).data;
		const section = {
			id: "new-sec",
			categoryId: WORK,
			name: "Billing",
			nameKey: "billing",
			sortKey: "a",
			createdAt: NOW,
			modifiedAt: NOW,
		};
		const added = applyOps(data, [{ c: "sections", id: "new-sec", v: section }]);
		expect(added.sections.get("new-sec")).toEqual(section);
		expect(data.sections.has("new-sec")).toBe(false);
		const removed = applyOps(added, [{ c: "sections", id: "new-sec", v: null }]);
		expect(removed.sections.has("new-sec")).toBe(false);
	});

	it.each(["test-vault/Checkpoint.cpbase", "e2e/fixtures/seed.cpbase"])("the seed %s is already schema 3, so the e2e vault never migrates (§11.6 #62)", (path) => {
		const text = readFileSync(join(import.meta.dirname, "..", "..", path), "utf8");
		const r = ok(loadText(text, NOW));
		expect(r.migratedFrom).toBeNull();
		expect(r.issues).toEqual([]);
		expect(r.data.meta.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
		expect(serializeDb(r.data)).toBe(text);
	});
});
