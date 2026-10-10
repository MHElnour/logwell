import { describe, expect, it } from "vitest";
import { applyTokenChoice, filterByQuery, noteInsertName, suggestNotes } from "../../src/obsidian/tokenChoice";

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
