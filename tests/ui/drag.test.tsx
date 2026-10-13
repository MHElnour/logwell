// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginPointerDrag, createAutoScroller, DRAG_THRESHOLD_PX, type DragHandlers, hitTest } from "../../src/ui/drag";
import { render } from "preact";
import { buildList } from "../../src/app/views";
import { emptyFilter, type TaskSort } from "../../src/domain/queries";
import { TaskList } from "../../src/ui/TaskList";
import { type AppHarness, appHarness } from "../app/harness";
import { dragTo, mountNode, pointer, pressKey, rect, releaseAt, settle, taskOf, U1Host } from "./app-helpers";

describe("pointer drag", () => {
	// The shared pointer drag.

	/** The kit's pointer event, with the point in `init`. */
	const ptr = (type: string, init: { x?: number; y?: number; button?: number; pointerType?: string; id?: number } = {}) => pointer(type, init.x ?? 0, init.y ?? 0, init);

	function setup(handlerOverrides: Partial<DragHandlers> = {}) {
		const parent = document.createElement("div");
		const el = document.createElement("button");
		parent.appendChild(el);
		document.body.appendChild(parent);
		(el as unknown as { setPointerCapture: (id: number) => void }).setPointerCapture = vi.fn();
		const calls: string[] = [];
		const handlers: DragHandlers = {
			onStart: () => {
				calls.push("start");
			},
			onMove: (p) => calls.push(`move ${p.x},${p.y}`),
			onDrop: (p) => calls.push(`drop ${p.x},${p.y}`),
			onCancel: () => calls.push("cancel"),
			...handlerOverrides,
		};
		const parentKeys = vi.fn();
		const parentClicks = vi.fn();
		parent.addEventListener("keydown", parentKeys);
		parent.addEventListener("click", parentClicks);
		const down = (init?: Parameters<typeof ptr>[1]) => {
			const e = ptr("pointerdown", { x: 10, y: 10, ...init });
			const c = beginPointerDrag(e, el, handlers);
			live.push(c);
			return c;
		};
		const fire = (type: string, init?: Parameters<typeof ptr>[1]) => el.dispatchEvent(ptr(type, init));
		return { parent, el, calls, down, fire, parentKeys, parentClicks };
	}

	const live: Array<{ cancel(): void } | null> = [];
	afterEach(() => {
		for (const c of live.splice(0)) c?.cancel();
		vi.useRealTimers();
		document.body.innerHTML = "";
	});

	describe("drag.ts constants and helpers", () => {
		it("exports the contract constants", () => {
			expect(DRAG_THRESHOLD_PX).toBe(4);
		});

		it("hitTest returns the first containing candidate or null", () => {
			const mk = (l: number, t: number, r: number, b: number) => {
				const d = document.createElement("div");
				d.getBoundingClientRect = () => ({ left: l, top: t, right: r, bottom: b, width: r - l, height: b - t, x: l, y: t }) as DOMRect;
				return d;
			};
			const a = mk(0, 0, 100, 100);
			const b = mk(50, 50, 200, 200);
			expect(hitTest({ x: 60, y: 60 }, [a, b])).toBe(a);
			expect(hitTest({ x: 150, y: 150 }, [a, b])).toBe(b);
			expect(hitTest({ x: 300, y: 300 }, [a, b])).toBeNull();
			expect(hitTest({ x: 1, y: 1 }, new Set([a]))).toBe(a);
		});
	});

	describe("beginPointerDrag", () => {
		it("captures the pointer", () => {
			const s = setup();
			s.down();
			expect((s.el as unknown as { setPointerCapture: ReturnType<typeof vi.fn> }).setPointerCapture).toHaveBeenCalledWith(1);
		});

		it("ignores the right button and touch", () => {
			const s = setup();
			expect(s.down({ button: 2 })).toBeNull();
			expect(s.down({ pointerType: "touch" })).toBeNull();
			s.fire("pointermove", { x: 100, y: 100 });
			expect(s.calls).toEqual([]);
		});

		it("below the threshold nothing fires and the click proceeds", () => {
			const s = setup();
			const c = s.down();
			s.fire("pointermove", { x: 12, y: 11 });
			s.fire("pointerup", { x: 12, y: 11 });
			s.el.click();
			expect(s.calls).toEqual([]);
			expect(c?.active).toBe(false);
			expect(s.parentClicks).toHaveBeenCalledTimes(1);
		});

		it("starts past the threshold, moves, drops", () => {
			const s = setup();
			const c = s.down();
			s.fire("pointermove", { x: 11, y: 11 });
			expect(s.calls).toEqual([]);
			s.fire("pointermove", { x: 30, y: 10 });
			expect(c?.active).toBe(true);
			s.fire("pointermove", { x: 40, y: 20 });
			s.fire("pointerup", { x: 40, y: 20 });
			expect(s.calls).toEqual(["start", "move 30,10", "move 40,20", "drop 40,20"]);
			expect(c?.active).toBe(false);
		});

		it("passes the origin to the handlers", () => {
			const onMove = vi.fn();
			const s = setup({ onMove });
			s.down();
			s.fire("pointermove", { x: 50, y: 50 });
			expect(onMove).toHaveBeenCalledWith({ x: 50, y: 50 }, { x: 10, y: 10 });
		});

		it("honours a custom threshold", () => {
			const s = setup();
			const e = ptr("pointerdown", { x: 0, y: 0 });
			beginPointerDrag(e, s.el, { onMove: () => s.calls.push("move"), onDrop: () => {}, onCancel: () => {} }, { threshold: 20 });
			s.fire("pointermove", { x: 10, y: 0 });
			expect(s.calls).toEqual([]);
			s.fire("pointermove", { x: 25, y: 0 });
			expect(s.calls).toEqual(["move"]);
		});

		it("swallows the click after a drop, once", () => {
			vi.useFakeTimers();
			const s = setup();
			s.down();
			s.fire("pointermove", { x: 50, y: 50 });
			s.fire("pointerup", { x: 50, y: 50 });
			s.el.click();
			expect(s.parentClicks).not.toHaveBeenCalled();
			s.el.click();
			expect(s.parentClicks).toHaveBeenCalledTimes(1);
		});

		it("stops swallowing after a 0 ms timer if no click came", () => {
			vi.useFakeTimers();
			const s = setup();
			s.down();
			s.fire("pointermove", { x: 50, y: 50 });
			s.fire("pointerup", { x: 50, y: 50 });
			vi.advanceTimersByTime(5);
			s.el.click();
			expect(s.parentClicks).toHaveBeenCalledTimes(1);
		});

		it("onStart returning false refuses: no move, no drop, no cancel, release is not a click", () => {
			const s = setup({ onStart: () => false });
			const c = s.down();
			s.fire("pointermove", { x: 50, y: 50 });
			expect(c?.active).toBe(false);
			s.fire("pointermove", { x: 60, y: 60 });
			s.fire("pointerup", { x: 60, y: 60 });
			s.el.click();
			expect(s.calls).toEqual([]);
			expect(s.parentClicks).not.toHaveBeenCalled();
		});

		it("Escape cancels, does not reach a parent keydown listener, and the release click is swallowed", () => {
			const s = setup();
			const c = s.down();
			s.fire("pointermove", { x: 50, y: 50 });
			const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
			s.el.dispatchEvent(esc);
			expect(s.parentKeys).not.toHaveBeenCalled();
			expect(esc.defaultPrevented).toBe(true);
			expect(s.calls).toEqual(["start", "move 50,50", "cancel"]);
			expect(c?.active).toBe(false);
			s.fire("pointermove", { x: 80, y: 80 });
			s.fire("pointerup", { x: 80, y: 80 });
			s.el.click();
			expect(s.calls).toEqual(["start", "move 50,50", "cancel"]);
			expect(s.parentClicks).not.toHaveBeenCalled();
		});

		it("Escape without an active drag is not swallowed", () => {
			const s = setup();
			s.down();
			const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
			s.el.dispatchEvent(esc);
			expect(s.parentKeys).toHaveBeenCalledTimes(1);
			expect(esc.defaultPrevented).toBe(false);
			// Below threshold counts as not active as well.
			s.fire("pointermove", { x: 11, y: 10 });
			s.el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
			expect(s.parentKeys).toHaveBeenCalledTimes(2);
			expect(s.calls).toEqual([]);
		});

		it("other keys during a drag are not swallowed", () => {
			const s = setup();
			s.down();
			s.fire("pointermove", { x: 50, y: 50 });
			s.el.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }));
			expect(s.parentKeys).toHaveBeenCalledTimes(1);
		});

		it("pointercancel cancels a started drag", () => {
			const s = setup();
			const c = s.down();
			s.fire("pointermove", { x: 50, y: 50 });
			s.fire("pointercancel");
			expect(s.calls).toEqual(["start", "move 50,50", "cancel"]);
			expect(c?.active).toBe(false);
			s.fire("pointermove", { x: 90, y: 90 });
			s.fire("pointerup", { x: 90, y: 90 });
			expect(s.calls).toHaveLength(3);
		});

		it("lostpointercapture before the drop cancels", () => {
			const s = setup();
			s.down();
			s.fire("pointermove", { x: 50, y: 50 });
			s.fire("lostpointercapture");
			expect(s.calls).toEqual(["start", "move 50,50", "cancel"]);
		});

		it("lostpointercapture after the drop does not cancel", () => {
			const s = setup();
			s.down();
			s.fire("pointermove", { x: 50, y: 50 });
			s.fire("pointerup", { x: 50, y: 50 });
			s.fire("lostpointercapture");
			expect(s.calls).toEqual(["start", "move 50,50", "drop 50,50"]);
		});

		it("pointercancel or lostpointercapture before the threshold fires nothing", () => {
			const s = setup();
			s.down();
			s.fire("pointercancel");
			s.fire("lostpointercapture");
			expect(s.calls).toEqual([]);
		});

		it("ignores events from another pointer", () => {
			const s = setup();
			s.down();
			s.fire("pointermove", { x: 90, y: 90, id: 7 });
			s.fire("pointerup", { x: 90, y: 90, id: 7 });
			expect(s.calls).toEqual([]);
		});

		it("cancel() cancels once and is idempotent; no handler fires afterwards", () => {
			const s = setup();
			const c = s.down();
			s.fire("pointermove", { x: 50, y: 50 });
			c?.cancel();
			c?.cancel();
			s.fire("pointermove", { x: 70, y: 70 });
			s.fire("pointerup", { x: 70, y: 70 });
			s.el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
			expect(s.calls).toEqual(["start", "move 50,50", "cancel"]);
			expect(s.parentKeys).toHaveBeenCalledTimes(1);
		});

		it("cancel() before the drag started fires nothing", () => {
			const s = setup();
			const c = s.down();
			c?.cancel();
			s.fire("pointermove", { x: 70, y: 70 });
			expect(s.calls).toEqual([]);
		});

		it("removes the window keydown listener after a drop", () => {
			const s = setup();
			s.down();
			s.fire("pointermove", { x: 50, y: 50 });
			s.fire("pointerup", { x: 50, y: 50 });
			const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
			s.el.dispatchEvent(esc);
			expect(esc.defaultPrevented).toBe(false);
			expect(s.parentKeys).toHaveBeenCalledTimes(1);
		});
		it("Escape also stops later window listeners (stopImmediatePropagation)", () => {
			const later = vi.fn();
			const s = setup();
			s.down();
			s.fire("pointermove", { x: 50, y: 50 });
			window.addEventListener("keydown", later, true);
			s.el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
			window.removeEventListener("keydown", later, true);
			expect(later).not.toHaveBeenCalled();
		});

		it("removing the element mid-drag: the next move cancels once, listeners are gone, nothing fires later", () => {
			const s = setup();
			const c = s.down();
			s.fire("pointermove", { x: 50, y: 50 });
			s.el.remove();
			// The pointer is no longer captured: the move reaches the document, not the element.
			document.body.dispatchEvent(ptr("pointermove", { x: 60, y: 60 }));
			expect(s.calls).toEqual(["start", "move 50,50", "cancel"]);
			expect(c?.active).toBe(false);
			document.body.dispatchEvent(ptr("pointermove", { x: 70, y: 70 }));
			document.body.dispatchEvent(ptr("pointerup", { x: 70, y: 70 }));
			const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
			document.body.dispatchEvent(esc);
			expect(esc.defaultPrevented).toBe(false);
			expect(s.calls).toEqual(["start", "move 50,50", "cancel"]);
		});

		it("removing the element mid-drag: a release on the document cancels instead of dropping", () => {
			const s = setup();
			s.down();
			s.fire("pointermove", { x: 50, y: 50 });
			s.el.remove();
			document.body.dispatchEvent(ptr("pointerup", { x: 60, y: 60 }));
			expect(s.calls).toEqual(["start", "move 50,50", "cancel"]);
		});

		it("pointercancel and lostpointercapture are heard on the document when the element is gone", () => {
			for (const type of ["pointercancel", "lostpointercapture"]) {
				const s = setup();
				s.down();
				s.fire("pointermove", { x: 50, y: 50 });
				s.el.remove();
				document.body.dispatchEvent(ptr(type, { x: 0, y: 0 }));
				document.body.dispatchEvent(ptr(type, { x: 0, y: 0 }));
				expect(s.calls).toEqual(["start", "move 50,50", "cancel"]);
				document.body.innerHTML = "";
			}
		});

		it("Escape then release swallows exactly one click", () => {
			vi.useFakeTimers();
			const s = setup();
			s.down();
			s.fire("pointermove", { x: 50, y: 50 });
			s.el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
			s.fire("pointerup", { x: 50, y: 50 });
			s.el.click();
			expect(s.parentClicks).not.toHaveBeenCalled();
			s.el.click();
			expect(s.parentClicks).toHaveBeenCalledTimes(1);
		});
	});
});

