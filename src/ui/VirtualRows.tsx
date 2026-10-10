import type { ComponentChildren } from "preact";
import { useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { type IndexRange, OVERSCAN_PX, type VirtualHandle, covers, itemOffsets, rangeIn, registerVirtual, renderIndices, windowPlan } from "./virtual";

// One listbox of task rows, or one board column's
// cards. Disabled, it renders `items.map(renderItem)` inside the listbox element, exactly as the plain markup did.
// Enabled, it draws only the items in or near the scroller's viewport and keeps every drawn item at its true offset
// with spacers, so the list looks and scrolls the same. Heights are measured after each render (a list row is one
// fixed height; a card varies); an item never measured counts as the average of those that were.
//
// Pinned items stay drawn wherever they are: the one holding focus (so focus, and keys, survive scrolling it out of
// view), a dragged row (the pointer capture lives on it) and one the keyboard is moving to. Preact never moves a
// kept keyed child while the order of the kept ones is unchanged, so a pinned row keeps its element, its focus and
// its pointer capture while the window slides past it.

interface VirtualRowsProps<T> {
	/** Window the items; false renders every item, as plain markup would. */
	enabled: boolean;
	items: readonly T[];
	keyOf: (item: T) => string;
	/** Renders one item as exactly one keyed element (a TaskRow, a BoardCard). */
	renderItem: (item: T, index: number) => ComponentChildren;
	/** The listbox element's attributes, applied in this order (class, role, aria-labelledby). */
	box: Record<string, string>;
	/** The scrolling ancestor, found with `closest()`. */
	scroller: string;
	/** The height of an item before any item was measured, in px. */
	estimate: number;
	/** Keys always drawn: a dragged row, a card the keyboard moved here. */
	pinned?: readonly (string | null | undefined)[];
}

interface View {
	/** The scroller's viewport, in px from the listbox's top. */
	top: number;
	bottom: number;
}

interface Layout {
	keys: string[];
	offsets: Float64Array;
	gap: number;
	index: Map<string, number> | null;
}

const NO_RANGE: IndexRange = { start: 0, end: 0 };

const isSpacer = (el: Element) => el.classList.contains("cp-virtual-spacer");

/** The viewport of `scroller` relative to `box`, or null while the scroller is hidden (a section not shown). */
function readView(box: HTMLElement, scroller: HTMLElement): View | null {
	const height = scroller.clientHeight;
	if (height <= 0) return null;
	const top = scroller.getBoundingClientRect().top + scroller.clientTop - box.getBoundingClientRect().top;
	return { top, bottom: top + height };
}

/** The first drawn item (`keys`, in DOM order, spacers aside) that shows in `scroller`, and where its top sits in it. */
function firstVisible(box: HTMLElement, scroller: HTMLElement, keys: readonly string[]): { key: string; offset: number } | null {
	const view = scroller.getBoundingClientRect();
	let k = 0;
	for (const child of box.children) {
		if (isSpacer(child)) continue;
		const key = keys[k++];
		if (key === undefined) return null;
		const r = child.getBoundingClientRect();
		if (r.bottom > view.top && r.top < view.bottom) return { key, offset: r.top - view.top };
	}
	return null;
}

function readGap(box: HTMLElement): number {
	const gap = parseFloat(box.ownerDocument.defaultView?.getComputedStyle(box).rowGap ?? "");
	return Number.isFinite(gap) ? gap : 0;
}

function indexMap(layout: Layout): Map<string, number> {
	if (layout.index === null) layout.index = new Map(layout.keys.map((k, i) => [k, i]));
	return layout.index;
}

export function VirtualRows<T>(props: VirtualRowsProps<T>) {
	const { enabled, items } = props;
	const boxRef = useRef<HTMLDivElement>(null);
	const [view, setView] = useState<View | null>(null);
	// Bumped when a measured height or the gap changes: the offsets are computed again.
	const [version, setVersion] = useState(0);
	// Bumped to draw an item the keyboard is moving to.
	const [, setTick] = useState(0);
	const sizes = useRef(new Map<string, number>());
	const gap = useRef(0);
	const pending = useRef<{ key: string; pick?: (item: HTMLElement) => HTMLElement | null } | null>(null);
	/** What the last render drew: the item indexes and keys in DOM order, and the range around the viewport. */
	const drawn = useRef<{ indexes: number[]; keys: string[]; range: IndexRange }>({ indexes: [], keys: [], range: NO_RANGE });
	const keyOfRef = useRef(props.keyOf);
	keyOfRef.current = props.keyOf;
	const wasEnabled = useRef(false);
	/** The last render read the viewport itself (entryView): the effect stores it, replacing an older `view`. */
	const entered = useRef(false);
	/** The item at the top of the viewport when windowing turned off, and its top below the scroller's top. */
	const anchor = useRef<{ key: string; offset: number } | null>(null);

	// Turning windowing on (a column or list crossing the threshold): the plain items of the last render are still in
	// the DOM. Measure them and the gap before the first windowed layout, so it puts every item where it was (an
	// estimate there moves the content under a scrolled viewport), and read the viewport to draw the right rows at once.
	let entryView: View | null = null;
	if (enabled && !wasEnabled.current && boxRef.current !== null) {
		const box = boxRef.current;
		gap.current = readGap(box);
		const { keys } = drawn.current;
		let k = 0;
		for (const child of box.children) {
			const key = keys[k++];
			if (key === undefined) break;
			const h = child.getBoundingClientRect().height;
			if (h > 0) sizes.current.set(key, h);
		}
		const scroller = box.closest<HTMLElement>(props.scroller);
		entryView = scroller === null ? null : readView(box, scroller);
	}
	// Turning windowing off (a column falling to the threshold): the drawn items are still in the DOM. A card that was
	// never drawn counted as the average height, and in the plain markup it has its real one, so the content under a
	// scrolled viewport would move. Remember the first visible item and where it sits in the scroller; the effect
	// below puts it back after the plain commit. Fixed-height rows come out with no change to make.
	if (!enabled && wasEnabled.current && boxRef.current !== null) {
		const box = boxRef.current;
		const scroller = box.closest<HTMLElement>(props.scroller);
		anchor.current = scroller === null ? null : firstVisible(box, scroller, drawn.current.keys);
	}
	wasEnabled.current = enabled;
	entered.current = entryView !== null;

	const layout = useMemo<Layout | null>(() => {
		if (!enabled) return null;
		const keys = items.map((item) => keyOfRef.current(item));
		const known = sizes.current;
		let sum = 0;
		for (const size of known.values()) sum += size;
		const estimate = known.size > 0 ? sum / known.size : props.estimate;
		return { keys, offsets: itemOffsets(keys.length, (i) => known.get(keys[i]!) ?? estimate, gap.current), gap: gap.current, index: null };
	}, [enabled, items, version]);
	const layoutRef = useRef(layout);
	layoutRef.current = layout;

	/** The drawn element of an item, or null. */
	const elementAt = (index: number): HTMLElement | null => {
		const box = boxRef.current;
		const k = drawn.current.indexes.indexOf(index);
		if (box === null || k < 0) return null;
		let n = 0;
		for (const child of box.children) {
			if (isSpacer(child)) continue;
			if (n++ === k) return child as HTMLElement;
		}
		return null;
	};
	/** The position, among the drawn items, of the drawn item that holds `el`, or -1. */
	const drawnPosition = (el: Element | null): number => {
		const box = boxRef.current;
		if (box === null || el === null || !box.contains(el) || el === box) return -1;
		let child: Element = el;
		while (child.parentElement !== box) child = child.parentElement!;
		if (isSpacer(child)) return -1;
		let n = 0;
		for (const c of box.children) {
			if (c === child) return n;
			if (!isSpacer(c)) n++;
		}
		return -1;
	};
	/**
	 * True when the viewport `next` needs a redraw: the drawn range misses an item within half the overscan of it,
	 * or holds one beyond twice the overscan (the viewport left this listbox; its rows can go).
	 */
	const stale = (next: View): boolean => {
		const l = layoutRef.current;
		if (l === null) return false;
		const { range } = drawn.current;
		const near = rangeIn(l.offsets, next.top - OVERSCAN_PX / 2, next.bottom + OVERSCAN_PX / 2);
		const far = rangeIn(l.offsets, next.top - 2 * OVERSCAN_PX, next.bottom + 2 * OVERSCAN_PX);
		return !covers(range, near) || !covers(far, range);
	};

	// Scroll and resize: draw again once the viewport nears the drawn edge. The handle lets the drag and keyboard
	// code reach the items that are not drawn.
	useLayoutEffect(() => {
		const box = boxRef.current;
		const scroller = box?.closest<HTMLElement>(props.scroller) ?? null;
		if (!enabled || box === null || scroller === null) return;
		const check = () => {
			const next = readView(box, scroller);
			if (next !== null && stale(next)) setView(next);
		};
		const win = box.ownerDocument.defaultView;
		scroller.addEventListener("scroll", check, { passive: true });
		const ro = win !== null && typeof win.ResizeObserver === "function" ? new win.ResizeObserver(check) : null;
		ro?.observe(scroller);
		const handle: VirtualHandle = {
			get count() {
				return layoutRef.current?.keys.length ?? 0;
			},
			indexOfKey: (key) => {
				const l = layoutRef.current;
				return l === null ? -1 : (indexMap(l).get(key) ?? -1);
			},
			elementAt,
			indexOfElement: (el) => {
				const k = drawnPosition(el);
				return k < 0 ? -1 : (drawn.current.indexes[k] ?? -1);
			},
			focusIndex: (index, pick) => {
				const key = layoutRef.current?.keys[index];
				if (key === undefined) return;
				const el = elementAt(index);
				if (el !== null) {
					(pick?.(el) ?? el).focus();
					return;
				}
				pending.current = { key, pick };
				setTick((t) => t + 1);
			},
			get pendingKey() {
				return pending.current?.key ?? null;
			},
			geometry: () => {
				const l = layoutRef.current;
				const b = box.getBoundingClientRect();
				return {
					rectOf: (key) => {
						const i = l === null ? undefined : indexMap(l).get(key);
						if (l === null || i === undefined) return null;
						const top = b.top + l.offsets[i]!;
						return { top, bottom: b.top + l.offsets[i + 1]! - l.gap, left: b.left, width: b.width };
					},
				};
			},
		};
		const unregister = registerVirtual(box, handle);
		return () => {
			scroller.removeEventListener("scroll", check);
			ro?.disconnect();
			unregister();
		};
	}, [enabled]);

	// After every render: measure what was drawn, follow the viewport, and focus an item the keyboard asked for.
	useLayoutEffect(() => {
		const box = boxRef.current;
		const l = layoutRef.current;
		const scroller = box?.closest<HTMLElement>(props.scroller) ?? null;
		if (!enabled || box === null || l === null || scroller === null) return;
		let changed = false;
		const g = readGap(box);
		if (Math.abs(g - gap.current) > 0.01) {
			gap.current = g;
			changed = true;
		}
		const known = sizes.current;
		const { keys, indexes } = drawn.current;
		let k = 0;
		for (const child of box.children) {
			if (isSpacer(child)) continue;
			const key = keys[k];
			const i = indexes[k++];
			if (key === undefined || i === undefined) break;
			// Zero: no layout (a hidden section); keep what was measured before.
			const h = child.getBoundingClientRect().height;
			if (h <= 0) continue;
			const used = l.offsets[i + 1]! - l.offsets[i]! - l.gap;
			if (!known.has(key) || Math.abs(known.get(key)! - h) > 0.5) known.set(key, h);
			if (Math.abs(used - h) > 0.5) changed = true;
		}
		const p = pending.current;
		if (p !== null) {
			const index = indexMap(l).get(p.key);
			const el = index === undefined ? null : elementAt(index);
			if (index === undefined || el !== null) pending.current = null;
			if (el !== null) (p.pick?.(el) ?? el).focus();
		}
		const next = readView(box, scroller);
		if (changed) {
			setVersion((v) => v + 1);
			if (next !== null) setView(next);
		} else if (next !== null && (view === null || entered.current || stale(next))) {
			setView(next);
		}
	});

	// Windowing just turned off: put the item that was at the top of the viewport back where it was.
	useLayoutEffect(() => {
		const a = anchor.current;
		if (enabled || a === null) return;
		anchor.current = null;
		const box = boxRef.current;
		const scroller = box?.closest<HTMLElement>(props.scroller) ?? null;
		const k = drawn.current.keys.indexOf(a.key);
		const el = k < 0 ? undefined : box?.children[k];
		if (scroller === null || el === undefined) return;
		const delta = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - a.offset;
		if (Math.abs(delta) > 0.5) scroller.scrollTop += delta;
	});

	if (!enabled || layout === null) {
		// Every item is drawn: recorded, so the render that turns windowing on can tell which row holds focus.
		const keys = items.map((item) => props.keyOf(item));
		drawn.current = { indexes: keys.map((_, i) => i), keys, range: { start: 0, end: keys.length } };
		return (
			<div {...props.box} ref={boxRef}>
				{items.map(props.renderItem)}
			</div>
		);
	}

	const shown = entryView ?? view;
	const range = shown === null ? NO_RANGE : rangeIn(layout.offsets, shown.top - OVERSCAN_PX, shown.bottom + OVERSCAN_PX);
	const pins: number[] = [];
	const pin = (key: string | null | undefined) => {
		if (key == null) return;
		const i = indexMap(layout).get(key);
		if (i !== undefined) pins.push(i);
	};
	for (const key of props.pinned ?? []) pin(key);
	pin(pending.current?.key);
	// The item holding focus, read from the DOM of the last render (it is not committed again yet).
	const box = boxRef.current;
	const position = drawnPosition(box?.ownerDocument.activeElement ?? null);
	if (position >= 0) pin(drawn.current.keys[position]);
	const indexes = renderIndices(range, pins, layout.keys.length);
	drawn.current = { indexes, keys: indexes.map((i) => layout.keys[i]!), range };
	return (
		<div {...props.box} ref={boxRef}>
			{windowPlan(layout.offsets, layout.gap, indexes).map((part) =>
				part.kind === "item" ? (
					props.renderItem(items[part.index]!, part.index)
				) : (
					<div key={`\u0000${part.after}`} class="cp-virtual-spacer" aria-hidden="true" style={{ "--cp-virtual-h": `${part.height}px` }} />
				),
			)}
		</div>
	);
}
