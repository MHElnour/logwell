import { describe, expect, it } from "vitest";
import type { Tag } from "../../src/domain/types";
import { appHarness } from "../app/harness";
import { makeTask } from "../persistence/fixtures";

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
		expect(h.app.store.state.tags.has("home/child19")).toBe(true);

		expect(renamed + undone).toBeLessThan(BUDGET_MS);
	});
});
