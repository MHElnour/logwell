import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { serializeDb } from "../../src/persistence/serializer";
import { settle } from "../helpers";
import { DB_PATH, descendant, emptyDbText, load, makeTask, withTask } from "../persistence/fixtures";
import { appHarness } from "./harness";

// The import check against a queued external change, and routing the
// Data section's restore and conflict actions through the command queue.

describe("N1: the import's stale-preview check runs where the replacement runs", () => {
	async function previewWithExternalChange(mode: "merge" | "replace") {
		const h = await appHarness();
		const backup = serializeDb(withTask(load(emptyDbText()), makeTask("imp")).next);
		const pv = h.app.data.previewImport(backup);
		if (!pv.ok) throw new Error(pv.message);
		// The modify event for another device's write is queued in the store just
		// before the user confirms.
		h.fs.files.set(DB_PATH, descendant(h.dbText(), (d) => withTask(d, makeTask("remote")).next, "r-remote000001"));
		const ext = h.store.handleExternalChange();
		const confirm = mode === "merge" ? h.app.data.importMerge(pv.preview) : h.app.data.importReplace(pv.preview);
		const [, outcome] = await Promise.allSettled([ext, confirm]);
		await settle();
		return { h, outcome };
	}

	for (const mode of ["merge", "replace"] as const) {
		it(`${mode}: refuses with StalePreview and keeps the external change`, async () => {
			const { h, outcome } = await previewWithExternalChange(mode);
			expect(outcome.status).toBe("rejected");
			expect((outcome as PromiseRejectedResult).reason).toMatchObject({ code: "StalePreview" });
			expect([...h.app.store.state.tasks.keys()]).toEqual(["remote"]);
			expect([...load(h.dbText()).tasks.keys()]).toEqual(["remote"]);
		});
	}

	it("a refused import writes no backup snapshot and leaves the store usable", async () => {
		const { h } = await previewWithExternalChange("merge");
		expect((await h.store.listSnapshots()).filter((s) => s.kind === "pre-import")).toHaveLength(0);
		await h.app.tasks.create({ title: "still works" });
		await h.store.flush();
		expect([...load(h.dbText()).tasks.values()].map((t) => t.title).sort()).toEqual(["Task remote", "still works"]);
	});
});

describe("Data section actions run on the command queue", () => {
	it("restoreSnapshot: a command issued right after runs on the restored state and is kept", async () => {
		const h = await appHarness();
		await h.app.tasks.create({ title: "old" });
		await h.store.flush();
		const [snap] = await h.store.listSnapshots();
		const changed: string[] = [];
		h.app.store.bus.on("changed", (e) => changed.push(e.label));
		const restore = h.app.store.restoreSnapshot(snap!.path);
		const create = h.app.tasks.create({ title: "after" });
		await Promise.all([restore, create]);
		await h.store.flush();
		expect([...load(h.dbText()).tasks.values()].map((t) => t.title)).toEqual(["after"]);
		expect(changed[0]).toBe("Reload");
	});

	it("restoreSnapshot clears the undo history", async () => {
		const h = await appHarness();
		await h.app.tasks.create({ title: "x" });
		await h.store.flush();
		const [snap] = await h.store.listSnapshots();
		expect(h.app.store.canUndo).toBe(true);
		await h.app.store.restoreSnapshot(snap!.path);
		expect(h.app.store.canUndo).toBe(false);
	});

	it("keepMine and keepTheirs resolve the conflict copy and notify status", async () => {
		const h = await appHarness();
		await h.app.tasks.create({ title: "mine" });
		h.fs.files.set(DB_PATH, descendant(emptyDbText(), (d) => withTask(d, makeTask("theirs")).next, "r-other0000001"));
		await h.store.handleExternalChange();
		const [c1] = await h.store.listConflicts();
		expect(c1).toBeDefined();
		let statuses = 0;
		h.app.store.bus.on("status", () => statuses++);
		await h.app.store.keepMine(c1!.path);
		expect([...h.app.store.state.tasks.values()].map((t) => t.title)).toEqual(["mine"]);
		expect(await h.store.listConflicts()).toHaveLength(0);
		expect(statuses).toBeGreaterThan(0);

		await h.app.tasks.create({ title: "more" });
		h.fs.files.set(DB_PATH, descendant(h.dbText(), (d) => withTask(d, makeTask("theirs2")).next, "r-other0000002"));
		await h.store.handleExternalChange();
		const [c2] = await h.store.listConflicts();
		await h.app.store.keepTheirs(c2!.path);
		expect(await h.store.listConflicts()).toHaveLength(0);
	});

	it("restoreRecovered writes the recovered state and notifies", async () => {
		const h = await appHarness();
		await h.app.tasks.create({ title: "kept" });
		await h.store.flush();
		h.fs.files.set(DB_PATH, "<<<<<<< HEAD\nbroken\n");
		await h.store.handleExternalChange();
		expect(h.app.store.readOnlyState?.reason).toBe("damaged");
		await h.app.store.restoreRecovered();
		expect(h.app.store.readOnlyState).toBeNull();
		expect([...load(h.dbText()).tasks.values()].map((t) => t.title)).toEqual(["kept"]);
	});

	it("the UI never calls the mutating host methods directly", () => {
		const dir = join(__dirname, "../../src/ui");
		const offenders: string[] = [];
		for (const f of readdirSync(dir)) {
			if (!/\.tsx?$/.test(f)) continue;
			const text = readFileSync(join(dir, f), "utf8");
			if (/\.host\.(restoreSnapshot|restoreRecovered|keepMine|keepTheirs|replaceAll|commit|flush)\b/.test(text)) offenders.push(f);
		}
		expect(offenders).toEqual([]);
	});
});
