import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { DELETE_LIST_LABEL, type TagMove } from "../app/CategoryService";
import { isListSynced } from "../app/syncMarks";
import { type SidebarCounts, type TaskView, sameView } from "../app/views";
import { isDomainError } from "../domain/errors";
import { plural } from "../domain/text";
import {
	TAG_FLAT_PARENT_MESSAGE,
	TAG_WITH_CHILDREN_MESSAGE,
	type TagNode,
	isUnderTag,
	newTagProblem,
	tagDisplayLeaf,
	tagLabel,
	tagPath,
	tagTree,
} from "../domain/tags";
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
 * it: a button cannot hold a button). Every node is a tag, with its color and the same menu.
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
					onContextMenu={props.menuFor(tag)}
				>
					<span class={`cp-tag-dot cp-tag-${tag.color ?? "none"}`} aria-hidden="true" />
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
				return dialogMessage(host, err);
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
		host.notifyUndo(`Deleted list "${category.name}".`, DELETE_LIST_LABEL, mark);
	} catch (err) {
		host.error(err);
	}
}

/** The Parent choices of the tag dialog: the top-level tags of the tree by name, never `self`. */
function tagParents(tree: TagNode[], self: string | null): { key: string; label: string }[] {
	// A key with an empty segment ("a//b") is one flat tag, not a parent.
	return tree.filter((n) => !n.key.includes("/") && n.key !== self).map((n) => ({ key: n.key, label: n.name }));
}

/** A dialog refusal (a rule broken since the dialog opened) goes back to the dialog as text; anything else to the host. */
function dialogMessage(host: UiHost, err: unknown): string | null {
	if (isDomainError(err)) return err.message;
	host.error(err);
	return null;
}

/** New tag: one create call, so one undo entry; the dialog stays open on a refusal. */
async function newTag(host: UiHost, parents: { key: string; label: string }[]): Promise<void> {
	if (host.tagDialog === undefined) return;
	const tags = () => host.app.store.state.tags;
	await host.tagDialog({
		title: "New tag",
		submit: "Create",
		// The swatch that starts selected is the palette color the tag would get; "Default" means none.
		initial: { name: "", parent: null, color: paletteColor(tags().size) },
		parents,
		parentLock: null,
		check: (name, parent) => newTagProblem(tags(), name, parent),
		save: async (values) => {
			try {
				const mark = host.app.store.undoMark();
				const tag = await host.app.tags.add(values.name, values.parent, values.color);
				notifyWrite(host, tag, `Created tag @${tagLabel(tags(), tag.key)}.`, mark);
				return null;
			} catch (err) {
				return dialogMessage(host, err);
			}
		},
	});
}

/** Edit tag: rename, parent and color in one write. `onMoved` gets the move when the key changed. */
async function editTag(host: UiHost, tag: Tag, parents: { key: string; label: string }[], onMoved: (moves: readonly TagMove[]) => void): Promise<void> {
	if (host.tagDialog === undefined) return;
	const tags = () => host.app.store.state.tags;
	const path = tagPath(tag.key);
	const name = tagDisplayLeaf(tag);
	const hasChildren = [...tags().keys()].some((k) => k !== tag.key && isUnderTag(k, tag.key));
	// The same reasons, in the same order, as TagService.edit refuses a new parent.
	const flat = path.length === 1 && tag.key.includes("/");
	await host.tagDialog({
		title: "Edit tag",
		submit: "Save",
		initial: { name, parent: path.length > 1 ? path.slice(0, -1).join("/") : null, color: tag.color },
		parents,
		parentLock: flat ? TAG_FLAT_PARENT_MESSAGE : hasChildren ? TAG_WITH_CHILDREN_MESSAGE : null,
		check: (typed, parent) => newTagProblem(tags(), typed, parent, tag.key),
		save: async (values) => {
			try {
				const before = tagLabel(tags(), tag.key);
				const mark = host.app.store.undoMark();
				const result = await host.app.tags.edit(tag.key, { name: values.name, parentKey: values.parent, color: values.color });
				if (result.key !== tag.key) onMoved([{ from: tag.key, to: result.key }]);
				const after = tagLabel(tags(), result.key);
				notifyWrite(host, result, values.name !== name ? `Renamed tag @${before} to @${after}.` : `Updated tag @${after}.`, mark);
				return null;
			} catch (err) {
				return dialogMessage(host, err);
			}
		},
	});
}

