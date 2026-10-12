// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { FocusService } from "../../src/app/FocusService";
import { createEmptyDb } from "../../src/persistence/schema";
import { serializeDb } from "../../src/persistence/serializer";
import { makeTask } from "../persistence/fixtures";
import { fakeApp } from "./fake-vault";

// Unloading the plugin while the database opens closes the opening session; the rest of
// its open then fails against the closed store. That is expected and shows no error once the plugin is gone.

const shown = vi.hoisted(() => [] as unknown[]);
vi.mock("../../src/obsidian/notices", async (original) => {
	const real = await original<typeof import("../../src/obsidian/notices")>();
	return {
		...real,
		showError: (err: unknown) => {
			shown.push(err);
		},
	};
});

afterEach(() => vi.restoreAllMocks());

describe("unloading while the database opens", () => {
	it("shows no error from the open the unload cut short", async () => {
		const fake = fakeApp();
		// Trash long expired: the open purges it, a write.
		const d = createEmptyDb({ dbId: "db-a", revision: "r-aaaaaaaaaaaa", deviceId: "d-other", now: "2020-01-01T00:00:00.000Z" });
		const old = makeTask("00000001-0000-4000-8000-000000000001", { title: "Old errand" });
		const trash = new Map([["b1", { batchId: "b1", deletedAt: "2020-01-01T00:00:00.000Z", tasks: [old] }]]);
		fake.files.set("A.cpbase", serializeDb({ ...d, trash }));
		const { default: CheckpointPlugin } = await import("../../src/main");
		const Ctor = CheckpointPlugin as unknown as new (a: unknown, m: unknown) => InstanceType<typeof CheckpointPlugin>;
		const plugin = new Ctor(fake.app, { id: "logwell", dir: "config/plugins/logwell" });
		await plugin.onload();
		plugin.settings.activeDatabasePath = "A.cpbase";
		// The unload lands after the file is read, while the open goes on.
		type Open = (this: FocusService, dbId: string) => ReturnType<FocusService["open"]>;
		const focusOpen = Object.getOwnPropertyDescriptor(FocusService.prototype, "open")!.value as Open;
		vi.spyOn(FocusService.prototype, "open").mockImplementation(async function (this: FocusService, dbId: string) {
			plugin.onunload();
			await new Promise((r) => setTimeout(r, 10));
			return focusOpen.call(this, dbId);
		});
		fake.layoutReady();
		await plugin.ready();
		await new Promise((r) => setTimeout(r, 20));
		expect(plugin.session).toBeNull();
		expect(shown).toEqual([]);
	});
});
