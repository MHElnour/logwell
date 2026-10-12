import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../../src/app/events";
import type { FocusEvents } from "../../src/app/FocusService";
import { type ActiveTimer, startSet } from "../../src/domain/focus";
import { FocusHost, type FocusHostUi, type FocusLike, formatStatus, statusLabel } from "../../src/obsidian/focusHost";
import { LocalStorageActiveTimer } from "../../src/obsidian/activeTimer";

describe("focus host", () => {
	const NOW = "2026-10-04T10:00:00.000Z";
	const config = { rounds: 4, focusSec: 1500, breakSec: 300, longBreakSec: 900 };
	const base = (task: { id: string; title: string } | null = { id: "t-a", title: "Write report" }): ActiveTimer =>
		startSet(config, task, NOW, () => "s-1").timer!;
	/** 18 minutes 42 seconds left of a 25 minute focus. */
	const NOW_1842 = "2026-10-04T10:06:18.000Z";

	interface Harness {
		host: FocusHost;
		focus: FocusLike & { bus: EventBus<FocusEvents>; current: ActiveTimer | null; calls: string[] };
		ui: { [K in keyof FocusHostUi]: ReturnType<typeof vi.fn> };
		sound: { play: ReturnType<typeof vi.fn>; unlock: ReturnType<typeof vi.fn> };
	}

	function harness(now = NOW_1842): Harness {
		const calls: string[] = [];
		const focus = {
			bus: new EventBus<FocusEvents>(),
			current: null as ActiveTimer | null,
			calls,
			timer() {
				return this.current;
			},
			start: vi.fn(async () => ({ kind: "started" }) as const),
			split: vi.fn(async (id: string | null) => void calls.push(`split:${id}`)),
			reassign: vi.fn(async (id: string | null) => void calls.push(`reassign:${id}`)),
			resolveRecovery: vi.fn(async (c: string) => {
				calls.push(`recovery:${c}`);
				return true;
			}),
			undoShortDiscard: vi.fn(async (_id: string) => true),
			restoreDiscardedTimer: vi.fn(async () => true),
		};
		const ui = {
			notify: vi.fn(),
			actionNotice: vi.fn(),
			systemNotify: vi.fn(),
			requestNotifyPermission: vi.fn(),
			choose: vi.fn(async () => null),
			openFocusPage: vi.fn(async () => undefined),
			setStatus: vi.fn(),
			error: vi.fn(),
		};
		const sound = { play: vi.fn(), unlock: vi.fn() };
		const host = new FocusHost(ui, sound, () => now);
		return { host, focus: focus, ui, sound };
	}

	const config2 = config;

	describe("formatStatus", () => {
		it("reads Round r/N with the task while a focus runs", () => {
			expect(formatStatus(base(), NOW_1842)).toBe("◎ 18:42 · Round 1/4 · Write report");
		});
		it("cuts a long task title so the status bar stays on one line", () => {
			const t = { ...base(), taskTitleSnapshot: "Write chapter 3 of the thesis on distributed systems and consensus" };
			expect(formatStatus(t, NOW_1842)).toBe("◎ 18:42 · Round 1/4 · Write chapter 3 of the thesis…");
		});
		it("shows the paused state", () => {
			expect(formatStatus({ ...base(), state: "paused" }, NOW_1842)).toBe("◎ 18:42 (paused) · Round 1/4 · Write report");
		});
		it("omits the task when there is none", () => {
			expect(formatStatus(base(null), NOW_1842)).toBe("◎ 18:42 · Round 1/4");
		});
		it("names the break", () => {
			const t = { ...base(), phase: "short-break" as const, sessionId: null, plannedSec: 300, startedAt: NOW, round: 2 };
			expect(formatStatus(t, "2026-10-04T10:01:00.000Z")).toBe("◎ 4:00 · Short break · Round 2/4 · Write report");
		});
		it("flags a pending recovery prompt", () => {
			expect(formatStatus({ ...base(), state: "paused", needsRecovery: true }, NOW_1842)).toBe(
				"◎ 18:42 (paused) · Round 1/4 · Write report · Needs your answer",
			);
		});
	});

	describe("statusLabel (the status-bar aria-label)", () => {
		it("names the time left, or the time a paused round stopped at", () => {
			expect(statusLabel(base(), NOW_1842)).toBe("Open focus, 18:42 left");
			expect(statusLabel({ ...base(), state: "paused" }, NOW_1842)).toBe("Open focus, paused at 18:42");
		});
	});

	describe("status bar", () => {
		it("follows the focus event and hides when no timer exists", () => {
			const h = harness();
			h.host.attach(h.focus, "none");
			expect(h.ui.setStatus).toHaveBeenLastCalledWith(null);
			h.focus.current = base();
			h.focus.bus.emit("focus", undefined);
			expect(h.ui.setStatus).toHaveBeenLastCalledWith("◎ 18:42 · Round 1/4 · Write report", "Open focus, 18:42 left");
			h.focus.current = null;
			h.focus.bus.emit("focus", undefined);
			expect(h.ui.setStatus).toHaveBeenLastCalledWith(null);
		});

		it("click opens the Focus page", async () => {
			const h = harness();
			h.focus.current = base();
			h.host.attach(h.focus, "restored");
			await h.host.statusClick();
			expect(h.ui.openFocusPage).toHaveBeenCalledTimes(1);
		});

		it("detach stops listening and clears the bar", () => {
			const h = harness();
			h.host.attach(h.focus, "none");
			h.host.detach();
			expect(h.ui.setStatus).toHaveBeenLastCalledWith(null);
			h.ui.setStatus.mockClear();
			h.focus.bus.emit("focus", undefined);
			expect(h.ui.setStatus).not.toHaveBeenCalled();
		});
	});

	describe("starting focus (B34, B35)", () => {
		it("a free timer starts and opens the Focus page", async () => {
			const h = harness();
			h.host.attach(h.focus, "none");
			await h.host.start("t-a", config2, "Write report");
			expect(h.focus.start).toHaveBeenCalledWith(config2, "t-a");
			expect(h.ui.openFocusPage).toHaveBeenCalledTimes(1);
		});

		it("the same task (or none) while running: notice with Go to running timer, no prompt", async () => {
			const h = harness();
			h.focus.current = base();
			(h.focus.start as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: "busy", sameTask: true });
			h.host.attach(h.focus, "restored");
			await h.host.start("t-a", config2, "Write report");
			expect(h.ui.choose).not.toHaveBeenCalled();
			expect(h.ui.openFocusPage).not.toHaveBeenCalled();
			const [message, actions] = h.ui.actionNotice.mock.calls[0] as [string, { label: string; run: () => unknown }[]];
			expect(message).toBe("A focus timer is running");
			expect(actions.map((a) => a.label)).toEqual(["Go to running timer"]);
			await actions[0]!.run();
			expect(h.ui.openFocusPage).toHaveBeenCalledTimes(1);
		});

		describe("another task during a focus round", () => {
			const busy = (h: Harness) => {
				h.focus.current = base();
				(h.focus.start as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: "busy", sameTask: false });
				h.host.attach(h.focus, "restored");
			};

			it("offers Split, Reassign and Cancel", async () => {
				const h = harness();
				busy(h);
				await h.host.start("t-b", config2, "Other");
				const buttons = (h.ui.choose.mock.calls[0] as unknown[])[2] as { label: string; value: string }[];
				expect(buttons.map((b) => b.label)).toEqual(["Split", "Reassign"]);
				expect((h.ui.choose.mock.calls[0] as unknown[])[3]).toBe("Cancel");
			});

			it("Split splits and opens the page", async () => {
				const h = harness();
				busy(h);
				h.ui.choose.mockResolvedValue("split");
				await h.host.start("t-b", config2, "Other");
				expect(h.focus.calls).toEqual(["split:t-b"]);
				expect(h.ui.openFocusPage).toHaveBeenCalledTimes(1);
			});

			it("Reassign reassigns and opens the page", async () => {
				const h = harness();
				busy(h);
				h.ui.choose.mockResolvedValue("reassign");
				await h.host.start("t-b", config2, "Other");
				expect(h.focus.calls).toEqual(["reassign:t-b"]);
				expect(h.ui.openFocusPage).toHaveBeenCalledTimes(1);
			});

			it("Cancel changes nothing", async () => {
				const h = harness();
				busy(h);
				h.ui.choose.mockResolvedValue(null);
				await h.host.start("t-b", config2, "Other");
				expect(h.focus.calls).toEqual([]);
				expect(h.ui.openFocusPage).not.toHaveBeenCalled();
			});

			it("a failing split is reported, not thrown", async () => {
				const h = harness();
				busy(h);
				h.ui.choose.mockResolvedValue("split");
				(h.focus.split as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("There is no focus round to split."));
				await expect(h.host.start("t-b", config2, "Other")).resolves.toBeUndefined();
				expect(h.ui.error).toHaveBeenCalledTimes(1);
			});
		});

		it("no task during a focus round of a task offers Split and Reassign too (B2, B9)", async () => {
			const h = harness();
			h.focus.current = base();
			(h.focus.start as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: "busy", sameTask: true });
			h.host.attach(h.focus, "restored");
			h.ui.choose.mockResolvedValue("split");
			await h.host.start(null, config2, "");
			expect(h.ui.choose).toHaveBeenCalledTimes(1);
			expect(h.ui.actionNotice).not.toHaveBeenCalled();
			expect(h.focus.calls).toEqual(["split:null"]);
			h.ui.choose.mockResolvedValue("reassign");
			await h.host.start(null, config2, "");
			expect(h.focus.calls).toEqual(["split:null", "reassign:null"]);
		});

		it("no task while a no-task round runs is the running-timer notice (B34)", async () => {
			const h = harness();
			h.focus.current = base(null);
			(h.focus.start as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: "busy", sameTask: true });
			h.host.attach(h.focus, "restored");
			await h.host.start(null, config2, "");
			expect(h.ui.choose).not.toHaveBeenCalled();
			expect(h.ui.actionNotice.mock.calls[0]![0]).toBe("A focus timer is running");
		});

		it("another task during a break reassigns without a prompt", async () => {
			const h = harness();
			h.focus.current = { ...base(), phase: "short-break", sessionId: null };
			(h.focus.start as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: "busy", sameTask: false });
			h.host.attach(h.focus, "restored");
			await h.host.start("t-b", config2, "Other");
			expect(h.ui.choose).not.toHaveBeenCalled();
			expect(h.focus.calls).toEqual(["reassign:t-b"]);
			expect(h.ui.openFocusPage).toHaveBeenCalledTimes(1);
		});

		it("another task while a recovery prompt is pending asks the recovery question first", async () => {
			const h = harness();
			h.focus.current = { ...base(), state: "paused", needsRecovery: true };
			(h.focus.start as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: "busy", sameTask: false });
			h.host.attach(h.focus, "restored");
			await h.host.start("t-b", config2, "Other");
			const buttons = (h.ui.choose.mock.calls[0] as unknown[])[2] as { label: string }[];
			expect(buttons.map((b) => b.label)).toEqual(["Resume", "Finish", "Discard"]);
			expect(h.focus.split).not.toHaveBeenCalled();
		});
	});

	describe("recovery prompt (B31, D5)", () => {
		const recovering = (h: Harness) => {
			h.focus.current = { ...base(), state: "paused", needsRecovery: true };
		};

		it("opens after open() returns recovery, with Resume, Finish and Discard (warning)", async () => {
			const h = harness();
			recovering(h);
			h.host.attach(h.focus, "recovery");
			await vi.waitFor(() => expect(h.ui.choose).toHaveBeenCalledTimes(1));
			const call = h.ui.choose.mock.calls[0] as unknown[];
			const buttons = call[2] as { label: string; value: string; warning?: boolean; cta?: boolean }[];
			expect(buttons.map((b) => [b.label, b.value, b.warning === true])).toEqual([
				["Resume", "resume", false],
				["Finish", "finish", false],
				["Discard", "discard", true],
			]);
			expect(call[3]).toBe("Decide later");
		});

		it("applies the choice", async () => {
			for (const choice of ["resume", "finish"] as const) {
				const h = harness();
				recovering(h);
				h.ui.choose.mockResolvedValue(choice);
				h.host.attach(h.focus, "recovery");
				await vi.waitFor(() => expect(h.focus.calls).toEqual([`recovery:${choice}`]));
				expect(h.ui.actionNotice).not.toHaveBeenCalled();
			}
		});

		it("Discard offers an Undo that restores the timer", async () => {
			const h = harness();
			recovering(h);
			h.ui.choose.mockResolvedValue("discard");
			h.host.attach(h.focus, "recovery");
			await vi.waitFor(() => expect(h.ui.actionNotice).toHaveBeenCalledTimes(1));
			expect(h.focus.calls).toEqual(["recovery:discard"]);
			const [, actions] = h.ui.actionNotice.mock.calls[0] as [string, { label: string; run: () => unknown }[]];
			expect(actions.map((a) => a.label)).toEqual(["Undo"]);
			await actions[0]!.run();
			expect(h.focus.restoreDiscardedTimer).toHaveBeenCalledTimes(1);
		});

		it("Discard shows no Undo when nothing was discarded, and says so when the Undo finds nothing (B4)", async () => {
			const h = harness();
			recovering(h);
			h.ui.choose.mockResolvedValue("discard");
			(h.focus.resolveRecovery as ReturnType<typeof vi.fn>).mockResolvedValue(false);
			h.host.attach(h.focus, "recovery");
			await vi.waitFor(() => expect(h.focus.resolveRecovery).toHaveBeenCalledTimes(1));
			await new Promise((r) => setTimeout(r, 0));
			expect(h.ui.actionNotice).not.toHaveBeenCalled();

			const h2 = harness();
			recovering(h2);
			h2.ui.choose.mockResolvedValue("discard");
			(h2.focus.restoreDiscardedTimer as ReturnType<typeof vi.fn>).mockResolvedValue(false);
			h2.host.attach(h2.focus, "recovery");
			await vi.waitFor(() => expect(h2.ui.actionNotice).toHaveBeenCalledTimes(1));
			const [, actions] = h2.ui.actionNotice.mock.calls[0] as [string, { run: () => unknown }[]];
			await actions[0]!.run();
			expect(h2.ui.notify).toHaveBeenCalledWith("Nothing to undo.");
		});

		it("closes the open prompt when the question was answered elsewhere (B4)", async () => {
			const h = harness();
			recovering(h);
			h.ui.choose.mockImplementation((async (...args: unknown[]) => {
				const signal = args[4] as AbortSignal;
				return new Promise((resolve) => signal.addEventListener("abort", () => resolve(null)));
			}) as never);
			h.host.attach(h.focus, "recovery");
			await vi.waitFor(() => expect(h.ui.choose).toHaveBeenCalledTimes(1));
			const signal = (h.ui.choose.mock.calls[0] as unknown[])[4] as AbortSignal;
			expect(signal.aborted).toBe(false);
			h.focus.bus.emit("focus", undefined);
			expect(signal.aborted).toBe(false);
			h.focus.current = { ...base(), state: "running", needsRecovery: false };
			h.focus.bus.emit("focus", undefined);
			expect(signal.aborted).toBe(true);
			await new Promise((r) => setTimeout(r, 0));
			expect(h.focus.calls).toEqual([]);
			expect(h.ui.actionNotice).not.toHaveBeenCalled();
		});

		it("dismissing leaves the timer pending and the status bar click asks again", async () => {
			const h = harness();
			recovering(h);
			h.ui.choose.mockResolvedValue(null);
			h.host.attach(h.focus, "recovery");
			await vi.waitFor(() => expect(h.ui.choose).toHaveBeenCalledTimes(1));
			await new Promise((r) => setTimeout(r, 0));
			expect(h.focus.calls).toEqual([]);
			h.ui.choose.mockResolvedValue("resume");
			await h.host.statusClick();
			expect(h.ui.choose).toHaveBeenCalledTimes(2);
			expect(h.focus.calls).toEqual(["recovery:resume"]);
		});

		it("a second recovery event while the prompt is open does not stack a second prompt", async () => {
			const h = harness();
			recovering(h);
			let release: (v: string | null) => void = () => undefined;
			const pending = new Promise<string | null>((r) => {
				release = r;
			});
			h.ui.choose.mockReturnValue(pending);
			h.host.attach(h.focus, "recovery");
			await vi.waitFor(() => expect(h.ui.choose).toHaveBeenCalledTimes(1));
			h.focus.bus.emit("recovery-needed", undefined);
			expect(h.ui.choose).toHaveBeenCalledTimes(1);
			release(null);
		});

		it("a recovery event during a run (B32) opens the prompt", async () => {
			const h = harness();
			h.host.attach(h.focus, "none");
			recovering(h);
			h.focus.bus.emit("recovery-needed", undefined);
			await vi.waitFor(() => expect(h.ui.choose).toHaveBeenCalledTimes(1));
		});
	});

	describe("open results and notices", () => {
		it("already-saved tells the user the round was saved and the set ended (D4)", () => {
			const h = harness();
			h.host.attach(h.focus, "already-saved");
			expect(h.ui.notify).toHaveBeenCalledTimes(1);
			expect(h.ui.notify.mock.calls[0]![0]).toMatch(/already saved/i);
		});

		it("restored and none are silent", () => {
			for (const r of ["restored", "none"] as const) {
				const h = harness();
				h.host.attach(h.focus, r);
				expect(h.ui.notify).not.toHaveBeenCalled();
				expect(h.ui.actionNotice).not.toHaveBeenCalled();
			}
		});

		it("a short discard offers Undo, which saves it (D7)", async () => {
			const h = harness();
			h.host.attach(h.focus, "none");
			h.focus.bus.emit("short-discarded", { sessionId: "s-1" });
			h.focus.bus.emit("short-discarded", { sessionId: "s-2" });
			const [message, actions] = h.ui.actionNotice.mock.calls[0] as [string, { label: string; run: () => unknown }[]];
			expect(message).toBe("Focus under a minute was not saved");
			expect(actions.map((a) => a.label)).toEqual(["Undo"]);
			await actions[0]!.run();
			expect(h.focus.undoShortDiscard).toHaveBeenCalledWith("s-1");
			expect(h.ui.notify).not.toHaveBeenCalled();
			(h.focus.undoShortDiscard as ReturnType<typeof vi.fn>).mockResolvedValue(false);
			const second = h.ui.actionNotice.mock.calls[1]![1] as { run: () => unknown }[];
			await second[0]!.run();
			expect(h.focus.undoShortDiscard).toHaveBeenLastCalledWith("s-2");
			expect(h.ui.notify).toHaveBeenCalledWith("Nothing to undo.");
		});
	});

	describe("user gesture", () => {
		it("starting a set from a command or task unlocks the sound and asks for notification permission", async () => {
			const h = harness();
			h.host.attach(h.focus, "none");
			await h.host.start(null, config, "");
			expect(h.sound.unlock).toHaveBeenCalledTimes(1);
			expect(h.ui.requestNotifyPermission).toHaveBeenCalledTimes(1);
		});

		it("the Focus page Start button uses the same gesture hook", () => {
			const h = harness();
			h.host.attach(h.focus, "none");
			h.host.gesture();
			expect(h.sound.unlock).toHaveBeenCalledTimes(1);
			expect(h.ui.requestNotifyPermission).toHaveBeenCalledTimes(1);
		});

		it("a timer-driven moment never asks", () => {
			const h = harness();
			h.focus.current = { ...base(), phase: "short-break", sessionId: null };
			h.host.attach(h.focus, "none");
			h.focus.bus.emit("moment", "break-start");
			expect(h.ui.requestNotifyPermission).not.toHaveBeenCalled();
			expect(h.sound.unlock).not.toHaveBeenCalled();
		});
	});

	describe("moments (B36, D14)", () => {
		it("every moment plays its sound", () => {
			const h = harness();
			h.host.attach(h.focus, "none");
			for (const m of ["focus-start", "break-start", "set-done"] as const) h.focus.bus.emit("moment", m);
			expect(h.sound.play.mock.calls.map((c: unknown[]) => c[0])).toEqual(["focus-start", "break-start", "set-done"]);
		});

		it("the end of a focus shows a notice and a system notification", () => {
			const h = harness();
			h.focus.current = { ...base(), phase: "short-break", sessionId: null };
			h.host.attach(h.focus, "none");
			h.focus.bus.emit("moment", "break-start");
			expect(h.ui.notify).toHaveBeenCalledTimes(1);
			expect(h.ui.systemNotify).toHaveBeenCalledTimes(1);
		});

		it("the start of a focus is only a sound", () => {
			const h = harness();
			h.focus.current = base();
			h.host.attach(h.focus, "none");
			h.focus.bus.emit("moment", "focus-start");
			expect(h.ui.notify).not.toHaveBeenCalled();
			expect(h.ui.systemNotify).not.toHaveBeenCalled();
		});

		it("set done shows the summary in a notice and a system notification", () => {
			const h = harness();
			h.host.attach(h.focus, "none");
			h.focus.bus.emit("set-done", { rounds: 4, focusedSec: 7200 });
			expect(h.ui.notify.mock.calls[0]![0]).toBe("Focus set done: 4 rounds · 2h focused");
			expect(h.ui.systemNotify).toHaveBeenCalledTimes(1);
			expect(h.ui.systemNotify).toHaveBeenCalledWith("Focus set done", "4 rounds · 2h focused.");
		});

		it("#18: set done rounds a short time to whole seconds and counts one round in the singular", () => {
			const h = harness();
			h.host.attach(h.focus, "none");
			h.focus.bus.emit("set-done", { rounds: 1, focusedSec: 40.5 });
			expect(h.ui.notify.mock.calls[0]![0]).toBe("Focus set done: 1 round · 41s focused");
		});
	});
});

