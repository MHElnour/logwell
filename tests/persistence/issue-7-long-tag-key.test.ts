import { describe, expect, it } from "vitest";
import { TAG_LENGTH_MESSAGE } from "../../src/domain/tags";
import { createEmptyDb } from "../../src/persistence/schema";
import { serializeDb } from "../../src/persistence/serializer";
import { appHarness } from "../app/harness";
import { load, makeTask } from "./fixtures";

// The 64-character limit applies to NEW names only (Lists, sections and tags rule 21): a longer tag already in a file
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
