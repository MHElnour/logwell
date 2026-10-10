// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { emptyDbText } from "../persistence/fixtures";
import { type FakeApp, fakeApp, loadPlugin } from "./fake-vault";

// Issue 29: the damaged-database notice's "Open conflict view" goes through openConflictView() like the other two.

interface Recorded {
	message: string;
	labels: string[];
	run: () => unknown;
}
const notices = vi.hoisted(() => ({ actions: [] as Recorded[] }));

vi.mock("../../src/obsidian/notices", () => ({
	actionNotice: (message: string, actions: { label: string; run: () => unknown }[]) => {
		notices.actions.push({ message, labels: actions.map((a) => a.label), run: () => actions.find((a) => a.label === "Open conflict view")?.run() });
		return {};
	},
	showError: () => undefined,
}));

const A = "A.cpbase";
const B = "B.cpbase";

function setup(): FakeApp {
	const fake = fakeApp();
	fake.files.set(A, emptyDbText("db-a", "r-aaaaaaaaaaaa"));
	fake.files.set(B, emptyDbText("db-b", "r-bbbbbbbbbbbb"));
	notices.actions.length = 0;
	return fake;
}

const damaged = { type: "read-only", state: { reason: "damaged", failure: "syntax", detail: "x", recoveredFrom: null } };

describe("the damaged-database notice's Open conflict view", () => {
	it("makes a closed database active again, then opens the Data section", async () => {
		const fake = setup();
		const plugin = await loadPlugin(fake, A);
		const old = plugin.session!;
		await plugin.setActiveDatabase(B);
		(old as unknown as { onStoreEvent(e: unknown): void }).onStoreEvent(damaged);
		const openApp = vi.spyOn(plugin, "openApp").mockResolvedValue(null);
		await notices.actions.at(-1)!.run();
		expect(plugin.settings.activeDatabasePath).toBe(A);
		expect(openApp).toHaveBeenCalledWith("data");
	});

	it("names where the copies are kept, and opens nothing, when the file is gone", async () => {
		const fake = setup();
		const plugin = await loadPlugin(fake, A);
		const old = plugin.session!;
		await plugin.setActiveDatabase(B);
		(old as unknown as { onStoreEvent(e: unknown): void }).onStoreEvent(damaged);
		fake.files.delete(A);
		const openApp = vi.spyOn(plugin, "openApp").mockResolvedValue(null);
		await notices.actions.at(-1)!.run();
		expect(openApp).not.toHaveBeenCalled();
		expect(notices.actions.at(-1)!.message).toContain("was not found");
	});
});