describe("the active timer in local storage", () => {
	function fakeLocal() {
		const store = new Map<string, unknown>();
		return {
			store,
			app: {
				loadLocalStorage: (k: string) => store.get(k) ?? null,
				saveLocalStorage: (k: string, v: unknown) => void (v === null ? store.delete(k) : store.set(k, v)),
			},
		};
	}

	const config = { rounds: 4, focusSec: 1500, breakSec: 300, longBreakSec: 900 };
	const timer = () => startSet(config, null, "2026-10-04T10:00:00.000Z", () => "s-1").timer!;

	describe("LocalStorageActiveTimer (D11)", () => {
		it("stores the timer under logwell-active-timer-<dbId> and reads it back", () => {
			const f = fakeLocal();
			const port = new LocalStorageActiveTimer(f.app as never);
			port.save("db-1", timer());
			expect([...f.store.keys()]).toEqual(["logwell-active-timer-db-1"]);
			expect(port.load("db-1")).toEqual(JSON.parse(JSON.stringify(timer())));
		});

		it("null clears the entry", () => {
			const f = fakeLocal();
			const port = new LocalStorageActiveTimer(f.app as never);
			port.save("db-1", timer());
			port.save("db-1", null);
			expect(f.store.size).toBe(0);
			expect(port.load("db-1")).toBeNull();
		});

		it("is per database", () => {
			const f = fakeLocal();
			const port = new LocalStorageActiveTimer(f.app as never);
			port.save("db-1", timer());
			expect(port.load("db-2")).toBeNull();
		});

		it("drops bad JSON with a console warning and no throw", () => {
			const f = fakeLocal();
			f.store.set("logwell-active-timer-db-1", "{not json");
			const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
			expect(new LocalStorageActiveTimer(f.app as never).load("db-1")).toBeNull();
			expect(warn).toHaveBeenCalledTimes(1);
			warn.mockRestore();
		});

		it("drops a value with a wrong version with a console warning", () => {
			const f = fakeLocal();
			f.store.set("logwell-active-timer-db-1", { ...timer(), v: 2 });
			const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
			expect(new LocalStorageActiveTimer(f.app as never).load("db-1")).toBeNull();
			expect(warn).toHaveBeenCalledTimes(1);
			warn.mockRestore();
		});

		it("drops a value that is not an object", () => {
			const f = fakeLocal();
			f.store.set("logwell-active-timer-db-1", 42);
			const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
			expect(new LocalStorageActiveTimer(f.app as never).load("db-1")).toBeNull();
			warn.mockRestore();
		});

		it("a throwing localStorage does not throw", () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
			const port = new LocalStorageActiveTimer({
				loadLocalStorage: () => {
					throw new Error("denied");
				},
				saveLocalStorage: () => {
					throw new Error("full");
				},
			} as never);
			expect(port.load("db-1")).toBeNull();
			expect(() => port.save("db-1", timer())).not.toThrow();
			warn.mockRestore();
		});
	});
});
