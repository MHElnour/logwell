import { describe, expect, it } from "vitest";
import type { Change } from "../../src/app/tx";
import { Tx } from "../../src/app/tx";
import { makeTask } from "../persistence/fixtures";
import { appHarness } from "./harness";

// The sync calls `tx.finish()` inside its command to learn whether the pull wrote anything. That call must
// have no side effects: the base state, later writes and the store's own commit are unchanged by it.

describe("Tx.finish is pure (issue #6)", () => {
	it("returns the same result twice and leaves the base untouched", async () => {
		const h = await appHarness();
		const base = h.app.store.state;
		const tx = new Tx(base, "2026-10-01T10:00:00.000Z");
		tx.put("tasks", makeTask("t1"));
		const a = tx.finish();
		const b = tx.finish();
		expect(b.ops).toEqual(a.ops);
		expect(b.changes).toEqual(a.changes);
		expect(base.tasks.has("t1")).toBe(false);
		// Writes after it still count.
		tx.put("tasks", makeTask("t2"));
		expect(tx.finish().ops.map((o) => o.id).sort()).toEqual(["t1", "t2"]);
	});

	it("does not change what the store commits, undoes or emits", async () => {
		const run = async (peek: boolean) => {
			const h = await appHarness();
			const events: (readonly Change[] | undefined)[] = [];
			h.app.store.bus.on("changed", (e) => events.push(e.changes));
			await h.app.store.run("Probe", (tx) => {
				tx.put("tasks", makeTask("t1"));
				if (peek) expect(tx.finish().ops).toHaveLength(1);
				tx.put("tasks", makeTask("t2", { title: "Second" }));
			});
			return { tasks: [...h.app.store.state.tasks.keys()].sort(), undo: h.app.store.undoLabel, events: events.map((c) => c?.map((x) => x.id).sort()) };
		};
		expect(await run(true)).toEqual(await run(false));
	});
});
