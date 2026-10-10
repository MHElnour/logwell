import { DomainError } from "../domain/errors";
import type { IdGenerator } from "../domain/ports";
import { assertUniqueSectionName, requireSectionName, sectionsOfList } from "../domain/sections";
import { categoryNameKey } from "../domain/tasks";
import { keyAfter, rekeyOrder } from "../domain/sortKey";
import type { ID, Section } from "../domain/types";
import type { AppStore } from "./store";
import type { Tx } from "./tx";

// Sections: named groups of tasks inside one list. Every method is one store.run.

function requireSection(tx: Tx, id: ID): Section {
	const s = tx.get("sections", id);
	if (s === undefined) throw new DomainError("NotFound", "The section no longer exists.");
	return s;
}

export class SectionService {
	constructor(
		private readonly store: AppStore,
		private readonly ids: IdGenerator,
	) {}

	/** The sections of a list, ordered by sortKey. */
	inList(categoryId: ID): Section[] {
		return sectionsOfList(this.store.state.sections.values(), categoryId);
	}

	/** The name is trimmed, not empty, and unique in the list ignoring case. */
	create(categoryId: ID, name: string): Promise<Section> {
		return this.store.run("Create section", (tx) => this.createIn(tx, categoryId, name));
	}

	/** `create` inside the caller's transaction (a TickTick column becomes a section in the sync's write). */
	createIn(tx: Tx, categoryId: ID, name: string): Section {
		const clean = requireSectionName(name);
		if (tx.get("categories", categoryId) === undefined) throw new DomainError("NotFound", "The list no longer exists.");
		assertUniqueSectionName(tx.all("sections"), categoryId, clean, null);
		const section: Section = {
			id: this.ids(),
			categoryId,
			name: clean,
			nameKey: categoryNameKey(clean),
			sortKey: keyAfter(tx.all("sections").filter((s) => s.categoryId === categoryId).map((s) => s.sortKey)),
			createdAt: tx.now,
			modifiedAt: tx.now,
		};
		tx.put("sections", section);
		return section;
	}

	rename(id: ID, name: string): Promise<Section> {
		return this.store.run("Rename section", (tx) => {
			const current = requireSection(tx, id);
			const clean = requireSectionName(name);
			assertUniqueSectionName(tx.all("sections"), current.categoryId, clean, id);
			if (clean === current.name) return current;
			const next: Section = { ...current, name: clean, nameKey: categoryNameKey(clean), modifiedAt: tx.now };
			tx.put("sections", next);
			return next;
		});
	}

	/** The section's tasks (subtasks included) move to No section in the same write; returns their count. */
	delete(id: ID): Promise<number> {
		return this.store.run("Delete section", (tx) => {
			requireSection(tx, id);
			let moved = 0;
			for (const t of tx.all("tasks")) {
				if (t.sectionId !== id) continue;
				tx.put("tasks", { ...t, sectionId: null, modifiedAt: tx.now });
				moved++;
			}
			tx.remove("sections", id);
			return moved;
		});
	}

	/**
	 * Puts `id` at its place in `order` (sections of one list, `id` included). The key rules are those of
	 * `TaskService.place`: `id` gets a key strictly between its neighbours; when the other keys are not
	 * strictly ascending, all of `order` gets new ascending keys inside the interval of the neighbouring
	 * sections outside `order`.
	 */
	place(id: ID, order: ID[]): Promise<{ changed: boolean }> {
		return this.store.run("Move section", (tx) => {
			if (!order.includes(id)) throw new DomainError("InvalidValue", "The section is not in the order.");
			if (new Set(order).size !== order.length) throw new DomainError("InvalidValue", "The order lists a section twice.");
			const sections = order.map((oid) => requireSection(tx, oid));
			const categoryId = sections[0]!.categoryId;
			if (sections.some((s) => s.categoryId !== categoryId)) {
				throw new DomainError("InvalidValue", "Only sections of one list can be reordered together.");
			}
			const keys = sections.map((s) => s.sortKey);
			const rewritten = new Map<ID, string>();
			// Already in this order: nothing to write.
			if (!keys.every((k, n) => n === 0 || keys[n - 1]! < k)) {
				const inOrder = new Set(order);
				const placed = rekeyOrder(keys, order.indexOf(id), tx.map("sections").values(), (s) => inOrder.has(s.id) || s.categoryId !== categoryId);
				order.forEach((oid, n) => rewritten.set(oid, placed[n]!));
			}
			let changed = false;
			for (const s of sections) {
				const sortKey = rewritten.get(s.id);
				if (sortKey === undefined || sortKey === s.sortKey) continue;
				tx.put("sections", { ...s, sortKey, modifiedAt: tx.now });
				changed = true;
			}
			return { changed };
		});
	}
}
