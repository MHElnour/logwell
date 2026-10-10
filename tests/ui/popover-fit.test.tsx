// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { fitPopover } from "../../src/ui/quickadd/popoverFit";

// The date popover (about 480 px tall) must not be cut off at the bottom of short
// views and of the Quick Add modal, or OK would hide under Obsidian's status bar.

describe("fitPopover", () => {
	const base = { anchorTop: 100, anchorBottom: 152, limitTop: 0, limitBottom: 1000, natural: 480 };

	it("opens below with no constraint beyond the 480 px cap when there is room", () => {
		expect(fitPopover(base)).toEqual({ above: false, maxHeight: 1000 - 152 - 8 - 12 });
	});

	it("limits the height to the space below the bar, minus the gap and a margin", () => {
		expect(fitPopover({ ...base, limitBottom: 500 })).toEqual({ above: false, maxHeight: 500 - 152 - 8 - 12 });
	});

	it("flips above the bar when the space below is too small and above has more", () => {
		const r = fitPopover({ ...base, anchorTop: 600, anchorBottom: 652, limitBottom: 700 });
		expect(r.above).toBe(true);
		expect(r.maxHeight).toBe(600 - 0 - 8 - 12);
	});

	it("stays below when above is no better", () => {
		const r = fitPopover({ ...base, anchorTop: 60, anchorBottom: 112, limitBottom: 400 });
		expect(r.above).toBe(false);
		expect(r.maxHeight).toBe(400 - 112 - 8 - 12);
	});

	it("never goes under a minimum height, even with almost no space", () => {
		expect(fitPopover({ ...base, anchorTop: 10, anchorBottom: 62, limitBottom: 80 }).maxHeight).toBe(160);
	});

	it("does not flip when the popover fits below", () => {
		expect(fitPopover({ ...base, natural: 200, anchorTop: 600, anchorBottom: 652, limitBottom: 900 }).above).toBe(false);
	});
});
