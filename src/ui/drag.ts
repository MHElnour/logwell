// Shared pointer drag. No obsidian import. Popout-safe: every listener and
// timer goes through el.ownerDocument.defaultView, never the global window.

export const DRAG_THRESHOLD_PX = 4;

export interface DragPoint {
	x: number;
	y: number;
}

export interface DragHandlers {
	/** Once the pointer passes the threshold. Return false to refuse the drag (then it is a no-op, not a click). */
	onStart?(origin: DragPoint): boolean | void;
	onMove(p: DragPoint, origin: DragPoint): void;
	/** Pointer released after a started drag. */
	onDrop(p: DragPoint, origin: DragPoint): void;
	/** Escape, pointercancel, lostpointercapture before the drop, or controller.cancel(). Never called after onDrop. */
	onCancel(): void;
}

export interface DragController {
	/** True between onStart and onDrop/onCancel. */
	readonly active: boolean;
	/** Idempotent; used on unmount. */
	cancel(): void;
}

/**
 * Call from onPointerDown. Ignores non-primary buttons and pointerType "touch" (returns null).
 * Calls el.setPointerCapture(e.pointerId). Below the threshold, nothing fires and the native click proceeds.
 * After a started drag (dropped, cancelled or refused), the next click on `el` is swallowed.
 * Removes every listener it added on drop, cancel, pointercancel and lostpointercapture.
 * The gesture survives the element being removed (a re-render): the document hears the pointer too,
 * and a move or release after the element left the document cancels instead of dropping.
 */
export function beginPointerDrag(
	e: PointerEvent,
	el: HTMLElement,
	handlers: DragHandlers,
	opts?: { threshold?: number },
): DragController | null {
	if (e.button !== 0 || e.pointerType === "touch") return null;
	const view = el.ownerDocument.defaultView;
	if (!view) return null;
	const win: Window = view;
	const threshold = opts?.threshold ?? DRAG_THRESHOLD_PX;
	const origin: DragPoint = { x: e.clientX, y: e.clientY };
	const pointerId = e.pointerId;
	try {
		el.setPointerCapture(pointerId);
	} catch {
		// Synthetic or already-released pointer: the listeners below still work.
	}

	let started = false;
	let finished = false;

	const doc = el.ownerDocument;
	// A move that reaches both the element and the document is handled once.
	let lastMove: Event | null = null;

	const point = (ev: PointerEvent): DragPoint => ({ x: ev.clientX, y: ev.clientY });

	// The click that follows a drag release must not open the details.
	const swallowNextClick = () => {
		const onClick = (ev: Event) => {
			ev.stopPropagation();
			ev.preventDefault();
			stop();
		};
		let timer = 0;
		const stop = () => {
			el.removeEventListener("click", onClick, true);
			win.clearTimeout(timer);
		};
		el.addEventListener("click", onClick, true);
		// The click is dispatched in the same task as the pointerup; 0 ms is enough.
		timer = win.setTimeout(stop, 0);
	};

	// The pointer is still down: swallow the click that follows its release.
	const swallowRelease = () => {
		el.addEventListener("pointerup", swallowNextClick, { once: true });
		// If the release never reaches el (capture lost), do not leave the listener behind.
		win.setTimeout(() => el.removeEventListener("pointerup", swallowNextClick), 60_000);
	};

	const removeAll = () => {
		for (const t of [el, doc]) {
			const capture = t === doc;
			t.removeEventListener("pointermove", onPointerMove as EventListener, capture);
			t.removeEventListener("pointerup", onPointerUp as EventListener, capture);
			t.removeEventListener("pointercancel", onPointerCancel as EventListener, capture);
			t.removeEventListener("lostpointercapture", onLostCapture as EventListener, capture);
		}
		win.removeEventListener("keydown", onKeyDown, true);
	};

	/** Ends the gesture without a drop. `pointerStillDown`: arm the click swallow for the eventual release. */
	const abort = (pointerStillDown: boolean) => {
		if (finished) return;
		finished = true;
		const wasStarted = started;
		removeAll();
		if (!wasStarted) return;
		if (pointerStillDown) swallowRelease();
		handlers.onCancel();
	};

	function onPointerMove(ev: PointerEvent) {
		if (finished || ev.pointerId !== pointerId || ev === lastMove) return;
		lastMove = ev;
		if (!el.isConnected) {
			abort(false);
			return;
		}
		const p = point(ev);
		if (!started) {
			if (Math.hypot(p.x - origin.x, p.y - origin.y) < threshold) return;
			started = true;
			if (handlers.onStart?.(origin) === false) {
				// Refused: a no-op, but the release must not count as a click.
				started = false;
				finished = true;
				removeAll();
				swallowRelease();
				return;
			}
		}
		handlers.onMove(p, origin);
	}

	function onPointerUp(ev: PointerEvent) {
		if (finished || ev.pointerId !== pointerId) return;
		if (!el.isConnected) {
			abort(false);
			return;
		}
		finished = true;
		removeAll();
		if (!started) return;
		swallowNextClick();
		handlers.onDrop(point(ev), origin);
	}

	function onPointerCancel(ev: PointerEvent) {
		if (ev.pointerId !== pointerId) return;
		abort(false);
	}

	function onLostCapture(ev: PointerEvent) {
		if (ev.pointerId !== pointerId) return;
		abort(false);
	}

	function onKeyDown(ev: KeyboardEvent) {
		if (ev.key !== "Escape" || !started || finished) return;
		ev.stopPropagation();
		ev.stopImmediatePropagation();
		ev.preventDefault();
		abort(true);
	}

	for (const t of [el, doc]) {
		const capture = t === doc;
		t.addEventListener("pointermove", onPointerMove as EventListener, capture);
		t.addEventListener("pointerup", onPointerUp as EventListener, capture);
		t.addEventListener("pointercancel", onPointerCancel as EventListener, capture);
		t.addEventListener("lostpointercapture", onLostCapture as EventListener, capture);
	}
	win.addEventListener("keydown", onKeyDown, true);

	return {
		get active() {
			return started && !finished;
		},
		cancel() {
			abort(false);
		},
	};
}

