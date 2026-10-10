// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { QuickAddSuggest } from "../../src/obsidian/suggest";

// Found by e2e in real Obsidian: AbstractInputSuggest calls open() on every
// input event, even when it then shows no suggestions. Counting that as "open"
// made Enter look like a suggestion pick, so Quick Add never saved.

function make(value: string) {
	const input = document.createElement("input");
	input.value = value;
	input.setSelectionRange(value.length, value.length);
	const app = { vault: { getMarkdownFiles: () => [] } };
	const suggest = new QuickAddSuggest(
		app as never,
		input,
		{ categories: () => [{ id: "c1", name: "Study", icon: null }], tags: () => [] },
		() => undefined,
	);
	const lookup = (q: string) => (suggest as unknown as { getSuggestions(q: string): unknown[] }).getSuggestions(q);
	return { suggest, input, lookup };
}

describe("QuickAddSuggest open state", () => {
	it("is not open when Obsidian opens it but there are no suggestions", () => {
		const { suggest, lookup } = make("Call mom tomorrow");
		suggest.open();
		expect(lookup("Call mom tomorrow")).toHaveLength(0);
		expect(suggest.isShowing()).toBe(false);
	});

	it("still works when Obsidian sets its own isOpen field on the instance", () => {
		const { suggest, lookup } = make("Read #Stu");
		(suggest as unknown as { isOpen: boolean }).isOpen = true;
		suggest.open();
		lookup("Read #Stu");
		expect(suggest.isShowing()).toBe(true);
	});

	it("is open while suggestions are shown, and closed after close()", () => {
		const { suggest, lookup } = make("Read #Stu");
		suggest.open();
		expect(lookup("Read #Stu").length).toBeGreaterThan(0);
		expect(suggest.isShowing()).toBe(true);
		suggest.close();
		expect(suggest.isShowing()).toBe(false);
	});

	it("stays closed after a pick until the user edits the text (PLAN #126)", () => {
		const bound: unknown[] = [];
		const input = document.createElement("input");
		input.value = "Read #Stu";
		input.setSelectionRange(9, 9);
		const app = { vault: { getMarkdownFiles: () => [] } };
		const suggest = new QuickAddSuggest(
			app as never,
			input,
			{ categories: () => [{ id: "c1", name: "Study", icon: null }], tags: () => [] },
			(d) => bound.push(d),
		);
		const lookup = (q: string) => (suggest as unknown as { getSuggestions(q: string): unknown[] }).getSuggestions(q);
		suggest.open();
		const [item] = lookup("Read #Stu");
		suggest.selectSuggestion(item as never);
		expect(input.value).toContain("#Study");
		expect(bound).toHaveLength(1);
		// Obsidian's late answer to the pick's input event: it looks up and opens again.
		expect(lookup(input.value)).toHaveLength(0);
		suggest.open();
		expect(suggest.isShowing()).toBe(false);
		// A real edit releases the hold.
		input.value = "Read #Stud";
		input.setSelectionRange(10, 10);
		input.dispatchEvent(new Event("beforeinput"));
		suggest.open();
		expect(lookup(input.value).length).toBeGreaterThan(0);
		expect(suggest.isShowing()).toBe(true);
	});
});
