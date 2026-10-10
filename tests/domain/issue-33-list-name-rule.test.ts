import { describe, expect, it } from "vitest";
import { runBlockQuery } from "../../src/domain/blockQuery";
import { resolveListName } from "../../src/domain/tasks";
import type { Category } from "../../src/domain/types";
import { parseBlockQuery } from "../../src/parsing/blockQuery";
import { blockOpenView } from "../../src/app/blockView";
import { parseQuickAdd } from "../../src/parsing";
import { makeCtx } from "../parsing/helpers";

// One list-name rule for Quick Add `#list` and the block `list:` filter (Quick Add rule 30, Task block rule 2):
// the exact name ignoring case first, else ignoring case, spaces, "-" and "_"; several loose matches are ambiguous.

const TS = "2026-09-01T09:00:00.000Z";

function list(id: string, name: string): Category {
	return { id, name, icon: null, color: null, nameKey: name.trim().toLowerCase(), isInbox: id === "inbox", sortKey: id, createdAt: TS, modifiedAt: TS };
}

const INBOX = list("inbox", "Inbox");
const SPACED = list("spaced", "Home work");
const DASHED = list("dashed", "Home-work");
const WORK = list("work", "Work");

describe("resolveListName", () => {
	it("the exact name ignoring case wins over a looser match", () => {
		const r = resolveListName([SPACED, DASHED], "home-work");
		expect(r).toEqual({ kind: "one", list: DASHED });
		expect(resolveListName([DASHED, SPACED], "HOME WORK")).toEqual({ kind: "one", list: SPACED });
	});

	it("finds a list ignoring spaces, dashes and underscores", () => {
		expect(resolveListName([WORK, SPACED], "homework")).toEqual({ kind: "one", list: SPACED });
		expect(resolveListName([WORK, list("snake", "Deep_work")], "deep work")).toMatchObject({ kind: "one", list: { id: "snake" } });
		expect(resolveListName([WORK, list("dash", "Side-project")], "SideProject")).toMatchObject({ kind: "one", list: { id: "dash" } });
	});

	it("several loose matches are reported together, in list order", () => {
		expect(resolveListName([WORK, SPACED, DASHED], "homework")).toEqual({ kind: "several", lists: [SPACED, DASHED] });
	});

	it("no match is none, and a name of only spaces and dashes never matches loosely", () => {
		expect(resolveListName([WORK], "Wrok")).toEqual({ kind: "none" });
		expect(resolveListName([WORK, list("dash", "-")], "_")).toEqual({ kind: "none" });
		expect(resolveListName([WORK], "  ")).toEqual({ kind: "none" });
	});

	it("the Inbox resolves like any list; a trimmed name still matches", () => {
		expect(resolveListName([INBOX, WORK], "inbox")).toEqual({ kind: "one", list: INBOX });
		expect(resolveListName([INBOX, WORK], "  Work ")).toEqual({ kind: "one", list: WORK });
	});

	it("accepts a map's values", () => {
		const map = new Map([SPACED, WORK].map((c) => [c.id, c]));
		expect(resolveListName(map.values(), "homework")).toEqual({ kind: "one", list: SPACED });
	});
});

describe("task block list filter", () => {
	const state = (lists: Category[]) => ({
		tasks: new Map(),
		categories: new Map([INBOX, ...lists].map((c) => [c.id, c])),
		sections: new Map(),
		tags: new Map(),
	});
	const ctx = { today: "2026-10-14", zone: "Europe/Berlin", upcomingDays: 7, weekStart: "MO" as const };
	const run = (source: string, lists: Category[]) => runBlockQuery(parseBlockQuery(source).filters, state(lists), ctx, "Plan.md");

	it("finds a list typed without its spaces", () => {
		expect(run("list: homework", [SPACED, WORK])).toEqual({ kind: "ok", entries: [] });
	});

	it("an ambiguous name is an error naming the matching lists", () => {
		expect(run("list: homework", [SPACED, DASHED])).toEqual({
			kind: "error",
			message: "“homework” matches several lists: Home work, Home-work. Use the exact name.",
		});
	});

	it("the exact name still resolves when a looser one also matches", () => {
		expect(run("list: Home work", [SPACED, DASHED])).toEqual({ kind: "ok", entries: [] });
	});

	it("an unknown list keeps its message", () => {
		expect(run("list: Wrok", [WORK])).toEqual({ kind: "error", message: "No list named “Wrok”." });
	});

	it("the block's Open in Logwell view follows the same rule", () => {
		const cats = state([SPACED, DASHED, WORK]).categories;
		expect(blockOpenView({ list: "work" }, { categories: cats, tags: new Map() })).toEqual({ kind: "category", id: "work" });
		expect(blockOpenView({ list: "homework" }, { categories: cats, tags: new Map() })).toBeNull();
		expect(blockOpenView({ list: "wrok" }, { categories: cats, tags: new Map() })).toBeNull();
		expect(blockOpenView({ list: "WorK" }, { categories: new Map([[WORK.id, WORK], [INBOX.id, INBOX]]), tags: new Map() })).toEqual({ kind: "category", id: "work" });
	});
});

describe("Quick Add #list", () => {
	const withLists = (...names: string[]) => ({ ...makeCtx(), categories: names.map((name, i) => ({ id: `cat-${i}`, name })) });

	it("still finds a list typed without spaces", () => {
		const r = parseQuickAdd("Sort #homework", withLists("Inbox", "Home work"));
		expect(r.fields.categoryId).toBe("cat-1");
		expect(r.chips[0]?.status).toBe("applied");
	});

	it("the exact name wins over a looser match", () => {
		const r = parseQuickAdd("Sort #Home-work", withLists("Home work", "Home-work"));
		expect(r.fields.categoryId).toBe("cat-1");
	});

	it("a name matching several lists is unknown and blocks saving", () => {
		const r = parseQuickAdd("Sort #homework", withLists("Inbox", "Home work", "Home-work"));
		expect(r.fields.categoryId).toBeUndefined();
		expect(r.chips[0]).toMatchObject({ kind: "category", status: "unresolved", notice: "\u201chomework\u201d matches several lists. Use the exact name." });
		expect(r.blocking).toEqual([r.chips[0]?.id]);
	});
});
