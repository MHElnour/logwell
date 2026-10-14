import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BackupStore, SNAPSHOT_INTERVAL_MS, type SnapshotKind } from "../../src/persistence/backups";
import { FakeClock, taskId } from "../helpers";
import { BACKUP_ROOT, emptyDbText, harness, makeTask } from "../persistence/fixtures";
import { MemoryFileGateway } from "../persistence/memoryGateway";
import { elapsedAsync, measuredAsync, median, perfLog } from "./measure";

// Backup retention after every save (issue 35). A save that writes no snapshot still lists the snapshots folder
// (`prune`), and the listing grows with the retention limits. This test counts the listings and logs the time of one
// retention pass (list, parse and sort in memory, nothing deleted) with the folder at its retention limits
// (CHECKPOINT_PERF_LOG=1). The count is the check; the times have nothing in the same run to compare with. Fixing
// issue 35 should take the listings per plain save from 1 to 0.
//
// The in-memory gateway has no disk I/O, so the timing is the CPU part of a listing (name parsing, sorting)
// only. The real gateway adds two adapter calls per listing (`exists` and `list`).

const PLAIN_SAVES = 50;
const REPEATS = 200;

// The retention limits in src/persistence/backups.ts: 5 hourly, 5 reload, 5 of each of the five "pre-" kinds
// and daily snapshots for 14 days (today and the 14 days before it).
const PRE_KINDS: SnapshotKind[] = ["pre-migration", "pre-repair", "pre-import", "pre-restore", "pre-sync"];
const FULL_FOLDER: { kind: SnapshotKind; count: number }[] = [
	{ kind: "hourly", count: 5 },
	{ kind: "reload", count: 5 },
	...PRE_KINDS.map((kind) => ({ kind, count: 5 })),
];
const DAILY_COUNT = 15;

describe("#35: backup retention listings", () => {
	it(`${PLAIN_SAVES} plain saves list the snapshots folder at most once each`, async () => {
		const h = harness();
		await h.store.open();
		await h.saveNow();

		let listings = 0;
		const originalList = h.fs.list.bind(h.fs);
		h.fs.list = async (dir: string) => {
			if (dir.endsWith("/snapshots")) listings++;
			return originalList(dir);
		};

		const writesBefore = h.fs.writes.filter((p) => p.includes("/snapshots/")).length;
		for (let i = 0; i < PLAIN_SAVES; i++) {
			// Seconds apart, far below the hourly interval, so no snapshot is due.
			h.clock.advance(1000);
			h.addTask(makeTask(taskId(i), { title: `Task ${i}` }));
			await h.saveNow();
		}
		const snapshotsWritten = h.fs.writes.filter((p) => p.includes("/snapshots/")).length - writesBefore;
		expect(PLAIN_SAVES * 1000).toBeLessThan(SNAPSHOT_INTERVAL_MS);
		expect(snapshotsWritten, "no snapshot is due during plain saves").toBe(0);
		expect(h.dbText()).toContain(`"title":"Task ${PLAIN_SAVES - 1}"`);

		perfLog(`issue-35: ${listings} snapshot listings for ${PLAIN_SAVES} plain saves (${(listings / PLAIN_SAVES).toFixed(2)} per save), ${snapshotsWritten} snapshots written`);
		// Today: exactly 1 per save (prune). The loose bound leaves room for a fix to lower it.
		expect(listings).toBeLessThanOrEqual(PLAIN_SAVES);
		await h.store.close();
	});

	it("logs one retention pass with the snapshot folder at its retention limits", async () => {
		const gateway = new MemoryFileGateway();
		const clock = new FakeClock("2026-10-01T10:00:00.000Z");
		const backups = new BackupStore(gateway, `${BACKUP_ROOT}/db-1`, clock);
		const content = emptyDbText();
		const now = clock.now().getTime();

		let minute = 0;
		for (const { kind, count } of FULL_FOLDER) {
			for (let i = 0; i < count; i++) {
				clock.set(new Date(now - (60 - minute++) * 60_000).toISOString());
				await backups.writeSnapshot(kind, content);
			}
		}
		for (let d = DAILY_COUNT - 1; d >= 0; d--) {
			clock.set(new Date(now - d * 86_400_000).toISOString());
			await backups.writeSnapshot("daily", content);
		}
		clock.set(new Date(now).toISOString());
		const files = (await gateway.list(backups.snapshotDir)).length;
		expect(files).toBe(5 + 5 + 5 * PRE_KINDS.length + DAILY_COUNT);

		// Warm up, then time the retention pass (list + parse + sort + nothing to remove).
		await backups.prune();
		expect((await gateway.list(backups.snapshotDir)).length, "steady state: nothing to prune").toBe(files);
		const prunes: number[] = [];
		const listed: number[] = [];
		for (let i = 0; i < REPEATS; i++) {
			prunes.push(await elapsedAsync(() => backups.prune()));
			listed.push(await elapsedAsync(() => gateway.list(backups.snapshotDir)));
		}
		const pruneMs = median(prunes);
		const listMs = median(listed);
		perfLog(`issue-35: ${files} snapshots; prune median ${pruneMs.toFixed(3)} ms (max ${Math.max(...prunes).toFixed(3)}), raw in-memory list median ${listMs.toFixed(3)} ms`);
		expect((await gateway.list(backups.snapshotDir)).length, "nothing pruned in the timed passes").toBe(files);
	});

	it("logs a disk listing of a folder with the same number of files (readdir and one stat per file)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "logwell-issue-35-"));
		try {
			const files = 5 + 5 + 5 * PRE_KINDS.length + DAILY_COUNT;
			for (let i = 0; i < files; i++) await writeFile(join(dir, `hourly-20261001T1000${i.toString().padStart(2, "0")}000Z~20261001T100000000Z~r-000000000000.cpbase`), "x");
			const times: number[] = [];
			let listed = 0;
			for (let i = 0; i < REPEATS; i++) {
				const { result: names, ms } = await measuredAsync(async () => {
					const found = await readdir(dir);
					await Promise.all(found.map((n) => stat(join(dir, n))));
					return found;
				});
				times.push(ms);
				listed = names.length;
			}
			perfLog(`issue-35: disk readdir + stat of ${files} files, median ${median(times).toFixed(3)} ms (warm OS cache)`);
			expect(listed).toBe(files);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
