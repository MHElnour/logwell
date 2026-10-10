// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fakeApp, loadPlugin } from "./fake-vault";

// A series whose end was reached outside a write (here a count already used up by its records)
// is ended when the database opens, like the Trash purge.

vi.mock("../../src/obsidian/notices", () => ({
	actionNotice: () => ({}),
	showError: () => undefined,
}));

const V5 = readFileSync(join(import.meta.dirname, "..", "fixtures", "schema-v5.cpbase"), "utf8");
const PATH = "Checkpoint.cpbase";
const RENT = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
const GYM = "4f5a6b7c-8d9e-4fa0-b1c2-d3e4f5a6b7c8";

describe("the session ends exhausted series on open", () => {
	it("a count reached by its records is ended; a live series is not", async () => {
		const fake = fakeApp();
		const text = V5.replace('"end":{"count":12,"kind":"count"}', '"end":{"count":1,"kind":"count"}');
		if (text === V5) throw new Error("the fixture's rent line changed");
		fake.files.set(PATH, text);
		const plugin = await loadPlugin(fake, PATH);
		const tasks = plugin.session!.store.data.tasks;
		expect(tasks.get(RENT)?.status).toBe("completed");
		expect(typeof tasks.get(RENT)?.recurrence?.endedAt).toBe("string");
		expect(tasks.get(GYM)).toMatchObject({ status: "open", recurrence: { endedAt: null } });
		await plugin.session!.store.flush();
		expect(fake.files.get(PATH)).toContain(`"id":"${RENT}"`);
		expect(fake.files.get(PATH)).not.toContain('"title":"Pay rent","categoryId":"inbox","status":"open"');
	});

	it("an untouched current-schema (v5) database is not rewritten", async () => {
		const fake = fakeApp();
		fake.files.set(PATH, V5);
		const plugin = await loadPlugin(fake, PATH);
		await plugin.session!.store.flush();
		expect(fake.files.get(PATH)).toBe(V5);
	});
});
