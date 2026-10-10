import { describe, expect, it } from "vitest";
import { rule } from "../domain/recurrence-fixtures";
import { appHarness } from "./harness";

// Known limitation: merge by ID compares records by their timestamp and never
// removes what only the other side lacks, so a removal is not carried by a merge. A task purged from Trash
// comes back from an older backup, and so does an occurrence record that Reopen removed. There are no
// tombstones; this test pins the behavior so a later change is deliberate.

describe("merge import and removed records", () => {
	it("an older backup brings back a purged task and a reopened occurrence", async () => {
		const h = await appHarness();
		h.clock.set("2026-10-05T10:00:00.000Z");
		const t = (await h.app.tasks.create({ title: "Gym", scheduled: { kind: "date", date: "2026-10-05" }, repeat: { rule: rule() } })).task;
		const gone = (await h.app.tasks.create({ title: "Gone" })).task;
		await h.app.tasks.complete(t.id);
		const backup = h.app.data.exportJson();

		await h.app.recurrence.reopen(t.id, "2026-10-05");
		await h.app.tasks.delete(gone.id);
		await h.app.tasks.emptyTrash();
		expect(h.app.store.state.occurrenceRecords.size).toBe(0);
		expect(h.app.store.state.tasks.has(gone.id)).toBe(false);

		const result = h.app.data.previewImport(backup);
		if (!result.ok) throw new Error(result.message);
		await h.app.data.importMerge(result.preview);
		expect(h.app.store.state.occurrenceRecords.has(`${t.id}:2026-10-05`)).toBe(true);
		expect(h.app.store.state.tasks.has(gone.id)).toBe(true);
	});
});
