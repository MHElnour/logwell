import type { TaskView } from "../app/views";
import type { ID } from "../domain/types";
import type { AppRootHandle } from "./AppRoot";
import type { SectionId } from "./host";

type Section = SectionId | "today";

/**
 * Carries a "show this section" request to the app root (the `open-calendar` and `open-search`
 * commands). `AppRoot` registers its handle in an effect, after the first paint, so a request made
 * while the view is still mounting has nobody to talk to yet: it is kept here and delivered the
 * moment the handle attaches. No timer, no retry. `pending` also seeds the first render, so the
 * section is right on the first paint when the request came before the mount.
 */
export class SectionRelay {
	private handle: AppRootHandle | null = null;
	private queued: Section | null = null;
	private queuedHabit: { id: string; focusControl: boolean } | null = null;
	private queuedTasks: { view: TaskView; selectedId: ID | null } | null = null;

	/** The section a first render should start on, if a request is waiting. */
	get pending(): Section | null {
		if (this.queuedTasks !== null) return "tasks";
		return this.queuedHabit !== null ? "habits" : this.queued;
	}

	show(section: Section): void {
		if (this.handle === null) {
			// A later section request wins over an earlier queued habit or task view; callers that want both call show() first.
			this.queued = section;
			this.queuedHabit = null;
			this.queuedTasks = null;
		} else this.handle.showSection(section);
	}

	/** Shows a Tasks view with a task selected (a dashboard block's row or button); queued like a section until the handle attaches. */
	showTasks(view: TaskView, selectedId: ID | null): void {
		if (this.handle === null) {
			this.queuedTasks = { view, selectedId };
			this.queued = null;
			this.queuedHabit = null;
		} else this.handle.showTasks(view, selectedId);
	}

	/** Selects a habit on the Habits page (a reminder's Check in); queued like a section until the handle attaches. */
	showHabit(id: string, focusControl = false): void {
		if (this.handle === null) {
			this.queuedHabit = { id, focusControl };
			this.queuedTasks = null;
		}
		else this.handle.showHabit(id, focusControl);
	}

	/** The task selected in the section on screen; null when nothing is selected or no app root is attached. */
	selectedTaskId(): string | null {
		return this.handle?.selectedTaskId() ?? null;
	}

	/** The app root's handle arrived (it re-registers on every render). */
	attach(handle: AppRootHandle): void {
		this.handle = handle;
		const waiting = this.queued;
		const habit = this.queuedHabit;
		const tasks = this.queuedTasks;
		this.queued = null;
		this.queuedHabit = null;
		this.queuedTasks = null;
		if (waiting !== null) handle.showSection(waiting);
		if (tasks !== null) handle.showTasks(tasks.view, tasks.selectedId);
		// After the section, so a waiting section never hides the selected habit.
		if (habit !== null) handle.showHabit(habit.id, habit.focusControl);
	}

	/** The app root went away: later requests wait for the next one. */
	detach(): void {
		this.handle = null;
	}
}
