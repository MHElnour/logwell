// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { createEmptyDb } from "../../src/persistence/schema";
import { serializeDb } from "../../src/persistence/serializer";
import { appHarness } from "../app/harness";
import { makeTask } from "../persistence/fixtures";
import { mountApp, settle } from "./app-helpers";

// The Tasks section's filter drops a tag that is gone too. Nothing in the Tasks
// section picks tags for its filter today, so the test starts it with one.

vi.mock("../../src/ui/TasksSection", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../../src/ui/TasksSection")>();
	const { emptyFilter } = await import("../../src/domain/queries");
	return {
		...mod,
		initialTasksState: () => ({ ...mod.initialTasksState(), view: { kind: "inbox" }, filter: { ...emptyFilter(), tagKeys: ["calls"] } }),
	};
});

const TS = "2026-10-01T08:00:00.000Z";

function file(): string {
	const data = createEmptyDb({ dbId: "db-1", revision: "r-000000000000", deviceId: "d-other", now: TS });
	const tags = new Map(data.tags);
	tags.set("calls", { key: "calls", displayName: "Calls", color: null, createdAt: TS, modifiedAt: TS });
	const tasks = new Map(data.tasks);
	tasks.set("t1", makeTask("t1", { title: "Ring mum", tagKeys: ["calls"], sortKey: "V1" }));
	tasks.set("t2", makeTask("t2", { title: "Pay rent", sortKey: "V2" }));
	return serializeDb({ ...data, tags, tasks });
}

describe("Tasks section filter", () => {
	it("drops a deleted tag, so the list shows its tasks again", async () => {
		const h = await appHarness({ initial: file() });
		const { root } = await mountApp({}, { harness: h });
		const titles = () => [...root.querySelectorAll(".cp-tasks .cp-task-row .cp-task-title")].map((e) => e.textContent.trim()).sort();
		expect(titles()).toEqual(["Ring mum"]);
		await h.app.tags.delete("calls");
		await settle();
		expect(titles()).toEqual(["Pay rent", "Ring mum"]);
	});
});
