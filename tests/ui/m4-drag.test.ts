// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DRAG_THRESHOLD_PX,
	beginPointerDrag,
	hitTest,
	type DragHandlers,
} from "../../src/ui/drag";

// The shared pointer drag.

function ptr(type: string, init: { x?: number; y?: number; button?: number; pointerType?: string; id?: number } = {}) {
	const ev = new MouseEvent(type, {
		bubbles: true,
		cancelable: true,
		clientX: init.x ?? 0,
		clientY: init.y ?? 0,
		button: init.button ?? 0,
	});
	Object.defineProperty(ev, "pointerId", { value: init.id ?? 1 });
	Object.defineProperty(ev, "pointerType", { value: init.pointerType ?? "mouse" });
	return ev as unknown as PointerEvent;
}

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
