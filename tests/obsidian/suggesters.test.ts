// @vitest-environment happy-dom
import type { App } from "obsidian";
import { describe, expect, it } from "vitest";
import { TagNames, resolveTagName } from "../../src/domain/tags";
import { resolveNoteLinks } from "../../src/obsidian/noteLinks";
import { QuickAddSuggest } from "../../src/obsidian/suggest";
import { applyTokenChoice, filterByQuery, noteInsertName, suggestNotes } from "../../src/obsidian/tokenChoice";
import { fileOf } from "./fake-vault";

describe("applyTokenChoice (B4)", () => {
	it("replaces the token span and reports the new span and cursor", () => {
		const r = applyTokenChoice("Buy milk #dee tomorrow", { span: { start: 9, end: 13 } }, "#Deep work");
		expect(r.value).toBe("Buy milk #Deep work tomorrow");
		expect(r.span).toEqual({ start: 9, end: 19 });
		expect(r.value.slice(r.span.start, r.span.end)).toBe("#Deep work");
		expect(r.cursor).toBe(19);
	});
	it("handles a token at the end and an empty token", () => {
		expect(applyTokenChoice("x @", { span: { start: 2, end: 3 } }, "@home")).toEqual({ value: "x @home", span: { start: 2, end: 7 }, cursor: 7 });
	});
	it("clamps a span beyond the value", () => {
		expect(applyTokenChoice("ab", { span: { start: 1, end: 99 } }, "Z").value).toBe("aZ");
	});
	it("keeps unicode intact", () => {
		const r = applyTokenChoice("héllo [[pl", { span: { start: 6, end: 10 } }, "[[Plän]]");
		expect(r.value).toBe("héllo [[Plän]]");
	});
});

describe("filterByQuery ranking", () => {
	it("lists prefix matches before substring matches before subsequence matches, whatever the input order", () => {
		const names = ["Wide orange road", "Deep work", "Worker", "Network", "W o r"];
		// "wor": Worker and "W o r" start with it (prefix), "Deep work" and "Network" contain it,
		// "Wide orange road" only has w, o, r in order.
		expect(filterByQuery(names, (n) => n, "wor")).toEqual(["Worker", "W o r", "Deep work", "Network", "Wide orange road"]);
	});
});

describe("filterByQuery", () => {
	const names = ["Work", "Deep work", "Home", "Study"];
	it("ranks prefix before substring before fuzzy and is case-insensitive", () => {
		expect(filterByQuery(names, (n) => n, "WOR")).toEqual(["Work", "Deep work"]);
		expect(filterByQuery(names, (n) => n, "dpw")).toEqual(["Deep work"]);
	});
	it("empty query lists all up to the limit", () => {
		expect(filterByQuery(names, (n) => n, "", 2)).toEqual(["Work", "Deep work"]);
	});
	it("no match gives nothing", () => {
		expect(filterByQuery(names, (n) => n, "zzz")).toEqual([]);
	});
});

describe("noteInsertName", () => {
	it("uses the basename when unique, else the path without .md", () => {
		const all = ["Projects/Plan.md", "Archive/Plan.md", "Notes/Big note.md"];
		expect(noteInsertName("Notes/Big note.md", all)).toBe("Big note");
		expect(noteInsertName("Projects/Plan.md", all)).toBe("Projects/Plan");
	});
});

describe("suggestNotes (H2: linear cost)", () => {
	it("reads each of 5,000 paths a bounded number of times and computes insert names for the results only", () => {
		let reads = 0;
		const n = 5000;
		const files = Array.from({ length: n }, (_, i) => {
			const path = `Folder${i % 50}/Note ${i}.md`;
			return {
				get path() {
					reads++;
					return path;
				},
				basename: `Note ${i}`,
			};
		});
		const out = suggestNotes(files, "note 12");
		expect(out.length).toBeLessThanOrEqual(20);
		expect(out[0]!.insert).toBe(out[0]!.basename); // unique basename
		// Linear: a handful of passes. The old per-file scan read about n * n paths.
		expect(reads).toBeLessThan(n * 6);
	});

	it("uses the path for colliding basenames and the basename otherwise", () => {
		const files = [
			{ path: "Projects/Plan.md", basename: "Plan" },
			{ path: "Archive/plan.md", basename: "plan" },
			{ path: "Notes/Big note.md", basename: "Big note" },
		];
		expect(suggestNotes(files, "").map((s) => s.insert)).toEqual(["Projects/Plan", "Archive/plan", "Big note"]);
	});
});

