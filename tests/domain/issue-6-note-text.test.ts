import { describe, expect, it } from "vitest";
import {
	type NoteDoc,
	asKind,
	baseDoc,
	docFromTickTick,
	docLines,
	mergeDocs,
	normalizeNoteText,
	readNote,
	sameDoc,
	splitFrontmatter,
	storedBase,
	ttNoteWrite,
	writeNote,
} from "../../src/domain/ticktick/noteText";
import { MERGE_MARKER } from "../../src/domain/textMerge";

// What a sync-created description note sends up, how TickTick's text comes down (changing
// the note as little as it can), and the checklist as tick boxes.

const up = (note: string) => readNote(note, false).text;
const text = (t: string): NoteDoc => ({ text: t, items: [] });
/** TickTick ticks or changes the items of a checklist note; the note as the sync writes it. */
function down(note: string, items: (items: string[]) => string[]): string {
	const ours = readNote(note, true);
	return writeNote(note, true, mergeDocs(ours, ours, { ...ours, items: items(ours.items) }));
}
const tickAt = (k: number) => (items: string[]) => items.map((x, i) => (i === k ? x.replace("- [ ]", "- [x]") : x));

describe("a note body going up (SYNC-09)", () => {
	it("drops the frontmatter", () => {
		const { front, body } = splitFrontmatter("---\ntags: [a]\n---\nHello\n");
		expect(front).toBe("---\ntags: [a]\n---\n");
		expect(body).toBe("Hello\n");
		expect(splitFrontmatter("---\n---\nBody").body).toBe("Body");
		expect(splitFrontmatter("No front\n---\n").front).toBe("");
		expect(splitFrontmatter("---\r\nx: 1\r\n---\r\nBody").body).toBe("Body");
	});

	it("sends a link as its text: an alias, else the note name", () => {
		expect(up("Read [[Plan|my plan]] and [[Budget]] today")).toBe("Read my plan and Budget today");
	});

	it("drops embeds, and a line that held only an embed", () => {
		expect(up("Before\n![[photo.png]]\nAfter ![[chart]] end")).toBe("Before\nAfter end");
	});

	it("reads code blocks like any line (their place depends on the layout), and an escaped [[ as [[", () => {
		expect(up("```\n[[Plan]]\n```")).toBe("```\nPlan\n```");
		expect(up("Type \\[[x]] and !\\[[y]]")).toBe("Type [[x]] and ![[y]]");
	});

	it("has no blank lines at the ends and reads CRLF", () => {
		expect(up("\n\nHello\r\nWorld  \n\n")).toBe("Hello\nWorld");
	});

	it("reads a checklist note's tick boxes as items wherever they are, the rest as its text", () => {
		expect(readNote("## Shop\n- [ ] milk [[Store]]\n## Notes\n* [X] Call [[Bob]]\n- \\[ ] not an item\n", true)).toEqual({
			text: "## Shop\n## Notes\n- [ ] not an item",
			items: ["- [ ] milk Store", "- [x] Call Bob"],
		});
	});
});

