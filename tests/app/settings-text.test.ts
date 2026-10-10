import { describe, expect, it } from "vitest";
import { CheckpointSettingTab } from "../../src/obsidian/SettingTab";

type Def = { name?: string; desc?: string; control?: { key?: string } } & { items?: Def[] };

function definitions(): Def[] {
	const tab = new CheckpointSettingTab({} as never, {} as never);
	const flat = (items: Def[]): Def[] => items.flatMap((i) => (i.items ? flat(i.items) : [i]));
	return flat(tab.getSettingDefinitions() as unknown as Def[]);
}

describe("setting texts", () => {
	it("the short focus round setting names Stop and Finish, not Skip", () => {
		const def = definitions().find((d) => d.control?.key === "discardShortFocus");
		expect(def?.name).toBe("Skip focus rounds under a minute");
		expect(def?.desc).toMatch(/\bStop\b/);
		expect(def?.desc).toMatch(/\bFinish\b/);
		expect(def?.desc).not.toMatch(/\bskip\b/i);
	});
});
