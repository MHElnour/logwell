import { describe, expect, it, vi } from "vitest";
import type { WriteResult } from "../../src/app/writes";
import type { UiHost } from "../../src/ui/host";
import { runWrite } from "../../src/ui/writeNotice";

// Issue 43: one write runner for the habit and repeating-task writes: Undo notice only when something was
// written, errors to the host.

function fakeHost(mark = 7) {
	const notifyUndo = vi.fn();
	const error = vi.fn();
	const host = { app: { store: { undoMark: () => mark } }, notifyUndo, error } as unknown as UiHost;
	return { host, notifyUndo, error };
}

describe("runWrite", () => {
	it("shows a string message with the label of the write and the mark taken before it", async () => {
		const { host, notifyUndo } = fakeHost(7);
		const ok = await runWrite(host, async () => ({ wrote: true, label: "Edit habit" }), "Saved.");
		expect(ok).toBe(true);
		expect(notifyUndo).toHaveBeenCalledWith("Saved.", "Edit habit", 7);
	});

	it("builds the message from the result when given a function", async () => {
		const { host, notifyUndo } = fakeHost();
		const result: WriteResult = { wrote: true, label: "Complete task" };
		const message = vi.fn((r: WriteResult) => `Done under ${r.label}.`);
		await runWrite(host, async () => result, message);
		expect(message).toHaveBeenCalledWith(result);
		expect(notifyUndo).toHaveBeenCalledWith("Done under Complete task.", "Complete task", 7);
	});

	it("shows no notice when nothing was written, and still succeeds", async () => {
		const { host, notifyUndo } = fakeHost();
		const ok = await runWrite(host, async () => ({ wrote: false, label: "Edit habit" }), "Saved.");
		expect(ok).toBe(true);
		expect(notifyUndo).not.toHaveBeenCalled();
	});

	it("reports a failing write to the host and resolves false", async () => {
		const { host, notifyUndo, error } = fakeHost();
		const err = new Error("boom");
		const ok = await runWrite(host, () => Promise.reject(err), "Saved.");
		expect(ok).toBe(false);
		expect(error).toHaveBeenCalledWith(err);
		expect(notifyUndo).not.toHaveBeenCalled();
	});
});
