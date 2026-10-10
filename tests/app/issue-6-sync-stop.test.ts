import { describe, expect, it } from "vitest";
import { linkedList, syncHarness } from "./sync-harness";

// `stop()` (a session closing) stops the sync between two requests: at most the request already in flight
// completes, what TickTick answered is still linked, and nothing else is sent or pulled.

const creates = (calls: string[]) => calls.filter((c) => c.startsWith("createTask")).length;

describe("stopping a sync (issue #6)", () => {
	it("mid-push: no request after the one in flight, whose answer is still linked", async () => {
		const s = await syncHarness();
		const { listId } = await linkedList(s);
		for (const title of ["One", "Two", "Three"]) await s.h.app.tasks.create({ title, categoryId: listId });
		let release!: () => void;
		const held = new Promise<void>((r) => (release = r));
		let first = true;
		s.tt.onCall = (m) => {
			if (m !== "createTask" || !first) return undefined;
			first = false;
			return held;
		};
		const running = s.sync.sync();
		await new Promise((r) => setTimeout(r, 0));
		while (creates(s.tt.calls) === 0) await new Promise((r) => setTimeout(r, 0));
		s.sync.stop();
		const calls = s.tt.calls.length;
		release();
		const r = await running;
		expect(r.ok).toBe(false);
		expect(s.tt.calls.length).toBe(calls);
		const linked = ["One", "Two", "Three"].filter((t) => s.link("task", s.task(t).id) !== undefined);
		expect(linked).toHaveLength(1);
		expect(s.tt.findByTitle(linked[0]!)?.id).toBe(s.ttIdOf(linked[0]!));
	});

	it("mid-pull: nothing pulled is written", async () => {
		const s = await syncHarness();
		const { projectId } = await linkedList(s);
		s.tt.add(projectId, { title: "From TickTick" });
		let release!: () => void;
		const held = new Promise<void>((r) => (release = r));
		// The last request of the pull: after it the sync would write what it pulled.
		s.tt.onCall = (m) => (m === "listCompleted" ? held : undefined);
		const state = s.h.app.store.state;
		const running = s.sync.sync();
		await new Promise((r) => setTimeout(r, 0));
		s.sync.stop();
		const calls = s.tt.calls.length;
		release();
		const r = await running;
		expect(r.ok).toBe(false);
		expect(s.tt.calls.length).toBe(calls);
		expect(s.h.app.store.state).toBe(state);
		expect(s.tasks("From TickTick")).toHaveLength(0);
	});
});
