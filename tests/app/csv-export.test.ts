import { describe, expect, it } from "vitest";
import { csvField, exportFolderName, toCsv } from "../../src/app/DataService";
import { isDomainError } from "../../src/domain/errors";
import { rule } from "../domain/recurrence-fixtures";
import { makeReadOnly, appHarness, type AppHarness } from "./harness";
import { csvValues } from "../../e2e-tests/limits/csv";

// One CSV per entity, RFC 4180, UTF-8 with a BOM.

describe("CSV writing", () => {
	it("quotes fields with a comma, a quote, CR or LF and doubles the quotes", () => {
		expect(csvField("plain")).toBe("plain");
		expect(csvField("a,b")).toBe('"a,b"');
		expect(csvField('say "hi"')).toBe('"say ""hi"""');
		expect(csvField("two\nlines")).toBe('"two\nlines"');
		expect(csvField("cr\rhere")).toBe('"cr\rhere"');
		expect(csvField("")).toBe("");
		expect(csvField(" spaced ")).toBe(" spaced ");
	});

	it("neutralizes cells a spreadsheet would read as a formula (CSV injection), but leaves numbers alone", () => {
		expect(csvField("=SUM(A1)")).toBe("'=SUM(A1)");
		expect(csvField("+1 call")).toBe("'+1 call");
		expect(csvField("@mention")).toBe("'@mention");
		expect(csvField("-cmd")).toBe("'-cmd");
		expect(csvField("\tTab")).toBe("'\tTab");
		expect(csvField("=a,b")).toBe('"\'=a,b"');
		expect(csvField("-5")).toBe("-5");
		expect(csvField("-0.5")).toBe("-0.5");
		expect(csvField("a=b")).toBe("a=b");
	});

	it("starts with a UTF-8 byte order mark, then the header, with CRLF line ends", () => {
		const text = toCsv(["a", "b"], [["1", "x,y"], ["2", ""]]);
		expect(text.charCodeAt(0)).toBe(0xfeff);
		expect(text.slice(1)).toBe('a,b\r\n1,"x,y"\r\n2,\r\n');
		expect(Buffer.from(text, "utf8").subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
	});

	it("names the export folder by the local time in the zone", () => {
		expect(exportFolderName(new Date("2026-10-05T12:34:00.000Z"), "Europe/Berlin")).toBe("Logwell export 2026-10-05 1434");
		expect(exportFolderName(new Date("2026-10-05T23:30:00.000Z"), "Asia/Tokyo")).toBe("Logwell export 2026-10-06 0830");
		expect(exportFolderName(new Date("2026-10-05T12:34:00.000Z"), "Not/AZone")).toMatch(/^Logwell export \d{4}-\d{2}-\d{2} \d{4}$/);
	});
});

async function populated(): Promise<AppHarness> {
	const h = await appHarness({ now: "2026-10-05T10:00:00.000Z" });
	const list = await h.app.categories.create('Work, "big"');
	await h.app.sections.create(list.id, "Doing");
	await h.app.tags.create("Home");
	const plain = (await h.app.tasks.create({ title: "Buy milk, eggs", categoryId: list.id, tagKeys: ["home"], scheduled: { kind: "datetime", local: "2026-10-06T09:00", tz: "Europe/Berlin" }, deadline: { kind: "date", date: "2026-10-09" } })).task;
	expect(plain.deadline).not.toBeNull();
	await h.app.tasks.create({ title: "Say \"hi\"\nnow" });
	const rep = (await h.app.tasks.create({ title: "Gym", scheduled: { kind: "date", date: "2026-10-01" }, repeat: { rule: rule({ freq: "weekly", weekdays: ["MO", "FR"] }) } })).task;
	await h.app.tasks.complete(rep.id);
	await h.app.recurrence.skip(rep.id);
	return h;
}

describe("DataService.exportCsv", () => {
	it("writes one file per entity, in a fixed order, each with a BOM and a header row", async () => {
		const h = await populated();
		const files = h.app.data.exportCsv();
		expect(files.map((f) => f.name)).toEqual(["tasks.csv", "lists.csv", "sections.csv", "tags.csv", "occurrences.csv", "focus-sessions.csv", "habits.csv", "check-ins.csv"]);
		for (const f of files) {
			expect(f.content.charCodeAt(0)).toBe(0xfeff);
			expect(f.content.endsWith("\r\n")).toBe(true);
			expect(csvValues(f.content.slice(1))[0]!.length).toBeGreaterThan(2);
		}
	});

	it("TickTick sync links change no CSV file (they are sync bookkeeping, not content)", async () => {
		const h = await populated();
		const before = h.app.data.exportCsv();
		const task = [...h.app.store.state.tasks.values()][0]!;
		await h.app.store.run("Add sync links", (tx) => {
			const at = "2026-10-05T10:00:00.000Z";
			tx.put("syncLinks", { kind: "task", logwellId: task.id, ttId: "tt-1", ttProjectId: "p-1", etag: "e1", base: { title: "ab12" }, noteBySync: false, lastPulledAt: null, modifiedAt: at });
			tx.put("syncLinks", { kind: "list", logwellId: task.categoryId, ttId: "p-1", ttProjectId: null, etag: null, base: {}, noteBySync: false, lastPulledAt: at, modifiedAt: at });
			tx.put("syncLinks", { kind: "task", logwellId: "orphan", ttId: "tt-2", ttProjectId: "p-1", etag: null, base: {}, noteBySync: false, lastPulledAt: null, modifiedAt: at });
		});
		expect(h.app.store.state.syncLinks.size).toBe(3);
		expect(h.app.data.exportCsv()).toEqual(before);
	});

	it("tasks.csv has one row per task with the documented columns, quoted values reading back exactly", async () => {
		const h = await populated();
		const rows = csvValues(h.app.data.exportCsv().find((f) => f.name === "tasks.csv")!.content.slice(1));
		const [header, ...body] = rows;
		expect(header).toEqual([
			"id", "title", "list", "section", "tags", "parentId", "scheduled", "scheduledTz", "deadline", "deadlineTz", "plannedDurationMin", "urgent", "important", "priority", "status", "completedAt", "repeat", "repeatJson", "nextOccurrence", "sortKey", "createdAt", "modifiedAt", "note",
		]);
		expect(body).toHaveLength(3);
		for (const r of body) expect(r).toHaveLength(header!.length);
		const col = (r: string[], name: string) => r[header!.indexOf(name)];
		const milk = body.find((r) => col(r, "title") === "Buy milk, eggs")!;
		expect(col(milk, "list")).toBe('Work, "big"');
		expect(col(milk, "tags")).toBe("Home");
		expect(col(milk, "scheduled")).toBe("2026-10-06T09:00");
		expect(col(milk, "scheduledTz")).toBe("Europe/Berlin");
		expect(col(milk, "deadline")).toBe("2026-10-09");
		expect(col(milk, "urgent")).toBe("false");
		expect(col(milk, "status")).toBe("open");
		expect(col(milk, "repeat")).toBe("");
		expect(body.some((r) => col(r, "title") === 'Say "hi"\nnow')).toBe(true);
	});

	it("a repeating task: scheduled is empty, the rule is described and kept as JSON, the next occurrence is derived", async () => {
		const h = await populated();
		const rows = csvValues(h.app.data.exportCsv().find((f) => f.name === "tasks.csv")!.content.slice(1));
		const header = rows[0]!;
		const gym = rows.find((r) => r[header.indexOf("title")] === "Gym")!;
		const col = (name: string) => gym[header.indexOf(name)]!;
		expect(col("scheduled")).toBe("");
		expect(col("repeat")).toBe("every Mon, Fri");
		const json = JSON.parse(col("repeatJson")) as { anchor: string; versions: { rule: { weekdays: string[] } }[] };
		// Made on Thu Oct 1 for Mondays and Fridays: the series starts on the first of them, Fri Oct 2 (seriesAnchor).
		expect(json.anchor).toBe("2026-10-02");
		expect(json.versions[0]!.rule.weekdays).toEqual(["MO", "FR"]);
		// Done Oct 2 (Fri, the first), then Mon Oct 5 skipped.
		const records = h.app.store.state.occurrenceRecords.size;
		expect(records).toBeGreaterThan(0);
		expect(col("nextOccurrence")).toBe("2026-10-09");
	});

	it("occurrences.csv lists every record with its task title; the other entities are present", async () => {
		const h = await populated();
		const files = h.app.data.exportCsv();
		const occ = csvValues(files.find((f) => f.name === "occurrences.csv")!.content.slice(1));
		expect(occ[0]).toEqual(["taskId", "task", "trashed", "occurrenceDate", "status", "resolvedAt", "auto", "completedOn"]);
		expect(occ.slice(1).map((r) => [r[1], r[2], r[3], r[4]])).toEqual([
			["Gym", "false", "2026-10-02", "done"],
			["Gym", "false", "2026-10-05", "skipped"],
		]);
		expect(csvValues(files.find((f) => f.name === "lists.csv")!.content.slice(1)).length).toBeGreaterThanOrEqual(3); // header, Inbox, Work
		expect(csvValues(files.find((f) => f.name === "sections.csv")!.content.slice(1)).slice(1)[0]![3]).toBe("Doing");
		expect(csvValues(files.find((f) => f.name === "tags.csv")!.content.slice(1)).slice(1)[0]![1]).toBe("Home");
	});

	it("occurrences.csv keeps the rows of a series in the Trash, with its title from the trash entry and trashed true", async () => {
		const h = await populated();
		const gym = [...h.app.store.state.tasks.values()].find((t) => t.title === "Gym")!;
		await h.app.tasks.delete(gym.id);
		const occ = csvValues(h.app.data.exportCsv().find((f) => f.name === "occurrences.csv")!.content.slice(1));
		expect(occ.slice(1).map((r) => [r[1], r[2], r[3], r[4]])).toEqual([
			["Gym", "true", "2026-10-02", "done"],
			["Gym", "true", "2026-10-05", "skipped"],
		]);
	});

	it("exports focus sessions, habits and check-ins", async () => {
		const h = await populated();
		const habit = await h.app.habits.create({
			name: "Read, daily",
			icon: null,
			color: null,
			timeOfDay: "evening",
			reminder: null,
			goal: { type: "binary", target: 1, unit: null, period: "day" },
			schedule: { kind: "daily" },
		});
		await h.app.habits.toggle(habit.id, "2026-10-05", true);
		await h.app.store.run("Add session", (tx) => {
			tx.put("focusSessions", {
				id: "f1",
				deviceId: "d1",
				taskId: null,
				taskTitleSnapshot: "Deep, work",
				plannedSec: 1500,
				status: "completed",
				segments: [{ start: "2026-10-05T08:00:00.000Z", end: "2026-10-05T08:25:00.000Z" }],
				unobserved: [],
				splitFrom: null,
				startedAt: "2026-10-05T08:00:00.000Z",
				endedAt: "2026-10-05T08:25:00.000Z",
				finalizedAt: "2026-10-05T08:25:00.000Z",
			});
		});
		const files = h.app.data.exportCsv();
		const habits = csvValues(files.find((f) => f.name === "habits.csv")!.content.slice(1));
		expect(habits[1]![1]).toBe("Read, daily");
		const checkins = csvValues(files.find((f) => f.name === "check-ins.csv")!.content.slice(1));
		expect(checkins).toHaveLength(2);
		expect(checkins[1]![2]).toBe("Read, daily");
		expect(checkins[1]![3]).toBe("2026-10-05");
		const focus = csvValues(files.find((f) => f.name === "focus-sessions.csv")!.content.slice(1));
		expect(focus[1]!.slice(0, 10)).toEqual(["f1", "d1", "", "Deep, work", "1500", "completed", "2026-10-05T08:00:00.000Z", "2026-10-05T08:25:00.000Z", "2026-10-05T08:25:00.000Z", "1500"]);
		expect(JSON.parse(focus[1]![14]!)).toHaveLength(1);
	});

	it("is refused while the database is read-only", async () => {
		const h = await appHarness();
		await makeReadOnly(h);
		expect(() => h.app.data.exportCsv()).toThrow(/read-only/);
		try {
			h.app.data.exportCsv();
		} catch (err) {
			expect(isDomainError(err, "ReadOnly")).toBe(true);
		}
	});
});
