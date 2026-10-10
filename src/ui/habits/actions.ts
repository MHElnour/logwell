import { NEW_HABIT_LABEL, type WriteResult } from "../../app/HabitService";
import type { HabitInput } from "../../domain/habits";
import { type Habit, type ID, type TagColor, paletteColor } from "../../domain/types";
import type { HabitDialogOptions, UiHost } from "../host";
import { notifyWrite } from "../writeNotice";
import { currentVersion } from "./format";

// Writes of the Habits page, the Today block and the Today column. Every write goes through app.habits; the
// Undo notice carries the label the service wrote under and shows only when something was written.

/** Runs a write; errors go to the host. Resolves whether it succeeded (a no-op write counts as success). */
export async function runWrite(host: UiHost, write: () => Promise<WriteResult>, message: string): Promise<boolean> {
	try {
		const mark = host.app.store.undoMark();
		notifyWrite(host, await write(), message, mark);
		return true;
	} catch (err) {
		host.error(err);
		return false;
	}
}

export const checkedInText = (habit: Pick<Habit, "name">): string => `Checked in ${habit.name}.`;

/** What the dialog starts from when editing: the current rule and the in-place fields. */
function inputOf(habit: Habit, today: string): HabitInput {
	const v = currentVersion(habit, today);
	return {
		name: habit.name,
		icon: habit.icon,
		color: habit.color,
		timeOfDay: habit.timeOfDay,
		reminder: habit.reminder === null ? null : { time: habit.reminder.time },
		goal: { ...v.goal },
		schedule: v.schedule.kind === "weekdays" ? { kind: "weekdays", days: [...v.schedule.days] } : { kind: v.schedule.kind },
	};
}

/** The color a new habit starts with: the next one in the palette (the swatch row's "Default" is no color). */
function defaultHabitColor(host: UiHost): TagColor {
	return paletteColor(host.app.habits.list().length);
}

/**
 * The options of the New habit and Edit habit dialog. `save` resolves a message when the dialog should stay
 * open and null when the habit is saved. The Notification permission is asked here, in the click that saves a
 * habit with a reminder (only from a user gesture).
 */
export function habitDialogOptions(
	host: UiHost,
	args: { habit?: Habit; initial?: HabitInput | null; onSaved?: (id: ID) => void },
): HabitDialogOptions {
	const { habit } = args;
	const today = host.app.habits.today();
	return {
		title: habit === undefined ? "New habit" : "Edit habit",
		submit: habit === undefined ? "Create habit" : "Save",
		initial: habit === undefined ? (args.initial ?? null) : inputOf(habit, today),
		defaultColor: defaultHabitColor(host),
		save: async (input) => {
			if (input.reminder !== null) host.reminderGesture();
			try {
				const mark = host.app.store.undoMark();
				if (habit === undefined) {
					const created = await host.app.habits.create(input);
					host.notifyUndo(`Created ${created.name}.`, NEW_HABIT_LABEL, mark);
					args.onSaved?.(created.id);
				} else {
					notifyWrite(host, await host.app.habits.update(habit.id, input), `Saved ${input.name.trim()}.`, mark);
					args.onSaved?.(habit.id);
				}
				return null;
			} catch (err) {
				return err instanceof Error ? err.message : String(err);
			}
		},
	};
}
