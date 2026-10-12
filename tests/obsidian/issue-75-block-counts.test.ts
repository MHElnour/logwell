// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/app/settings";
import { BLOCK_LANGUAGE, type BlockEnv, REFRESH_MS, registerDashboardBlock } from "../../src/obsidian/dashboardBlock";
import { appHarness } from "../app/harness";
import { Plugin } from "../app/obsidian-stub";
import { U1Host } from "../ui/u1-helpers";

// Issue 75: a task block reads the subtask counts of its shown parents from the task index (`subtaskCounts()`),
// not from a pass over every task of its own.

beforeAll(() => {
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	proto.empty = function (this: HTMLElement) {
		this.replaceChildren();
	};
	Object.defineProperty(HTMLElement.prototype, "win", { configurable: true, get: () => window });
	Object.defineProperty(HTMLElement.prototype, "doc", { configurable: true, get: () => document });
	proto.createDiv = function (this: HTMLElement, o: { cls: string }) {
		const el = this.ownerDocument.createElement("div");
		el.className = o.cls;
		this.appendChild(el);
		return el;
	};
	proto.isShown = function (this: HTMLElement) {
		return this.isConnected;
	};
	vi.stubGlobal("IntersectionObserver", undefined);
	(window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = undefined;
});
afterAll(() => {
	vi.unstubAllGlobals();
});

const children: { unload(): void }[] = [];
const elements: HTMLElement[] = [];
afterEach(() => {
	vi.useRealTimers();
	for (const c of children.splice(0)) c.unload();
	for (const e of elements.splice(0)) e.remove();
});

async function setup() {
	const h = await appHarness();
	const host = new U1Host(h);
	const plugin = new Plugin({}, {});
	const session = { app: h.app, host };
	const env: BlockEnv = { session: () => session, onSession: () => () => undefined, settings: () => DEFAULT_SETTINGS, openTask: () => undefined, openView: () => undefined };
	registerDashboardBlock(plugin as never, env);
	const processor = plugin.codeBlockProcessors.get(BLOCK_LANGUAGE)!;
	const block = (source: string) => {
		const el = document.createElement("div");
		document.body.appendChild(el);
		elements.push(el);
		processor(source, el, { sourcePath: "Note.md", addChild: (c: { load(): void; unload(): void }) => (children.push(c), c.load()) });
		return el;
	};
	return { h, block };
}

const badge = (el: HTMLElement, title: string) =>
	[...el.querySelectorAll<HTMLElement>(".cp-task-row")]
		.find((r) => r.querySelector(".cp-task-title")!.textContent.trim() === title)
		?.querySelector(".cp-meta-subtasks")
		?.textContent.replace(/\s/g, "");

describe("a task block's subtask counts (issue 75)", () => {
	it("reads them from the task index in a draw, and the badge matches", async () => {
		const { h, block } = await setup();
		const parent = (await h.app.tasks.create({ title: "Parent", priority: 1 })).task;
		const done = (await h.app.tasks.create({ title: "Done", parentId: parent.id })).task;
		await h.app.tasks.create({ title: "Open", parentId: parent.id });
		await h.app.tasks.complete(done.id);
		await h.app.tasks.create({ title: "Other", priority: 1 });
		const spy = vi.spyOn(h.app.tasks.lists, "subtaskCounts");
		const el = block("priority: high");
		// Once for the block's check of what changed, once by the list for its badges.
		expect(spy).toHaveBeenCalledTimes(2);
		expect(badge(el, "Parent")).toBe("1/2");
		expect(badge(el, "Other")).toBeUndefined();
	});

	it("follows a change of a count in the next draw", async () => {
		const { h, block } = await setup();
		const parent = (await h.app.tasks.create({ title: "Parent" })).task;
		const child = (await h.app.tasks.create({ title: "Child", parentId: parent.id })).task;
		const el = block("");
		expect(badge(el, "Parent")).toBe("0/1");
		vi.useFakeTimers();
		await h.app.tasks.complete(child.id);
		await vi.advanceTimersByTimeAsync(REFRESH_MS + 10);
		expect(badge(el, "Parent")).toBe("1/1");
	});
});
