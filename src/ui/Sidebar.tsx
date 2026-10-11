import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { isListSynced } from "../app/syncMarks";
import { type SidebarCounts, type TaskView, sameView } from "../app/views";
import { isDomainError } from "../domain/errors";
import { plural } from "../domain/text";
import { type TagNode, hasTagOrChild, isUnderTag, tagLabel, tagPath, tagTree } from "../domain/tags";
import { TAG_COLORS, type Category, INBOX_ID, INBOX_NAME, type Tag, type TagColor, paletteColor } from "../domain/types";
import type { DbData } from "../persistence/schema";
import { Icon, IconButton, SrOnly, hueClass } from "./common";
import { capitalize } from "./format";
import { useUniqueId } from "./hooks";
import type { MenuSpec, UiHost } from "./host";
import { ICON, categoryIcon } from "./icons";
import { notifyWrite } from "./writeNotice";

// The Tasks section sidebar: Today, Upcoming, Inbox, categories,
// tags, Completed, Trash.

type ItemProps = {
	host: UiHost;
	icon: string | null;
	emoji?: string | null;
	/** The list color: the `cp-hue-*` class sets --cp-list-color for the icon. */
	color?: TagColor | null;
	label: string;
	count?: number;
	/** The list is linked to TickTick (the marker after its name). */
	synced?: boolean;
	active: boolean;
	onClick: () => void;
	onContextMenu?: (e: MouseEvent) => void;
	children?: ComponentChildren;
};

function ItemButton(props: ItemProps) {
	return (
		<button
			type="button"
			class={`cp-sidebar-item${props.active ? " is-active" : ""}${props.color ? ` ${hueClass(props.color)}` : ""}`}
			aria-current={props.active ? "page" : undefined}
			onClick={props.onClick}
			onContextMenu={(e) => {
				if (props.onContextMenu === undefined) return;
				e.preventDefault();
				props.onContextMenu(e);
			}}
			onKeyDown={(e) => {
				if (props.onContextMenu !== undefined && (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey))) {
					e.preventDefault();
					const r = e.currentTarget.getBoundingClientRect();
					props.onContextMenu(new MouseEvent("contextmenu", { clientX: r.left + 16, clientY: r.bottom }));
				}
			}}
		>
			{props.emoji ? (
				<span class="cp-emoji" aria-hidden="true">
					{props.emoji}
				</span>
			) : props.icon !== null ? (
				<Icon host={props.host} icon={props.icon} cls="cp-nav-icon" fallback={ICON.list} />
			) : null}
			{props.children}
			<span class="cp-sidebar-label">{props.label}</span>
			{props.synced === true && (
				<span class="cp-sync-mark" role="img" aria-label="Synced with TickTick">
					<Icon host={props.host} icon={ICON.sync} />
				</span>
			)}
			{props.count !== undefined && props.count > 0 && <span class="cp-count">{props.count}</span>}
		</button>
	);
}

function Item(props: ItemProps) {
	return (
		<li>
			<ItemButton {...props} />
		</li>
	);
}

/**
 * One node of the Tags tree. A node with children has a fold button beside its row (never inside
 * it: a button cannot hold a button). An implicit parent (no tag record) has no color and no menu.
 */
