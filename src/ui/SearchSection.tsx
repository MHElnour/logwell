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
	setUi: (update: (s: SearchSectionState) => SearchSectionState) => void;
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
		// Linked notes that changed while the full scan ran: read again one by one once it is done.
		const dirty = new Set<string>();
		// Read one linked note again and update only the tasks that link it.
		const readOne = async (path: string): Promise<void> => {
			const ids = links.get(path);
			if (ids === undefined) return;
			const hit = await searchNoteContent(new Map([[path, ids]]), query, host.app.notes);
			if (stopped) return;
			setFound((f) => {
				if (f.query !== query) return f;
				const next = new Set(f.ids);
				for (const id of ids) next.delete(id);
				for (const id of hit) next.add(id);
				return sameIds(f.ids, next) ? f : { query, ids: next };
			});
		};
		// One full scan after a pause. Only a new query, toggle, set of links or visibility starts another one (this effect runs again).
		timer = window.setTimeout(() => {
			timer = undefined;
			const mine = new AbortController();
			scan = mine;
			void (async () => {
				try {
					const ids = await searchNoteContent(links, query, host.app.notes, mine.signal);
					if (mine.signal.aborted) return;
					scan = null;
					setFound((f) => (f.query === query && sameIds(f.ids, ids) ? f : { query, ids }));
					for (const path of dirty) {
						dirty.delete(path);
						await readOne(path);
						if (stopped) return;
					}
				} catch (err) {
					scan = null;
					dirty.clear();
					host.error(err);
				}
			})();
		}, NOTE_SCAN_DELAY_MS);
		// A linked note changed in the vault. Before the full scan: it reads that note anyway. During it: read again afterwards. Otherwise: read just that note.
		const stopListening = host.onNotesChanged((path) => {
			if (!links.has(path) || timer !== undefined) return;
			if (scan !== null) dirty.add(path);
			else readOne(path).catch((err: unknown) => host.error(err));
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
	const select = useStableCallback((id: ID | null) => setUi((s) => ({ ...s, selectedId: id })));

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
						onInput={(e) => {
							// Read now: the updater runs after the event is done.
							const query = e.currentTarget.value;
							setUi((s) => ({ ...s, query }));
						}}
					/>
					<label class="cp-checkbox-label">
						<input
							type="checkbox"
							checked={ui.includeNotes}
							onChange={(e) => {
								const includeNotes = e.currentTarget.checked;
								setUi((s) => ({ ...s, includeNotes }));
							}}
						/>
						Also search description notes
					</label>
				</div>
				<FilterBar
					host={host}
					state={state}
					filter={ui.filter}
					defaultStatus="all"
					onChange={(filter) => setUi((s) => ({ ...s, filter }))}
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

