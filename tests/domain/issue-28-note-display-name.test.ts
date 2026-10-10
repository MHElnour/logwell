import { describe, expect, it } from "vitest";
import { basenameOf, noteDisplayName } from "../../src/domain/notes";
import { noteInsertName } from "../../src/obsidian/tokenChoice";

// Issue 28: a linked note's name hides only the ".md" extension; any other extension stays.

describe("noteDisplayName", () => {
	it("hides .md, whatever the case, and the folders", () => {
		expect(noteDisplayName("Notes/Budget.md")).toBe("Budget");
		expect(noteDisplayName("Budget.MD")).toBe("Budget");
		expect(noteDisplayName("Budget")).toBe("Budget");
	});

	it("keeps any other extension", () => {
		expect(noteDisplayName("Files/report.pdf")).toBe("report.pdf");
		expect(noteDisplayName("a/b/archive.tar.gz")).toBe("archive.tar.gz");
		expect(noteDisplayName("Plan.v2.md")).toBe("Plan.v2");
	});

	it("leaves basenameOf as it was: any extension is dropped", () => {
		expect(basenameOf("Files/report.pdf")).toBe("report");
		expect(basenameOf("Notes/Budget.md")).toBe("Budget");
	});

	it("is the name a link inserts for a unique note", () => {
		expect(noteInsertName("Files/report.pdf", ["Files/report.pdf"])).toBe("report.pdf");
		expect(noteInsertName("Notes/Budget.md", ["Notes/Budget.md"])).toBe("Budget");
	});
});