function TagBranch(props: {
	host: UiHost;
	node: TagNode;
	depth: number;
	view: TaskView;
	folded: ReadonlySet<string>;
	onFold: (key: string) => void;
	onView: (v: TaskView) => void;
	menuFor: (t: Tag) => (e: MouseEvent) => void;
}) {
	const { host, node, depth, folded } = props;
	const open = !folded.has(node.key);
	const hasChildren = node.children.length > 0;
	const tag = node.tag;
	return (
		<li class="cp-tag-node">
			<div class="cp-tag-row" style={{ "--cp-tag-depth": depth }}>
				{hasChildren ? (
					<button
						type="button"
						class="cp-tag-fold"
						data-tag-label={node.name}
						aria-expanded={open}
						aria-label={`${open ? "Collapse" : "Expand"} ${node.name}`}
						onClick={() => props.onFold(node.key)}
					>
						<Icon host={host} icon={open ? "chevron-down" : "chevron-right"} />
					</button>
				) : (
					<span class="cp-tag-fold-spacer" aria-hidden="true" />
				)}
				<ItemButton
					host={host}
					icon={null}
					label={node.name}
					count={node.count}
					active={sameView(props.view, { kind: "tag", key: node.key })}
					onClick={() => props.onView({ kind: "tag", key: node.key })}
					onContextMenu={tag === null ? undefined : props.menuFor(tag)}
				>
					<span class={`cp-tag-dot cp-tag-${tag?.color ?? "none"}`} aria-hidden="true" />
				</ItemButton>
			</div>
			{hasChildren && open && (
				<ul class="cp-sidebar-list cp-tag-children">
					{node.children.map((c) => (
						<TagBranch key={c.key} {...props} node={c} depth={depth + 1} />
					))}
				</ul>
			)}
		</li>
	);
}

/** The one-step dialog (name, icon, color) is one create call, so one undo entry. */
async function newCategory(host: UiHost): Promise<void> {
	if (host.newList === undefined) return editCategory(host, null);
	// The swatch that starts selected is the palette color the list would get; "Default" means none.
	const defaultColor = paletteColor([...host.app.store.state.categories.values()].filter((c) => !c.isInbox).length);
	await host.newList({
		defaultColor,
		// A rule violation (a duplicate name) comes back as text for the dialog, which stays open.
		create: async (values) => {
			try {
				await host.app.categories.create(values.name, values.icon, values.color);
				return null;
			} catch (err) {
				if (isDomainError(err)) return err.message;
				host.error(err);
				return null;
			}
		},
	});
}

async function editCategory(host: UiHost, category: Category | null): Promise<void> {
	const values = await host.prompt(
		category === null ? "New list" : "Edit list",
		[
			{ key: "name", label: "Name", value: category?.name ?? "", placeholder: "Study" },
		],
		category === null ? "Create" : "Save",
	);
	if (values === null) return;
	try {
		// The icon is chosen with "Change icon…"; editing the name leaves it as it is.
		if (category === null) await host.app.categories.create(values.name ?? "", null);
		else await host.app.categories.update(category.id, { name: values.name ?? "" });
	} catch (err) {
		host.error(err);
	}
}

/** The list icon, from a grid of Lucide names. Dismissing changes nothing. */
async function changeIcon(host: UiHost, category: Category): Promise<void> {
	if (host.pickIcon === undefined) return;
	const icon = await host.pickIcon(category.icon);
	if (icon === undefined) return;
	try {
		await host.app.categories.setIcon(category.id, icon);
	} catch (err) {
		host.error(err);
	}
}

/** The TickTick item of a list menu: link the list, or unlink it. Only where the host has the sync. */
function tickTickMenuItems(host: UiHost, state: DbData, category: Category): MenuSpec {
	const sync = host.tickTick;
	if (sync === undefined) return [];
	return [
		"separator",
		isListSynced(state.syncLinks, category.id)
			? { title: "Unlink from TickTick", icon: "unlink", run: () => void sync.unlink(category.id) }
			: { title: "Sync with TickTick…", icon: ICON.sync, run: () => void sync.link(category.id) },
		"separator",
	];
}

/** The list color, from the eight tag colors or none. */
function changeColor(host: UiHost, category: Category, at: MouseEvent): void {
	host.showMenu(at, [
		...TAG_COLORS.map((color) => ({
			title: capitalize(color),
			checked: category.color === color,
			run: () => void setColor(host, category, color),
		})),
		{ title: "None", checked: category.color === null, run: () => void setColor(host, category, null) },
	]);
}

async function setColor(host: UiHost, category: Category, color: TagColor | null): Promise<void> {
	try {
		await host.app.categories.setColor(category.id, color);
	} catch (err) {
		host.error(err);
	}
}

