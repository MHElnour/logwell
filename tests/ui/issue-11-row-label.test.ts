import { describe, expect, it } from "vitest";
import type { Tag, Task } from "../../src/domain/types";
import type { DbData } from "../../src/persistence/schema";
import { sameLookups } from "../../src/ui/rowMemo";

// A row shows its tags by name, and a name depends on the other tags: a row redraws when its label changes (#11).

const TS = "2026-09-01T09:00:00.000Z";
const tag = (key: string, displayName: string): Tag => ({ key, displayName, color: null, createdAt: TS, modifiedAt: TS });
const stateOf = (...tags: Tag[]): DbData => ({ categories: new Map(), tags: new Map(tags.map((t) => [t.key, t])) }) as unknown as DbData;
const taskWith = (...tagKeys: string[]): Task => ({ id: "t", categoryId: "inbox", tagKeys }) as unknown as Task;

describe("sameLookups: tag labels", () => {
	const home = tag("home/calls", "Home/Calls");
	const work = tag("work/calls", "Work/Calls");

	it("redraws when deleting a duplicate changes the label of the task's tag", () => {
		expect(sameLookups(stateOf(home, work), stateOf(home), taskWith("home/calls"))).toBe(false);
	});

	it("redraws when adding a duplicate changes the label", () => {
		expect(sameLookups(stateOf(home), stateOf(home, work), taskWith("home/calls"))).toBe(false);
	});

	it("does not redraw when an unrelated tag changes", () => {
		const errands = tag("errands", "Errands");
		expect(sameLookups(stateOf(home), stateOf(home, errands), taskWith("home/calls"))).toBe(true);
	});

	it("does not redraw a task without tags", () => {
		expect(sameLookups(stateOf(home, work), stateOf(home), taskWith())).toBe(true);
	});

	it("redraws when the tag record itself changes", () => {
		expect(sameLookups(stateOf(home), stateOf({ ...home, color: "red" }), taskWith("home/calls"))).toBe(false);
	});
});