describe("autoscroll", () => {
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
});

describe("list reorder", () => {
	// Dragging list rows to reorder them (manual sort only). happy-dom has no layout, so every
	// row gets a fake 40 px high box in DOM order and the list a 500 px wide one.

	interface Mount {
		h: AppHarness;
		host: U1Host;
		root: HTMLElement;
		undo: ReturnType<typeof vi.spyOn>;
		redraw: (sort: TaskSort | undefined, extra?: Partial<Parameters<typeof TaskList>[0]>) => Promise<void>;
	}

	async function mount(sort: TaskSort | undefined = "manual"): Promise<Mount> {
		const h = await appHarness();
		const host = new U1Host(h);
		const undo = vi.spyOn(host, "notifyUndo");
		const root = mountNode(null);
		const redraw = async (s: TaskSort | undefined, extra: Partial<Parameters<typeof TaskList>[0]> = {}) => {
			const state = h.app.store.state;
			const ctx = h.app.queryContext();
			const filter = { ...emptyFilter("all"), sort: s ?? "manual" };
			const groups = buildList(state, { kind: "inbox" }, ctx, filter, "").groups;
			render(
				<TaskList host={host} state={state} groups={groups} ctx={ctx} selectedId={null} showCategory={false} emptyText="" label="Inbox" sort={s} onSelect={() => undefined} {...extra} />,
				root,
			);
			await settle();
			const list = root.querySelector<HTMLElement>(".cp-task-list");
			if (list === null) return;
			list.getBoundingClientRect = () => rect(0, 0, 500, 1000);
			root.querySelectorAll<HTMLElement>(".cp-task-row").forEach((r, i) => (r.getBoundingClientRect = () => rect(0, 40 * i, 500, 40 * i + 40)));
		};
		await redraw(sort);
		return { h, host, root, undo, redraw };
	}

	const titles = (m: Mount) => [...m.root.querySelectorAll(".cp-task-row .cp-task-title")].map((t) => t.textContent.trim());
	const row = (m: Mount, text: string) =>
		[...m.root.querySelectorAll<HTMLElement>(".cp-task-row")].find((r) => r.querySelector(".cp-task-title")!.textContent.includes(text))!;
	const centerY = (i: number) => 40 * i + 20;
	const X = 100;

	async function seedFlat(m: Mount, names = ["A", "B", "C", "D"]) {
		for (const n of names) await m.h.app.tasks.create({ title: n });
		await m.redraw("manual");
	}

	/** The order after the store changed, as the app would re-render it. */
	const reordered = async (m: Mount) => {
		await m.redraw("manual");
		return titles(m);
	};

	describe("list row reorder (D5)", () => {
		it("starts with the stored order", async () => {
			const m = await mount();
			await seedFlat(m);
			expect(titles(m)).toEqual(["A", "B", "C", "D"]);
		});

		it("drops a row at the top", async () => {
			const m = await mount();
			await seedFlat(m);
			const id = taskOf(m, "C").id;
			await dragTo(row(m, "C"), { x: X, y: centerY(2) }, { x: X, y: 2 });
			expect(taskOf(m, "C").id).toBe(id);
			expect(await reordered(m)).toEqual(["C", "A", "B", "D"]);
			expect(m.undo).toHaveBeenCalledWith('Moved "C".', "Move task", expect.any(Number));
			expect(await m.h.app.store.undo()).toBe("Move task");
			expect(await reordered(m)).toEqual(["A", "B", "C", "D"]);
		});

		it("drops a row in the middle, in one write", async () => {
			const m = await mount();
			await seedFlat(m);
			const place = vi.spyOn(m.h.app.tasks, "place");
			// Row A dragged below B's middle (y 60) lands between B and C.
			await dragTo(row(m, "A"), { x: X, y: centerY(0) }, { x: X, y: 62 });
			expect(place).toHaveBeenCalledTimes(1);
			expect(place.mock.calls[0]![1]).toEqual([taskOf(m, "B").id, taskOf(m, "A").id, taskOf(m, "C").id, taskOf(m, "D").id]);
			expect(await reordered(m)).toEqual(["B", "A", "C", "D"]);
		});

		it("drops a row at the bottom, also when released below the list", async () => {
			const m = await mount();
			await seedFlat(m);
			await dragTo(row(m, "B"), { x: X, y: centerY(1) }, { x: X, y: 400 });
			expect(await reordered(m)).toEqual(["A", "C", "D", "B"]);
		});

		it("shows a drop line while dragging and removes it afterwards", async () => {
			const m = await mount();
			await seedFlat(m);
			await dragTo(row(m, "A"), { x: X, y: centerY(0) }, { x: X, y: 62 }, false);
			const list = m.root.querySelector(".cp-task-list")!;
			const line = list.querySelector<HTMLElement>(".cp-reorder-line")!;
			expect(line.hidden).toBe(false);
			expect(line.style.top).toBe("80px");
			expect(row(m, "A").classList.contains("is-dragging")).toBe(true);
			await releaseAt(row(m, "A"), { x: X, y: 62 });
			expect(list.querySelector(".cp-reorder-line")).toBeNull();
			expect(list.classList.contains("is-reordering")).toBe(false);
		});

		it("a drop where the row already is writes nothing and offers no Undo", async () => {
			const m = await mount();
			await seedFlat(m);
			const place = vi.spyOn(m.h.app.tasks, "place");
			await dragTo(row(m, "B"), { x: X, y: centerY(1) }, { x: X, y: centerY(1) + 6 });
			expect(place).not.toHaveBeenCalled();
			expect(m.undo).not.toHaveBeenCalled();
		});

		it("does not drag under By date or By priority, or without a sort", async () => {
			for (const sort of ["date", "priority", undefined] as const) {
				const m = await mount(sort);
				for (const n of ["A", "B", "C"]) await m.h.app.tasks.create({ title: n });
				await m.redraw(sort);
				const place = vi.spyOn(m.h.app.tasks, "place");
				await dragTo(row(m, "C"), { x: X, y: centerY(2) }, { x: X, y: 2 });
				expect(place).not.toHaveBeenCalled();
				expect(m.root.querySelector(".cp-reorder-line")).toBeNull();
				expect(row(m, "C").classList.contains("is-dragging")).toBe(false);
			}
		});

		it("keeps a subtask among its siblings, and a top-level row moves with its subtasks", async () => {
			const m = await mount();
			const P = await m.h.app.tasks.create({ title: "P" });
			await m.h.app.tasks.create({ title: "S1", parentId: P.task.id });
			await m.h.app.tasks.create({ title: "S2", parentId: P.task.id });
			await m.h.app.tasks.create({ title: "Q" });
			await m.redraw("manual");
			expect(titles(m)).toEqual(["P", "S1", "S2", "Q"]);
			// S1 dragged far down only goes below S2, never out of P.
			const place = vi.spyOn(m.h.app.tasks, "place");
			await dragTo(row(m, "S1"), { x: X, y: centerY(1) }, { x: X, y: 900 });
			expect(place.mock.calls[0]![1]).toEqual([taskOf(m, "S2").id, taskOf(m, "S1").id]);
			expect(await reordered(m)).toEqual(["P", "S2", "S1", "Q"]);
			// P dragged below Q takes S2 and S1 along.
			await dragTo(row(m, "P"), { x: X, y: centerY(0) }, { x: X, y: 900 });
			expect(place.mock.calls[1]![1]).toEqual([taskOf(m, "Q").id, taskOf(m, "P").id]);
			expect(await reordered(m)).toEqual(["Q", "P", "S2", "S1"]);
		});

		it("a subtask alone under its parent has nothing to reorder: the press is a click", async () => {
			const m = await mount();
			const P = await m.h.app.tasks.create({ title: "P" });
			await m.h.app.tasks.create({ title: "S1", parentId: P.task.id });
			await m.h.app.tasks.create({ title: "Q" });
			await m.redraw("manual");
			const place = vi.spyOn(m.h.app.tasks, "place");
			await dragTo(row(m, "S1"), { x: X, y: centerY(1) }, { x: X, y: 900 });
			expect(place).not.toHaveBeenCalled();
		});

		it("Escape cancels: nothing is written and the line goes away", async () => {
			const m = await mount();
			await seedFlat(m);
			const place = vi.spyOn(m.h.app.tasks, "place");
			const r = row(m, "C");
			await dragTo(r, { x: X, y: centerY(2) }, { x: X, y: 2 }, false);
			expect(m.root.querySelector(".cp-reorder-line")).not.toBeNull();
			await pressKey(window as unknown as Element, "Escape");
			expect(m.root.querySelector(".cp-reorder-line")).toBeNull();
			await releaseAt(r, { x: X, y: 2 });
			expect(place).not.toHaveBeenCalled();
			expect(titles(m)).toEqual(["A", "B", "C", "D"]);
		});

		it("a press that does not pass the threshold is still a click", async () => {
			const m = await mount();
			await seedFlat(m);
			const onSelect = vi.fn();
			await m.redraw("manual", { onSelect });
			const r = row(m, "B");
			r.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			expect(onSelect).toHaveBeenCalledTimes(1);
		});

		it("the checkbox and buttons inside a row never start a drag", async () => {
			const m = await mount();
			await seedFlat(m);
			const place = vi.spyOn(m.h.app.tasks, "place");
			const box = row(m, "C").querySelector<HTMLElement>("input")!;
			await dragTo(box, { x: X, y: centerY(2) }, { x: X, y: 2 });
			expect(place).not.toHaveBeenCalled();
			expect(m.root.querySelector(".cp-reorder-line")).toBeNull();
		});

		it("a read-only list never reorders", async () => {
			const m = await mount();
			await seedFlat(m);
			await m.redraw("manual", { readOnly: true });
			const place = vi.spyOn(m.h.app.tasks, "place");
			await dragTo(row(m, "C"), { x: X, y: centerY(2) }, { x: X, y: 2 });
			expect(place).not.toHaveBeenCalled();
		});
	});
});
