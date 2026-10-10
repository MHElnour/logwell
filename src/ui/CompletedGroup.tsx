import type { ComponentChildren } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ListEntry } from "../domain/queries";
import { Icon } from "./common";
import { entryKey } from "./format";
import type { UiHost } from "./host";

// The Completed group at the end of a task view and of each matrix quadrant: collapsed
// by default, newest first, 20 at a time. The parent owns the expanded state, so a view keeps it for
// the session; the page size lives here and starts again at 20 when the group is collapsed or when
// `resetKey` changes (the view or its filter).

const COMPLETED_PAGE = 20;

export function CompletedGroup(props: {
	host: UiHost;
	/** Used for the heading's element ID. */
	idBase: string;
	entries: ListEntry[];
	open: boolean;
	onToggle: () => void;
	renderRow: (entry: ListEntry) => ComponentChildren;
	cls?: string;
	/** Identifies the view and its filter; a change starts the paging again. */
	resetKey: string;
}) {
	const [page, setPage] = useState({ key: props.resetKey, limit: COMPLETED_PAGE });
	const limit = page.key === props.resetKey ? page.limit : COMPLETED_PAGE;
	// Collapsing starts the paging again.
	useLayoutEffect(() => {
		if (!props.open) setPage({ key: props.resetKey, limit: COMPLETED_PAGE });
	}, [props.open]);
	const groupRef = useRef<HTMLDivElement>(null);
	// "Show more" may remove its own button once everything shows; focus goes to the first new row.
	// A ref, not the event target: that button can be gone after the re-render.
	const focusId = useRef<string | null>(null);
	useLayoutEffect(() => {
		const id = focusId.current;
		if (id === null) return;
		const row = [...(groupRef.current?.querySelectorAll<HTMLElement>(".cp-task-row") ?? [])].find((r) => r.dataset.rowKey === id);
		if (row === undefined) return;
		focusId.current = null;
		row.focus();
	});
	const headingId = `${props.idBase}-completed`;
	const { entries, open } = props;
	return (
		<div ref={groupRef} class={`cp-task-group cp-completed-group${props.cls === undefined ? "" : ` ${props.cls}`}`} role="group" aria-labelledby={headingId}>
			<button type="button" class="cp-completed-toggle" aria-expanded={open} onClick={props.onToggle}>
				<Icon host={props.host} icon={open ? "chevron-down" : "chevron-right"} />
				<span id={headingId}>{`Completed · ${entries.length}`}</span>
			</button>
			{open && entries.length > 0 && (
				<div class="cp-task-rows" role="listbox" aria-labelledby={headingId}>
					{entries.slice(0, limit).map(props.renderRow)}
				</div>
			)}
			{open && entries.length > limit && (
				<button type="button" class="cp-link-button cp-completed-more" onClick={() => {
						const next = entries[limit];
						focusId.current = next === undefined ? null : entryKey(next);
						setPage({ key: props.resetKey, limit: limit + COMPLETED_PAGE });
					}}>
					Show more
				</button>
			)}
		</div>
	);
}
