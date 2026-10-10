import type { App } from "obsidian";
import { describe, expect, it } from "vitest";
import { resolveNoteLinks } from "../../src/obsidian/noteLinks";
import { fileOf } from "./fake-vault";

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
