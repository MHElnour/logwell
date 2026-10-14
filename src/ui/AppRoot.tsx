import { Fragment } from "preact";
import type { TaskView } from "../app/views";
import { type TaskFilter, existingTagFilter } from "../domain/queries";
import type { ID } from "../domain/types";
import { useEffect, useRef, useState } from "preact/hooks";
import { isDomainError } from "../domain/errors";
import { CalendarSection, type CalendarSectionState, initialCalendarState } from "./CalendarSection";
import { cancelMoveToSection } from "./actions";
import { ReadOnlyBanner } from "./Banners";
import { accentClass } from "./accent";
import { IconButton, SrOnly } from "./common";
import { DataSection } from "./DataSection";
import { FocusSection } from "./FocusSection";
import { type HabitFocusRequest, HabitsSection, type HabitsSectionState, initialHabitsState } from "./HabitsSection";
import type { SectionId, UiHost } from "./host";
import { ICON } from "./icons";
import { undoneText } from "./format";
import { useAppState, useQueryContext, useUniqueId } from "./hooks";
import { MatrixSection, type MatrixSectionState, initialMatrixState } from "./MatrixSection";
import { SearchSection, type SearchSectionState, initialSearchState } from "./SearchSection";
import { TasksSection, type TasksSectionState, initialTasksState, revealInTasks } from "./TasksSection";

export interface AppRootHandle {
	showSection(section: SectionId | "today"): void;
	/**
	 * Opens the Habits section with the habit selected (reminders, search). `focusControl` also focuses its
	 * check-in control once it shows. An archived habit opens in the archived list.
	 */
	showHabit(id: string, focusControl?: boolean): void;
	/** The task selected in the section on screen (the one the details pane shows), or null. */
	selectedTaskId(): string | null;
	/** Opens the Tasks section on `view`, with `selectedId` selected (its details open), or nothing selected for null. */
	showTasks(view: TaskView, selectedId: ID | null): void;
}

const SECTIONS: { id: SectionId; icon: string; label: string }[] = [
	{ id: "tasks", icon: ICON.railTasks, label: "Tasks" },
	{ id: "calendar", icon: ICON.railCalendar, label: "Calendar" },
	{ id: "focus", icon: ICON.railFocus, label: "Focus" },
	{ id: "habits", icon: ICON.railHabits, label: "Habits" },
	{ id: "matrix", icon: ICON.railMatrix, label: "Matrix" },
	{ id: "search", icon: ICON.railSearch, label: "Search" },
	{ id: "data", icon: ICON.railData, label: "Data" },
];

/**
 * The full-page app: icon rail, sections and a shared details pane.
 * Inactive sections stay mounted (hidden), so each keeps its state.
 */
