import type { FocusService, OpenResult } from "../app/FocusService";
import { type ActiveTimer, type FocusMoment, type FocusSetConfig, remainingSec } from "../domain/focus";
import type { Instant } from "../domain/types";
import { PHASE_LABEL, clockText, roundText, summaryText } from "../ui/focus/format";
import type { ButtonSpec } from "../ui/host";
import type { NoticeAction } from "./notices";

// The Obsidian side of a running focus set. Reacts to the FocusService bus (notices, sound,
// status bar, prompts). The 1 s heartbeat itself is a plugin interval in main.ts.

/** The slice of FocusService this host uses, so tests can fake it. */
export type FocusLike = Pick<
	FocusService,
	"bus" | "timer" | "start" | "split" | "reassign" | "resolveRecovery" | "undoShortDiscard" | "restoreDiscardedTimer"
>;

export interface FocusHostUi {
	notify(message: string): void;
	actionNotice(message: string, actions: NoticeAction[]): void;
	/** An Undo notice for `undo` (`boundUndoNotice`); it says so when `undo` resolves false. */
	notifyUndo(message: string, undo: () => Promise<boolean>): void;
	/** A desktop notification; a no-op where the platform has none. */
	systemNotify(title: string, body: string): void;
	/** Asks for the system notification permission; only called from a user gesture. */
	requestNotifyPermission(): void;
	choose<T>(title: string, message: string, buttons: ButtonSpec<T>[], cancelLabel?: string, signal?: AbortSignal): Promise<T | null>;
	openFocusPage(): Promise<void>;
	/** null hides the status-bar item. `label` is its accessible name. */
	setStatus(text: string | null, label?: string): void;
	error(err: unknown): void;
}

/** The status-bar text: "◎ 18:42 · Round 2 of 4 · Task title". */
export function formatStatus(t: ActiveTimer, now: Instant): string {
	const parts = [`◎ ${clockText(remainingSec(t, now))}${t.state === "paused" ? " (paused)" : ""}`];
	const round = roundText(t.round, t.config.rounds);
	if (t.phase === "focus") parts.push(round);
	else parts.push(PHASE_LABEL[t.phase], round);
	if (t.taskTitleSnapshot !== "") parts.push(shortTitle(t.taskTitleSnapshot));
	if (t.needsRecovery) parts.push("Needs your answer");
	return parts.join(" · ");
}

