// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

// A save against a deleted database file is silent in the
// store, so the plugin's delete handling must tell the user, exactly once.

const notices = vi.hoisted(() => [] as unknown[]);

vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	Notice: class {
		constructor(message: unknown) {
			notices.push(message);
		}
	},
}));

type Handler = (...args: unknown[]) => unknown;

async function loadPlugin() {
	const { default: CheckpointPlugin } = await import("../../src/main");
	const vaultHandlers = new Map<string, Handler>();
	let layoutReady: (() => void) | null = null;
	const app = {
		workspace: {
			onLayoutReady: (fn: () => void) => {
				layoutReady = fn;
			},
			on: () => ({}),
		},
		vault: {
			configDir: "config",
			on: (name: string, fn: Handler) => {
				vaultHandlers.set(name, fn);
				return {};
			},
			getFileByPath: () => null,
		},
		loadLocalStorage: () => "d-test",
		saveLocalStorage: () => undefined,
	};
	const Ctor = CheckpointPlugin as unknown as new (app: unknown, manifest: unknown) => InstanceType<typeof CheckpointPlugin>;
	const plugin = new Ctor(app, { id: "logwell", dir: "config/plugins/logwell" });
	await plugin.onload();
	plugin.settings.activeDatabasePath = "Checkpoint.cpbase";
	layoutReady!();
	await plugin.ready();
	return { plugin, vaultHandlers };
}

describe("deleting the active database file", () => {
	it("shows exactly one notice", async () => {
		const { plugin, vaultHandlers } = await loadPlugin();
		const close = vi.fn(() => Promise.resolve());
		plugin.session = { close, settleSync: () => Promise.resolve(), store: {} } as unknown as typeof plugin.session;
		notices.length = 0;
		vaultHandlers.get("delete")!({ path: "Checkpoint.cpbase" });
		await plugin.ready();
		expect(close).toHaveBeenCalledTimes(1);
		expect(notices).toHaveLength(1);
		expect(String(notices[0])).toContain("Checkpoint.cpbase");
	});
});
