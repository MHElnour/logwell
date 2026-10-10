// TickTick's Inbox is not in the project list. It is read under the alias `inbox`, and its answers carry the
// real id, `inbox<digits>`. Both spell the same project.

/** True for the alias `inbox` and for a real Inbox id such as `inbox121212`. */
export function isInboxProjectId(id: string): boolean {
	return id === "inbox" || /^inbox\d+$/u.test(id);
}
