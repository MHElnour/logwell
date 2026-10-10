import { useEffect, useState } from "preact/hooks";
import { globalSearch, searchNoteContent } from "../app/views";
import { type QueryContext, type TaskFilter, emptyFilter } from "../domain/queries";
import type { ID } from "../domain/types";
import type { DbData } from "../persistence/schema";
import { FilterBar } from "./FilterBar";
import { EmptyState } from "./common";
import { useStableCallback, useSubtaskCounts, useUniqueId } from "./hooks";
import type { UiHost } from "./host";
import { ICON, categoryText } from "./icons";
import { DetailsPane } from "./TaskDetails";
import { TaskList } from "./TaskList";

export interface SearchSectionState {
	query: string;
	includeNotes: boolean;
	filter: TaskFilter;
	selectedId: ID | null;
}

export function initialSearchState(): SearchSectionState {
	return { query: "", includeNotes: false, filter: emptyFilter("all"), selectedId: null };
}

/** Global search: task titles, list names and habit names; optionally note content, never stored. */
export function SearchSection(props: {
	host: UiHost;
	state: DbData;
	ctx: QueryContext;
	ui: SearchSectionState;
	setUi: (s: SearchSectionState) => void;
	onOpenCategory: (id: ID) => void;
	/** A habit result opens the Habits page with that habit selected. */
	onOpenHabit: (id: ID) => void;
	/** True while the section is shown. */
	visible: boolean;
}) {
	const { host, state, ctx, ui, setUi } = props;
	const [noteMatches, setNoteMatches] = useState<Set<ID>>(new Set());
	const categoriesId = useUniqueId("cp-search-categories");
	const habitsId = useUniqueId("cp-search-habits");
	const tasksId = useUniqueId("cp-search-tasks");

	useEffect(() => {
		if (!ui.includeNotes || ui.query.trim() === "") {
			// The effect runs on every store change; an empty set that stays empty must not render again.
			setNoteMatches((prev) => (prev.size === 0 ? prev : new Set()));
			return;
		}
		let cancelled = false;
		const timer = window.setTimeout(() => {
			void searchNoteContent(state, ui.query, host.app.notes).then((ids) => {
				if (!cancelled) setNoteMatches(ids);
			});
		}, 300);
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	}, [ui.query, ui.includeNotes, state, host]);

	const results = globalSearch(state, ui.query, ctx, ui.filter, noteMatches);
	const searching = ui.query.trim() !== "";
	// Counted only while the results are shown: the list below would otherwise scan every task on each store change of a hidden section.
	const subtaskCounts = useSubtaskCounts(state.tasks, props.visible && searching);
	const select = useStableCallback((id: ID | null) => setUi({ ...ui, selectedId: id }));

	return (
		<div class={`cp-search${ui.selectedId !== null ? " has-details" : ""}`}>
			<main class="cp-main">
				<header class="cp-main-header">
					<h2 class="cp-main-title">Search</h2>
					{searching && <span class="cp-count-pill">{results.tasks.length}</span>}
				</header>
				<div class="cp-search-box">
					<input
						type="search"
						placeholder="Search tasks, lists and habits"
						aria-label="Search tasks, lists and habits"
						value={ui.query}
						onInput={(e) => setUi({ ...ui, query: e.currentTarget.value })}
					/>
					<label class="cp-checkbox-label">
						<input
							type="checkbox"
							checked={ui.includeNotes}
							onChange={(e) => setUi({ ...ui, includeNotes: e.currentTarget.checked })}
						/>
						Also search description notes
					</label>
				</div>
				<FilterBar
					host={host}
					state={state}
					filter={ui.filter}
					defaultStatus="all"
					onChange={(filter) => setUi({ ...ui, filter })}
				/>
				{!searching ? (
					<EmptyState host={host} icon={ICON.railSearch} text="Type to search task titles, list names and habit names." />
				) : (
					<>
						{results.categories.length > 0 && (
							<section class="cp-search-group" aria-labelledby={categoriesId}>
								<div class="cp-group-heading" id={categoriesId}>
									Lists
								</div>
								<ul class="cp-search-categories">
									{results.categories.map((c) => (
										<li key={c.id}>
											<button type="button" class="cp-link-button" onClick={() => props.onOpenCategory(c.id)}>
												{categoryText(c)}
											</button>
										</li>
									))}
								</ul>
							</section>
						)}
						{results.habits.length > 0 && (
							<section class="cp-search-group" aria-labelledby={habitsId}>
								<div class="cp-group-heading" id={habitsId}>
									Habits
								</div>
								<ul class="cp-search-categories cp-search-habits">
									{results.habits.map((h) => (
										<li key={h.id}>
											<button type="button" class="cp-link-button" onClick={() => props.onOpenHabit(h.id)}>
												{h.name}
											</button>
											{h.archivedAt !== null && <span class="cp-search-tag">Archived</span>}
										</li>
									))}
								</ul>
							</section>
						)}
						<section class="cp-search-group" aria-labelledby={tasksId}>
							<div class="cp-group-heading" id={tasksId}>
								Tasks
							</div>
							<TaskList
								host={host}
								state={state}
								groups={[{ key: "all", date: null, entries: results.tasks }]}
								ctx={ctx}
								selectedId={ui.selectedId}
								showCategory={true}
								emptyText="No tasks match."
								label="Search results"
								subtaskCounts={subtaskCounts}
								onSelect={select}
							/>
						</section>
					</>
				)}
			</main>
			<DetailsPane host={host} state={state} ctx={ctx} selectedId={ui.selectedId} onSelect={select} />
		</div>
	);
}