/** Delete tag: one write; a parent's child tags move to the top level. `onDeleted` gets the children's moves. */
async function deleteTag(host: UiHost, tag: Tag, onDeleted: (moves: readonly TagMove[]) => void): Promise<void> {
	const n = host.app.tags.usage(tag.key);
	const tasks = plural(n, "task");
	const label = tagLabel(host.app.store.state.tags, tag.key);
	// A parent tag with child tags: the message says where they go.
	const isParent = [...host.app.store.state.tags.keys()].some((k) => k !== tag.key && isUnderTag(k, tag.key));
	const ok = await host.choose(
		"Delete tag",
		// No "removed from 0 tasks" when no task holds the tag itself.
		n === 0
			? `Delete @${label}?${isParent ? " Its child tags move to the top level." : ""}`
			: `Delete @${label}? It is removed from ${tasks}${isParent ? ", and its child tags move to the top level" : ""}.`,
		[{ label: "Delete", value: true, warning: true }],
	);
	if (ok !== true) return;
	try {
		const mark = host.app.store.undoMark();
		const result = await host.app.tags.delete(tag.key);
		onDeleted(result.moves);
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

	const categoryMenu = (c: Category) => (e: MouseEvent) => {
		const items: MenuSpec = [
			{ title: "Edit", icon: "pencil", run: () => void editCategory(host, c) },
			{ title: "Change icon…", icon: "smile-plus", run: () => void changeIcon(host, c) },
			{ title: "Change color…", icon: "palette", run: () => changeColor(host, c, e) },
			...tickTickMenuItems(host, state, c),
		];
		if (c.isInbox) {
			// The Inbox stays first and cannot be deleted: no Move or Delete items.
			if (items.at(-1) === "separator") items.pop();
		} else {
			// Lists move among the lists after the Inbox, never past either end.
			const place = categories.findIndex((x) => x.id === c.id);
			items.push(
				{ title: "Move up", icon: "arrow-up", disabled: place <= 0, run: () => void host.app.categories.move(c.id, -1) },
				{ title: "Move down", icon: "arrow-down", disabled: place === categories.length - 1, run: () => void host.app.categories.move(c.id, 1) },
				"separator",
				{
					title: "Delete",
					icon: "trash-2",
					warning: true,
					run: () => void deleteCategory(host, c, () => is({ kind: "category", id: c.id }) && toInbox()),
				},
			);
		}
		host.showMenu(e, items);
	};

	// After an edit or a delete: an open tag view at or under a moved key follows to the new one (the latest view,
	// since the dialog stays open across renders); a view whose tag is gone goes to Inbox.
	const viewRef = useRef(view);
	viewRef.current = view;
	const followMovedTags = (moves: readonly TagMove[]) => {
		const current = viewRef.current;
		if (current.kind !== "tag") return;
		// The view's own tag, else its closest moved ancestor: a delete moves each child to the top on its own.
		let move: TagMove | undefined;
		for (const m of moves) if (isUnderTag(current.key, m.from) && (move === undefined || m.from.length > move.from.length)) move = m;
		if (move !== undefined) onView({ kind: "tag", key: move.to + current.key.slice(move.from.length) });
		else if (!host.app.store.state.tags.has(current.key)) toInbox();
	};

	const tagMenu = (t: Tag) => (e: MouseEvent) =>
		host.showMenu(e, [
			...(host.tagDialog === undefined
				? []
				: [{ title: "Edit", icon: "pencil", run: () => void editTag(host, t, tagParents(tree, t.key), followMovedTags) }, "separator" as const]),
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
				run: () => void deleteTag(host, t, followMovedTags),
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
			<div class="cp-sidebar-heading">
				<span>Tags</span>
				{host.tagDialog !== undefined && (
					<IconButton host={host} icon={ICON.add} label="New tag" cls="cp-sidebar-add" onClick={() => void newTag(host, tagParents(tree, null))} />
				)}
			</div>
			{tree.length > 0 && (
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
			)}
			<ul class="cp-sidebar-list cp-sidebar-footer">
				<Item host={host} icon={ICON.completed} label="Completed" active={is({ kind: "completed" })} onClick={() => onView({ kind: "completed" })} />
				<Item host={host} icon={ICON.trash} label="Trash" count={counts.trash} active={is({ kind: "trash" })} onClick={() => onView({ kind: "trash" })} />
			</ul>
		</nav>
	);
}