export function AppRoot(props: { host: UiHost; initialSection: SectionId | "today" | null; handle: (h: AppRootHandle) => void }) {
	const { host } = props;
	const state = useAppState(host);
	const railLabelId = useUniqueId("cp-rail-label");
	const ctx = useQueryContext(host);
	const initial = props.initialSection;
	const [section, setSection] = useState<SectionId>(initial === "today" || initial === null ? "tasks" : initial);
	const [tasksUi, setTasksUi] = useState<TasksSectionState>(initialTasksState);
	const [calendarUi, setCalendarUi] = useState<CalendarSectionState>(() => initialCalendarState(ctx.today));
	const [habitsUi, setHabitsUi] = useState<HabitsSectionState>(() => initialHabitsState(ctx.today));
	const [habitFocus, setHabitFocus] = useState<HabitFocusRequest | null>(null);
	const [matrixUi, setMatrixUi] = useState<MatrixSectionState>(initialMatrixState);
	const [searchUi, setSearchUi] = useState<SearchSectionState>(initialSearchState);
	const [sidebarOpen, setSidebarOpen] = useState(false);

	// The handle reads the selection through a ref, so it always sees the latest state.
	const live = useRef({ section, tasksUi, calendarUi, matrixUi, searchUi });
	live.current = { section, tasksUi, calendarUi, matrixUi, searchUi };

	// A pending "Move to section…" menu must not outlive the view.
	useEffect(() => cancelMoveToSection, []);

	// A renamed or deleted tag leaves every section's filter, so no view filters by a tag its menu cannot list.
	useEffect(() => {
		const prune = <S extends { filter: TaskFilter }>(s: S): S => {
			const filter = existingTagFilter(s.filter, state.tags);
			return filter === s.filter ? s : { ...s, filter };
		};
		setTasksUi(prune);
		setCalendarUi(prune);
		setMatrixUi(prune);
		setSearchUi(prune);
	}, [state.tags]);

	useEffect(() => {
		props.handle({
			showSection: (s) => {
				if (s === "today") {
					setSection("tasks");
					// Already on Today: keep the object, so the section is not rendered again for nothing.
					setTasksUi((ui) => (ui.view.kind === "today" ? ui : { ...ui, view: { kind: "today" } }));
				} else {
					setSection(s);
				}
			},
			showTasks: (view, selectedId) => {
				setSection("tasks");
				const task = selectedId === null ? undefined : host.app.store.state.tasks.get(selectedId);
				setTasksUi((ui) => revealInTasks(ui, view, selectedId, task));
			},
			showHabit: (id, focusControl = false) => {
				const habit = host.app.habits.list().find((h) => h.id === id);
				setSection("habits");
				setHabitsUi((ui) => ({ ...ui, selectedId: id, day: null, showArchived: habit !== undefined && habit.archivedAt !== null }));
				if (focusControl) setHabitFocus((cur) => ({ id, n: (cur?.n ?? 0) + 1 }));
			},
			selectedTaskId: () => {
				const l = live.current;
				switch (l.section) {
					case "tasks":
						return l.tasksUi.selectedId;
					case "calendar":
						return l.calendarUi.selectedId;
					case "matrix":
						return l.matrixUi.selectedId;
					case "search":
						return l.searchUi.selectedId;
					default:
						return null;
				}
			},
		});
	}, [props.handle]);

	// Cmd/Ctrl+Z outside text fields undoes the last task change.
	const onKeyDown = (e: KeyboardEvent) => {
		if (!(e.key === "z" && (e.metaKey || e.ctrlKey) && !e.shiftKey)) return;
		const target = e.target as HTMLElement;
		if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
		// Popovers, menus, dialogs and the add bar keep their own keys.
		if (target.closest?.('.cp-qa, .cp-pop, [role="dialog"], [role="menu"]') != null) return;
		e.preventDefault();
		void host.app.store.undo().then(
			(label) => host.notify(undoneText(label)),
			(err: unknown) => (isDomainError(err) ? host.notify(err.message) : host.error(err)),
		);
	};

	const readOnly = host.app.store.readOnlyState;
	return (
		<div class={`cp-app cp-theme ${accentClass(host.settings())}`} onKeyDown={onKeyDown}>
			{/* Outside the nav so the rail's children stay buttons and the spacer. */}
			<SrOnly id={railLabelId}>Sections</SrOnly>
			<nav class="cp-rail" aria-labelledby={railLabelId}>
				{SECTIONS.map((s) => (
					<Fragment key={s.id}>
						{/* Data sits at the bottom of the rail. */}
						{s.id === "data" && <div class="cp-rail-spacer" aria-hidden="true" />}
						<IconButton
							host={host}
							icon={s.icon}
							label={s.label}
							pressed={section === s.id}
							cls={section === s.id ? "is-active" : ""}
							onClick={() => setSection(s.id)}
						/>
					</Fragment>
				))}
			</nav>
			<div class="cp-body">
				{readOnly !== null && (
					<ReadOnlyBanner
						state={readOnly}
						onRestore={() =>
							void host.app.store.restoreRecovered().catch((err: unknown) => host.error(err))
						}
						onOpenConflicts={() => setSection("data")}
					/>
				)}
				<div class="cp-section" hidden={section !== "tasks"}>
					<TasksSection
						host={host}
						state={state}
						ctx={ctx}
						ui={tasksUi}
						setUi={setTasksUi}
						visible={section === "tasks"}
						sidebarOpen={sidebarOpen}
						setSidebarOpen={setSidebarOpen}
					/>
				</div>
				<div class="cp-section" hidden={section !== "calendar"}>
					<CalendarSection
						host={host}
						state={state}
						ctx={ctx}
						ui={calendarUi}
						setUi={setCalendarUi}
						visible={section === "calendar"}
					/>
				</div>
				<div class="cp-section" hidden={section !== "focus"}>
					<FocusSection host={host} state={state} ctx={ctx} visible={section === "focus"} />
				</div>
				<div class="cp-section" hidden={section !== "habits"}>
					<HabitsSection host={host} state={state} ctx={ctx} ui={habitsUi} setUi={setHabitsUi} focusRequest={habitFocus} />
				</div>
				<div class="cp-section" hidden={section !== "matrix"}>
					<MatrixSection
						host={host}
						state={state}
						ctx={ctx}
						ui={matrixUi}
						setUi={setMatrixUi}
						visible={section === "matrix"}
					/>
				</div>
				<div class="cp-section" hidden={section !== "search"}>
					<SearchSection
						host={host}
						state={state}
						ctx={ctx}
						ui={searchUi}
						setUi={setSearchUi}
						visible={section === "search"}
						onOpenCategory={(id) => {
							setTasksUi((ui) => ({ ...ui, view: { kind: "category", id }, selectedId: null }));
							setSection("tasks");
						}}
						onOpenHabit={(id) => {
							const habit = host.app.habits.list().find((h) => h.id === id);
							setHabitsUi((ui) => ({ ...ui, selectedId: id, day: null, showArchived: habit !== undefined && habit.archivedAt !== null }));
							setSection("habits");
						}}
					/>
				</div>
				<div class="cp-section" hidden={section !== "data"}>
					<DataSection host={host} ctx={ctx} visible={section === "data"} />
				</div>
			</div>
		</div>
	);
}
