import { describe, expect, it } from "vitest";
import { cssBlock, cssSection, selectors } from "./styles-helpers";

// Keyboard focus is visible on the Focus page's small controls and on the status-bar item. The section's scoping and
// hygiene are checked with the other sections in layout-styles.test.ts.

const section = cssSection("M5 focus");

describe("focus stylesheet section", () => {
	it("outlines the gap buttons, the show-more button and the status-bar item on :focus-visible with variables", () => {
		for (const sel of [
			".checkpoint-view .cp-focus-gap button:focus-visible",
			".checkpoint-view .cp-focus-more:focus-visible",
			".status-bar-item.cp-focus-status:focus-visible",
		]) {
			expect(section).toContain(sel);
		}
		expect(section).toMatch(/:focus-visible[^{]*\{[^}]*outline:\s*2px solid var\(--/);
	});

	it("the status dots use the hues of the focus record and the keyboard outlines use theme variables", () => {
		expect(rule(".checkpoint-view .cp-focus-status-dot.is-completed")).toContain("background: var(--cp-green)");
		expect(rule(".checkpoint-view .cp-focus-status-dot.is-early")).toContain("background: var(--cp-blue)");
		expect(rule(".checkpoint-view .cp-focus-status-dot.is-stopped")).toContain("background: var(--cp-orange)");
		expect(rule(".checkpoint-view .cp-focus-status-dot.is-recovered")).toContain("background: var(--cp-purple)");
		expect(section).toContain("grid-template-columns: minmax(0, 1fr) 430px");
		expect(section).toContain(".checkpoint-view .cp-focus-set-head:focus-visible");
		expect(section).toContain(".checkpoint-view .cp-focus-round-more:focus-visible");
	});

	const rule = (sel: string): string => cssBlock(`${sel} {`, section);

	it("the ring has one tone in every phase", () => {
		expect(section).not.toContain("is-break");
		const stage = rule(".checkpoint-view .cp-focus-stage");
		expect(stage).toContain("--cp-focus-tone: var(--cp-accent);");
		expect(stage).toContain("--cp-focus-tone-soft: var(--cp-accent-soft);");
		expect(stage).toContain("--cp-focus-tone-text: var(--cp-accent-text);");
		expect(rule(".checkpoint-view .cp-focus-ring-wrap")).not.toContain("--cp-focus-tone");
		expect(rule(".checkpoint-view .cp-focus-ring-track")).toContain("stroke: var(--cp-focus-tone-soft)");
		expect(rule(".checkpoint-view .cp-focus-ring-bar")).toContain("stroke: var(--cp-focus-tone)");
		expect(rule(".checkpoint-view .cp-focus-dot")).toContain("background: var(--cp-focus-tone-soft)");
		expect(rule(".checkpoint-view .cp-focus-dot.is-done")).toContain("background: var(--cp-focus-tone)");
		expect(rule(".checkpoint-view .cp-focus-phase")).toContain("color: var(--cp-focus-tone-text)");
		expect(rule(".checkpoint-view .cp-focus-ctl.is-main .cp-focus-ctl-disc")).toContain("background: var(--cp-focus-tone)");
		expect(rule(".checkpoint-view .cp-focus-summary-main")).toContain("color: var(--cp-focus-tone-text)");
		const pill = rule(".checkpoint-view .cp-focus-task");
		expect(pill).toContain("background: var(--cp-focus-tone-soft)");
		expect(pill).toContain("color: var(--cp-focus-tone-text)");
		// A paused ring is the same hue, dimmed; the track keeps its tint.
		expect(rule(".checkpoint-view .cp-focus-ring-wrap.is-paused")).toContain("--cp-focus-tone: color-mix(in srgb, var(--cp-accent) 45%, transparent)");
		expect(rule(".checkpoint-view .cp-focus-ring-wrap.is-paused .cp-focus-phase")).toContain("color: var(--text-muted)");
	});

	it("the finished-set check is a disc as tall as the time, so the phase line does not move", () => {
		const check = rule(".checkpoint-view .cp-focus-check");
		expect(check).toContain("width: var(--cp-focus-face)");
		expect(check).toContain("height: var(--cp-focus-face)");
		expect(check).toContain("place-items: center");
		expect(rule(".checkpoint-view .cp-focus-time")).toContain("font-size: var(--cp-focus-face)");
	});

	it("the control discs are centered on one line and the captions sit on another", () => {
		expect(rule(".checkpoint-view .cp-focus-controls")).toContain("align-items: flex-start");
		const ctl = rule(".checkpoint-view .cp-focus-ctl");
		expect(ctl).toContain("display: grid");
		expect(ctl).toContain("grid-template-rows: var(--cp-focus-main-disc) auto");
		expect(ctl).toContain("justify-items: center");
		expect(rule(".checkpoint-view .cp-focus-ctl-disc")).toContain("align-self: center");
		const main = rule(".checkpoint-view .cp-focus-ctl.is-main .cp-focus-ctl-disc");
		expect(main).toContain("width: var(--cp-focus-main-disc)");
		expect(main).toContain("height: var(--cp-focus-main-disc)");
	});

	it("a set dot takes its place from the tokens of the day line and half the head height", () => {
		const line = rule(".checkpoint-view .cp-focus-sets::before");
		expect(line).toContain("left: calc(var(--cp-focus-axis) - var(--cp-focus-line-w) / 2)");
		expect(line).toContain("width: var(--cp-focus-line-w)");
		const dot = rule(".checkpoint-view .cp-focus-set-head::before");
		expect(dot).toContain("left: calc(var(--cp-focus-axis) - var(--cp-focus-rail) - var(--cp-focus-set-dot) / 2)");
		expect(dot).toContain("top: calc(50% - var(--cp-focus-set-dot) / 2)");
		expect(rule(".checkpoint-view .cp-focus-set-head")).toContain("position: relative");
		expect(rule(".checkpoint-view .cp-focus-sets")).toContain("padding-left: var(--cp-focus-rail)");
		// The head left edge is the card left edge: the card has no padding and no border.
		const card = rule(".checkpoint-view .cp-focus-set");
		expect(card).not.toContain("padding");
		expect(card).not.toContain("border:");
	});

	it("the status dot has one size and no halo, and the set head and legend do not restyle it", () => {
		const base = rule(".checkpoint-view .cp-focus-status-dot");
		expect(base).toContain("width: var(--cp-focus-dot)");
		expect(base).toContain("height: var(--cp-focus-dot)");
		expect(base).not.toContain("box-shadow");
		expect(selectors(section).filter((sel) => /(-set-dots|-legend) .*cp-focus-status-dot/.test(sel))).toEqual([]);
	});

	it("a round and a set head share their padding, gap and last column", () => {
		for (const grid of [rule(".checkpoint-view .cp-focus-set-head"), rule(".checkpoint-view .cp-focus-rec")]) {
			expect(grid).toContain("var(--cp-focus-end-col)");
			expect(grid).toContain("column-gap: var(--cp-focus-col-gap)");
		}
		expect(rule(".checkpoint-view .cp-focus-set-head")).toContain("padding: 12px var(--cp-focus-set-pad)");
		expect(rule(".checkpoint-view .cp-focus-rounds")).toContain("var(--cp-focus-set-pad)");
		const rec = rule(".checkpoint-view .cp-focus-rec");
		expect(rec).toContain("align-items: center");
		expect(rec).toContain("grid-template-columns: var(--cp-focus-dot) minmax(0, 1fr) auto var(--cp-focus-end-col)");
		expect(section).not.toContain(".cp-focus-rec::before");
		expect(section).not.toContain("--cp-dot-y");
	});

	it("the overview figures align on the baseline and the two tiles share one grid row", () => {
		expect(rule(".checkpoint-view .cp-focus-figs")).toContain("align-items: baseline");
		expect(rule(".checkpoint-view .cp-focus-stats")).toContain("repeat(auto-fit, minmax(150px, 1fr))");
		expect(rule(".checkpoint-view .cp-focus-stat")).toContain("background: var(--cp-hue-soft)");
		expect(rule(".checkpoint-view .cp-focus-fig-value")).toContain("grid-row: 1");
		expect(rule(".checkpoint-view .cp-focus-fig-cap")).toContain("grid-row: 2");
		expect(section).not.toContain("cp-focus-stat-count");
		expect(section).not.toContain("border-spacing");
	});

	it("the steppers are three fixed columns and the settings line centers its parts", () => {
		const field = rule(".checkpoint-view .cp-focus-field");
		expect(field).toContain("grid-template-columns: var(--cp-focus-tile) minmax(0, 1fr) auto");
		expect(field).toContain("align-items: center");
		const stepper = rule(".checkpoint-view .cp-focus-stepper");
		expect(stepper).toContain("grid-template-columns: var(--cp-focus-step) var(--cp-focus-value-w) var(--cp-focus-step)");
		expect(stepper).toContain("align-items: center");
		const step = rule(".checkpoint-view .cp-focus-step");
		expect(step).toContain("display: grid");
		expect(step).toContain("place-items: center");
		expect(step).toContain("width: var(--cp-focus-step)");
		expect(step).toContain("height: var(--cp-focus-step)");
		const value = rule(".checkpoint-view .cp-focus-value");
		expect(value).toContain("text-align: center");
		expect(value).toContain("font-variant-numeric: tabular-nums");
		expect(rule(".checkpoint-view .cp-focus-field .cp-habit-icon")).toContain("width: var(--cp-focus-tile)");
		expect(rule(".checkpoint-view .cp-focus-settings")).toContain("width: min(420px, 100%)");
	});
});
