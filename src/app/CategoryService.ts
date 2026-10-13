import { DomainError } from "../domain/errors";
import type { IdGenerator } from "../domain/ports";
import { keyAfter, rekeyOrder } from "../domain/sortKey";
import {
	TAG_FLAT_PARENT_MESSAGE,
	TAG_WITH_CHILDREN_MESSAGE,
	isUnderTag,
	newTagProblem,
	normalizeTagKey,
	requireTagDepth,
	requireTagKey,
	requireUniqueTagName,
	tagDisplayLeaf,
	tagDisplayName,
	tagDisplayPath,
	tagDisplaySegments,
	tagLeaf,
	tagNameClashMessage,
	tagPath,
} from "../domain/tags";
import {
	assertUniqueCategoryName,
	categoryNameKey,
	compareCategories,
	listsInSidebarOrder,
	requireCategoryName,
	requireColor,
	requireIconName,
} from "../domain/tasks";
import { type Category, type ID, INBOX_ID, type Tag, type TagColor, paletteColor, syncLinkId } from "../domain/types";
import type { AppStore } from "./store";
import type { TaskIndex } from "./taskIndex";
import type { Tx } from "./tx";
import type { WriteResult } from "./writes";

// Categories (lists) and tags.

export class CategoryService {
	constructor(
		private readonly store: AppStore,
		private readonly ids: IdGenerator,
		/** The task index: the synced-list cap a delete's move into Inbox obeys, and a list's task count. */
		private readonly lists: TaskIndex,
	) {}

	/** The lists in sidebar order, Inbox first. */
	list(): Category[] {
		return listsInSidebarOrder(this.store.state.categories.values());
	}

	/** Explicit creation from list management only. */
	create(name: string, icon: string | null = null, color?: TagColor | null): Promise<Category> {
		return this.store.run("Create category", (tx) => {
			const clean = requireCategoryName(name);
			assertUniqueCategoryName(tx.all("categories"), clean, null);
			const category: Category = {
				id: this.ids(),
				name: clean,
				icon: icon?.trim() || null,
				// An explicit color (null = default) is kept. Without one a new list starts colored;
				// Inbox is not counted, so the first list is red.
				color: color === undefined ? paletteColor(tx.all("categories").filter((c) => !c.isInbox).length) : requireColor(color),
				nameKey: categoryNameKey(clean),
				isInbox: false,
				sortKey: keyAfter(tx.all("categories").map((c) => c.sortKey)),
				createdAt: tx.now,
				modifiedAt: tx.now,
			};
			tx.put("categories", category);
			return category;
		});
	}

	/** The ID and membership stay. Inbox can be renamed for display. */
	update(id: ID, patch: { name?: string; icon?: string | null }): Promise<Category> {
		return this.store.run("Edit category", (tx) => {
			const current = tx.get("categories", id);
			if (current === undefined) throw new DomainError("NotFound", "The list no longer exists.");
			const next: Category = { ...current };
			if (patch.name !== undefined) {
				next.name = requireCategoryName(patch.name);
				assertUniqueCategoryName(tx.all("categories"), next.name, id);
				next.nameKey = categoryNameKey(next.name);
			}
			if (patch.icon !== undefined) next.icon = patch.icon?.trim() || null;
			if (next.name === current.name && next.icon === current.icon) return current;
			next.modifiedAt = tx.now;
			tx.put("categories", next);
			return next;
		});
	}

	/**
	 * A Lucide icon name (/^[a-z0-9-]{1,40}$/) or null. A value equal to the stored icon is
	 * accepted as is, so a legacy emoji icon can be kept.
	 */
	setIcon(id: ID, icon: string | null): Promise<Category> {
		return this.store.run("Change category icon", (tx) => {
			const current = tx.get("categories", id);
			if (current === undefined) throw new DomainError("NotFound", "The list no longer exists.");
			const next = icon === null ? null : icon.trim() || null;
			requireIconName(next, current.icon);
			if (next === current.icon) return current;
			const category: Category = { ...current, icon: next, modifiedAt: tx.now };
			tx.put("categories", category);
			return category;
		});
	}

	/** The list color, or null for the default. */
	setColor(id: ID, color: TagColor | null): Promise<Category> {
		return this.store.run("Change category color", (tx) => {
			const current = tx.get("categories", id);
			if (current === undefined) throw new DomainError("NotFound", "The list no longer exists.");
			requireColor(color);
			if (color === current.color) return current;
			const category: Category = { ...current, color, modifiedAt: tx.now };
			tx.put("categories", category);
			return category;
		});
	}