describe("TickTick's text coming down changes the note as little as it can (SYNC-09)", () => {
	it("keeps a link on a line TickTick did not change, and an embed it cannot see", () => {
		const note = "Read [[Plan|my plan]]\n![[photo.png]]\nOld line\n";
		expect(writeNote(note, false, text("Read my plan\nNew line"))).toBe("Read [[Plan|my plan]]\n![[photo.png]]\nNew line\n");
	});

	it("a line TickTick edits keeps its links whose text is still there, and its embeds at the end (L5)", () => {
		expect(writeNote("Call [[Bob|the bank]] today ![[img.png]]\nOther\n", false, text("Call the bank tomorrow\nOther"))).toBe(
			"Call [[Bob|the bank]] tomorrow ![[img.png]]\nOther\n",
		);
		expect(writeNote("Call [[Bob]]\n", false, text("Call Alice"))).toBe("Call Alice\n");
	});

	it("a line TickTick removes keeps its embeds", () => {
		expect(writeNote("Keep\nPhoto ![[x.png]]\n", false, text("Keep"))).toBe("Keep\n![[x.png]]\n");
		expect(readNote("Keep\n![[x.png]]\n", false).text).toBe("Keep");
	});

	it("fills an empty body and ends it with a newline", () => {
		expect(writeNote("", false, text("One\nTwo"))).toBe("One\nTwo\n");
	});

	it("keeps CRLF line endings and the frontmatter", () => {
		expect(writeNote("---\r\ntags: x\r\n---\r\nLine1\r\n![[e.png]]\r\nLine2\r\n", false, text("Line1\nLine2 changed"))).toBe(
			"---\r\ntags: x\r\n---\r\nLine1\r\n![[e.png]]\r\nLine2 changed\r\n",
		);
	});

	it("an unchanged doc leaves the note byte for byte", () => {
		const note = "---\na: 1\n---\n\nIntro [[X|x]]\n\n![[img]]\n- [ ] One\n\n";
		expect(writeNote(note, true, readNote(note, true))).toBe(note);
	});

	it("a frontmatter with no line ending after it gets one before the body (H1)", () => {
		const next = writeNote("---\ntags: x\n---", false, text("New text"));
		expect(next).toBe("---\ntags: x\n---\nNew text\n");
		expect(splitFrontmatter(next)).toEqual({ front: "---\ntags: x\n---\n", body: "New text\n" });
	});
});

describe("checklist ticks change only the box (B1)", () => {
	it("a tick keeps the item's link", () => {
		expect(down("- [ ] milk [[Store]]\n", tickAt(0))).toBe("- [x] milk [[Store]]\n");
	});

	it("a tick leaves the other lines, links and order as they are", () => {
		expect(down("Intro\n- [ ] a\n- [ ] b\n- [ ] c\nSee [[Plan]]\n", tickAt(2))).toBe("Intro\n- [ ] a\n- [ ] b\n- [x] c\nSee [[Plan]]\n");
		expect(down("- [ ] a\nNotes [[Link|here]]\n", tickAt(0))).toBe("- [x] a\nNotes [[Link|here]]\n");
		expect(down("- [ ] a\n- [ ] b\nNotes [[Link|here]]\n![[pic.png]]\n", tickAt(1))).toBe("- [ ] a\n- [x] b\nNotes [[Link|here]]\n![[pic.png]]\n");
	});

	it("items under headings stay under them", () => {
		expect(down("## Shop\n- [ ] milk [[Store]]\n## Notes\nCall [[Bob]]\n", tickAt(0))).toBe("## Shop\n- [x] milk [[Store]]\n## Notes\nCall [[Bob]]\n");
	});

	it("keeps the user's bullet and box spelling", () => {
		expect(down("* [ ] a\n+ [X] b\n", (items) => ["- [x] a", "- [ ] b"])).toBe("* [x] a\n+ [ ] b\n");
	});

	it("a new item goes after the item it follows; a removed one goes", () => {
		expect(down("## Shop\n- [ ] milk\n## Notes\nx\n", (items) => [...items, "- [ ] eggs"])).toBe("## Shop\n- [ ] milk\n- [ ] eggs\n## Notes\nx\n");
		expect(down("- [ ] a\nmid\n- [ ] b\n", () => ["- [ ] b"])).toBe("mid\n- [ ] b\n");
	});

	it("the first items of a note go after its text, behind a blank line", () => {
		expect(writeNote("Trip notes\n", true, { text: "Trip notes", items: ["- [ ] Bring passport"] })).toBe("Trip notes\n\n- [ ] Bring passport\n");
	});
});

