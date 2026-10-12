import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// With thresholds that are too small for the pane widths, an app width of about 960 px with the details
// open squeezes the list column to about 200 px. happy-dom has no layout, so these tests
// read the stylesheet. The e2e spec ui.e2e.ts checks the real widths.

const css = readFileSync("styles.css", "utf8");

/** The text between the braces of the first rule that starts with `head`. */
function block(head: string): string {
	const start = css.indexOf(head);
	if (start < 0) throw new Error(`missing ${head}`);
	const open = css.indexOf("{", start);
	let depth = 0;
	for (let i = open; i < css.length; i++) {
		if (css[i] === "{") depth++;
		else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
	}
	throw new Error(`unbalanced ${head}`);
}
const px = (name: string): number => Number(new RegExp(`${name}:\\s*(\\d+)px`).exec(css)![1]);
const containerQueries = (name: string): number[] =>
	[...css.matchAll(new RegExp(`@container ${name} \\(max-width: (\\d+)px\\)`, "g"))].map((m) => Number(m[1]));
const MIN_LIST = 440;

describe("app breakpoints", () => {
	it("the old 900 and 600 px thresholds are gone", () => {
		expect(containerQueries("cp-app")).not.toContain(900);
		expect(containerQueries("cp-app")).not.toContain(600);
	});

	it("the details pane is a drawer below 1200 px, so the list keeps at least 440 px", () => {
		const rail = px("--cp-rail-w");
		const side = px("--cp-side-w");
		const details = px("--cp-details-w");
		expect(containerQueries("cp-app")).toContain(1200);
		expect(rail + side + details + MIN_LIST).toBeLessThanOrEqual(1200);
		const q = block("@container cp-app (max-width: 1200px)");
		expect(q).toMatch(/\.cp-details-pane\s*\{[^}]*position:\s*absolute/);
		expect(q).toMatch(/\.cp-details-close\s*\{[^}]*display:\s*inline-flex/);
	});

	it("the sidebar collapses behind the menu button below 800 px", () => {
		expect(containerQueries("cp-app")).toContain(800);
		const q = block("@container cp-app (max-width: 800px)");
		expect(q).toMatch(/\.cp-sidebar-pane\s*\{[^}]*display:\s*none/);
		expect(q).toMatch(/is-sidebar-open \.cp-sidebar-pane\s*\{[^}]*position:\s*absolute/);
		expect(q).toMatch(/\.cp-sidebar-toggle\s*\{[^}]*display:\s*inline-flex/);
	});

	it("keeps the mechanics the e2e specs use", () => {
		for (const cls of [".cp-details-pane", ".cp-details-close", ".cp-sidebar-toggle", ".cp-sidebar-pane"]) expect(css).toContain(cls);
	});
});

describe("list column", () => {
	it("cannot collapse below a readable width inside the inline layout", () => {
		expect(block(".checkpoint-view .cp-main {")).toMatch(/min-width:\s*min\(440px,\s*100%\)/);
	});

	it("is a size container, so rows adapt to the list width and not the window", () => {
		const main = block(".checkpoint-view .cp-main {");
		expect(main).toMatch(/container-type:\s*inline-size/);
		expect(main).toMatch(/container-name:\s*cp-list/);
	});

	it("the title never gets under 120 px before meta is hidden, and ellipsizes past that", () => {
		const t = block(".checkpoint-view .cp-task-title {");
		expect(t).toMatch(/min-width:\s*120px/);
		expect(t).toMatch(/text-overflow:\s*ellipsis/);
		expect(t).toMatch(/overflow:\s*hidden/);
	});

	it("the meta can shrink and the date never does, so the date stays inside the row", () => {
		expect(block(".checkpoint-view .cp-task-meta {")).toMatch(/flex:\s*0 1 auto/);
		expect(block(".checkpoint-view .cp-task-meta {")).toMatch(/min-width:\s*0/);
		expect(block(".checkpoint-view .cp-task-meta {")).toMatch(/overflow:\s*hidden/);
		expect(block(".checkpoint-view .cp-task-meta > .cp-meta-date {")).toMatch(/flex-shrink:\s*0/);
	});

	it("hides tags first, then the list name, then the rest of the meta, as the list narrows", () => {
		const q = containerQueries("cp-list").sort((a, b) => b - a);
		expect(q.length).toBeGreaterThanOrEqual(3);
		const [tags, listName, rest] = q as [number, number, number];
		expect(block(`@container cp-list (max-width: ${tags}px)`)).toMatch(/\.cp-meta-tags\s*\{[^}]*display:\s*none/);
		expect(block(`@container cp-list (max-width: ${listName}px)`)).toMatch(/\.cp-meta-list-name\s*\{[^}]*display:\s*none/);
		expect(block(`@container cp-list (max-width: ${rest}px)`)).toMatch(/\.cp-meta-note/);
		// The tag threshold is wider than the list-name one: tags go first.
		expect(tags).toBeGreaterThan(listName);
		expect(listName).toBeGreaterThan(rest);
		// The details-open inline layout (list content about 384 px) must hide tags and the list name.
		const inlineContent = 1200 - px("--cp-rail-w") - px("--cp-side-w") - px("--cp-details-w") - 64;
		expect(inlineContent).toBeLessThanOrEqual(listName);
	});
});

describe("view header", () => {
	it("the title does not shrink, so 'Today' is never cut to 'To…'", () => {
		const t = block(".checkpoint-view .cp-main-title {");
		expect(t).toMatch(/flex:\s*0 0 auto/);
		// A very long list name may still ellipsize, but only against the whole header width.
		expect(t).toMatch(/max-width:\s*100%/);
	});

	it("the search field shrinks to 120 px and the header wraps before anything else shrinks", () => {
		const s = block(".checkpoint-view .cp-view-search {");
		expect(s).toMatch(/min-width:\s*120px/);
		expect(s).toMatch(/flex:\s*1 1 120px/);
		expect(block(".checkpoint-view .cp-main-header {")).toMatch(/flex-wrap:\s*wrap/);
	});
});

describe("task checkbox", () => {
	// Obsidian's check mark is a :after offset by -1px, which assumes a 1 px border.
	it("offsets the check mark by the border width so it is centered", () => {
		const own = block(".checkpoint-view .cp-task-checkbox:checked:after");
		expect(own).toMatch(/top:\s*calc\(-1 \* var\(--cp-cb-border\)\)/);
		expect(own).toMatch(/inset-inline-start:\s*calc\(-1 \* var\(--cp-cb-border\)\)/);
		expect(block(".checkpoint-view .cp-task-checkbox {")).toMatch(/border-width:\s*var\(--cp-cb-border\)/);
		expect(own).not.toContain("!important");
	});
});

describe("task row tag pill", () => {
	it("is wide enough for a two-level name, still ellipsized beyond that", () => {
		const rule = block(".checkpoint-view .cp-meta-tags .cp-tag-pill {");
		expect(Number(/max-width:\s*(\d+)px/.exec(rule)![1])).toBeGreaterThanOrEqual(220);
		expect(rule).toContain("text-overflow: ellipsis");
	});
});
