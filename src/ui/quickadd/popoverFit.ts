// Fits a popover into the space it really has. The date popover is
// about 480 px tall; in a short view or in the Quick Add modal the lower part would be cut off and OK
// would end up under Obsidian's status bar. The popover gets a max height from the space below the
// add bar (up to the nearest clipping container, the window and the status bar) and flips above
// the bar when that is clearly roomier. Its body scrolls; the Clear / OK footer stays visible.

const POP_GAP = 8;
const POP_MARGIN = 12;
const POP_MIN_HEIGHT = 160;

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

const CLIPPING = new Set(["auto", "scroll", "hidden", "clip"]);

/** The region of the screen the popover can use: the window, the status bar and every clipping ancestor. */
function visibleLimits(anchor: HTMLElement): { limitTop: number; limitBottom: number } {
	const doc = anchor.ownerDocument;
	const view = doc.defaultView;
	let limitTop = 0;
	let limitBottom = view?.innerHeight ?? Number.POSITIVE_INFINITY;
	// The status bar floats over the bottom of the window.
	const status = doc.querySelector(".status-bar");
	if (status !== null) {
		const top = status.getBoundingClientRect().top;
		if (top > 0 && top < limitBottom) limitBottom = top;
	}
	for (let el = anchor.parentElement; el !== null; el = el.parentElement) {
		const overflow = view?.getComputedStyle(el).overflowY ?? "";
		if (!CLIPPING.has(overflow)) continue;
		const r = el.getBoundingClientRect();
		// An ancestor without layout (zero height) clips nothing we can measure.
		if (r.height === 0) continue;
		limitTop = Math.max(limitTop, r.top);
		limitBottom = Math.min(limitBottom, r.bottom);
	}
	return { limitTop, limitBottom };
}

/** Measures and applies the fit to a popover element inside its positioned anchor (the bar's wrapper). */
export function applyPopoverFit(pop: HTMLElement): void {
	const anchor = pop.parentElement;
	if (anchor === null) return;
	// Measure the unconstrained size and the default placement.
	pop.style.removeProperty("--cp-pop-max");
	pop.classList.remove("is-above");
	const natural = pop.getBoundingClientRect().height;
	const a = anchor.getBoundingClientRect();
	if (natural === 0 && a.height === 0) return; // no layout (not rendered)
	const fit = fitPopover({ anchorTop: a.top, anchorBottom: a.bottom, ...visibleLimits(anchor), natural });
	pop.style.setProperty("--cp-pop-max", `${fit.maxHeight}px`);
	pop.classList.toggle("is-above", fit.above);
}
