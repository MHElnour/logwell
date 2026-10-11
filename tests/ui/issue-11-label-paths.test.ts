import { describe, expect, it } from "vitest";
import { tagsByLabel } from "../../src/domain/tags";
import type { Tag } from "../../src/domain/types";
import { chipLabel } from "../../src/ui/quickadd/chipLabels";
import { manualPills } from "../../src/ui/quickadd/manualPills";
import type { QuickAddModel } from "../../src/ui/quickadd/QuickAddModel";

// Where a tag is shown by its own name (#11): the Quick Add chip, the manual pill and the sorted tag lists.

const TS = "2026-09-01T09:00:00.000Z";
const tag = (key: string, displayName: string): Tag => ({ key, displayName, color: null, createdAt: TS, modifiedAt: TS });
const map = (...tags: Tag[]) => new Map(tags.map((t) => [t.key, t]));
const tagChip = (tagKey: string) => ({ kind: "tag", status: "applied", tagKey, text: `@${tagKey}` }) as never;
const envOf = (tags: ReadonlyMap<string, Tag>) => ({ zone: "Europe/Berlin", today: "2026-10-01", categories: [], tags });

describe("Quick Add chip label", () => {
	it("a nested tag shows its own name", () => {
		expect(chipLabel(tagChip("home/calls"), envOf(map(tag("home/calls", "Home/Calls"))))).toBe("@Calls");
	});

	it("a name two tags use shows the full path", () => {
		const tags = map(tag("home/calls", "Home/Calls"), tag("work/calls", "Work/Calls"));
		expect(chipLabel(tagChip("work/calls"), envOf(tags))).toBe("@Work/Calls");
	});

	it("a new tag keeps the typed text", () => {
		const chip = { kind: "tag", status: "applied", tagKey: "home/garden", newTag: true, text: "@home/garden" } as never;
		expect(chipLabel(chip, envOf(map()))).toBe("New tag: home/garden");
	});
});

describe("manual tag pill label", () => {
	const modelOf = (tags: ReadonlyMap<string, Tag>, tagKeys: string[]): QuickAddModel =>
		({
			manual: new Set(),
			parent: undefined,
			tagKeys,
			urgent: false,
			important: false,
			vals: {},
			env: { app: { settings: { zone: () => "UTC" }, queryContext: () => ({ today: "2026-01-01" }), categories: { list: () => [] }, store: { state: { tags } } } },
			setTags: () => undefined,
		}) as unknown as QuickAddModel;

	it("a nested tag shows its own name", () => {
		const pills = manualPills(modelOf(map(tag("home/calls", "Home/Calls")), ["home/calls"]));
		expect(pills.filter((p) => p.kind === "tag").map((p) => p.label)).toEqual(["@Calls"]);
	});

	it("a name two tags use shows the full path", () => {
		const tags = map(tag("home/calls", "Home/Calls"), tag("work/calls", "Work/Calls"));
		expect(manualPills(modelOf(tags, ["home/calls"])).filter((p) => p.kind === "tag").map((p) => p.label)).toEqual(["@Home/Calls"]);
	});
});

describe("tagsByLabel", () => {
	it("sorts by the label that is shown, not by the full path", () => {
		const tags = map(tag("errands", "Errands"), tag("home/calls", "Home/Calls"), tag("work/barista", "Work/Barista"));
		expect(tagsByLabel(tags).map((t) => t.label)).toEqual(["Barista", "Calls", "Errands"]);
		// By path the order would be Errands, Home/Calls, Work/Barista.
		expect(tagsByLabel(tags).map((t) => t.tag.key)).toEqual(["work/barista", "home/calls", "errands"]);
	});
});
