// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { QuickAddSuggest } from "../../src/obsidian/suggest";
import { resolveTagName, TagNames } from "../../src/domain/tags";

// The @tag suggester shows and inserts a tag by its own name, and what it inserts finds the same tag (#11).

type Tags = { key: string; label: string }[];

function make(value: string, tags: Tags) {
	const input = document.createElement("input");
	input.value = value;
	input.setSelectionRange(value.length, value.length);
	const bound: unknown[] = [];
	const app = { vault: { getMarkdownFiles: () => [] } };
	const suggest = new QuickAddSuggest(app as never, input, { categories: () => [], tags: () => tags }, (d) => bound.push(d));
	const lookup = (q: string) => (suggest as unknown as { getSuggestions(q: string): unknown[] }).getSuggestions(q);
	const render = (item: unknown): string => {
		const el = document.createElement("div");
		(el as unknown as { setText(t: string): void }).setText = (t) => void (el.textContent = t);
		suggest.renderSuggestion(item as never, el);
		return el.textContent ?? "";
	};
	return { suggest, input, lookup, render, bound };
}

describe("@tag suggester: a tag by its own name", () => {
	it("shows @Calls for Home/Calls and inserts @Calls", () => {
		const { suggest, input, lookup, render, bound } = make("Ring mum @ca", [{ key: "home/calls", label: "Calls" }]);
		const items = lookup("Ring mum @ca");
		expect(items).toHaveLength(1);
		expect(render(items[0])).toBe("@Calls");
		suggest.selectSuggestion(items[0] as never);
		expect(input.value).toContain("@Calls");
		expect(input.value).not.toContain("Home");
		expect(bound).toMatchObject([{ kind: "tag", key: "home/calls", text: "@Calls" }]);
	});

	it("a name two tags use shows and inserts the full path, which finds its own tag", () => {
		const tags: Tags = [
			{ key: "home/calls", label: "Home/Calls" },
			{ key: "work/calls", label: "Work/Calls" },
		];
		const { suggest, input, lookup, render } = make("x @wor", tags);
		const items = lookup("x @wor");
		expect(items).toHaveLength(1);
		expect(render(items[0])).toBe("@Work/Calls");
		suggest.selectSuggestion(items[0] as never);
		expect(input.value).toContain("@Work/Calls");
		const names = TagNames.of(tags.map((t) => ({ key: t.key })));
		expect(resolveTagName(names, "Work/Calls")).toBe("work/calls");
	});
});
