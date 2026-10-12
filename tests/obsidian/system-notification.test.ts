import { afterEach, describe, expect, it, vi } from "vitest";
import { type NotificationApiLike, SystemNotifier, appHasFocus } from "../../src/obsidian/systemNotification";

function setup(permission: string, focused = false) {
	const api = {
		permission,
		requestPermission: vi.fn(async () => {
			api.permission = "granted";
			return "granted";
		}),
		create: vi.fn(),
	};
	const env = { api: api as NotificationApiLike, hasFocus: () => focused };
	return { api, notifier: new SystemNotifier(() => env), env };
}

describe("SystemNotifier", () => {
	it("notify never asks for permission", () => {
		const { api, notifier } = setup("default");
		notifier.notify("a", "b");
		expect(api.requestPermission).not.toHaveBeenCalled();
		expect(api.create).not.toHaveBeenCalled();
	});

	it("asks once on a gesture while the permission is undecided", () => {
		const { api, notifier } = setup("default");
		notifier.requestPermission();
		notifier.requestPermission();
		expect(api.requestPermission).toHaveBeenCalledTimes(1);
	});

	it("does not ask again when the user dismissed the prompt (still default)", () => {
		const { api, notifier } = setup("default");
		api.requestPermission.mockImplementation(async () => "default");
		notifier.requestPermission();
		notifier.requestPermission();
		expect(api.requestPermission).toHaveBeenCalledTimes(1);
	});

	it("does not ask once granted or denied", () => {
		for (const p of ["granted", "denied"]) {
			const { api, notifier } = setup(p);
			notifier.requestPermission();
			expect(api.requestPermission).not.toHaveBeenCalled();
		}
	});

	it("shows the notification when granted and the window is in the background", () => {
		const { api, notifier } = setup("granted", false);
		notifier.notify("Focus done", "Time for a break.");
		expect(api.create).toHaveBeenCalledWith("Focus done", "Time for a break.");
	});

	it("skips it while the window has focus, or when denied", () => {
		const focused = setup("granted", true);
		focused.notifier.notify("a", "b");
		expect(focused.api.create).not.toHaveBeenCalled();
		const denied = setup("denied", false);
		denied.notifier.notify("a", "b");
		expect(denied.api.create).not.toHaveBeenCalled();
	});

	it("is a no-op where the platform has no notifications", () => {
		const notifier = new SystemNotifier(() => ({ api: null, hasFocus: () => false }));
		expect(() => {
			notifier.requestPermission();
			notifier.notify("a", "b");
		}).not.toThrow();
	});
});

describe("appHasFocus", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("asks the active document, so a focused popout window counts as in front", () => {
		vi.stubGlobal("document", { hasFocus: () => false });
		vi.stubGlobal("activeDocument", { hasFocus: () => true });
		expect(appHasFocus()).toBe(true);
	});

	it("falls back to document where activeDocument is not defined", () => {
		vi.stubGlobal("document", { hasFocus: () => true });
		vi.stubGlobal("activeDocument", undefined);
		expect(appHasFocus()).toBe(true);
	});
});
