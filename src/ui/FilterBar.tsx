import { categoryText } from "./icons";
import type { TargetedEvent } from "preact";
import { useState } from "preact/hooks";
import { type DateFilter, type StatusFilter, type TaskFilter, type TaskSort, emptyFilter, isFilterActive } from "../domain/queries";
import type { Priority } from "../domain/types";
import type { DbData } from "../persistence/schema";
import { QUADRANTS } from "./actions";
import type { UiHost } from "./host";
import { IconButton, SrOnly } from "./common";
import { useUniqueId } from "./hooks";
import { toggle } from "./ViewMenu";

// The shared filter bar: category, tags (any/all), date, status,
// has note, matrix quadrant and priority, combined with AND. No query language.
// The sort control shares the panel but is not a filter: it does not count as active
// and "Clear filters" keeps it.

const DATE_OPTIONS: { value: DateFilter; label: string }[] = [
	{ value: "any", label: "Any date" },
	{ value: "overdue", label: "Overdue" },
	{ value: "today", label: "Today" },
	{ value: "next7", label: "Next 7 days" },
	{ value: "none", label: "No date" },
	{ value: "range", label: "Date range" },
];

const PRIORITY_OPTIONS: { value: Priority; label: string }[] = [
	{ value: 1, label: "High" },
	{ value: 2, label: "Medium" },
	{ value: 3, label: "Low" },
	{ value: 0, label: "None" },
];

const SORT_OPTIONS: { value: TaskSort; label: string }[] = [
	{ value: "manual", label: "Default order" },
	{ value: "priority", label: "Priority" },
];

export function FilterBar(props: {
	host: UiHost;
	state: DbData;
	filter: TaskFilter;
	defaultStatus: StatusFilter;
	onChange: (f: TaskFilter) => void;
}) {
	const { host, state, filter: f, onChange } = props;
	const [open, setOpen] = useState(false);
	const panelLabelId = useUniqueId("cp-filters-label");
	const active = isFilterActive(f, props.defaultStatus);
	const set = (patch: Partial<TaskFilter>) => onChange({ ...f, ...patch });
	const select =
		<K extends keyof TaskFilter>(key: K) =>
		(e: TargetedEvent<HTMLSelectElement>) =>
			set({ [key]: e.currentTarget.value });

	return (
		<div class="cp-filter-bar">
			<div class="cp-filter-toggle-row">
				<IconButton
					host={host}
					icon="filter"
					label={open ? "Hide filters" : "Show filters"}
					pressed={open}
					cls={active || f.sort !== "manual" ? "is-active" : ""}
					onClick={() => setOpen(!open)}
				/>
				{active && (
					<button type="button" class="cp-link-button" onClick={() => onChange({ ...emptyFilter(props.defaultStatus), sort: f.sort })}>
						Clear filters
					</button>
				)}
			</div>
			{open && (
				<div class="cp-filter-panel" role="group" aria-labelledby={panelLabelId}>
						<SrOnly id={panelLabelId}>Filters</SrOnly>
					<fieldset class="cp-filter-chips">
						<legend>Lists</legend>
						{host.app.categories.list().map((c) => (
							<button
								key={c.id}
								type="button"
								class={`cp-toggle-chip${f.categoryIds.includes(c.id) ? " is-on" : ""}`}
								aria-pressed={f.categoryIds.includes(c.id)}
								onClick={() => set({ categoryIds: toggle(f.categoryIds, c.id) })}
							>
								{categoryText(c)}
							</button>
						))}
					</fieldset>
					{state.tags.size > 0 && (
						<fieldset class="cp-filter-chips">
							<legend>
								Tags{" "}
								<select class="dropdown cp-inline-select" aria-label="Tag match" value={f.tagMode} onChange={select("tagMode")}>
									<option value="any">Any</option>
									<option value="all">All</option>
								</select>
							</legend>
							{[...state.tags.values()].map((t) => (
								<button
									key={t.key}
									type="button"
									class={`cp-toggle-chip cp-tag-${t.color ?? "none"}${f.tagKeys.includes(t.key) ? " is-on" : ""}`}
									aria-pressed={f.tagKeys.includes(t.key)}
									onClick={() => set({ tagKeys: toggle(f.tagKeys, t.key) })}
								>
									@{t.displayName}
								</button>
							))}
						</fieldset>
					)}
					<div class="cp-filter-selects">
						<label>
							<span>Date</span>
							<select class="dropdown" value={f.date} onChange={select("date")}>
								{DATE_OPTIONS.map((o) => (
									<option key={o.value} value={o.value}>
										{o.label}
									</option>
								))}
							</select>
						</label>
						{f.date === "range" && (
							<>
								<label>
									<span>From</span>
									<input type="date" value={f.from ?? ""} onChange={(e) => set({ from: e.currentTarget.value || null })} />
								</label>
								<label>
									<span>To</span>
									<input type="date" value={f.to ?? ""} onChange={(e) => set({ to: e.currentTarget.value || null })} />
								</label>
							</>
						)}
						<label>
							<span>Status</span>
							<select class="dropdown" value={f.status} onChange={select("status")}>
								<option value="all">All</option>
								<option value="open">Open</option>
								<option value="completed">Completed</option>
							</select>
						</label>
						<label>
							<span>Description note</span>
							<select class="dropdown" value={f.hasNote} onChange={select("hasNote")}>
								<option value="any">Any</option>
								<option value="yes">Has a note</option>
								<option value="no">No note</option>
							</select>
						</label>
					</div>
					<fieldset class="cp-filter-chips cp-filter-priority">
						<legend>Priority</legend>
						{PRIORITY_OPTIONS.map((o) => (
							<button
								key={o.value}
								type="button"
								class={`cp-toggle-chip cp-pri-${o.value}${f.priorities.includes(o.value) ? " is-on" : ""}`}
								aria-pressed={f.priorities.includes(o.value)}
								onClick={() => set({ priorities: toggle(f.priorities, o.value) })}
							>
								{o.label}
							</button>
						))}
					</fieldset>
					<div class="cp-filter-selects cp-filter-sort">
						<label>
							<span>Sort by</span>
							<select class="dropdown" value={f.sort} onChange={select("sort")}>
								{SORT_OPTIONS.map((o) => (
									<option key={o.value} value={o.value}>
										{o.label}
									</option>
								))}
							</select>
						</label>
					</div>
					<fieldset class="cp-filter-chips">
						<legend>Matrix</legend>
						{QUADRANTS.map((q) => (
							<button
								key={q.id}
								type="button"
								class={`cp-toggle-chip${f.quadrants.includes(q.id) ? " is-on" : ""}`}
								aria-pressed={f.quadrants.includes(q.id)}
								onClick={() => set({ quadrants: toggle(f.quadrants, q.id) })}
							>
								{q.label}
							</button>
						))}
					</fieldset>
				</div>
			)}
		</div>
	);
}
