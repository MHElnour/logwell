import type { Ref } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { GROUP_BY_TITLE, type GroupBy } from "../domain/groupBy";
import type { TaskFilter, TaskSort } from "../domain/queries";
import { Icon } from "./common";
import type { MenuSpec, UiHost } from "./host";
import { categoryText } from "./icons";

// The ⋯ "View" menu. Tasks use it for sort and "Show completed"; the calendar and the
// matrix use it for the lists and tags they narrow to, and "Show completed". It is a native menu
// like the other menus here, so the keyboard and the screen reader work as they do everywhere.

type Anchor = { x: number; y: number };

/** The ⋯ button. A dot shows while the menu narrows the view. Opens the menu under the button, mouse or keyboard. */
export function ViewMenuButton(props: { host: UiHost; open: (at: Anchor) => void; narrowing?: boolean; buttonRef?: Ref<HTMLButtonElement> }) {
	return (
		<button
			ref={props.buttonRef}
			type="button"
			class={`cp-icon-button clickable-icon cp-view-menu-button${props.narrowing === true ? " is-narrowing" : ""}`}
			aria-label="View options"
			aria-haspopup="menu"
			onClick={(e) => {
				const rect = e.currentTarget.getBoundingClientRect();
				props.open({ x: rect.left, y: rect.bottom });
			}}
		>
			<Icon host={props.host} icon="more-horizontal" />
			{props.narrowing === true && <span class="cp-view-dot" aria-hidden="true" />}
		</button>
	);
}

const SORTS: { sort: TaskSort; title: string }[] = [
	{ sort: "manual", title: "Sort: default" },
	{ sort: "date", title: "Sort: by date" },
	{ sort: "priority", title: "Sort: by priority" },
];

/** The Tasks view menu: sort and, where the view has a group, "Show completed". */
export function tasksViewMenu(opts: {
	sort: TaskSort;
	onSort: (sort: TaskSort) => void;
	/** Omitted where the view has no Completed group. */
	showCompleted?: boolean;
	onShowCompleted?: (on: boolean) => void;
	/** "Add section", in Inbox and lists only (List and Board). Omitted elsewhere and while read-only. */
	onAddSection?: () => void;
	/** "Group by…", opens `groupByMenu`. List mode of a view that offers a grouping only; never on the board. */
	onGroupBy?: () => void;
}): MenuSpec {
	const items: MenuSpec = SORTS.map((o) => ({ title: o.title, checked: opts.sort === o.sort, run: () => opts.onSort(o.sort) }));
	if (opts.onGroupBy !== undefined) {
		const open = opts.onGroupBy;
		items.push("separator", { title: "Group by…", icon: "layout-list", run: open });
	}
	if (opts.onAddSection !== undefined) items.push("separator", { title: "Add section", icon: "plus", run: opts.onAddSection });
	if (opts.showCompleted !== undefined && opts.onShowCompleted !== undefined) {
		const on = opts.showCompleted;
		const set = opts.onShowCompleted;
		items.push("separator", { title: "Show completed", checked: on, run: () => set(!on) });
	}
	return items;
}

/** The second menu of "Group by…": the view's options, the current one checked. */
export function groupByMenu(options: readonly GroupBy[], current: GroupBy, onPick: (by: GroupBy) => void): MenuSpec {
	return options.map((by) => ({ title: GROUP_BY_TITLE[by], checked: current === by, run: () => onPick(by) }));
}

/** True while the lists or tags narrow the calendar or the matrix; drives the button's dot. */
function isNarrowed(f: TaskFilter): boolean {
	return f.categoryIds.length > 0 || f.tagKeys.length > 0;
}

/** The list without `value` when it is there, else with it added. */
export function toggle<T>(list: T[], value: T): T[] {
	return list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
}

/**
 * The calendar and matrix menu: "Lists…", "Tags…" and "Show completed", all on the section's
 * TaskFilter (`categoryIds`, `tagKeys`, `status`). "Lists…" and "Tags…" open a menu of checked items;
 * each pick keeps it open by showing it again, so several can be picked in a row.
 */