/** "N tasks will move to Inbox", then an Undo notice. */
async function deleteCategory(host: UiHost, category: Category, onDeleted: () => void): Promise<void> {
	const n = host.app.categories.taskCount(category.id);
	const ok = await host.choose(
		"Delete list",
		`Delete "${category.name}"? ${plural(n, "task")} will move to Inbox.`,
		[{ label: "Delete", value: true, warning: true }],
	);
	if (ok !== true) return;
	try {
		const mark = host.app.store.undoMark();
		await host.app.categories.delete(category.id);
		onDeleted();
		host.notifyUndo(`Deleted list "${category.name}".`, "Delete category", mark);
	} catch (err) {
		host.error(err);
	}
}

async function deleteTag(host: UiHost, tag: Tag, onDeleted: () => void): Promise<void> {
	const n = host.app.tags.usage(tag.key);
	const tasks = plural(n, "task");
	const label = tagLabel(host.app.store.state.tags, tag.key);
	// A parent tag with child tags: only this key goes, so the message says what stays.
	const isParent = [...host.app.store.state.tags.keys()].some((k) => k !== tag.key && isUnderTag(k, tag.key));
	const ok = await host.choose(
		"Delete tag",
		isParent ? `Remove the tag "${label}" from ${tasks}? Its child tags are kept.` : `Delete @${label}? It is removed from ${tasks}.`,
		[{ label: "Delete", value: true, warning: true }],
	);
	if (ok !== true) return;
	try {
		const mark = host.app.store.undoMark();
		const result = await host.app.tags.delete(tag.key);
		onDeleted();
		// A tag already gone and unused: nothing was written, so no notice and no Undo.
		notifyWrite(host, result, `Deleted tag @${label}.`, mark);
	} catch (err) {
		host.error(err);
	}
}

/** The emoji a new database seeds Inbox with (persistence/schema); the design shows the Lucide inbox instead. */
const SEEDED_INBOX_ICON = "\u{1F4E5}";

/** The icon props of a category row: Lucide name, legacy emoji, or the fallback. */
function listIconProps(stored: string | null, fallback: string): { icon: string | null; emoji: string | null } {
	const i = categoryIcon(stored, fallback);
	return i.kind === "emoji" ? { icon: null, emoji: i.text } : { icon: i.name, emoji: null };
}