describe("writing TickTick's text reads back as that text (B2)", () => {
	const tricky = [
		"---\nAgenda\n---\nCall the bank",
		"---",
		"See [[Plan]] and [[Plan|alias]]",
		"![[photo.png]]",
		"Escaped \\[[x]] stays",
		"```\n[[in code]]\n```\nafter [[x]]",
		"- [ ] looks like an item",
		"- \\[ ] escaped item-like",
		"Line one\n\n\nLine four",
		"Ends with spaces",
	];
	const docs: NoteDoc[] = [
		...tricky.map(text),
		...tricky.map((t) => ({ text: t, items: ["- [ ] Bring [[passport]]", "- [x] Print ticket", "- [ ]"] })),
		{ text: "", items: ["- [ ] only items"] },
	];

	it.each(docs.map((d) => [JSON.stringify(d), d] as const))("into a new note: %s", (_name, doc) => {
		const checklist = doc.items.length > 0 || doc.text.startsWith("- \\");
		const note = writeNote("", checklist, doc);
		expect(readNote(note, checklist)).toEqual(doc);
		// A second write changes nothing.
		expect(writeNote(note, checklist, doc)).toBe(note);
	});

	it.each(tricky.map((t) => [t] as const))("over an existing note with frontmatter and links: %s", (t) => {
		const note = "---\ntags: x\n---\nOld [[Link|line]]\n![[img.png]]\n";
		const next = writeNote(note, false, text(t));
		expect(readNote(next, false)).toEqual(text(t));
		expect(next.startsWith("---\ntags: x\n---\n")).toBe(true);
	});
});

describe("checklists (SYNC-09)", () => {
	const tt = {
		kind: "CHECKLIST",
		desc: "Trip notes go here.",
		items: [
			{ id: "i1", title: "Bring passport", status: 0, sortOrder: 0, startDate: "2026-10-09T08:00:00.000+0000", isAllDay: false, timeZone: "Europe/Moscow" },
			{ id: "i2", title: "Print ticket", status: 1, sortOrder: 0 },
		],
	};

	it("comes down as the text, a blank line and the items", () => {
		expect(docLines(docFromTickTick(tt))).toEqual(["Trip notes go here.", "", "- [ ] Bring passport", "- [x] Print ticket"]);
	});

	it("a normal task's text is its content, tick boxes included", () => {
		expect(docFromTickTick({ kind: "TEXT", content: "- [ ] not an item" })).toEqual({ text: "- [ ] not an item", items: [] });
	});

	it("stores the base as the text and the item lines, and reads it back", () => {
		const doc = docFromTickTick(tt);
		expect(storedBase(doc, true)).toEqual({ noteBase: "Trip notes go here.", noteItems: ["- [ ] Bring passport", "- [x] Print ticket"] });
		expect(baseDoc(storedBase(doc, true), true)).toEqual(doc);
		expect(storedBase(text("Plain"), false)).toEqual({ noteBase: "Plain" });
	});

	it("goes up with every field TickTick gave each item, ticks and titles from the note; a new item has no id (M3)", () => {
		const doc = { text: "Notes", items: ["- [x] Bring passport", "- [ ] Pack charger", "- [x] Print ticket"] };
		expect(ttNoteWrite(doc, true, tt.items)).toEqual({
			desc: "Notes",
			items: [
				{ ...tt.items[0], status: 1 },
				{ title: "Pack charger", status: 0 },
				{ ...tt.items[1], status: 1 },
			],
		});
		expect(ttNoteWrite(text("Plain"), false, [])).toEqual({ content: "Plain" });
	});

	it("a kind change reads either side as the new kind, losing nothing", () => {
		expect(asKind({ text: "Intro\n- [x] done", items: [] }, true)).toEqual({ text: "Intro", items: ["- [x] done"] });
		expect(asKind({ text: "Intro", items: ["- [ ] a"] }, false)).toEqual({ text: "Intro\n\n- [ ] a", items: [] });
		expect(baseDoc({ noteBase: "Intro\n- [ ] a" }, true)).toEqual({ text: "Intro", items: ["- [ ] a"] });
	});
});

