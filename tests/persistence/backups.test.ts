import { describe, expect, it } from "vitest";
import { BackupStore } from "../../src/persistence/backups";
import { MemoryFileGateway } from "./memoryGateway";
import { createEmptyDb } from "../../src/persistence/schema";
import { serializeDb } from "../../src/persistence/serializer";
import { FakeClock } from "../helpers";

// Listing backups must not read every backup file in full.

class CountingGateway extends MemoryFileGateway {
	reads: string[] = [];

	override async read(path: string): Promise<string | null> {
		this.reads.push(path);
		return super.read(path);
	}
}

function dbText(revision: string, writtenAt: string): string {
	return serializeDb(createEmptyDb({ dbId: "db-1", revision, deviceId: "d-1", now: writtenAt }));
}

function setup() {
	const fs = new CountingGateway();
	const clock = new FakeClock();
	return { fs, clock, backups: new BackupStore(fs, "root", clock) };
}

describe("BackupStore listing", () => {
	it("lists snapshots and conflicts from their names, without reading the files", async () => {
		const { fs, clock, backups } = setup();
		await backups.writeSnapshot("hourly", dbText("r-older", "2026-10-01T08:00:00.000Z"));
		clock.advance(1000);
		await backups.writeSnapshot("pre-repair", dbText("r-newer", "2026-10-01T09:30:00.123Z"));
		await backups.writeSnapshot("daily", dbText("r-newer", "2026-10-01T09:30:00.123Z"));
		await backups.writeConflict(dbText("r-mine", "2026-10-01T09:45:00.000Z"), "r-mine");
		clock.advance(1000);
		await backups.writeConflict("<<<<<<< HEAD\nnot a database\n", "damaged");
		fs.reads = [];

		const snapshots = await backups.listSnapshots();
		const conflicts = await backups.listConflicts();
		expect(fs.reads).toEqual([]);

		expect(snapshots.map((s) => [s.kind, s.revision, s.writtenAt])).toEqual([
			// Newest first by file stamp. Same stamp: the "before" state ranks older.
			["daily", "r-newer", "2026-10-01T09:30:00.123Z"],
			["pre-repair", "r-newer", "2026-10-01T09:30:00.123Z"],
			["hourly", "r-older", "2026-10-01T08:00:00.000Z"],
		]);
		expect(snapshots.find((s) => s.kind === "daily")?.stamp).toBe("20261001T100001000Z");
		expect(snapshots.find((s) => s.kind === "hourly")?.stamp).toBe("20261001T100000000Z");
		expect(conflicts.map((c) => [c.revision, c.writtenAt, c.stamp])).toEqual([
			["", "", "20261001T100002000Z"],
			["r-mine", "2026-10-01T09:45:00.000Z", "20261001T100001000Z"],
		]);
	});

	it("still lists files with older names by reading their header", async () => {
		const { fs, backups } = setup();
		fs.files.set("root/snapshots/hourly-20261001T080000000Z.cpbase", dbText("r-legacy", "2026-10-01T08:00:00.000Z"));
		fs.files.set("root/conflicts/20261001T080000000Z-r-legacy.cpbase", dbText("r-legacy", "2026-10-01T08:00:00.000Z"));
		const [snap] = await backups.listSnapshots();
		const [conflict] = await backups.listConflicts();
		expect(snap).toMatchObject({ kind: "hourly", revision: "r-legacy", writtenAt: "2026-10-01T08:00:00.000Z", stamp: "20261001T080000000Z" });
		expect(conflict).toMatchObject({ revision: "r-legacy", writtenAt: "2026-10-01T08:00:00.000Z", stamp: "20261001T080000000Z" });
	});

	it("finds today's daily snapshot and prunes by kind", async () => {
		const { clock, backups } = setup();
		expect(await backups.hasDailySnapshot(clock.now())).toBe(false);
		await backups.writeSnapshot("daily", dbText("r-1", "2026-10-01T08:00:00.000Z"));
		expect(await backups.hasDailySnapshot(clock.now())).toBe(true);
		for (let i = 0; i < 7; i++) {
			clock.advance(60_000);
			await backups.writeSnapshot("hourly", dbText(`r-h${i}`, clock.now().toISOString()));
		}
		await backups.prune();
		const kinds = (await backups.listSnapshots()).map((s) => s.kind);
		expect(kinds.filter((k) => k === "hourly")).toHaveLength(5);
		expect(kinds.filter((k) => k === "daily")).toHaveLength(1);
	});

	it("still understands day-only daily names", async () => {
		const { fs, clock, backups } = setup();
		fs.files.set("root/snapshots/daily-2026-10-01.cpbase", dbText("r-today", "2026-10-01T08:00:00.000Z"));
		fs.files.set("root/snapshots/daily-2026-09-01.cpbase", dbText("r-old", "2026-09-01T08:00:00.000Z"));
		fs.files.set("root/snapshots/hourly-20260930T230000000Z.cpbase", dbText("r-yesterday", "2026-09-30T23:00:00.000Z"));
		expect(await backups.hasDailySnapshot(clock.now())).toBe(true);
		// A day-only stamp sorts as the start of its day.
		expect((await backups.listSnapshots()).map((s) => s.revision)).toEqual(["r-today", "r-yesterday", "r-old"]);
		await backups.prune();
		expect(fs.files.has("root/snapshots/daily-2026-09-01.cpbase")).toBe(false);
		expect(fs.files.has("root/snapshots/daily-2026-10-01.cpbase")).toBe(true);
	});
});

describe("#224: a copy of a file with Git merge markers", () => {
	it("is listed as a version-control merge copy, other damaged copies stay conflict copies", async () => {
		const { clock, backups } = setup();
		await backups.writeConflict("<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> other\n", "merge-markers");
		clock.advance(1000);
		await backups.writeConflict("{ cut off", "damaged");
		clock.advance(1000);
		await backups.writeConflict(dbText("r-mine", "2026-10-01T09:45:00.000Z"), "r-mine");

		const conflicts = await backups.listConflicts();
		expect(conflicts.map((c) => [c.kind, c.revision])).toEqual([
			["conflict", "r-mine"],
			["conflict", ""],
			["merge-copy", ""],
		]);
	});

	it("lists a merge copy whose name has no header values, and a conflict copy whose revision only starts like the label", async () => {
		const { fs, backups } = setup();
		fs.files.set("root/conflicts/20261001T080000000Z-merge-markers.cpbase", "<<<<<<< HEAD\n");
		fs.files.set("root/conflicts/20261001T080001000Z-merge-markers-2.cpbase", "x");
		const conflicts = await backups.listConflicts();
		expect(conflicts.map((c) => [c.stamp, c.kind])).toEqual([
			["20261001T080001000Z", "conflict"],
			["20261001T080000000Z", "merge-copy"],
		]);
	});
});
