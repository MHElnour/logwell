import { type TagNames, isValidTagKey, normalizeTagKey, tagLeaf, tagPath } from "../tags";

// How Logwell tags map to TickTick tags. A TickTick task carries tag NAMES: lowercase, the
// leaf only, never a path (a slash would be stored literally). Names are unique across a TickTick account, as they are
// in Logwell. A Logwell tag syncs when it owns its name (an older duplicate wins), has at most one parent, and its
// parent owns its name too.

/** A TickTick tag name as Logwell would hold it (lowercase), or null when it is not a valid one-segment key. */
export function ttTagName(raw: string): string | null {
	const name = normalizeTagKey(raw);
	return name !== "" && !name.includes("/") && isValidTagKey(name) ? name : null;
}

/** Whether a Logwell tag key goes up to TickTick. */
export function isSyncedTag(names: TagNames, key: string): boolean {
	const path = tagPath(key);
	if (path.length > 2 || (path.length === 1 && key.includes("/"))) return false;
	if (names.owner(path[path.length - 1]!) !== key) return false;
	return path.length === 1 || names.owner(path[0]!) === path[0];
}

/** The TickTick names of a task's synced tags: sorted, each once. */
export function syncedTagLeaves(names: TagNames, keys: readonly string[]): string[] {
	const out = new Set<string>();
	for (const key of keys) if (isSyncedTag(names, key)) out.add(tagLeaf(key));
	return [...out].sort();
}

/**
 * A TickTick task's tag name that Logwell takes in, lowercase; null when Logwell cannot hold it (not a valid key) or
 * its name belongs to a Logwell tag that does not sync. Such a name stays on the TickTick task and is never pulled.
 */
export function pullableTagName(names: TagNames, raw: string): string | null {
	const name = ttTagName(raw);
	if (name === null) return null;
	const owner = names.owner(name);
	return owner === undefined || isSyncedTag(names, owner) ? name : null;
}