describe("merging checklist items (SYNC-09)", () => {
	const doc = (...items: string[]): NoteDoc => ({ text: "", items });

	it("ticks on both sides apply", () => {
		expect(mergeDocs(doc("- [ ] A", "- [ ] B", "- [ ] C"), doc("- [x] A", "- [ ] B", "- [ ] C"), doc("- [ ] A", "- [ ] B", "- [x] C")).items).toEqual([
			"- [x] A",
			"- [ ] B",
			"- [x] C",
		]);
	});

	it("a removal on one side and an addition on the other", () => {
		expect(mergeDocs(doc("- [ ] A", "- [ ] B", "- [ ] C"), doc("- [ ] A", "- [ ] C"), doc("- [ ] A", "- [ ] B", "- [ ] New", "- [ ] C")).items).toEqual([
			"- [ ] A",
			"- [ ] New",
			"- [ ] C",
		]);
	});

	it("an item replaced here and ticked there is kept in both versions, not renamed (M1)", () => {
		expect(mergeDocs(doc("- [ ] Milk", "- [ ] Bread"), doc("- [ ] Eggs", "- [ ] Bread"), doc("- [x] Milk", "- [ ] Bread")).items).toEqual([
			"- [ ] Eggs",
			"- [x] Milk",
			"- [ ] Bread",
		]);
	});

	it("the same item added on both sides is kept once, whatever its case (M2)", () => {
		expect(mergeDocs(doc("- [ ] a"), doc("- [ ] a", "- [ ] Eggs"), doc("- [ ] a", "- [ ] eggs")).items).toEqual(["- [ ] a", "- [ ] Eggs"]);
		expect(mergeDocs(doc("- [ ] a"), doc("- [ ] a", "- [ ] Eggs"), doc("- [ ] a", "- [ ] Eggs")).items).toEqual(["- [ ] a", "- [ ] Eggs"]);
	});

	it("TickTick's reorder is taken when the note's items did not change", () => {
		expect(mergeDocs(doc("- [ ] a", "- [ ] b"), doc("- [ ] a", "- [ ] b"), doc("- [ ] b", "- [ ] a")).items).toEqual(["- [ ] b", "- [ ] a"]);
	});

	it("text and items merge together", () => {
		const base: NoteDoc = { text: "one\ntwo", items: ["- [ ] A"] };
		const ours: NoteDoc = { text: "one\nmine", items: ["- [x] A"] };
		const theirs: NoteDoc = { text: "one\ntheirs", items: ["- [ ] A"] };
		expect(mergeDocs(base, ours, theirs)).toEqual({ text: `one\nmine\n${MERGE_MARKER}\ntheirs`, items: ["- [x] A"] });
	});
});

