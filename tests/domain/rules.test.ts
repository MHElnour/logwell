import { describe, expect, it } from "vitest";
import { isDomainError } from "../../src/domain/errors";
import { basenameOf, noteDisplayName, noteNameCandidate, rewriteNotePath, sanitizeNoteName } from "../../src/domain/notes";
import { compareSortKeys, keyAfter, keyBetween } from "../../src/domain/sortKey";
import { isValidTagKey, normalizeTagKey, requireTagKey, tagDisplayName } from "../../src/domain/tags";
import { assertCanBecomeSubtask, assertUniqueCategoryName, requireTitle } from "../../src/domain/tasks";
import type { Category, Task } from "../../src/domain/types";
import { noteInsertName } from "../../src/obsidian/tokenChoice";

describe("rules", () => {
	function task(id: string, parentId: string | null = null): Task {
		return {
			id,
			title: id,
			descriptionNote: null,
			categoryId: "inbox",
			tagKeys: [],
			parentId,
			sectionId: null,
			scheduled: null,
			deadline: null,
			plannedDurationMin: null,
			urgent: false,
			important: false,
			priority: 0,
			status: "open",
			completedAt: null,
			recurrence: null,
			sortKey: "V",
			createdAt: "2026-10-01T00:00:00.000Z",
			modifiedAt: "2026-10-01T00:00:00.000Z",
		};
	}

	describe("tags (TAG-03)", () => {
		it("normalizes keys: NFC, trimmed, lowercased", () => {
			expect(normalizeTagKey("  @Learning ")).toBe("learning");
			expect(normalizeTagKey("Café")).toBe("café");
			expect(normalizeTagKey("@learning")).toBe(normalizeTagKey("@Learning"));
		});

		it("allows letters, digits, - _ /", () => {
			expect(isValidTagKey("work/deep-focus_2")).toBe(true);
			expect(isValidTagKey("über")).toBe(true);
			expect(isValidTagKey("two words")).toBe(false);
			expect(isValidTagKey("a#b")).toBe(false);
			expect(() => requireTagKey("bad tag")).toThrow(/letters, digits/);
		});

		it("keeps the display casing", () => {
			expect(tagDisplayName("@Learning")).toBe("Learning");
		});
	});

	describe("titles and categories", () => {
		it("TASK-02: rejects empty titles after trimming", () => {
			expect(requireTitle("  Buy milk ")).toBe("Buy milk");
			try {
				requireTitle("   ");
				expect.unreachable();
			} catch (err) {
				expect(isDomainError(err, "TitleRequired")).toBe(true);
			}
		});

		it("CAT-03: category names are unique case-insensitively", () => {
			const cats: Category[] = [
				{ id: "a", name: "Study", icon: null, color: null, nameKey: "study", isInbox: false, sortKey: "V", createdAt: "", modifiedAt: "" },
			];
			expect(() => assertUniqueCategoryName(cats, "STUDY", null)).toThrow(/already exists/);
			expect(() => assertUniqueCategoryName(cats, "Study", "a")).not.toThrow();
			expect(() => assertUniqueCategoryName(cats, "Exercise", null)).not.toThrow();
		});
	});

	describe("subtask depth (SUB-01, B13)", () => {
		it("blocks a subtask of a subtask", () => {
			const parent = task("p");
			const child = task("c", "p");
			const candidate = task("x");
			expect(() => assertCanBecomeSubtask(candidate, child, [parent, child, candidate])).toThrow(
				"Only one subtask level is supported",
			);
		});

		it("blocks a parent from becoming a subtask", () => {
			const parent = task("p");
			const child = task("c", "p");
			const other = task("o");
			expect(() => assertCanBecomeSubtask(parent, other, [parent, child, other])).toThrow(
				"Only one subtask level is supported",
			);
		});

		it("allows a plain task under a top-level task", () => {
			const a = task("a");
			const b = task("b");
			expect(() => assertCanBecomeSubtask(a, b, [a, b])).not.toThrow();
		});
	});

	describe("note names (NOTE-02, B45)", () => {
		it("removes forbidden characters and collapses whitespace", () => {
			expect(sanitizeNoteName('Plan: a/b  "draft" #1 [x] ^y | z?')).toBe("Plan ab draft 1 x y z");
		});

		it("falls back to Untitled task", () => {
			expect(sanitizeNoteName("///")).toBe("Untitled task");
			expect(sanitizeNoteName("...")).toBe("Untitled task");
		});

		it("truncates to 100 characters", () => {
			expect(sanitizeNoteName("x".repeat(150))).toHaveLength(100);
		});

		it("probes Title.md, Title (2).md, …", () => {
			expect(noteNameCandidate("Plan", 1)).toBe("Plan.md");
			expect(noteNameCandidate("Plan", 2)).toBe("Plan (2).md");
		});

		it("NOTE-06: rewrites exact file paths and folder prefixes", () => {
			expect(rewriteNotePath("Plan.md", "Plan.md", "Plan v2.md", false)).toBe("Plan v2.md");
			expect(rewriteNotePath("Other.md", "Plan.md", "Plan v2.md", false)).toBeNull();
			expect(rewriteNotePath("Notes/a/Plan.md", "Notes", "Archive/Notes", true)).toBe("Archive/Notes/a/Plan.md");
			expect(rewriteNotePath("Notes2/Plan.md", "Notes", "X", true)).toBeNull();
			expect(basenameOf("a/b/Plan v2.md")).toBe("Plan v2");
		});
	});

	describe("sort keys", () => {
		it("always finds a key strictly between", () => {
			let lo: string | null = null;
			const keys: string[] = [];
			for (let i = 0; i < 50; i++) {
				const k = keyBetween(lo, null);
				if (lo !== null) expect(compareSortKeys(lo, k)).toBe(-1);
				keys.push(k);
				lo = k;
			}
			let a = "V";
			const b = "W";
			for (let i = 0; i < 100; i++) {
				const k = keyBetween(a, b);
				expect(a < k && k < b).toBe(true);
				expect(k.endsWith("0")).toBe(false);
				a = k;
			}
			expect(keyAfter(keys) > keys[keys.length - 1]!).toBe(true);
		});

		it("handles the start bound", () => {
			let hi = "V";
			for (let i = 0; i < 50; i++) {
				const k = keyBetween(null, hi);
				expect(k < hi).toBe(true);
				expect(k > "").toBe(true);
				hi = k;
			}
		});
	});
});

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
