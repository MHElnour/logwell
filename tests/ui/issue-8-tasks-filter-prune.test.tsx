// @vitest-environment happy-dom
import { render } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyDb } from "../../src/persistence/schema";
import { serializeDb } from "../../src/persistence/serializer";
import { AppRoot } from "../../src/ui/AppRoot";
import { appHarness } from "../app/harness";
import { makeTask } from "../persistence/fixtures";
import { U1Host, settle } from "./u1-helpers";

// The Tasks section's filter drops a tag that is gone too (Lists, sections and tags rule 24). Nothing in the Tasks
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

let root: HTMLElement | null = null;
afterEach(() => {
	if (root !== null) render(null, root);
	root?.remove();
	root = null;
});

describe("Tasks section filter", () => {
	it("drops a deleted tag, so the list shows its tasks again", async () => {
		(HTMLElement.prototype as unknown as { empty: () => void }).empty = function (this: HTMLElement) {
			this.replaceChildren();
		};
		const h = await appHarness({ initial: file() });
		const host = new U1Host(h);
		root = document.createElement("div");
		document.body.appendChild(root);
		render(<AppRoot host={host} initialSection={null} handle={() => undefined} />, root);
		await settle();
		const titles = () => [...root!.querySelectorAll(".cp-tasks .cp-task-row .cp-task-title")].map((e) => e.textContent.trim()).sort();
		expect(titles()).toEqual(["Ring mum"]);
		await h.app.tags.delete("calls");
		await settle();
		expect(titles()).toEqual(["Pay rent", "Ring mum"]);
	});
});
