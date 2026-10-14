import { describe, expect, it, vi } from "vitest";

// The `obsidian` package ships types only; VaultDbFile needs none of its runtime.
vi.mock("obsidian", () => ({ TFile: class {}, TFolder: class {}, normalizePath: (p: string) => p }));

const { VaultDbFile } = await import("../../src/obsidian/gateways");

const { fakeApp } = await import("../obsidian/fake-vault");

/** The fake vault (its process() behaves like Obsidian's: read, call fn, write its result) holding `db.cpbase` with `text`. */
function vaultWith(text: string | null) {
	const fake = fakeApp();
	if (text !== null) fake.files.set("db.cpbase", text);
	return { fake, app: fake.app as never };
}

describe("VaultDbFile", () => {
	it("writes inside vault.process when the current text is the expected one", async () => {
		const { fake, app } = vaultWith("old");
		const result = await new VaultDbFile(app, () => "db.cpbase").write("new", (t) => t === "old");
		expect(result).toEqual({ written: true });
		expect(fake.files.get("db.cpbase")).toBe("new");
	});

	it("aborts inside vault.process, before anything is written, on a mismatch", async () => {
		const { fake, app } = vaultWith("theirs");
		const result = await new VaultDbFile(app, () => "db.cpbase").write("mine", (t) => t === "old");
		expect(result).toEqual({ written: false, current: "theirs" });
		expect(fake.files.get("db.cpbase")).toBe("theirs");
		expect(fake.log.processed).toEqual([]);
	});

	it("never recreates a missing file", async () => {
		const { fake, app } = vaultWith(null);
		expect(await new VaultDbFile(app, () => "db.cpbase").write("x", () => true)).toEqual({ written: false, current: null });
		expect(fake.files.has("db.cpbase")).toBe(false);
	});
});
