// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { click, flushEffects, mountApp, settle, typeInto } from "./app-helpers";

// Reading `scrollLeft` of the Quick Add input after every commit forces a synchronous layout of everything the
// commit changed (350-475 ms at 50,000 tasks). The editor aligns the highlight layer only when its own content
// changed, and on scroll.

/** Counts reads of the input's `scrollLeft` and lets a test choose the value. */
function watchScrollLeft(input: HTMLInputElement): { reads: () => number; set: (v: number) => void } {
	let value = 0;
	let reads = 0;
	Object.defineProperty(input, "scrollLeft", {
		configurable: true,
		get: () => {
			reads++;
			return value;
		},
		set: (v: number) => {
			value = v;
		},
	});
	return { reads: () => reads, set: (v) => (value = v) };
}

const type = async (input: HTMLInputElement, text: string) => {
	await typeInto(input, text);
	await flushEffects();
};

describe("Quick Add editor scroll alignment", () => {
	it("does not read scrollLeft when the app re-renders for another reason", async () => {
		const m = await mountApp();
		await m.h.app.tasks.create({ title: "A", scheduled: { kind: "date", date: "2026-10-01" } });
		await flushEffects();
		const input = m.root.querySelector<HTMLInputElement>(".cp-tasks .cp-add-bar .cp-qa-input")!;
		const watch = watchScrollLeft(input);
		// A store change, a selection and a full re-render of the app: none touches the editor's content.
		await m.h.app.tasks.create({ title: "B" });
		await settle();
		await click(m.root.querySelector(".cp-tasks .cp-task-row"));
		await m.rerender();
		await flushEffects();
		expect(watch.reads()).toBe(0);
	});

	it("keeps the highlight layer aligned with the input when its text changes", async () => {
		const m = await mountApp();
		const input = m.root.querySelector<HTMLInputElement>(".cp-tasks .cp-add-bar .cp-qa-input")!;
		const mirror = m.root.querySelector<HTMLElement>(".cp-tasks .cp-add-bar .cp-qa-mirror")!;
		const watch = watchScrollLeft(input);
		watch.set(37);
		await type(input, "Read the very long chapter title tomorrow at 7pm");
		expect(watch.reads()).toBeGreaterThan(0);
		expect(mirror.scrollLeft).toBe(37);
	});

	it("aligns on a scroll of the input", async () => {
		const m = await mountApp();
		const input = m.root.querySelector<HTMLInputElement>(".cp-tasks .cp-add-bar .cp-qa-input")!;
		const mirror = m.root.querySelector<HTMLElement>(".cp-tasks .cp-add-bar .cp-qa-mirror")!;
		const watch = watchScrollLeft(input);
		watch.set(12);
		input.dispatchEvent(new Event("scroll"));
		expect(mirror.scrollLeft).toBe(12);
	});
});
