import { TFile } from "obsidian";
import { describe, expect, it } from "vitest";
import { VaultNotes } from "../../src/obsidian/gateways";

// The one note write (`replaceText`, for notes TickTick sync created) is a compare-and-swap inside
// vault.process, and a new sync note is created with its text.

function vault() {
	const files = new Map<string, { text: string; mtime: number }>();
	const created: string[] = [];
	const fileOf = (path: string) => Object.assign(new TFile(), { path, stat: { mtime: files.get(path)!.mtime } });
	const v = {
		getFileByPath: (path: string) => (files.has(path) ? fileOf(path) : null),
		getAbstractFileByPath: (path: string) => (files.has(path) ? fileOf(path) : null),
		getFolderByPath: () => ({}),
		create: (path: string, text: string) => {
			files.set(path, { text, mtime: 1 });
			created.push(path);
			return Promise.resolve(fileOf(path));
		},
		process: (file: TFile, fn: (data: string) => string) => {
			const current = files.get(file.path)!;
			const next = fn(current.text); // a throw aborts before anything is written, like Obsidian
			files.set(file.path, { text: next, mtime: current.mtime + 1 });
			return Promise.resolve(next);
		},
	};
	return { notes: new VaultNotes({ vault: v } as never), files, created };
}

describe("VaultNotes for TickTick sync (SYNC-09)", () => {
	it("replaces a note's text only while it is still what the sync read", async () => {
		const { notes, files } = vault();
		files.set("Task notes/Trip.md", { text: "old", mtime: 5 });
		expect(await notes.replaceText("Task notes/Trip.md", "old", "new")).toBe(true);
		expect(files.get("Task notes/Trip.md")).toEqual({ text: "new", mtime: 6 });
		expect(await notes.replaceText("Task notes/Trip.md", "old", "newer")).toBe(false);
		expect(files.get("Task notes/Trip.md")!.text).toBe("new");
	});

	it("never recreates a note that is gone", async () => {
		const { notes, files } = vault();
		expect(await notes.replaceText("Task notes/Gone.md", "", "text")).toBe(false);
		expect(files.size).toBe(0);
	});

	it("reads the modification time, null for a missing file", () => {
		const { notes, files } = vault();
		files.set("a.md", { text: "", mtime: 42 });
		expect(notes.modifiedAt("a.md")).toBe(42);
		expect(notes.modifiedAt("b.md")).toBeNull();
	});

	it("creates a note with its text at a free name", async () => {
		const { notes, files } = vault();
		files.set("Task notes/Trip.md", { text: "mine", mtime: 1 });
		expect(await notes.createNote("Task notes", "Trip", "Pack\n")).toBe("Task notes/Trip (2).md");
		expect(files.get("Task notes/Trip (2).md")!.text).toBe("Pack\n");
		expect(files.get("Task notes/Trip.md")!.text).toBe("mine");
	});
});