	/**
	 * Moves a list one place up or down among the lists after the Inbox, which stays first. The Inbox does not move,
	 * and neither does a list at either end: nothing is written. Lists that share a key get new ascending ones.
	 */
	move(id: ID, direction: -1 | 1): Promise<void> {
		return this.store.run("Reorder categories", (tx) => {
			const order = listsInSidebarOrder(tx.all("categories")).filter((c) => c.id !== INBOX_ID);
			const i = order.findIndex((c) => c.id === id);
			const target = i + direction;
			if (i < 0 || target < 0 || target >= order.length) return;
			[order[i], order[target]] = [order[target]!, order[i]!];
			for (const [c, sortKey] of rekeyOrder(order, target, [], compareCategories)) {
				if (sortKey !== c.sortKey) tx.put("categories", { ...c, sortKey, modifiedAt: tx.now });
			}
		});
	}

	/** Tasks (open and completed) that a delete would move, for the delete prompt. */
	taskCount(id: ID): number {
		const tasks = this.store.state.tasks;
		return this.lists.tasksOf((tid) => tasks.get(tid), id).length;
	}

	/**
	 * Tasks move to Inbox in the same write; undo restores both. Refused when the move would take a synced Inbox past
	 * its open-task cap. A list linked to TickTick is unlinked in the same write (its link and its sections' links go);
	 * its tasks keep their links, so the next sync treats them as moved to the Inbox.
	 */
	delete(id: ID): Promise<number> {
		return this.store.run("Delete category", (tx) => {
			if (id === INBOX_ID) throw new DomainError("InboxProtected", "The Inbox cannot be deleted.");
			if (tx.get("categories", id) === undefined) throw new DomainError("NotFound", "The list no longer exists.");
			let moved = 0;
			for (const t of tx.all("tasks")) {
				if (t.categoryId !== id) continue;
				// The list's sections go with it, so the tasks land in Inbox with no section.
				tx.put("tasks", { ...t, categoryId: INBOX_ID, sectionId: null, modifiedAt: tx.now });
				moved++;
			}
			for (const s of tx.all("sections")) {
				if (s.categoryId !== id) continue;
				tx.remove("sections", s.id);
				tx.remove("syncLinks", syncLinkId("section", s.id));
			}
			tx.remove("syncLinks", syncLinkId("list", id));
			tx.remove("categories", id);
			this.lists.assertSyncedRoom(tx);
			return moved;
		});
	}
}

/** The store labels of the tag writes; a notice's Undo names its write by them. */
export const CREATE_TAG_LABEL = "Create tag";
export const EDIT_TAG_LABEL = "Edit tag";
export const DELETE_TAG_LABEL = "Delete tag";

/** A tag key that a write moved (an edit, or a parent's delete moving a child to the top level): before and after. */
export interface TagMove {
	from: string;
	to: string;
}

/**
 * Throws when `parent` cannot take a tag: NotFound when it is not a tag, InvalidTag when it is not top-level or is the
 * tag being edited (`self`).
 */
function requireTagParent(tags: ReadonlyMap<string, Tag>, parent: string, self: string | null): void {
	if (!tags.has(parent)) throw new DomainError("NotFound", "The parent tag no longer exists.");
	if (parent.includes("/") || parent === self) throw new DomainError("InvalidTag", "Pick a top-level tag as the parent.");
}

export class TagService {
	constructor(private readonly store: AppStore) {}