/** True when the topmost element at `p` is, or sits inside, an element matching `selector` (a floating panel that covers `root`). */
export function overElement(root: HTMLElement, p: DragPoint, selector: string): boolean {
	const doc = root.ownerDocument;
	// happy-dom has no elementFromPoint; a real browser always does.
	if (typeof doc.elementFromPoint !== "function") return false;
	return doc.elementFromPoint(p.x, p.y)?.closest(selector) != null;
}

/** The first candidate whose getBoundingClientRect contains p, else null. */
export function hitTest<T extends Element>(p: DragPoint, candidates: Iterable<T>): T | null {
	for (const c of candidates) {
		const r = c.getBoundingClientRect();
		if (p.x >= r.left && p.x < r.right && p.y >= r.top && p.y < r.bottom) return c;
	}
	return null;
}

const AUTOSCROLL_EDGE_PX = 40;
const AUTOSCROLL_MAX_SPEED = 18;

/** Pixels to scroll per frame for a pointer `pos` on one axis of a box spanning [start, end). 0 when it is not near an edge. */
function edgeSpeed(pos: number, start: number, end: number, edge: number, maxSpeed: number): number {
	// Reaching one edge zone of a box smaller than two zones would pull both ways; the nearer one wins.
	const zone = Math.min(edge, (end - start) / 2);
	if (zone <= 0) return 0;
	const intoStart = start + zone - pos;
	if (intoStart > 0) return -Math.max(1, Math.round(maxSpeed * Math.min(1, intoStart / zone)));
	const intoEnd = pos - (end - zone);
	if (intoEnd > 0) return Math.max(1, Math.round(maxSpeed * Math.min(1, intoEnd / zone)));
	return 0;
}

/**
 * Scrolls whichever of the containers the point is near the edge of, until update() moves away or stop() is called.
 * Within `edge` px of an edge (default 40) the container scrolls on that axis, faster the closer the point
 * is (up to `maxSpeed` px per frame, default 18) and at full speed beyond the edge. The loop is the container
 * window's requestAnimationFrame, so it keeps scrolling while the pointer is still. It never scrolls past the
 * ends and goes idle once nothing can scroll. The caller listens for `scroll` to move its ghost and drop target.
 */
export function createAutoScroller(
	containers: () => Iterable<HTMLElement>,
	opts?: { edge?: number; maxSpeed?: number },
): { update(p: DragPoint): void; stop(): void } {
	const edge = opts?.edge ?? AUTOSCROLL_EDGE_PX;
	const maxSpeed = opts?.maxSpeed ?? AUTOSCROLL_MAX_SPEED;
	let point: DragPoint | null = null;
	let frame = 0;
	let frameWin: Window | null = null;

	/** Scrolls every container the point is at the edge of by one step; true when something moved. */
	const step = (p: DragPoint): boolean => {
		let moved = false;
		for (const el of containers()) {
			const r = el.getBoundingClientRect();
			// The cross axis must be inside the box, or a drag in the next column would scroll this one.
			const inX = p.x >= r.left && p.x < r.right;
			const inY = p.y >= r.top && p.y < r.bottom;
			// A pointer just outside the box on the scrolling axis still counts, at full speed.
			const outX = p.x >= r.left - edge && p.x < r.right + edge;
			const outY = p.y >= r.top - edge && p.y < r.bottom + edge;
			if (inX && outY) {
				const dy = edgeSpeed(p.y, r.top, r.bottom, edge, maxSpeed);
				const max = el.scrollHeight - el.clientHeight;
				const next = Math.min(Math.max(el.scrollTop + dy, 0), Math.max(max, 0));
				if (dy !== 0 && next !== el.scrollTop) {
					el.scrollTop = next;
					moved = true;
				}
			}
			if (inY && outX) {
				const dx = edgeSpeed(p.x, r.left, r.right, edge, maxSpeed);
				const max = el.scrollWidth - el.clientWidth;
				const next = Math.min(Math.max(el.scrollLeft + dx, 0), Math.max(max, 0));
				if (dx !== 0 && next !== el.scrollLeft) {
					el.scrollLeft = next;
					moved = true;
				}
			}
		}
		return moved;
	};

	const cancelFrame = () => {
		if (frame !== 0) frameWin?.cancelAnimationFrame(frame);
		frame = 0;
	};

	const tick = () => {
		frame = 0;
		if (point === null) return;
		if (step(point)) schedule();
	};

	const schedule = () => {
		if (frame !== 0 || point === null) return;
		const first = containers()[Symbol.iterator]().next();
		const win = first.done ? null : first.value.ownerDocument.defaultView;
		if (win === null) return;
		frameWin = win;
		frame = win.requestAnimationFrame(tick);
	};

	return {
		update(p) {
			point = p;
			// The scrolling happens on the frame, so a burst of pointer events never scrolls faster than the frame rate.
			schedule();
		},
		stop() {
			point = null;
			cancelFrame();
		},
	};
}
