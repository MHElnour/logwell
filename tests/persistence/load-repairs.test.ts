import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadText } from "../../src/persistence/CpbaseStore";
import { applyOps } from "../../src/persistence/journal";
import { createEmptyDb, CURRENT_SCHEMA_VERSION, type DbData } from "../../src/persistence/schema";
import { serializeDb } from "../../src/persistence/serializer";
import { type Checkin, type Habit, INBOX_ID, type OccurrenceRecord, type Section, type Tag, type Task, type TrashEntry } from "../../src/domain/types";
import { readRecord } from "../../src/persistence/validate";
import { done, repeating, rule, series } from "../domain/recurrence-fixtures";
import { TAG_LENGTH_MESSAGE } from "../../src/domain/tags";
import { appHarness } from "../app/harness";
import { load, loadWithIssues, makeSection, makeTag, makeTask } from "./fixtures";

describe("sections", () => {
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

	describe("section repairs on load", () => {
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

		it("a section with a bad or missing name is dropped with an issue, its tasks are cleared, and the load succeeds", () => {
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

		it("a section with a bad id, categoryId or sortKey is dropped with an issue", () => {
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

		it("a task whose sectionId is not a string or null gets null with an issue", () => {
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

		it("nameKey is recomputed from the name on read; a stored key that differs records an issue", () => {
			const r = ok(loadMutated((raw) => (raw.sections.find((s) => s.id === WEEK1)!.nameKey = "stale")));
			expect(r.data.sections.get(WEEK1)?.nameKey).toBe("week 1");
			expect(r.issues).toHaveLength(1);
			expect(r.issues[0]).toContain("Week 1");
			expect(ok(loadText(serializeDb(r.data), NOW)).issues).toEqual([]);
		});

		it("duplicate nameKeys within a list stay as they are, with a note and no issue (#104)", () => {
			const r = ok(
				loadMutated((raw) => {
					const w = raw.sections.find((s) => s.id === WEEK1)!;
					raw.sections.push({ ...w, id: "dup-sec", sortKey: "zz" });
				}),
			);
			expect(r.data.sections.has("dup-sec")).toBe(true);
			expect(r.issues).toEqual([]);
			expect(r.notes.some((i) => i.includes("same name"))).toBe(true);
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

		it.each(["test-vault/Checkpoint.cpbase", "e2e-tests/fixtures/seed.cpbase"])("the seed %s is already at the current schema, so the e2e vault never migrates", (path) => {
			const text = readFileSync(join(import.meta.dirname, "..", "..", path), "utf8");
			const r = ok(loadText(text, NOW));
			expect(r.migratedFrom).toBeNull();
			expect(r.issues).toEqual([]);
			expect(r.data.meta.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
			expect(serializeDb(r.data)).toBe(text);
		});
	});
});

describe("years 0000 to 0099", () => {
	// Every real day in years 0000 to 9999 loads. Before the fix a
	// repeat, end date, occurrence record, habit version or check-in in years 0000 to 0099 was
	// removed on load.

	const AT = "0050-01-01T09:00:00.000Z";

	describe("records dated in years 0000 to 0099 load unchanged (#15)", () => {
		it("keeps a repeat anchored on 0050-01-01 with an end date and a version", () => {
			const task = repeating(series("0050-01-01", [["0050-01-01", rule()], ["0050-03-01", rule({ interval: 2 })]], { kind: "date", date: "0050-12-31" }));
			const issues: string[] = [];
			const read = readRecord("tasks", JSON.parse(JSON.stringify(task)), task.id, issues) as Task;
			expect(issues).toEqual([]);
			expect(read.recurrence).toEqual(task.recurrence);
		});

		it("keeps an occurrence record dated 0050-01-02", () => {
			const record: OccurrenceRecord = done("0050-01-02");
			const issues: string[] = [];
			expect(readRecord("occurrenceRecords", { ...record }, "t1:0050-01-02", issues)).toEqual(record);
			expect(issues).toEqual([]);
		});

		it("keeps a habit version and a check-in in year 0050", () => {
			const habit: Habit = {
				id: "h-1",
				name: "Read",
				icon: null,
				color: null,
				timeOfDay: "anytime",
				reminder: null,
				archivedAt: null,
				sortKey: "a0",
				createdAt: AT,
				modifiedAt: AT,
				versions: [{ effectiveFrom: "0050-01-01", goal: { type: "binary", target: 1, unit: null, period: "day" }, schedule: { kind: "daily" }, weekStart: "MO" }],
			};
			const checkin: Checkin = { id: "c-1", habitId: "h-1", date: "0050-01-01", value: 1, note: null, createdAt: AT, modifiedAt: AT, deletedAt: null };
			const issues: string[] = [];
			expect(readRecord("habits", JSON.parse(JSON.stringify(habit)), "h-1", issues)).toEqual(habit);
			expect(readRecord("checkins", { ...checkin }, "c-1", issues)).toEqual(checkin);
			expect(issues).toEqual([]);
		});
	});
});

describe("list name keys", () => {
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
});

describe("long tag keys", () => {
	// The 64-character limit applies to NEW names only: a longer tag already in a file
	// loads, stays on its tasks, can be recolored, and is never cut or refused.

	const long = "a".repeat(100);

	function fileWithLongTag(): string {
		const data = createEmptyDb({ dbId: "db-1", revision: "r-000000000000", deviceId: "d-other", now: "2026-10-01T08:00:00.000Z" });
		const tags = new Map(data.tags);
		tags.set(long, { key: long, displayName: long.toUpperCase(), color: null, createdAt: "2026-10-01T08:00:00.000Z", modifiedAt: "2026-10-01T08:00:00.000Z" });
		tags.set(`home/${long}`, { key: `home/${long}`, displayName: `Home/${long}`, color: null, createdAt: "2026-10-01T08:00:00.000Z", modifiedAt: "2026-10-01T08:00:00.000Z" });
		const tasks = new Map(data.tasks);
		tasks.set("t1", makeTask("t1", { tagKeys: [long, `home/${long}`] }));
		return serializeDb({ ...data, tags, tasks });
	}

	describe("a tag key longer than 64 characters in a file", () => {
		it("loads, and its task keeps it", () => {
			const data = load(fileWithLongTag());
			expect(data.tags.get(long)?.displayName).toBe(long.toUpperCase());
			expect(data.tags.has(`home/${long}`)).toBe(true);
			expect(data.tasks.get("t1")?.tagKeys).toEqual([long, `home/${long}`]);
		});

		it("can be recolored and kept by Edit, while a new long name is refused", async () => {
			const h = await appHarness({ initial: fileWithLongTag() });
			const r = await h.app.tags.edit(long, { name: long.toUpperCase(), parentKey: null, color: "red" });
			expect(r.wrote).toBe(true);
			expect(h.app.store.state.tags.get(long)).toMatchObject({ key: long, displayName: long.toUpperCase(), color: "red" });
			await expect(h.app.tags.add("b".repeat(65), null, null)).rejects.toMatchObject({ code: "InvalidTag", message: TAG_LENGTH_MESSAGE });
			await expect(h.app.tags.create("c".repeat(65))).rejects.toMatchObject({ code: "InvalidTag", message: TAG_LENGTH_MESSAGE });
		});
	});
});

describe("timed dates written with other digits", () => {
	// A device whose language writes other digits (Arabic, Persian) once stored timed dates with them. Such a file
	// still opens: the digits are read as 0 to 9, with an issue per date.

	const NOW = "2026-10-13T10:00:00.000Z";
	const ARABIC = "٢٠٢٦-١٠-١٣T١٧:٠٠";
	const PERSIAN = "۲۰۲۶-۱۰-۱۴T۰۹:۳۰";

	function fileWith(scheduled: string, deadline: string): string {
		const data = createEmptyDb({ dbId: "db-1", revision: "r-000000000000", deviceId: "d-other", now: "2026-10-01T08:00:00.000Z" });
		const tasks = new Map(data.tasks);
		tasks.set("t1", makeTask("t1", { title: "Call mom", scheduled: { kind: "datetime", local: "2026-01-01T00:00", tz: "Africa/Cairo" }, deadline: { kind: "datetime", local: "2026-01-02T00:00", tz: "Asia/Tehran" } }));
		const trash = new Map(data.trash);
		trash.set("b1", { batchId: "b1", deletedAt: "2026-10-12T10:00:00.000Z", tasks: [makeTask("t2", { title: "Old call", scheduled: { kind: "datetime", local: "2026-01-01T00:00", tz: "Africa/Cairo" } })] });
		return serializeDb({ ...data, tasks, trash }).replaceAll("2026-01-01T00:00", scheduled).replace("2026-01-02T00:00", deadline);
	}

	it("#100: loads with the digits 0 to 9 and one issue per date; the repaired file loads clean", () => {
		const r = loadText(fileWith(ARABIC, PERSIAN), NOW);
		if (r.kind !== "ok") throw new Error(`did not load: ${JSON.stringify(r)}`);
		expect(r.data.tasks.get("t1")?.scheduled).toEqual({ kind: "datetime", local: "2026-10-13T17:00", tz: "Africa/Cairo" });
		expect(r.data.tasks.get("t1")?.deadline).toEqual({ kind: "datetime", local: "2026-10-14T09:30", tz: "Asia/Tehran" });
		expect(r.data.trash.get("b1")?.tasks[0]?.scheduled).toEqual({ kind: "datetime", local: "2026-10-13T17:00", tz: "Africa/Cairo" });
		expect(r.issues).toHaveLength(3);
		expect(r.issues[0]).toContain("Call mom");
		expect(r.issues.join(" ")).toContain("Old call");
		const again = loadText(serializeDb(r.data), NOW);
		expect(again.kind === "ok" && again.issues).toEqual([]);
	});

	it("#100: a date that is still not a real time once read as 0 to 9 fails the load as before", () => {
		const r = loadText(fileWith("٢٠٢٦-١٣-٠١T١٧:٠٠", PERSIAN), NOW);
		expect(r.kind).not.toBe("ok");
	});
});

describe("links a file left broken", () => {
	// The load repair reads the table of links: each record that points at a record that is missing (or one the link
	// does not accept) is repaired as the table says, with one issue each, and the repaired file loads clean. A trashed
	// task keeps its links as they are: restoring it decides.

	const NOW = "2026-10-02T10:00:00.000Z";

	/** A file with Inbox, the list "work" and these records. */
	function fileWith(records: { tasks?: Task[]; sections?: Section[]; tags?: Tag[]; trash?: TrashEntry[] }): string {
		const data = createEmptyDb({ dbId: "db-1", revision: "r-000000000000", deviceId: "d-other", now: "2026-10-01T08:00:00.000Z" });
		const categories = new Map(data.categories);
		categories.set("work", { ...data.categories.get(INBOX_ID)!, id: "work", name: "Work", nameKey: "work", isInbox: false });
		const byId = <K, V>(list: V[] | undefined, id: (v: V) => K) => new Map((list ?? []).map((v) => [id(v), v]));
		return serializeDb({
			...data,
			categories,
			tasks: byId(records.tasks, (t) => t.id),
			sections: byId(records.sections, (s) => s.id),
			tags: byId(records.tags, (t) => t.key),
			trash: byId(records.trash, (e) => e.batchId),
		});
	}

	const trashed = (task: Task): TrashEntry => ({ batchId: "b1", deletedAt: NOW, tasks: [task] });

	it.each<{ name: string; file: Parameters<typeof fileWith>[0]; issues: string[]; repaired: (d: DbData) => unknown; want: unknown }>([
		{
			name: "a task in a list that does not exist goes to Inbox",
			file: { tasks: [makeTask("t", { categoryId: "gone" })] },
			issues: ['Task "Task t" pointed to a missing list and was moved to Inbox.'],
			repaired: (d) => d.tasks.get("t")?.categoryId,
			want: INBOX_ID,
		},
		{
			name: "a task in a section that does not exist goes to No section",
			file: { tasks: [makeTask("t", { sectionId: "gone" })] },
			issues: ['Task "Task t" pointed to a missing section and was moved to No section.'],
			repaired: (d) => d.tasks.get("t")?.sectionId,
			want: null,
		},
		{
			name: "a task in a section of another list goes to No section",
			file: { sections: [makeSection("s-work", "work")], tasks: [makeTask("t", { sectionId: "s-work" })] },
			issues: ['Task "Task t" was in a section of another list and was moved to No section.'],
			repaired: (d) => d.tasks.get("t")?.sectionId,
			want: null,
		},
		{
			name: "a section in a list that does not exist is removed",
			file: { sections: [makeSection("s-gone", "gone", { name: "Week 1" })] },
			issues: ['Section "Week 1" pointed to a missing list and was removed.'],
			repaired: (d) => d.sections.has("s-gone"),
			want: false,
		},
		{
			name: "a subtask under a task that does not exist becomes top-level",
			file: { tasks: [makeTask("t", { parentId: "gone" })] },
			issues: ['Subtask "Task t" lost its parent and is now a top-level task.'],
			repaired: (d) => d.tasks.get("t")?.parentId,
			want: null,
		},
		{
			name: "a subtask under a subtask becomes top-level",
			file: { tasks: [makeTask("p"), makeTask("c", { parentId: "p" }), makeTask("t", { parentId: "c" })] },
			issues: ['Subtask "Task t" lost its parent and is now a top-level task.'],
			repaired: (d) => d.tasks.get("t")?.parentId,
			want: null,
		},
		{
			name: "a task's tag that does not exist is recreated",
			file: { tasks: [makeTask("t", { tagKeys: ["errands"] })] },
			issues: ['Tag "errands" was missing and has been recreated.'],
			repaired: (d) => d.tags.get("errands")?.key,
			want: "errands",
		},
		{
			name: "#215: the tag above a tag, missing, is recreated",
			file: { tags: [makeTag("home/calls", { displayName: "Home/Calls" })] },
			issues: ['Tag "home" was missing and has been recreated.'],
			repaired: (d) => [...d.tags.keys()].sort(),
			want: ["home", "home/calls"],
		},
		{
			name: "#215: a task's tag that does not exist is recreated with the tags above it",
			file: { tasks: [makeTask("t", { tagKeys: ["a/b"] })] },
			issues: ['Tag "a/b" was missing and has been recreated.', 'Tag "a" was missing and has been recreated.'],
			repaired: (d) => [...d.tags.keys()].sort(),
			want: ["a", "a/b"],
		},
		{
			name: "a trashed task keeps a tag that does not exist (restoring it drops the tag)",
			file: { trash: [trashed(makeTask("t", { tagKeys: ["ghost"] }))] },
			issues: [],
			repaired: (d) => [d.trash.get("b1")?.tasks[0]?.tagKeys, d.tags.has("ghost")],
			want: [["ghost"], false],
		},
		{
			name: "a trashed task keeps a list, a section and a parent that do not exist",
			file: { trash: [trashed(makeTask("t", { categoryId: "gone", sectionId: "gone", parentId: "gone" }))] },
			issues: [],
			repaired: (d) => d.trash.get("b1")?.tasks[0],
			want: expect.objectContaining({ categoryId: "gone", sectionId: "gone", parentId: "gone" }),
		},
	])("$name, and the repaired file loads clean", ({ file, issues, repaired, want }) => {
		const r = loadWithIssues(fileWith(file), NOW);
		expect(r.issues).toEqual(issues);
		expect(repaired(r.data)).toEqual(want);
		expect(loadWithIssues(serializeDb(r.data), NOW).issues).toEqual([]);
	});

	describe("#215: editing what the file left broken", () => {
		// A file whose task holds the tag a/b with no tag records (the load recreates a/b and a), and whose trashed task
		// holds x and ghost, a tag the file lacks (kept as it is). Each edit below saves and its Undo works.
		const file = () =>
			fileWith({
				tasks: [makeTask("t1", { tagKeys: ["a/b", "x"] })],
				tags: [makeTag("x")],
				trash: [trashed(makeTask("t2", { tagKeys: ["x", "ghost"] }))],
			});

		it.each<{ name: string; edit: (h: Awaited<ReturnType<typeof appHarness>>) => Promise<unknown>; label: string }>([
			{ name: "recolor the tag the load recreated under a recreated parent", edit: (h) => h.app.tags.setColor("a/b", "red"), label: "Edit tag" },
			{ name: "rename that tag, keeping its parent", edit: (h) => h.app.tags.edit("a/b", { name: "Bee", parentKey: "a", color: null }), label: "Edit tag" },
			{ name: "rename a tag a trashed task holds beside a tag the file lacks", edit: (h) => h.app.tags.edit("x", { name: "Y", parentKey: null, color: null }), label: "Edit tag" },
		])("$name", async ({ edit, label }) => {
			const h = await appHarness({ initial: file() });
			const before = h.app.store.state;
			await edit(h);
			expect(h.app.store.state).not.toBe(before);
			expect(await h.app.store.undo()).toBe(label);
			expect(h.app.store.state.tags).toEqual(before.tags);
			expect(h.app.store.state.trash).toEqual(before.trash);
		});
	});
});
