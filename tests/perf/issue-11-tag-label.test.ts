import { describe, expect, it } from "vitest";
import { resolveTagName, tagLabel, tagNamesOf } from "../../src/domain/tags";
import type { Tag, Task } from "../../src/domain/types";
import type { DbData } from "../../src/persistence/schema";
import { sameLookups } from "../../src/ui/rowMemo";

// Tag labels at 50,000 tasks (issue 11). A label depends on the other tags, so a row compares its tags' labels when the
// tags change. With the names memoized per tags map that is one pass over the tags plus O(1) per row, not a scan of
// the tags per row. The time bound is loose so it passes on CI.

const TASKS = 50_000;
const TAGS = 200;
const CI_SLACK = process.env.CI ? 4 : 1;
const BUDGET_MS = 300 * CI_SLACK;
const TS = "2026-09-01T09:00:00.000Z";

const tagMap = (count: number, skip?: string): Map<string, Tag> => {
	const tags = new Map<string, Tag>();
	for (let i = 0; i < count; i++) {
		const key = `parent${i % 20}/tag${i}`;
		if (key !== skip) tags.set(key, { key, displayName: `Parent${i % 20}/Tag${i}`, color: null, createdAt: TS, modifiedAt: TS });
	}
	return tags;
};

describe("tag labels at 50,000 tasks", () => {
	it("a tags change redraws no row whose labels are the same, in one pass over the tags", () => {
		const before = tagMap(TAGS);
		const after = new Map(before);
		after.set("extra/tag-new", { key: "extra/tag-new", displayName: "Extra/Tag-new", color: null, createdAt: TS, modifiedAt: TS });
		const prev = { categories: new Map(), tags: before } as unknown as DbData;
		const next = { categories: new Map(), tags: after } as unknown as DbData;
		const keys = [...before.keys()];
		const tasks = Array.from({ length: TASKS }, (_, i) => ({ id: String(i), categoryId: "inbox", tagKeys: [keys[i % keys.length]!, keys[(i * 7) % keys.length]!] }) as unknown as Task);
		const start = performance.now();
		let redraws = 0;
		for (const task of tasks) if (!sameLookups(prev, next, task)) redraws++;
		const ms = performance.now() - start;
		expect(redraws).toBe(0);
		expect(ms).toBeLessThan(BUDGET_MS);
	});

	it("label and resolve use one memoized names object per tags map", () => {
		const tags = tagMap(TAGS);
		const names = tagNamesOf(tags);
		expect(tagNamesOf(tags)).toBe(names);
		const start = performance.now();
		for (let i = 0; i < TASKS; i++) {
			const key = `parent${i % 20}/tag${i % TAGS}`;
			if (tags.has(key)) tagLabel(tags, key);
			resolveTagName(names, `tag${i % TAGS}`);
		}
		expect(performance.now() - start).toBeLessThan(BUDGET_MS);
	});

	it("deleting a duplicate redraws only the rows of the tag whose label changed", () => {
		const dup = tagMap(TAGS);
		dup.set("other/tag0", { key: "other/tag0", displayName: "Other/Tag0", color: null, createdAt: TS, modifiedAt: TS });
		const rest = new Map(dup);
		rest.delete("other/tag0");
		const prev = { categories: new Map(), tags: dup } as unknown as DbData;
		const next = { categories: new Map(), tags: rest } as unknown as DbData;
		const row = (tagKey: string) => ({ id: "t", categoryId: "inbox", tagKeys: [tagKey] }) as unknown as Task;
		expect(sameLookups(prev, next, row("parent0/tag0"))).toBe(false);
		expect(sameLookups(prev, next, row("parent1/tag1"))).toBe(true);
	});
});
