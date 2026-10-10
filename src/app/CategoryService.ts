import { DomainError } from "../domain/errors";
import type { IdGenerator } from "../domain/ports";
import { compareSortKeys, keyAfter, keyBetween } from "../domain/sortKey";
import { requireTagDepth, requireTagKey, requireUniqueTagName, tagDisplayName } from "../domain/tags";
import { assertUniqueCategoryName, categoryNameKey, requireCategoryName, requireColor, requireIconName } from "../domain/tasks";
import { type Category, type ID, INBOX_ID, type Tag, type TagColor, paletteColor } from "../domain/types";
import type { AppStore } from "./store";
import type { Tx } from "./tx";
import type { WriteResult } from "./writes";

// Categories (lists) and tags.

function sortedCategories(categories: Iterable<Category>): Category[] {
	return [...categories].sort((a, b) => compareSortKeys(a.sortKey, b.sortKey));
}

export class CategoryService {
	constructor(
		private readonly store: AppStore,
		private readonly ids: IdGenerator,
	) {}

	list(): Category[] {
		return sortedCategories(this.store.state.categories.values());
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

	/** Moves a category one place up or down in the sidebar. */
	move(id: ID, direction: -1 | 1): Promise<void> {
		return this.store.run("Reorder categories", (tx) => {
			const list = sortedCategories(tx.all("categories"));
			const i = list.findIndex((c) => c.id === id);
			const current = list[i];
			if (current === undefined) return;
			const target = i + direction;
			if (target < 0 || target >= list.length) return;
			const lo = direction < 0 ? (list[target - 1]?.sortKey ?? null) : (list[target]?.sortKey ?? null);
			const hi = direction < 0 ? (list[target]?.sortKey ?? null) : (list[target + 1]?.sortKey ?? null);
			tx.put("categories", { ...current, sortKey: keyBetween(lo, hi), modifiedAt: tx.now });
		});
	}

	/** Tasks (open and completed) that a delete would move, for the delete prompt. */
	taskCount(id: ID): number {
		let n = 0;
		for (const t of this.store.state.tasks.values()) if (t.categoryId === id) n++;
		return n;
	}

	/** Tasks move to Inbox in the same write; undo restores both. */
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
			for (const s of tx.all("sections")) if (s.categoryId === id) tx.remove("sections", s.id);
			tx.remove("categories", id);
			return moved;
		});
	}
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
		return this.store.run("Create tag", (tx) => TagService.createIn(tx, raw, color));
	}

	/** `create` inside the caller's transaction (Quick Add makes its new tags in the task's write). */
	static createIn(tx: Tx, raw: string, color?: TagColor | null): Tag {
		const key = requireTagKey(raw);
		const existing = tx.get("tags", key);
		if (existing !== undefined) return existing;
		requireTagDepth(key);
		// A name is used once, whatever its parent.
		requireUniqueTagName(tx.map("tags"), key);
		// No color given: rotate through the palette by the number of tags. An explicit null means none.
		const tag: Tag = {
			key,
			displayName: tagDisplayName(raw),
			color: color === undefined ? paletteColor(tx.all("tags").length) : color,
			createdAt: tx.now,
			modifiedAt: tx.now,
		};
		tx.put("tags", tag);
		return tag;
	}

	setColor(key: string, color: TagColor | null): Promise<void> {
		return this.store.run("Edit tag", (tx) => {
			const tag = tx.get("tags", key);
			if (tag === undefined) throw new DomainError("NotFound", "The tag no longer exists.");
			tx.put("tags", { ...tag, color, modifiedAt: tx.now });
		});
	}

	usage(key: string): number {
		let n = 0;
		for (const t of this.store.state.tasks.values()) if (t.tagKeys.includes(key)) n++;
		return n;
	}

	/**
	 * Removes the tag and its key from every task, including tasks in Trash, in one write. `tasks` counts the tasks
	 * changed; `wrote` is false when there was nothing to remove (the tag was already gone and unused).
	 */
	delete(key: string): Promise<WriteResult & { tasks: number }> {
		const label = "Delete tag";
		return this.store.run(label, (tx) => {
			let tasks = 0;
			let trashed = 0;
			for (const t of tx.all("tasks")) {
				if (!t.tagKeys.includes(key)) continue;
				tx.put("tasks", { ...t, tagKeys: t.tagKeys.filter((k) => k !== key), modifiedAt: tx.now });
				tasks++;
			}
			// Trashed tasks keep their state as deleted; only the dangling key goes.
			for (const e of tx.all("trash")) {
				if (!e.tasks.some((t) => t.tagKeys.includes(key))) continue;
				const kept = e.tasks.map((t) => (t.tagKeys.includes(key) ? { ...t, tagKeys: t.tagKeys.filter((k) => k !== key) } : t));
				tx.put("trash", { ...e, tasks: kept });
				trashed++;
			}
			const existed = tx.get("tags", key) !== undefined;
			tx.remove("tags", key);
			return { wrote: existed || tasks > 0 || trashed > 0, label, tasks };
		});
	}
}