export function Sidebar(props: {
	host: UiHost;
	state: DbData;
	counts: SidebarCounts;
	view: TaskView;
	onView: (v: TaskView) => void;
}) {
	const { host, state, counts, view, onView } = props;
	const labelId = useUniqueId("cp-sidebar-label");
	const is = (v: TaskView) => sameView(view, v);
	const categories = host.app.categories.list().filter((c) => c.id !== INBOX_ID);
	const inbox = state.categories.get(INBOX_ID);
	const toInbox = () => onView({ kind: "inbox" });
	// Folded parent tags; per mounted view, not saved.
	const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
	const toggleFold = (key: string) =>
		setFolded((prev) => {
			const next = new Set(prev);
			if (!next.delete(key)) next.add(key);
			return next;
		});
	// Opening a tag view (here or from elsewhere) opens its collapsed ancestors; folding afterwards sticks.
	const openKey = view.kind === "tag" ? view.key : null;
	useEffect(() => {
		if (openKey === null) return;
		const path = tagPath(openKey);
		const above = path.slice(0, -1).map((_, i) => path.slice(0, i + 1).join("/"));
		setFolded((prev) => (above.some((k) => prev.has(k)) ? new Set([...prev].filter((k) => !above.includes(k))) : prev));
	}, [openKey]);
	const tree = useMemo(() => tagTree(state.tags.values(), counts.tags), [state.tags, counts.tags]);

	const categoryMenu = (c: Category) => (e: MouseEvent) =>
		host.showMenu(e, [
			{ title: "Edit", icon: "pencil", run: () => void editCategory(host, c) },
			{ title: "Change icon…", icon: "smile-plus", run: () => void changeIcon(host, c) },
			{ title: "Change color…", icon: "palette", run: () => changeColor(host, c, e) },
			...tickTickMenuItems(host, state, c),
			{ title: "Move up", icon: "arrow-up", run: () => void host.app.categories.move(c.id, -1) },
			{ title: "Move down", icon: "arrow-down", run: () => void host.app.categories.move(c.id, 1) },
			...(c.isInbox
				? []
				: [
						"separator" as const,
						{
							title: "Delete",
							icon: "trash-2",
							warning: true,
							run: () => void deleteCategory(host, c, () => is({ kind: "category", id: c.id }) && toInbox()),
						},
					]),
		]);

	// After a delete: an open tag view with no tag record left at or under its key has nothing to show.
	const leaveDeletedTagView = () => {
		if (view.kind !== "tag") return;
		const key = view.key;
		if (!hasTagOrChild(host.app.store.state.tags.keys(), key)) toInbox();
	};

	const tagMenu = (t: Tag) => (e: MouseEvent) =>
		host.showMenu(e, [
			...[null, ...TAG_COLORS].map((color) => ({
				title: color === null ? "No color" : `Color: ${color}`,
				checked: t.color === color,
				run: () => void host.app.tags.setColor(t.key, color),
			})),
			"separator" as const,
			{
				title: "Delete",
				icon: "trash-2",
				warning: true,
				run: () => void deleteTag(host, t, leaveDeletedTagView),
			},
		]);

	return (
		<nav class="cp-sidebar" aria-labelledby={labelId}>
			<SrOnly id={labelId}>Task lists</SrOnly>
			<ul class="cp-sidebar-list">
				<Item host={host} icon={ICON.today} label="Today" count={counts.today} active={is({ kind: "today" })} onClick={() => onView({ kind: "today" })} />
				<Item
					host={host}
					icon={ICON.upcoming}
					label="Upcoming"
					count={counts.upcoming}
					active={is({ kind: "upcoming" })}
					onClick={() => onView({ kind: "upcoming" })}
				/>
				<Item
					host={host}
					{...listIconProps(inbox?.icon === SEEDED_INBOX_ICON ? null : (inbox?.icon ?? null), ICON.inbox)}
					label={inbox?.name ?? INBOX_NAME}
					count={counts.categories.get(INBOX_ID)}
					synced={isListSynced(state.syncLinks, INBOX_ID)}
					active={is({ kind: "inbox" })}
					color={inbox?.color}
					onClick={toInbox}
					onContextMenu={inbox === undefined ? undefined : categoryMenu(inbox)}
				/>
			</ul>
			<div class="cp-sidebar-heading">
				<span>Lists</span>
				<IconButton host={host} icon={ICON.add} label="New list" cls="cp-sidebar-add" onClick={() => void newCategory(host)} />
			</div>
			<ul class="cp-sidebar-list">
				{categories.map((c) => (
					<Item
						key={c.id}
						host={host}
						{...listIconProps(c.icon, ICON.list)}
						label={c.name}
						color={c.color}
						count={counts.categories.get(c.id)}
						synced={isListSynced(state.syncLinks, c.id)}
						active={is({ kind: "category", id: c.id })}
						onClick={() => onView({ kind: "category", id: c.id })}
						onContextMenu={categoryMenu(c)}
					/>
				))}
			</ul>
			{state.tags.size > 0 && (
				<>
					<div class="cp-sidebar-heading">
						<span>Tags</span>
					</div>
					<ul class="cp-sidebar-list cp-tag-tree">
							{tree.map((n) => (
								<TagBranch
									key={n.key}
									host={host}
									node={n}
									depth={0}
									view={view}
									folded={folded}
									onFold={toggleFold}
									onView={onView}
									menuFor={tagMenu}
								/>
							))}
						</ul>
				</>
			)}
			<ul class="cp-sidebar-list cp-sidebar-footer">
				<Item host={host} icon={ICON.completed} label="Completed" active={is({ kind: "completed" })} onClick={() => onView({ kind: "completed" })} />
				<Item host={host} icon={ICON.trash} label="Trash" count={counts.trash} active={is({ kind: "trash" })} onClick={() => onView({ kind: "trash" })} />
			</ul>
		</nav>
	);
}