describe("verification findings (SYNC-09)", () => {
	it.each([
		["Receipt ![[scan.png]]", "Receipt March"],
		["![[scan.png]] Receipt", "Receipt March"],
		["Receipt ![[scan.png]] here", "Receipt March here"],
		["Receipt  ![[a.png]] ![[b.png]]", "Receipt March"],
	])("a line with embeds reads without the space they leave, and round-trips when TickTick edits it (M): %s", (line, next) => {
		expect(readNote(`${line}\n`, false).text).toBe(line.replace(/ *!\[\[[^\]]*\]\] */gu, " ").trim().replace(/ +/gu, " "));
		const out = writeNote(`${line}\n`, false, text(next));
		expect(readNote(out, false).text).toBe(next);
		expect(writeNote(out, false, text(next))).toBe(out);
		expect(out).toContain("![[");
	});

	it("TickTick text with an unclosed code fence does not swallow the note's later lines (L1)", () => {
		const note = "Old\n![[pic.png]]\n- [ ] milk\n";
		const target: NoteDoc = { text: "```\ncode [[x]]", items: ["- [ ] milk"] };
		const out = writeNote(note, true, target);
		expect(readNote(out, true)).toEqual(target);
		expect(writeNote(out, true, target)).toBe(out);
		const plain = writeNote("A\n![[pic.png]]\n", false, text("```\nB"));
		expect(readNote(plain, false).text).toBe("```\nB");
	});

	it("an escaped item-like line of a checklist reads as plain text after the task becomes a normal one (L2)", () => {
		const doc = docFromTickTick({ kind: "CHECKLIST", desc: "- [ ] not an item", items: [{ id: "1", title: "real", status: 0 }] });
		const note = writeNote("", true, doc);
		expect(readNote(note, true)).toEqual(doc);
		expect(readNote(note, false).text).toBe("- [ ] not an item\n\n- [ ] real");
		// A normal task's own text keeps its backslashes either way.
		for (const t of ["- \\[ ] typed", "- [ ] box", "- \\\\[x] two"]) {
			const n = writeNote("", false, text(t));
			expect(readNote(n, false).text).toBe(t);
		}
	});

	it("an item retitled in place keeps its TickTick fields, such as its date; a line removed and one added elsewhere is a new item (L3)", () => {
		const cur = [
			{ id: "1", title: "Milk", status: 0, startDate: "d1" },
			{ id: "2", title: "Bread", status: 0 },
		];
		expect(ttNoteWrite({ text: "", items: ["- [ ] Oat milk", "- [ ] Bread"] }, true, cur).items).toEqual([
			{ id: "1", title: "Oat milk", status: 0, startDate: "d1" },
			{ id: "2", title: "Bread", status: 0 },
		]);
		expect(ttNoteWrite({ text: "", items: ["- [ ] Bread", "- [ ] Eggs"] }, true, cur).items).toEqual([
			{ id: "2", title: "Bread", status: 0 },
			{ title: "Eggs", status: 0 },
		]);
	});

	it("the same item changed on both sides keeps Logwell's title and the tick of the side that changed it (L4)", () => {
		const doc = (...items: string[]): NoteDoc => ({ text: "", items });
		expect(mergeDocs(doc("- [ ] Milk"), doc("- [ ] milk"), doc("- [x] Milk")).items).toEqual(["- [x] milk"]);
		expect(mergeDocs(doc("- [x] Milk"), doc("- [ ] milk"), doc("- [x] MILK")).items).toEqual(["- [ ] milk"]);
	});

	it("writing any TickTick text reads back as that text, keeps the frontmatter, and a second write changes nothing (fuzz, fixed seed)", () => {
		// mulberry32, a fixed seed: the same cases every run.
		let seed = 7;
		const rnd = (n: number) => {
			seed = (seed + 0x6d2b79f5) | 0;
			let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return (((t ^ (t >>> 14)) >>> 0) % n);
		};
		const pick = <T>(a: readonly T[], n: number): T[] => Array.from({ length: n }, () => a[rnd(a.length)]!);
		const noteLines = ["A", "B [[Link|b]]", "![[pic.png]]", "", "- [ ] milk", "- [x] eggs [[Store]]", "## H", "```", "code [[x]]", "- \\[ ] esc", "\\[[lit]]", "  indented", "---", "C ![[e.png]] tail", "* [X] star", "Receipt ![[scan.png]]"];
		const ttLines = ["A", "b", "", "New", "[[raw]]", "![[emb]]", "- [ ] looks item", "```", "---", "x \\[[y", "  sp", "#tag", "B b", "Receipt March", "- \\[ ] esc"];
		const itemPool = ["- [ ] milk", "- [x] eggs Store", "- [ ] new", "- [ ]", "- [x] [[odd]]", "- [ ] Milk"];
		const failures: unknown[] = [];
		for (let i = 0; i < 5000 && failures.length < 3; i++) {
			const checklist = rnd(2) === 0;
			const front = rnd(3) === 0 ? "---\nk: v\n---\n" : "";
			const crlf = rnd(4) === 0;
			let note = front + pick(noteLines, rnd(7)).join("\n") + (rnd(2) ? "\n" : "");
			if (crlf) note = note.replace(/\n/gu, "\r\n");
			const target: NoteDoc = { text: normalizeNoteText(pick(ttLines, rnd(6)).join("\n")), items: checklist ? pick(itemPool, rnd(4)) : [] };
			const out = writeNote(note, checklist, target);
			const back = readNote(out, checklist);
			const frontKept = front === "" || out.startsWith(crlf ? front.replace(/\n/gu, "\r\n") : front);
			if (!sameDoc(back, target) || !frontKept || writeNote(out, checklist, target) !== out) failures.push({ checklist, note, target, out, back });
		}
		expect(failures).toEqual([]);
	});
});
