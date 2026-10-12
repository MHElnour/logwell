import { describe, expect, it } from "vitest";
import { resolveTagName, tagLabel, tagNamesOf } from "../../src/domain/tags";
import type { Tag, Task } from "../../src/domain/types";
import type { DbData } from "../../src/persistence/schema";
import { sameLookups } from "../../src/ui/rowMemo";
import { appHarness } from "../app/harness";
import { makeTask } from "../persistence/fixtures";

describe("tag labels", () => {
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
});

describe("tag rename", () => {
	// Renaming a parent tag at 50,000 tasks (Lists, sections and tags rule 24): one pass over the tasks and the trash,
	// in one write, and one Undo. The time bound is loose so it passes on CI.

	const TASKS = 50_000;
	const TAGS = 200;
	const CI_SLACK = process.env.CI ? 4 : 1;
	const BUDGET_MS = 300 * CI_SLACK;
	const TS = "2026-09-01T09:00:00.000Z";

	describe("tag rename at 50,000 tasks", () => {
		it("renames a parent with 20 children on 5,000 tasks, and undoes it, within the budget", async () => {
			const h = await appHarness();
			await h.app.store.run("Seed", (tx) => {
				const put = (key: string, displayName: string) => tx.put("tags", { key, displayName, color: null, createdAt: TS, modifiedAt: TS } satisfies Tag);
				put("home", "Home");
				for (let i = 0; i < 20; i++) put(`home/child${i}`, `Home/Child${i}`);
				for (let i = 21; i < TAGS; i++) put(`tag${i}`, `Tag${i}`);
				for (let i = 0; i < TASKS; i++) {
					const tagKeys = i < 5_000 ? [i % 21 === 0 ? "home" : `home/child${i % 20}`, `tag${21 + (i % 100)}`] : [`tag${21 + (i % (TAGS - 21))}`];
					tx.put("tasks", makeTask(`t${i}`, { tagKeys, sortKey: `V${i}` }));
				}
				// Trash entries, half of them holding a key the rename moves: the rename rewrites them, and the undo's
				// reference check reads them all.
				for (let i = 0; i < 100; i++) {
					const tasks = [0, 1, 2].map((j) => makeTask(`d${i}-${j}`, { tagKeys: i % 2 === 0 ? [`home/child${(i + j) % 20}`] : [`tag${21 + i}`] }));
					tx.put("trash", { batchId: `b${i}`, deletedAt: TS, tasks });
				}
			});
			const before = h.app.store.state;

			const start = performance.now();
			const r = await h.app.tags.edit("home", { name: "House", parentKey: null, color: null });
			const renamed = performance.now() - start;
			expect(r.wrote).toBe(true);
			expect(h.app.store.state.tasks.get("t1")!.tagKeys[0]).toBe("house/child1");
			expect(h.app.store.state.tags.has("house/child19")).toBe(true);

			const undoStart = performance.now();
			await h.app.store.undo();
			const undone = performance.now() - undoStart;
			expect(h.app.store.state.tasks.get("t1")).toBe(before.tasks.get("t1"));
			expect(h.app.store.state.trash.get("b0")).toBe(before.trash.get("b0"));
			expect(h.app.store.state.tags.has("home/child19")).toBe(true);

			expect(renamed + undone).toBeLessThan(BUDGET_MS);
		});
	});
});

describe("parent tag delete", () => {
	// Deleting a parent tag at 50,000 tasks (Lists, sections and tags rule 28): its children move to the top level in one
	// pass over the tasks and the trash, in one write, and one Undo. The time bound is loose so it passes on CI.

	const TASKS = 50_000;
	const TAGS = 200;
	const CI_SLACK = process.env.CI ? 4 : 1;
	const BUDGET_MS = 300 * CI_SLACK;
	const TS = "2026-09-01T09:00:00.000Z";

	describe("parent tag delete at 50,000 tasks", () => {
		it("deletes a parent with 20 children on 5,000 tasks, and undoes it, within the budget", async () => {
			const h = await appHarness();
			await h.app.store.run("Seed", (tx) => {
				const put = (key: string, displayName: string) => tx.put("tags", { key, displayName, color: null, createdAt: TS, modifiedAt: TS } satisfies Tag);
				put("home", "Home");
				for (let i = 0; i < 20; i++) put(`home/child${i}`, `Home/Child${i}`);
				for (let i = 21; i < TAGS; i++) put(`tag${i}`, `Tag${i}`);
				for (let i = 0; i < TASKS; i++) {
					const tagKeys = i < 5_000 ? [i % 21 === 0 ? "home" : `home/child${i % 20}`, `tag${21 + (i % 100)}`] : [`tag${21 + (i % (TAGS - 21))}`];
					tx.put("tasks", makeTask(`t${i}`, { tagKeys, sortKey: `V${i}` }));
				}
				// Trash entries, half of them holding a key the delete moves: the delete rewrites them, and the undo's
				// reference check reads them all.
				for (let i = 0; i < 100; i++) {
					const tasks = [0, 1, 2].map((j) => makeTask(`d${i}-${j}`, { tagKeys: i % 2 === 0 ? [`home/child${(i + j) % 20}`] : [`tag${21 + i}`] }));
					tx.put("trash", { batchId: `b${i}`, deletedAt: TS, tasks });
				}
			});
			const before = h.app.store.state;

			const start = performance.now();
			const r = await h.app.tags.delete("home");
			const deleted = performance.now() - start;
			expect(r.wrote).toBe(true);
			expect(r.moves).toHaveLength(20);
			expect(h.app.store.state.tasks.get("t1")!.tagKeys[0]).toBe("child1");
			expect(h.app.store.state.tasks.get("t0")!.tagKeys).toEqual(["tag21"]);
			expect(h.app.store.state.tags.has("child19")).toBe(true);
			expect(h.app.store.state.tags.has("home")).toBe(false);

			const undoStart = performance.now();
			await h.app.store.undo();
			const undone = performance.now() - undoStart;
			expect(h.app.store.state.tasks.get("t1")).toBe(before.tasks.get("t1"));
			expect(h.app.store.state.trash.get("b0")).toBe(before.trash.get("b0"));
			expect(h.app.store.state.tags.has("home/child19")).toBe(true);

			expect(deleted + undone).toBeLessThan(BUDGET_MS);
		});
	});
});
