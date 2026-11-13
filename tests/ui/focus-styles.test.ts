import { describe, expect, it } from "vitest";
import { cssBlock, cssSection } from "./styles-helpers";

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

	it("the tree line, the four dots and the keyboard outlines are styled with theme variables", () => {
		const rule = (sel: string): string => cssBlock(`${sel} {`, section);
		expect(rule(".checkpoint-view .cp-focus-rec::before")).toMatch(/background:\s*var\(--background-modifier-border\)/);
		expect(rule(".checkpoint-view .cp-focus-rec:only-child::before")).toContain("display: none");
		expect(rule(".checkpoint-view .cp-focus-rec:first-child::before")).toContain("top: var(--cp-dot-y)");
		expect(rule(".checkpoint-view .cp-focus-rec:last-child::before")).toContain("height: var(--cp-dot-y)");
		expect(rule(".checkpoint-view .cp-focus-status-dot.is-recovered")).toContain("var(--color-yellow)");
		expect(rule(".checkpoint-view .cp-focus-status-dot.is-early")).toContain("var(--cp-accent)");
		expect(rule(".checkpoint-view .cp-focus-status-dot.is-stopped")).toContain("var(--text-faint)");
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