export function ScopeMenuButton(props: {
	host: UiHost;
	filter: TaskFilter;
	onChange: (update: (f: TaskFilter) => TaskFilter) => void;
	/** False while the section is hidden: a pending reopen is dropped (default true). */
	visible?: boolean;
}) {
	const { host } = props;
	// The menus are shown later (after a pick), so they read the latest filter, not this render's.
	const filterRef = useRef(props.filter);
	filterRef.current = props.filter;
	const change = (update: (f: TaskFilter) => TaskFilter) => {
		filterRef.current = update(filterRef.current);
		props.onChange(update);
	};

	// The reopen loop. `reopen` is the pending "show it again" timer, `closeCheck` the pending
	// decision after a menu hid, `picked` whether the menu that is open now was closed by a pick.
	const buttonRef = useRef<HTMLButtonElement>(null);
	const reopen = useRef<number | null>(null);
	const closeCheck = useRef<number | null>(null);
	const picked = useRef(false);
	const alive = useRef(true);
	const stop = (focus: boolean) => {
		if (reopen.current !== null) window.clearTimeout(reopen.current);
		if (closeCheck.current !== null) window.clearTimeout(closeCheck.current);
		reopen.current = null;
		closeCheck.current = null;
		if (focus) buttonRef.current?.focus();
	};
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
			stop(false);
		};
	}, []);
	const visible = props.visible !== false;
	// Read by the reopen timer, so it sees the latest render, not the one that scheduled it.
	const visibleRef = useRef(visible);
	visibleRef.current = visible;
	useEffect(() => {
		if (!visible) stop(false);
	}, [visible]);

	// A native menu closes when an item is picked; showing the next one right then would race with that.
	const later = (fn: () => void) => {
		picked.current = true;
		if (reopen.current !== null) window.clearTimeout(reopen.current);
		reopen.current = window.setTimeout(() => {
			reopen.current = null;
			if (alive.current && visibleRef.current) fn();
		}, 0);
	};
	// Every menu goes through here. A hide with no pick is a dismissal and ends the loop; the pick's
	// `run` and the hide may arrive in either order, so the decision waits one tick.
	const show = (at: Anchor, items: MenuSpec) => {
		picked.current = false;
		host.showMenu(at, items, () => {
			if (closeCheck.current !== null) window.clearTimeout(closeCheck.current);
			closeCheck.current = window.setTimeout(() => {
				closeCheck.current = null;
				if (!picked.current) stop(true);
			}, 0);
		});
	};

	const showLists = (at: Anchor) => {
		const items: MenuSpec = host.app.categories.list().map((c) => ({
			title: categoryText(c),
			checked: filterRef.current.categoryIds.includes(c.id),
			run: () => {
				change((f) => ({ ...f, categoryIds: toggle(f.categoryIds, c.id) }));
				later(() => showLists(at));
			},
		}));
		show(at, items);
	};
	const showTags = (at: Anchor) => {
		const tags = host.app.tags.list();
		const items: MenuSpec =
			tags.length === 0
				? [{ title: "No tags yet", disabled: true, run: () => undefined }]
				: tags.map((t) => ({
						title: `@${t.displayName}`,
						checked: filterRef.current.tagKeys.includes(t.key),
						run: () => {
							change((f) => ({ ...f, tagKeys: toggle(f.tagKeys, t.key) }));
							later(() => showTags(at));
						},
					}));
		show(at, items);
	};
	const showRoot = (at: Anchor) => {
		show(at, [
			{ title: "Lists…", run: () => later(() => showLists(at)) },
			{ title: "Tags…", run: () => later(() => showTags(at)) },
			"separator",
			{
				title: "Show completed",
				checked: filterRef.current.status !== "open",
				run: () => {
					picked.current = true;
					change((f) => ({ ...f, status: f.status === "open" ? "all" : "open" }));
				},
			},
		]);
	};
	return <ViewMenuButton host={host} open={showRoot} narrowing={isNarrowed(props.filter)} buttonRef={buttonRef} />;
}
