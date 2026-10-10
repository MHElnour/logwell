// @vitest-environment happy-dom
import { Plugin } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyDbText } from "../persistence/fixtures";
import { fakeApp, loadPlugin } from "./fake-vault";

// "Start focus on selected task" uses the selection from the app's state, and does nothing
// but say so when nothing is selected.

const notices = vi.hoisted(() => ({ plain: [] as string[] }));
vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	Notice: class {
		constructor(message: unknown) {
			notices.plain.push(String(message));
		}
	},
}));

interface Cmd {
	id: string;
	callback?: () => void;
}

async function setup(selected: string | null) {
	const commands: Cmd[] = [];
	vi.spyOn(Plugin.prototype, "addCommand").mockImplementation(((c: Cmd) => void commands.push(c)) as never);
	const fake = fakeApp();
	fake.files.set("A.cpbase", emptyDbText("db-a", "r-aaaaaaaaaaaa"));
	const plugin = await loadPlugin(fake, "A.cpbase");
	(plugin as unknown as { appView: () => unknown }).appView = () => ({ selectedTaskId: () => selected });
	const start = vi.spyOn(plugin, "startFocus").mockResolvedValue(undefined);
	notices.plain.length = 0;
	return { start, run: () => commands.find((c) => c.id === "start-focus")!.callback!() };
}

afterEach(() => vi.restoreAllMocks());

describe("start-focus command (B3)", () => {
	it("with nothing selected it shows a notice and starts nothing", async () => {
		const { start, run } = await setup(null);
		run();
		expect(notices.plain).toEqual(["Select a task first."]);
		expect(start).not.toHaveBeenCalled();
	});

	it("with a selected task it starts focus on it", async () => {
		const { start, run } = await setup("t-1");
		run();
		expect(notices.plain).toEqual([]);
		expect(start).toHaveBeenCalledWith("t-1");
	});
});