	list(): Tag[] {
		return [...this.store.state.tags.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
	}

	/** Resolves a raw name to an existing tag key, or null. */
	resolve(raw: string): string | null {
		const key = requireTagKey(raw);
		return this.store.state.tags.has(key) ? key : null;
	}

	/** Explicit creation. An existing key is returned unchanged. */
	create(raw: string, color?: TagColor | null): Promise<Tag> {
		return this.store.run(CREATE_TAG_LABEL, (tx) => TagService.createIn(tx, raw, color));
	}

	/**
	 * The New tag dialog: `name` under `parent` (a top-level tag, or null) with `color` (null = none). Unlike `create`,
	 * a tag that exists already is refused.
	 */
	add(name: string, parent: string | null, color: TagColor | null): Promise<Tag & WriteResult> {
		return this.store.run(CREATE_TAG_LABEL, (tx) => {
			const tags = tx.map("tags");
			if (parent !== null) requireTagParent(tags, parent, null);
			const problem = newTagProblem(tags, name, parent);
			if (problem !== null) throw new DomainError("InvalidTag", problem);
			const display = tagDisplayName(name);
			// The tag is new (a repeat was refused above), so this always wrote.
			const tag = TagService.createIn(tx, parent === null ? display : `${tagDisplayPath(tags, parent)}/${display}`, color);
			return { ...tag, wrote: true, label: CREATE_TAG_LABEL };
		});
	}

	/**
	 * `create` inside the caller's transaction (Quick Add makes its new tags in the task's write). A missing parent is
	 * created first, with the next palette color (rule 26); `color` is the new tag's own.
	 */
	static createIn(tx: Tx, raw: string, color?: TagColor | null): Tag {
		const key = requireTagKey(raw);
		const existing = tx.get("tags", key);
		if (existing !== undefined) return existing;
		requireTagDepth(key);
		// A name is used once, whatever its parent; a missing parent's name is checked too.
		requireUniqueTagName(tx.map("tags"), key);
		const typed = tagDisplayName(raw).split("/");
		const path = tagPath(key);
		if (path.length === 1) return TagService.putNew(tx, key, typed.join("/"), color);
		// The parent's part of the display name is the parent's own, so a child always reads as its parent does.
		const parentKey = path.slice(0, -1).join("/");
		const parent = tx.get("tags", parentKey) ?? TagService.putNew(tx, parentKey, typed.slice(0, -1).join("/"), undefined);
		return TagService.putNew(tx, key, `${parent.displayName}/${typed[typed.length - 1]!}`, color);
	}

	/** Writes a new tag record. No color given: the palette color by the number of tags. An explicit null means none. */
	private static putNew(tx: Tx, key: string, displayName: string, color: TagColor | null | undefined): Tag {
		const tag: Tag = {
			key,
			displayName,
			color: color === undefined ? paletteColor(tx.all("tags").length) : color,
			createdAt: tx.now,
			modifiedAt: tx.now,
		};
		tx.put("tags", tag);
		return tag;
	}

	/**
	 * Gives every live task (modifiedAt now) and trashed task (modifiedAt kept) holding a moving key its new key, or
	 * drops the key where the new one is null, each key once. Returns the number of live tasks and trash entries changed.
	 */
	private static rekeyTasks(tx: Tx, moves: ReadonlyMap<string, string | null>): { tasks: number; trash: number } {
		let tasks = 0;
		let trash = 0;
		if (moves.size === 0) return { tasks, trash };
		const holds = (keys: readonly string[]) => keys.some((k) => moves.has(k));
		const rekey = (keys: readonly string[]): string[] => {
			const out = new Set<string>();
			for (const k of keys) {
				const to = moves.get(k);
				if (to === undefined) out.add(k);
				else if (to !== null) out.add(to);
			}
			return [...out];
		};
		for (const t of tx.all("tasks")) {
			if (!holds(t.tagKeys)) continue;
			tx.put("tasks", { ...t, tagKeys: rekey(t.tagKeys), modifiedAt: tx.now });
			tasks++;
		}
		// Trashed tasks keep their state as deleted; only the keys change.
		for (const e of tx.all("trash")) {
			if (!e.tasks.some((t) => holds(t.tagKeys))) continue;
			tx.put("trash", { ...e, tasks: e.tasks.map((t) => (holds(t.tagKeys) ? { ...t, tagKeys: rekey(t.tagKeys) } : t)) });
			trash++;
		}
		return { tasks, trash };
	}

	setColor(key: string, color: TagColor | null): Promise<void> {
		return this.store.run(EDIT_TAG_LABEL, (tx) => {
			const tag = tx.get("tags", key);
			if (tag === undefined) throw new DomainError("NotFound", "The tag no longer exists.");
			tx.put("tags", { ...tag, color, modifiedAt: tx.now });
		});
	}

	/**
	 * The Edit tag dialog: rename, move under a top-level tag or to the top, and recolor, in one write. The tag's
	 * children move with it, and every live task (modifiedAt now) and trashed task (modifiedAt kept) holding a moving key
	 * gets the new one. A name in use is refused (two tags are never merged); a tag with children takes no new parent.
	 * `key` is the tag's key after the edit. An edit that changes nothing writes nothing.
	 */
	edit(key: string, values: { name: string; parentKey: string | null; color: TagColor | null }): Promise<WriteResult & { key: string }> {
		const label = EDIT_TAG_LABEL;
		return this.store.run(label, (tx) => {
			const tag = tx.get("tags", key);
			if (tag === undefined) throw new DomainError("NotFound", "The tag no longer exists.");
			const { name, parentKey, color } = values;
			const tags = tx.map("tags");
			const path = tagPath(key);
			const currentParent = path.length > 1 ? path.slice(0, -1).join("/") : null;
			const children = tx.all("tags").filter((t) => t.key !== key && isUnderTag(t.key, key));
			// Keeping the current parent is always allowed, so a deeper tag from an older file can still be renamed.
			if (parentKey !== currentParent && parentKey !== null) {
				if (path.length === 1 && key.includes("/")) throw new DomainError("InvalidTag", TAG_FLAT_PARENT_MESSAGE);
				if (children.length > 0) throw new DomainError("InvalidTag", TAG_WITH_CHILDREN_MESSAGE);
				requireTagParent(tags, parentKey, key);
			}
			const problem = newTagProblem(tags, name, parentKey, key);
			if (problem !== null) throw new DomainError("InvalidTag", problem);

			const leaf = normalizeTagKey(name);
			const newKey = parentKey === null ? leaf : `${parentKey}/${leaf}`;
			// The parent's part of the display name: the tag's own while the parent stays, else the parent's.
			const own = tagDisplaySegments(tag);
			const prefix = parentKey === null ? null : parentKey === currentParent && own !== null ? own.slice(0, -1).join("/") : tagDisplayPath(tags, parentKey);
			const newDisplay = prefix === null ? tagDisplayName(name) : `${prefix}/${tagDisplayName(name)}`;

			const keyMoves = new Map<string, string>();
			const next: Tag[] = [];
			for (const t of [tag, ...children]) {
				const k = t.key === key ? newKey : newKey + t.key.slice(key.length);
				let display = newDisplay;
				if (t.key !== key) {
					display = `${newDisplay}/${(tagDisplaySegments(t) ?? tagPath(t.key)).slice(path.length).join("/")}`;
				}
				const c = t.key === key ? color : t.color;
				if (k === t.key && display === t.displayName && c === t.color) continue;
				if (k !== t.key) keyMoves.set(t.key, k);
				// createdAt stays: it is what a tag owns its name by (rule 22).
				next.push({ ...t, key: k, displayName: display, color: c, modifiedAt: tx.now });
			}
			if (next.length === 0) return { wrote: false, label, key };
			for (const old of keyMoves.keys()) tx.remove("tags", old);
			for (const t of next) tx.put("tags", t);
			TagService.rekeyTasks(tx, keyMoves);
			return { wrote: true, label, key: newKey };
		});
	}

	usage(key: string): number {
		let n = 0;
		for (const t of this.store.state.tasks.values()) if (t.tagKeys.includes(key)) n++;
		return n;
	}

	/**
	 * Removes the tag and its key from every task, including tasks in Trash, in one write. Its child tags move to the
	 * top level (`home/calls` becomes `calls`, createdAt kept) on every task in the same write (rule 28). A child whose
	 * name is already a top-level tag (two tags of one name from an older file) refuses the delete, as a rename would. `tasks` counts
	 * the live tasks changed; `moves` lists the children moved; `wrote` is false when there was nothing to remove (the
	 * tag was already gone and unused).
	 */
	delete(key: string): Promise<WriteResult & { tasks: number; moves: TagMove[] }> {
		const label = DELETE_TAG_LABEL;
		return this.store.run(label, (tx) => {
			const keyMoves = new Map<string, string | null>([[key, null]]);
			const moves: TagMove[] = [];
			const children = tx.all("tags").filter((t) => t.key !== key && isUnderTag(t.key, key));
			const tags = tx.map("tags");
			// The tag each top-level key goes to; a child never lands on another tag (two tags are never merged).
			const holders = new Map<string, string>();
			for (const t of children.sort((a, b) => (a.key < b.key ? -1 : 1))) {
				const to = tagLeaf(t.key);
				const holder = to !== key && tags.has(to) ? to : holders.get(to);
				if (holder !== undefined) throw new DomainError("InvalidTag", tagNameClashMessage(tags, holder));
				holders.set(to, t.key);
				keyMoves.set(t.key, to);
				moves.push({ from: t.key, to });
			}
			const existed = tx.get("tags", key) !== undefined;
			tx.remove("tags", key);
			for (const t of children) tx.remove("tags", t.key);
			for (const t of children) tx.put("tags", { ...t, key: tagLeaf(t.key), displayName: tagDisplayLeaf(t), modifiedAt: tx.now });
			const changed = TagService.rekeyTasks(tx, keyMoves);
			return { wrote: existed || changed.tasks > 0 || changed.trash > 0, label, tasks: changed.tasks, moves };
		});
	}
}
