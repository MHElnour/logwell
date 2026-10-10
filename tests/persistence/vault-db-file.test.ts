import { describe, expect, it, vi } from "vitest";

// The `obsidian` package ships types only; VaultDbFile needs none of its runtime.
vi.mock("obsidian", () => ({ TFile: class {}, TFolder: class {}, normalizePath: (p: string) => p }));

const { VaultDbFile } = await import("../../src/obsidian/gateways");

/** A vault whose process() behaves like Obsidian's: read, call fn, write its result. */
function fakeApp(initial: string | null) {
	const state = { text: initial, writes: 0 };
	const file = {};
	const vault = {
		getFileByPath: () => (state.text === null ? null : file),
		read: () => Promise.resolve(state.text ?? ""),
		process: (_f: unknown, fn: (data: string) => string) => {
			const next = fn(state.text ?? "");
			state.text = next;
			state.writes++;
			return Promise.resolve(next);
		},
	};
	return { state, app: { vault } as never };
}

describe("VaultDbFile (review #1, #20)", () => {
	it("writes inside vault.process when the current text is the expected one", async () => {
		const { state, app } = fakeApp("old");
		const result = await new VaultDbFile(app, () => "db.cpbase").write("new", (t) => t === "old");
		expect(result).toEqual({ written: true });
		expect(state.text).toBe("new");
	});

	it("aborts inside vault.process, before anything is written, on a mismatch", async () => {
		const { state, app } = fakeApp("theirs");
		const result = await new VaultDbFile(app, () => "db.cpbase").write("mine", (t) => t === "old");
		expect(result).toEqual({ written: false, current: "theirs" });
		expect(state.text).toBe("theirs");
		expect(state.writes).toBe(0);
	});

	it("never recreates a missing file", async () => {
		const { app } = fakeApp(null);
		expect(await new VaultDbFile(app, () => "db.cpbase").write("x", () => true)).toEqual({ written: false, current: null });
	});
});
