import { useLayoutEffect, useRef } from "preact/hooks";
import { dayShare, groupHabits, timeOfDayNow } from "../domain/habits";
import type { HabitInput } from "../domain/habits";
import type { QueryContext } from "../domain/queries";
import type { Habit, ID, LocalDate } from "../domain/types";
import type { DbData } from "../persistence/schema";
import { Icon } from "./common";
import { ArchivedList } from "./habits/ArchivedList";
import { EmptyHabits } from "./habits/EmptyState";
import { HabitDetail } from "./habits/HabitDetail";
import { HabitGroups, habitsOn } from "./habits/HabitGroups";
import { WeekStrip } from "./habits/WeekStrip";
import { habitDialogOptions } from "./habits/actions";
import { monthOf, stripDays, subText } from "./habits/format";
import { useClockTime, useUniqueId } from "./hooks";
import type { UiHost } from "./host";
import { ICON } from "./icons";

// The Habits section: header, week strip, the day's habits by time of day and, beside them,
// the selected habit's detail. Every write goes through app.habits.

export interface HabitsSectionState {
	selectedId: ID | null;
	/** The day shown for backfilling; null = today. */
	day: LocalDate | null;
	/** The month of the History calendar, "YYYY-MM". */
	month: string;
	showArchived: boolean;
}

export function initialHabitsState(today: LocalDate): HabitsSectionState {
	return { selectedId: null, day: null, month: monthOf(today), showArchived: false };
}

/** A request to focus a habit's control once the section shows (reminders, search). `n` makes each request new. */
export interface HabitFocusRequest {
	id: ID;
	n: number;
}

export function HabitsSection(props: {
	host: UiHost;
	state: DbData;
	ctx: QueryContext;
	ui: HabitsSectionState;
	setUi: (s: HabitsSectionState) => void;
	focusRequest: HabitFocusRequest | null;
}) {
	const { host, ctx, ui, setUi } = props;
	const { today, zone } = ctx;
	const titleId = useUniqueId("cp-habits-title");
	const rootRef = useRef<HTMLDivElement>(null);
	// Read in every render: `state` only makes the section re-render on a store change.
	const all = host.app.habits.list();
	const active = all.filter((h) => h.archivedAt === null);
	const archived = all.filter((h) => h.archivedAt !== null);
	const index = host.app.habits.index();
	const archivedMode = ui.showArchived && archived.length > 0;
	const date = ui.day !== null && ui.day < today ? ui.day : today;
	const shownDay = date === today ? null : date;

	// The selection: the habit chosen, else the first one on screen (the first row of the first group).
	const groups = archivedMode ? [] : groupHabits(habitsOn(active, date));
	const onScreen = archivedMode ? archived : groups.flatMap((g) => g.habits);
	const selected: Habit | null = (archivedMode ? archived : active).find((h) => h.id === ui.selectedId) ?? onScreen[0] ?? (archivedMode ? null : (active[0] ?? null));
	const selectedId = selected?.id ?? null;

	const clock = useClockTime(host, zone);
	const now = date === today ? timeOfDayNow(clock, host.settings().eveningTime) : null;

	// Focus a habit's control after the render that shows it (a ref to the section, never the event target).
	const handled = useRef(0);
	useLayoutEffect(() => {
		const req = props.focusRequest;
		if (req === null || req.n === handled.current) return;
		handled.current = req.n;
		const row = [...(rootRef.current?.querySelectorAll<HTMLElement>(".cp-habit-row") ?? [])].find((r) => r.dataset.habitId === req.id);
		(row?.querySelector<HTMLElement>(".cp-habit-ctl input, .cp-habit-ctl button") ?? row?.querySelector<HTMLElement>(".cp-habit-name"))?.focus();
	});

	const select = (id: ID) => setUi({ ...ui, selectedId: id });
	// The dialog outlives this render: a saved habit is selected on the latest state.
	const uiLatest = useRef(ui);
	uiLatest.current = ui;
	const openDialog = (initial: HabitInput | null) =>
		void host
			.habitDialog(habitDialogOptions(host, { initial, onSaved: (id) => setUi({ ...uiLatest.current, selectedId: id, showArchived: false }) }))
			.catch((err: unknown) => host.error(err));

	const newButton = (
		<button type="button" class="cp-habit-btn is-cta" onClick={() => openDialog(null)}>
			<Icon host={host} icon={ICON.add} />
			<span>New habit</span>
		</button>
	);

	/** The page header: the title, an optional line under it and the New habit button. */
	const head = (sub: string | null) => (
		<div class="cp-habits-head">
			<div>
				<h2 class="cp-habits-title" id={titleId}>
					Habits
				</h2>
				{sub !== null && <div class="cp-habits-sub">{sub}</div>}
			</div>
			{newButton}
		</div>
	);

	if (all.length === 0) {
		return (
			<div class="cp-habits" ref={rootRef}>
				<section class="cp-habits-main is-empty" aria-labelledby={titleId}>
					{head(null)}
					<EmptyHabits host={host} onExample={openDialog} />
				</section>
			</div>
		);
	}

	const share = (d: LocalDate) => dayShare(habitsOn(active, d), index, d, today);
	const { met, scheduled } = share(date);
	return (
		<div class="cp-habits" ref={rootRef}>
			<div class="cp-habits-body">
				<section class="cp-habits-main" aria-labelledby={titleId}>
					{head(archivedMode ? "Archived habits" : subText(date, today, met, scheduled))}
					{archivedMode ? (
						<ArchivedList host={host} habits={archived} today={today} selectedId={selectedId} onSelect={select} />
					) : (
						<>
							<WeekStrip days={stripDays(today, share)} today={today} selected={shownDay} onSelect={(day) => setUi({ ...ui, day })} />
							{onScreen.length === 0 ? (
								<p class="cp-habit-none">{active.length === 0 ? "No active habits. Restore one from the archive, or add a new one." : "No habits on this day."}</p>
							) : (
								<HabitGroups
									host={host}
									groups={groups}
									index={index}
									date={date}
									today={today}
									now={now}
									selectedId={selectedId}
									onSelect={select}
								/>
							)}
						</>
					)}
					{archived.length > 0 && (
						<div class="cp-habits-foot">
							<button type="button" onClick={() => setUi({ ...ui, showArchived: !archivedMode })}>
								{archivedMode ? "Back to habits" : `Archived habits (${archived.length})`}
							</button>
						</div>
					)}
				</section>
				{selected !== null && (
					<HabitDetail key={selected.id} host={host} habit={selected} index={index} today={today} zone={zone} month={ui.month} onMonth={(month) => setUi({ ...ui, month })} />
				)}
			</div>
		</div>
	);
}