/** Long titles are cut so the status bar stays on one line (it wraps at narrow widths). */
const STATUS_TITLE_MAX = 32;
function shortTitle(title: string): string {
	if (title.length <= STATUS_TITLE_MAX) return title;
	const cut = title.slice(0, STATUS_TITLE_MAX - 1);
	// Prefer a word boundary when one is not too far back.
	const space = cut.lastIndexOf(" ");
	return `${(space > STATUS_TITLE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The accessible name of the status-bar item: the time as the text shows it, in words. */
export function statusLabel(t: ActiveTimer, now: Instant): string {
	const time = clockText(remainingSec(t, now));
	return t.state === "paused" ? `Open focus, paused at ${time}` : `Open focus, ${time} left`;
}

type RecoveryChoice = "resume" | "finish" | "discard";

export class FocusHost {
	private focus: FocusLike | null = null;
	private off: (() => void)[] = [];
	private prompting = false;
	/** Aborts the open recovery prompt when the question is answered elsewhere. */
	private promptAbort: AbortController | null = null;

	constructor(
		private readonly ui: FocusHostUi,
		private readonly sound: { play(moment: FocusMoment): void; unlock(): void },
		private readonly now: () => Instant,
	) {}

	/** Starts reacting to a session's focus service. `opened` is what `focus.open` returned. */
	attach(focus: FocusLike, opened: OpenResult): void {
		this.detach();
		this.focus = focus;
		this.off = [
			focus.bus.on("focus", () => {
				this.updateStatus();
				if (this.promptAbort !== null && focus.timer()?.needsRecovery !== true) this.promptAbort.abort();
			}),
			focus.bus.on("moment", (m) => this.onMoment(m)),
			focus.bus.on("set-done", (s) => this.onSetDone(s)),
			focus.bus.on("recovery-needed", () => void this.promptRecovery()),
			focus.bus.on("short-discarded", (e) => this.onShortDiscarded(e.sessionId)),
		];
		this.updateStatus();
		if (opened === "already-saved") {
			this.ui.notify("The focus round was already saved before Obsidian closed. The focus set ended.");
		} else if (opened === "recovery") {
			void this.promptRecovery();
		}
	}

	detach(): void {
		for (const off of this.off.splice(0)) off();
		this.promptAbort?.abort();
		this.focus = null;
		this.prompting = false;
		this.ui.setStatus(null);
	}

	/** Status-bar click and the "Open focus" command. A pending recovery prompt is asked again (it can be dismissed). */
	async statusClick(): Promise<void> {
		await this.ui.openFocusPage();
		if (this.focus?.timer()?.needsRecovery === true) await this.promptRecovery();
	}

	/**
	 * The user gesture that starts a set (the Focus page Start button, a command, a task action): unlocks the sound
	 * for the timer-driven moments later and asks once for the notification permission.
	 */
	gesture(): void {
		this.sound.unlock();
		this.ui.requestNotifyPermission();
	}

	/** Starts focus on a task, then shows the Focus page. */
	async start(taskId: string | null, config: FocusSetConfig, taskTitle: string): Promise<void> {
		const focus = this.focus;
		if (focus === null) return;
		this.gesture();
		try {
			const result = await focus.start(config, taskId);
			if (result.kind === "started") {
				await this.ui.openFocusPage();
				return;
			}
			const running = focus.timer();
			if (running === null) return;
			if (taskId === running.taskId) {
				// The task that already runs (or no task while a no-task round runs).
				this.ui.actionNotice("A focus timer is running", [
					{ label: "Go to running timer", run: () => this.statusClick() },
				]);
				return;
			}
			if (running.needsRecovery) {
				await this.promptRecovery();
				return;
			}
			if (running.phase !== "focus") {
				// A break: the task only becomes the "Focus on" task of the next round.
				await focus.reassign(taskId);
				await this.ui.openFocusPage();
				return;
			}
			const from = running.taskTitleSnapshot === "" ? "no task" : `“${running.taskTitleSnapshot}”`;
			const to = taskId === null ? "no task" : `“${taskTitle}”`;
			const choice = await this.ui.choose<"split" | "reassign">(
				"Change the focus task",
				`A focus round is running on ${from}. Focus on ${to} instead? Split saves the time so far on ${from} and continues on ${to}. Reassign moves the whole round to ${to}.`,
				[
					{ label: "Split", value: "split", cta: true },
					{ label: "Reassign", value: "reassign" },
				],
				"Cancel",
			);
			if (choice === null) return;
			if (choice === "split") await focus.split(taskId);
			else await focus.reassign(taskId);
			await this.ui.openFocusPage();
		} catch (err) {
			this.ui.error(err);
		}
	}

	// ---------------------------------------------------------------------

	private updateStatus(): void {
		const t = this.focus?.timer() ?? null;
		const now = this.now();
		if (t === null) this.ui.setStatus(null);
		else this.ui.setStatus(formatStatus(t, now), statusLabel(t, now));
	}

	private onMoment(moment: FocusMoment): void {
		this.sound.play(moment);
		if (moment === "break-start") {
			this.ui.notify("Focus done. Time for a break.");
			this.ui.systemNotify("Focus done", "Time for a break.");
		}
	}

	private onSetDone(summary: { rounds: number; focusedSec: number }): void {
		const text = summaryText(summary.rounds, summary.focusedSec);
		this.ui.notify(`Focus set done: ${text}`);
		this.ui.systemNotify("Focus set done", `${text}.`);
	}

	private onShortDiscarded(sessionId: string): void {
		const focus = this.focus;
		this.ui.notifyUndo("Focus under a minute was not saved", async () => (await focus?.undoShortDiscard(sessionId)) ?? false);
	}

	/** The recovery prompt. Dismissing it (Escape or "Decide later") leaves the timer paused with the prompt pending. */
	async promptRecovery(): Promise<void> {
		const focus = this.focus;
		if (focus === null || this.prompting) return;
		this.prompting = true;
		const abort = new AbortController();
		this.promptAbort = abort;
		try {
			const choice = await this.ui.choose<RecoveryChoice>(
				"Focus timer was interrupted",
				"Obsidian was closed or the computer slept while a focus timer was running. The time in between is not counted unless you include it later in the focus history. What should happen to the timer?",
				[
					{ label: "Resume", value: "resume", cta: true },
					{ label: "Finish", value: "finish" },
					{ label: "Discard", value: "discard", warning: true },
				],
				"Decide later",
				abort.signal,
			);
			// Answered: an abort from here on would only close a dialog that is already gone.
			if (this.promptAbort === abort) this.promptAbort = null;
			if (choice === null || this.focus !== focus) return;
			const applied = await focus.resolveRecovery(choice);
			if (choice === "discard" && applied) {
				this.ui.notifyUndo("Focus timer discarded", () => focus.restoreDiscardedTimer());
			}
		} catch (err) {
			this.ui.error(err);
		} finally {
			this.prompting = false;
			if (this.promptAbort === abort) this.promptAbort = null;
		}
	}
}
