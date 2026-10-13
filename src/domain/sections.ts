import { DomainError } from "./errors";
import { compareSortKeys } from "./sortKey";
import { categoryNameKey } from "./tasks";
import type { ID, Section } from "./types";

// Section names: unique per list, compared case-insensitively by the same key as list names.

export function requireSectionName(raw: string): string {
	const name = raw.normalize("NFC").trim();
	if (name.length === 0) throw new DomainError("InvalidValue", "A section needs a name.");
	return name;
}

export function assertUniqueSectionName(sections: Iterable<Section>, categoryId: ID, name: string, exceptId: ID | null): void {
	const key = categoryNameKey(name);
	for (const s of sections) {
		if (s.categoryId === categoryId && s.id !== exceptId && s.nameKey === key) {
			throw new DomainError("DuplicateName", `A section named "${s.name}" already exists in this list.`);
		}
	}
}

/** The order of a list's sections: by sortKey, then id for equal keys. */
export function compareSections(a: Section, b: Section): number {
	return compareSortKeys(a.sortKey, b.sortKey) || compareSortKeys(a.id, b.id);
}

/** The sections of one list, in their order (`compareSections`). */
export function sectionsOfList(sections: Iterable<Section>, categoryId: ID): Section[] {
	return [...sections].filter((s) => s.categoryId === categoryId).sort(compareSections);
}
