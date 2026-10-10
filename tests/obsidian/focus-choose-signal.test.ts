// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyDbText } from "../persistence/fixtures";
import { fakeApp, loadPlugin } from "./fake-vault";

// The plugin's FocusHostUi.choose must hand its AbortSignal to the real ChoiceModal, so the recovery dialog
// closes when the banner resolves the question. A mocked ui.choose cannot show that.

const modals = vi.hoisted(() => ({ opened: 0, closed: 0 }));
vi.mock("obsidian", async (importOriginal) => {
	const original = await importOriginal<Record<string, unknown>>();
	class FakeModal {
		contentEl = { createEl: () => ({}), empty: () => undefined };
		constructor(readonly app: unknown) {}
		setTitle(): void {}
		open(): void {
			modals.opened++;
			(this as unknown as { onOpen(): void }).onOpen();
		}
		close(): void {
			modals.closed++;
			(this as unknown as { onClose(): void }).onClose();
		}
	}
	class FakeSetting {
		constructor(readonly el: unknown) {}
		addButton(cb: (b: Record<string, () => unknown>) => void): this {
			const btn: Record<string, () => unknown> = {};
			for (const k of ["setButtonText", "setCta", "setDestructive", "onClick"]) btn[k] = () => btn;
			cb(btn);
			return this;
		}
	}
	return { ...original, Modal: FakeModal, Setting: FakeSetting };
});

afterEach(() => vi.restoreAllMocks());

describe("FocusHostUi.choose in the plugin (B4)", () => {
	it("aborting the signal closes the ChoiceModal once and resolves null", async () => {
		modals.opened = 0;
		modals.closed = 0;
		const fake = fakeApp();
		fake.files.set("A.cpbase", emptyDbText("db-a", "r-aaaaaaaaaaaa"));
		const plugin = await loadPlugin(fake, "A.cpbase");
		const ui = (plugin as unknown as { focusHost: { ui: { choose: (...a: unknown[]) => Promise<unknown> } } }).focusHost.ui;
		const abort = new AbortController();
		const result = ui.choose("Title", "Message", [{ label: "Resume", value: "resume" }], "Decide later", abort.signal);
		expect(modals.opened).toBe(1);
		abort.abort();
		await expect(result).resolves.toBeNull();
		expect(modals.closed).toBe(1);
		// A second abort-after-close must not close again.
		abort.abort();
		expect(modals.closed).toBe(1);
	});
});
