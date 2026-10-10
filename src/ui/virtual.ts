// Above a threshold, a task listbox or a board
// column draws only the rows in or near the viewport. This file is the pure windowing math and the registry
// that lets the drag and keyboard code reach a windowed listbox's rows that are not drawn. VirtualRows.tsx
// renders with it. No obsidian import.

/** A list (Tasks section) or a board column with more rows than this draws only the rows near the viewport. */
export const VIRTUAL_THRESHOLD = 150;

/** How far above and below the viewport rows are drawn. A redraw happens once the viewport comes within half of it of the drawn edge. */
export const OVERSCAN_PX = 600;

/** A half-open run of item indexes [start, end); empty when start === end. */
export interface IndexRange {
	start: number;
	end: number;
}

/**
 * Where each item starts: `offsets[i]` is the sum of the sizes and gaps before item i, `offsets[n]` the sum of all
 * of them (so the content height is `offsets[n] - gap` for n > 0). Positions are relative to the listbox's top.
 */
export function itemOffsets(n: number, sizeOf: (i: number) => number, gap: number): Float64Array {
	const offsets = new Float64Array(n + 1);
	for (let i = 0; i < n; i++) offsets[i + 1] = offsets[i]! + sizeOf(i) + gap;
	return offsets;
}

/** The items that intersect the band [top, bottom), by binary search over `offsets`. */
export function rangeIn(offsets: Float64Array, top: number, bottom: number): IndexRange {
	const n = offsets.length - 1;
	// The first item whose end is below the band's top.
	let lo = 0;
	let hi = n;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (offsets[mid + 1]! > top) hi = mid;
		else lo = mid + 1;
	}
	const start = lo;
	// The first item at or after `start` that starts at or below the band's bottom.
	hi = n;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (offsets[mid]! >= bottom) hi = mid;
		else lo = mid + 1;
	}
	return { start, end: Math.max(start, lo) };
}

/** The indexes to draw: the range plus the pinned items (a focused or dragged row), sorted, without duplicates. */
export function renderIndices(range: IndexRange, pinned: Iterable<number>, n: number): number[] {
	const out: number[] = [];
	for (let i = range.start; i < range.end; i++) out.push(i);
	let extra = false;
	for (const p of pinned) {
		if (p >= 0 && p < n && (p < range.start || p >= range.end) && !out.includes(p)) {
			out.push(p);
			extra = true;
		}
	}
	return extra ? out.sort((a, b) => a - b) : out;
}

type WindowPart = { kind: "item"; index: number } | { kind: "spacer"; after: number; height: number };

/**
 * The children of a windowed listbox: the drawn items, with a spacer for every run of items that is not drawn, so
 * each drawn item sits exactly at its offset. In a flex column with a `gap`, a spacer adds a gap on each side it
 * has a neighbour; its height subtracts one gap, which comes out right in every position (see the tests).
 */
export function windowPlan(offsets: Float64Array, gap: number, indices: readonly number[]): WindowPart[] {
	const n = offsets.length - 1;
	if (n === 0) return [];
	const parts: WindowPart[] = [];
	let next = 0;
	const spacerTo = (i: number) => parts.push({ kind: "spacer", after: next, height: Math.max(0, offsets[i]! - offsets[next]! - gap) });
	for (const index of indices) {
		if (index > next) spacerTo(index);
		parts.push({ kind: "item", index });
		next = index + 1;
	}
	if (next < n) spacerTo(n);
	return parts;
}

/** True when the drawn range already holds every item of the needed one (an empty need is always held). */
export function covers(have: IndexRange, need: IndexRange): boolean {
	return need.start >= need.end || (need.start >= have.start && need.end <= have.end);
}

/** A windowed listbox, as the drag and keyboard code see it. Registered on its element while it windows. */
export interface VirtualHandle {
	/** The number of items, drawn or not. */
	readonly count: number;
	/** The item's index, or -1. */
	indexOfKey(key: string): number;
	/** The drawn element of an item, or null when it is not drawn. */
	elementAt(index: number): HTMLElement | null;
	/** The index of a drawn item element (a direct child of the listbox), or -1. */
	indexOfElement(el: Element): number;
	/**
	 * Draws the item (if it is not drawn yet) and focuses it, or the element `pick` chooses inside it. Focusing
	 * scrolls it into view the way the browser does for any focused element.
	 */
	focusIndex(index: number, pick?: (item: HTMLElement) => HTMLElement | null): void;
	/** The key of an item that `focusIndex` is about to focus, or null. */
	readonly pendingKey: string | null;
	/** Viewport positions of every item from its offset, drawn or not (one layout read for the whole call). */
	geometry(): { rectOf(key: string): { top: number; bottom: number; left: number; width: number } | null };
}

const handles = new WeakMap<Element, VirtualHandle>();

/** Registers a listbox's handle; returns the unregister function. */
export function registerVirtual(box: Element, handle: VirtualHandle): () => void {
	handles.set(box, handle);
	return () => {
		if (handles.get(box) === handle) handles.delete(box);
	};
}

/** The handle of a windowed listbox element, or undefined when it draws every row. */
export function virtualHandle(box: Element | null | undefined): VirtualHandle | undefined {
	return box == null ? undefined : handles.get(box);
}
