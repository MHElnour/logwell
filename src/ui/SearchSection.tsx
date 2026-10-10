import { useEffect, useRef, useState } from "preact/hooks";
import { type LinkedNotes, globalSearch, linkedNotes, searchNoteContent } from "../app/views";
import { type QueryContext, type TaskFilter, emptyFilter } from "../domain/queries";
import type { ID } from "../domain/types";
import type { DbData } from "../persistence/schema";
import { FilterBar } from "./FilterBar";
import { EmptyState } from "./common";
import { useActiveMemo, useStableCallback, useSubtaskCounts, useUniqueId } from "./hooks";
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

/** Pause after the last change before the notes are read, as for typing. */
const NOTE_SCAN_DELAY_MS = 300;
const NO_IDS: ReadonlySet<ID> = new Set();
const NO_LINKS: LinkedNotes = new Map();
/** The task IDs whose linked note matched, with the query they were found for; no note text. */
const NO_FOUND: { query: string; ids: ReadonlySet<ID> } = { query: "", ids: NO_IDS };

function sameIds(a: ReadonlySet<ID>, b: ReadonlySet<ID>): boolean {
	if (a.size !== b.size) return false;
	for (const id of a) if (!b.has(id)) return false;
	return true;
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
	const [found, setFound] = useState(NO_FOUND);
	const categoriesId = useUniqueId("cp-search-categories");
	const habitsId = useUniqueId("cp-search-habits");
	const tasksId = useUniqueId("cp-search-tasks");

	// Note matches refresh only while Search is shown with the toggle on and a query typed (App shell and views rule 24).
	const query = ui.query.trim();
	const active = props.visible && ui.includeNotes && query !== "";
	const previousLinks = useRef<LinkedNotes>(NO_LINKS);
	const links = useActiveMemo(active, () => (previousLinks.current = linkedNotes(state.tasks, previousLinks.current)), [state.tasks], NO_LINKS);

	useEffect(() => {
		if (!active) {
			// Toggle off or query cleared while shown: drop the matches. A hidden section keeps its last ones.
			if (props.visible) setFound((f) => (f === NO_FOUND ? f : NO_FOUND));
			return;
		}
		let timer: number | undefined;
		let scan: AbortController | null = null;
		let stopped = false;
		const fullScanDue = () => timer !== undefined || scan !== null;
		// One full scan after a pause; a newer one stops an older one.
		const scheduleScan = () => {
			scan?.abort();
			scan = null;
			window.clearTimeout(timer);
			timer = window.setTimeout(() => {
				timer = undefined;
				const mine = new AbortController();
				scan = mine;
				searchNoteContent(links, query, host.app.notes, mine.signal)
					.then((ids) => {
						if (mine.signal.aborted) return;
						scan = null;
						setFound((f) => (f.query === query && sameIds(f.ids, ids) ? f : { query, ids }));
					})
					.catch((err) => {
						if (scan === mine) scan = null;
						host.error(err);
					});
			}, NOTE_SCAN_DELAY_MS);
		};
		scheduleScan();
		// A linked note changed in the vault: read that note again, nothing else.
		const stopListening = host.onNotesChanged((path) => {
			const ids = links.get(path);
			if (ids === undefined) return;
			if (fullScanDue()) {
				scheduleScan();
				return;
			}
			void searchNoteContent(new Map([[path, ids]]), query, host.app.notes).then((hit) => {
				if (stopped || fullScanDue()) return;
				setFound((f) => {
					if (f.query !== query) return f;
					const next = new Set(f.ids);
					for (const id of ids) next.delete(id);
					for (const id of hit) next.add(id);
					return sameIds(f.ids, next) ? f : { query, ids: next };
				});
			}, (err: unknown) => host.error(err));
		});
		return () => {
			stopped = true;
			stopListening();
			scan?.abort();
			window.clearTimeout(timer);
		};
	}, [active, props.visible, query, links, host]);

	// Matches belong to the query they were found for and to the toggle.
	const noteMatches = ui.includeNotes && found.query === query ? found.ids : NO_IDS;

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

