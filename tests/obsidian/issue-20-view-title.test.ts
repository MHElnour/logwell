// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

// Issue 20: with no database file loaded the view tab says "Logwell", the plugin's name.

vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	FileView: class {
		file: { basename: string } | null = null;
		scope: unknown = null;
		app = { scope: {} };
		containerEl = document.createElement("div");
	},
	Scope: class {
		register(): void {}
	},
}));

async function makeView() {
	const { CheckpointView } = await import("../../src/obsidian/CheckpointView");
	return new CheckpointView({} as never, {} as never);
}

describe("view tab title", () => {
	it("says Logwell when no file is loaded", async () => {
		const view = await makeView();
		expect(view.getDisplayText()).toBe("Logwell");
	});

	it("shows the database name when a file is loaded", async () => {
		const view = await makeView();
		(view as unknown as { file: { basename: string } }).file = { basename: "Work" };
		expect(view.getDisplayText()).toBe("Work");
	});
});
