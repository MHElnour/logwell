// Places the add bar's anchored popovers (the date popover and the more menu) and fits them into the
// space they really have. The owner for every anchored plugin popover: never position one yourself.
//
// Where the Popover API exists, the popover goes to the browser's top layer without moving in the DOM
// (`popover="manual"` + `showPopover()`), so no modal, scroller or details pane can clip it, while its
// ancestry stays: Escape handling, the press-outside check, the `.checkpoint-view .cp-pop` selectors
// and the `--cp-*` tokens all keep working. It is then placed with `position: fixed` from the add bar's
// box in window coordinates: under the bar, right-aligned to it, kept 8 px inside the window. Only the
// window and Obsidian's status bar limit it. It gets a max height from the space below the bar and
// flips above the bar when that is clearly roomier. Its body scrolls; the Clear / OK footer stays visible.
// Without the Popover API it stays where the stylesheet puts it (under the bar, inside its container).

const POP_GAP = 8;
const POP_MARGIN = 12;
const POP_MIN_HEIGHT = 160;
/** The space kept between a popover and the left and right edges of the window. */
const POP_EDGE = 8;

interface FitInput {
	/** The add bar's box, in the same coordinates as the limits. */
	anchorTop: number;
	anchorBottom: number;
	/** The visible region the popover may use. */
	limitTop: number;
	limitBottom: number;
	/** The popover's height when it is not constrained by the available space. */
	natural: number;
}

interface Fit {
	above: boolean;
	maxHeight: number;
}

export function fitPopover(i: FitInput): Fit {
	const below = i.limitBottom - i.anchorBottom - POP_GAP - POP_MARGIN;
	const above = i.anchorTop - i.limitTop - POP_GAP - POP_MARGIN;
	const flip = i.natural > below && above > below;
	return { above: flip, maxHeight: Math.max(POP_MIN_HEIGHT, Math.floor(flip ? above : below)) };
}

/** The popover's left edge: right-aligned to the anchor, kept inside the window's 8 px margins. */
export function alignPopover(i: { anchorRight: number; width: number; viewportWidth: number }): number {
	const max = i.viewportWidth - POP_EDGE - i.width;
	return Math.max(POP_EDGE, Math.min(i.anchorRight - i.width, max));
}

/** The region of the window the popover can use: the whole window above Obsidian's status bar. */
function windowLimits(doc: Document): { limitTop: number; limitBottom: number } {
	let limitBottom = doc.defaultView?.innerHeight ?? Number.POSITIVE_INFINITY;
	// The status bar floats over the bottom of the window.
	const status = doc.querySelector(".status-bar");
	if (status !== null) {
		const top = status.getBoundingClientRect().top;
		if (top > 0 && top < limitBottom) limitBottom = top;
	}
	return { limitTop: 0, limitBottom };
}

/** Measures and applies the fit to a popover element inside its anchor (the bar's wrapper). */
export function applyPopoverFit(pop: HTMLElement): void {
	const anchor = pop.parentElement;
	if (anchor === null) return;
	// Measure the unconstrained size and the default placement.
	pop.style.removeProperty("--cp-pop-max");
	pop.classList.remove("is-above");
	const box = pop.getBoundingClientRect();
	const a = anchor.getBoundingClientRect();
	if (box.height === 0 && a.height === 0) return; // no layout (not rendered)
	const doc = pop.ownerDocument;
	const fit = fitPopover({ anchorTop: a.top, anchorBottom: a.bottom, ...windowLimits(doc), natural: box.height });
	pop.style.setProperty("--cp-pop-max", `${fit.maxHeight}px`);
	pop.classList.toggle("is-above", fit.above);
	// In the top layer the popover is placed in window coordinates (see the stylesheet's `.cp-pop[popover]`).
	if (!pop.hasAttribute("popover")) return;
	const view = doc.defaultView;
	const left = alignPopover({ anchorRight: a.right, width: box.width, viewportWidth: view?.innerWidth ?? a.right });
	pop.style.setProperty("--cp-pop-left", `${left}px`);
	pop.style.setProperty("--cp-pop-top", `${a.bottom + POP_GAP}px`);
	pop.style.setProperty("--cp-pop-bottom", `${(view?.innerHeight ?? a.top) - a.top + POP_GAP}px`);
}

/**
 * Attaches a popover to its anchor for as long as it is open: puts it in the top layer when the
 * Popover API exists, and fits it again when its window is resized or anything in its document
 * scrolls. When a scroll takes the anchor out of the window, `onAnchorGone` is called (the caller
 * closes the popover). Returns the detach function, which removes the listeners and hides it.
 * Only the element's own document and window are used, so pop-out windows work.
 */
export function attachPopover(pop: HTMLElement, onAnchorGone: () => void): () => void {
	const doc = pop.ownerDocument;
	const view = doc.defaultView;
	let layered = false;
	if (typeof pop.showPopover === "function") {
		pop.setAttribute("popover", "manual");
		try {
			pop.showPopover();
			layered = true;
		} catch {
			// Not connected, or an engine that refuses it: the popover stays in place.
			pop.removeAttribute("popover");
		}
	}
	const onResize = () => applyPopoverFit(pop);
	const onScroll = (e: Event) => {
		// The popover's own body scrolling does not move it.
		if (e.target instanceof Node && pop.contains(e.target)) return;
		const anchor = pop.parentElement;
		if (anchor === null) return;
		const a = anchor.getBoundingClientRect();
		const height = view?.innerHeight ?? Number.POSITIVE_INFINITY;
		if (a.bottom < 0 || a.top > height) {
			onAnchorGone();
			return;
		}
		applyPopoverFit(pop);
	};
	view?.addEventListener("resize", onResize);
	doc.addEventListener("scroll", onScroll, { capture: true, passive: true });
	return () => {
		view?.removeEventListener("resize", onResize);
		doc.removeEventListener("scroll", onScroll, { capture: true });
		if (!layered) return;
		try {
			pop.hidePopover();
		} catch {
			// Already hidden: removing the element from the document hides it.
		}
	};
}
