// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutoScroller } from "../../src/ui/drag";

// The drag autoscroller. rAF is stubbed and stepped by hand.

let frames: FrameRequestCallback[] = [];
const runFrame = () => {
	const cbs = frames;
	frames = [];
	for (const cb of cbs) cb(0);
};

beforeEach(() => {
	frames = [];
	vi.useFakeTimers();
	vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
	window.requestAnimationFrame = (cb: FrameRequestCallback) => frames.push(cb);
	window.cancelAnimationFrame = (id: number) => {
		frames[id - 1] = () => undefined;
	};
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	document.body.replaceChildren();
});

/** A 300 x 400 box at (0, 0) with 2000 px of content in both directions. */
function box(scrollTop = 500, scrollLeft = 500): HTMLElement {
	const el = document.createElement("div");
	document.body.appendChild(el);
	el.getBoundingClientRect = () => ({ left: 0, top: 0, right: 300, bottom: 400, width: 300, height: 400, x: 0, y: 0, toJSON: () => ({}) });
	for (const [k, v] of [
		["scrollHeight", 2000],
		["clientHeight", 400],
		["scrollWidth", 2000],
		["clientWidth", 300],
	] as const) {
		Object.defineProperty(el, k, { value: v, configurable: true });
	}
	el.scrollTop = scrollTop;
	el.scrollLeft = scrollLeft;
	return el;
}

describe("createAutoScroller (D8)", () => {
	it("scrolls up near the top edge and down near the bottom edge, faster closer to the edge", () => {
		const el = box();
		const s = createAutoScroller(() => [el]);
		s.update({ x: 150, y: 20 });
		runFrame();
		const slow = 500 - el.scrollTop;
		expect(slow).toBeGreaterThan(0);
		el.scrollTop = 500;
		s.update({ x: 150, y: 2 });
		runFrame();
		const fast = 500 - el.scrollTop;
		expect(fast).toBeGreaterThan(slow);
		el.scrollTop = 500;
		s.update({ x: 150, y: 390 });
		runFrame();
		expect(el.scrollTop).toBeGreaterThan(500);
		s.stop();
	});

	it("scrolls sideways near the left and right edges", () => {
		const el = box();
		const s = createAutoScroller(() => [el]);
		s.update({ x: 5, y: 200 });
		runFrame();
		expect(el.scrollLeft).toBeLessThan(500);
		s.update({ x: 295, y: 200 });
		runFrame();
		runFrame();
		expect(el.scrollLeft).toBeGreaterThan(0);
		s.stop();
	});

	it("keeps scrolling while the pointer is still", () => {
		const el = box();
		const s = createAutoScroller(() => [el]);
		s.update({ x: 150, y: 395 });
		runFrame();
		const a = el.scrollTop;
		runFrame();
		const b = el.scrollTop;
		runFrame();
		expect(b).toBeGreaterThan(a);
		expect(el.scrollTop).toBeGreaterThan(b);
		s.stop();
	});

	it("does nothing away from the edges", () => {
		const el = box();
		const s = createAutoScroller(() => [el]);
		s.update({ x: 150, y: 200 });
		runFrame();
		expect(el.scrollTop).toBe(500);
		expect(el.scrollLeft).toBe(500);
		expect(frames.length).toBe(0);
		s.stop();
	});

	it("stops when the pointer moves away from the edge", () => {
		const el = box();
		const s = createAutoScroller(() => [el]);
		s.update({ x: 150, y: 395 });
		runFrame();
		const at = el.scrollTop;
		s.update({ x: 150, y: 200 });
		runFrame();
		runFrame();
		expect(el.scrollTop).toBe(at);
		s.stop();
	});

	it("stop() ends the loop", () => {
		const el = box();
		const s = createAutoScroller(() => [el]);
		s.update({ x: 150, y: 395 });
		runFrame();
		const at = el.scrollTop;
		s.stop();
		runFrame();
		runFrame();
		expect(el.scrollTop).toBe(at);
	});

	it("never scrolls past either end and goes idle there", () => {
		const el = box(5, 0);
		const s = createAutoScroller(() => [el]);
		s.update({ x: 150, y: 0 });
		runFrame();
		expect(el.scrollTop).toBe(0);
		runFrame();
		expect(el.scrollTop).toBe(0);
		expect(frames.length).toBe(0);
		const bottom = box(1595, 0);
		const s2 = createAutoScroller(() => [bottom]);
		s2.update({ x: 150, y: 399 });
		runFrame();
		runFrame();
		expect(bottom.scrollTop).toBe(1600);
		expect(frames.length).toBe(0);
		s.stop();
		s2.stop();
	});

	it("scrolls only the container the point is in", () => {
		const a = box();
		const b = box();
		b.getBoundingClientRect = () => ({ left: 400, top: 0, right: 700, bottom: 400, width: 300, height: 400, x: 400, y: 0, toJSON: () => ({}) });
		const s = createAutoScroller(() => [a, b]);
		s.update({ x: 550, y: 395 });
		runFrame();
		expect(a.scrollTop).toBe(500);
		expect(b.scrollTop).toBeGreaterThan(500);
		s.stop();
	});

	it("honours the edge and maxSpeed options", () => {
		const el = box();
		const s = createAutoScroller(() => [el], { edge: 10, maxSpeed: 3 });
		s.update({ x: 150, y: 30 });
		runFrame();
		expect(el.scrollTop).toBe(500);
		s.update({ x: 150, y: 0 });
		runFrame();
		expect(500 - el.scrollTop).toBe(3);
		s.stop();
	});
});
