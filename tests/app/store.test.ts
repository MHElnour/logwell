import { describe, expect, it } from "vitest";
import type { Task } from "../../src/domain/types";
import type { ReferenceProblem } from "../../src/persistence/references";
import { makeTask } from "../persistence/fixtures";
import { appHarness, expectDomainError } from "./harness";

describe("the reference check at commit", () => {
	// Every command's result is checked against the table of links before it is saved: no record may point at one that
	// is gone. In the test harnesses the check refuses the command (enforce); in Obsidian it saves the command and
	// reports the problem (report), until the check has run a release without a report.

	async function withList() {
		const h = await appHarness();
		const list = await h.app.categories.create("Work");
		return { h, store: h.app.store, listId: list.id };
	}

	const ORPHAN = makeTask("t-orphan", { categoryId: "gone" });

	describe("#215: enforce", () => {
		it.each([
			{ name: "an undoable command", undoable: true },
			{ name: "a command without Undo (a sync pull, a rename)", undoable: false },
		])("refuses $name that leaves a broken link, and commits nothing", async ({ undoable }) => {
			const { store } = await withList();
			const state = store.state;
			const version = store.version;
			const below = store.undoLabel;
			await expectDomainError(
				store.run("Create task", (tx) => tx.put("tasks", ORPHAN), { undoable }),
				"ReferenceConflict",
				"Cannot create task: a task is in a list that does not exist.",
			);
			expect(store.state).toBe(state);
			expect(store.version).toBe(version);
			expect(store.undoLabel).toBe(below);
		});

		it("refuses removing a record an unchanged record points at", async () => {
			const { h, store, listId } = await withList();
			await h.app.tasks.create({ title: "Call the bank", categoryId: listId });
			await expectDomainError(store.run("Delete list", (tx) => tx.remove("categories", listId)), "ReferenceConflict", "Cannot delete list: a task now uses this list.");
			expect(store.state.categories.has(listId)).toBe(true);
		});

		it.each([
			{ name: "the subtask first", order: ["sub", "parent"] },
			{ name: "the parent first", order: ["parent", "sub"] },
		])("saves a parent and its new subtask written in one command, $name", async ({ order }) => {
			const { store, listId } = await withList();
			const records: Record<string, Task> = { parent: makeTask("t-parent", { categoryId: listId }), sub: makeTask("t-sub", { categoryId: listId, parentId: "t-parent" }) };
			await store.run("Create task", (tx) => {
				for (const name of order) tx.put("tasks", records[name]!);
			});
			expect(store.state.tasks.get("t-sub")?.parentId).toBe("t-parent");
		});
	});

	describe("#215: report", () => {
		it("saves the command and reports each problem with the command's label", async () => {
			const { store } = await withList();
			store.referenceMode = "report";
			const reported: [string, readonly ReferenceProblem[]][] = [];
			store.onReferenceProblem = (label, problems) => reported.push([label, problems]);
			await store.run("Create task", (tx) => tx.put("tasks", ORPHAN));
			expect(store.state.tasks.get(ORPHAN.id)).toBe(ORPHAN);
			expect(store.undoLabel).toBe("Create task");
			expect(reported.map(([label, problems]) => [label, problems.map((p) => [p.id, p.target, p.message])])).toEqual([
				["Create task", [[ORPHAN.id, "gone", "a task is in a list that does not exist."]]],
			]);
		});

		it("reports nothing for a command that leaves every link whole", async () => {
			const { h, store, listId } = await withList();
			store.referenceMode = "report";
			let reports = 0;
			store.onReferenceProblem = () => reports++;
			const { task } = await h.app.tasks.create({ title: "Call the bank", categoryId: listId, newTags: ["Home"] });
			await h.app.tasks.create({ title: "Find the account number", parentId: task.id });
			await h.app.categories.delete(listId);
			expect(reports).toBe(0);
		});
	});
});