function vaultWith(paths: string[]): App {
	const files = paths.map(fileOf);
	return {
		vault: {
			getFileByPath: (p: string) => files.find((f) => f.path === p) ?? null,
			getMarkdownFiles: () => files.filter((f) => f.extension === "md"),
		},
	} as unknown as App;
}

const app = vaultWith(["Plan.md", "Projects/Plan.md", "Archive/Plan.md", "Notes/Big note.md", "Projects/data.csv", "Archive/Plan.pdf", "Other/Plan.txt"]);

describe("resolveNoteLinks (B3)", () => {
	it("returns every basename match sorted by path", () => {
		expect(resolveNoteLinks(vaultWith(["Projects/Plan.md", "Archive/Plan.md"]), "Plan")).toEqual(["Archive/Plan.md", "Projects/Plan.md"]);
	});
	it("an exact path wins as the single result, with or without .md", () => {
		expect(resolveNoteLinks(app, "Projects/Plan")).toEqual(["Projects/Plan.md"]);
		expect(resolveNoteLinks(app, "Projects/Plan.md")).toEqual(["Projects/Plan.md"]);
		expect(resolveNoteLinks(app, "Plan")).toEqual(["Plan.md"]);
	});
	it("matches basenames case-insensitively", () => {
		expect(resolveNoteLinks(app, "big NOTE")).toEqual(["Notes/Big note.md"]);
	});
	it("strips alias and heading", () => {
		expect(resolveNoteLinks(app, "Projects/Plan|my alias")).toEqual(["Projects/Plan.md"]);
		expect(resolveNoteLinks(app, "Projects/Plan#Goals")).toEqual(["Projects/Plan.md"]);
		expect(resolveNoteLinks(app, "big note#h|a")).toEqual(["Notes/Big note.md"]);
	});
	it("returns nothing for no match, empty text and non-md files", () => {
		expect(resolveNoteLinks(app, "Nope")).toEqual([]);
		expect(resolveNoteLinks(app, "  ")).toEqual([]);
		expect(resolveNoteLinks(app, "data")).toEqual([]);
		expect(resolveNoteLinks(app, "Projects/data.csv")).toEqual([]);
		expect(resolveNoteLinks(app, "Archive/Plan.pdf")).toEqual([]);
	});
});

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

describe("a tag by its own name", () => {
	// The @tag suggester shows and inserts a tag by its own name, and what it inserts finds the same tag (#11).

	type Tags = { key: string; label: string; path: string }[];

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
		it("#11: shows @Calls for Home/Calls and inserts @Calls", () => {
			const { suggest, input, lookup, render, bound } = make("Ring mum @ca", [{ key: "home/calls", label: "Calls", path: "Home/Calls" }]);
			const items = lookup("Ring mum @ca");
			expect(items).toHaveLength(1);
			expect(render(items[0])).toBe("@Calls");
			suggest.selectSuggestion(items[0] as never);
			expect(input.value).toContain("@Calls");
			expect(input.value).not.toContain("Home");
			expect(bound).toMatchObject([{ kind: "tag", key: "home/calls", text: "@Calls" }]);
		});

		it("#11: a typed path still finds the tag; the shown and inserted text stays its own name", () => {
			const tags: Tags = [
				{ key: "home/calls", label: "Calls", path: "Home/Calls" },
				{ key: "errands", label: "Errands", path: "Errands" },
			];
			for (const typed of ["@home/", "@home/ca", "@Home/Calls"]) {
				const { suggest, input, lookup, render } = make(`x ${typed}`, tags);
				const items = lookup(`x ${typed}`);
				expect(items).toHaveLength(1);
				expect(render(items[0])).toBe("@Calls");
				suggest.selectSuggestion(items[0] as never);
				expect(input.value).toBe("x @Calls");
			}
		});

		it("#11: a name match comes before a path match", () => {
			const tags: Tags = [
				{ key: "calls/x", label: "X", path: "Calls/X" },
				{ key: "home/calls", label: "Calls", path: "Home/Calls" },
			];
			const { lookup, render } = make("@calls", tags);
			expect(lookup("@calls").map(render)).toEqual(["@Calls", "@X"]);
		});

		it("#11: a name two tags use shows and inserts the full path, which finds its own tag", () => {
			const tags: Tags = [
				{ key: "home/calls", label: "Home/Calls", path: "Home/Calls" },
				{ key: "work/calls", label: "Work/Calls", path: "Work/Calls" },
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
});
