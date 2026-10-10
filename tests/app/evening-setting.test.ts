import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, isValidEveningTime, sanitizeSettings } from "../../src/app/settings";
import { CheckpointSettingTab } from "../../src/obsidian/SettingTab";

// "Evening time": HH:mm, default 20:00, used by "tonight".

describe("evening time setting", () => {
	it("defaults to 20:00", () => {
		expect(DEFAULT_SETTINGS.eveningTime).toBe("20:00");
		expect(sanitizeSettings(null).eveningTime).toBe("20:00");
		expect(sanitizeSettings({}).eveningTime).toBe("20:00");
	});

	it("keeps a valid HH:mm and drops anything else", () => {
		expect(sanitizeSettings({ eveningTime: "19:30" }).eveningTime).toBe("19:30");
		expect(sanitizeSettings({ eveningTime: "00:00" }).eveningTime).toBe("00:00");
		expect(sanitizeSettings({ eveningTime: "23:59" }).eveningTime).toBe("23:59");
		for (const bad of ["24:00", "7:30", "19:60", "19:3", "evening", "", 2000, null, undefined]) {
			expect(sanitizeSettings({ eveningTime: bad }).eveningTime).toBe("20:00");
		}
	});

	it("isValidEveningTime", () => {
		expect(isValidEveningTime("20:00")).toBe(true);
		expect(isValidEveningTime("20:0")).toBe(false);
		expect(isValidEveningTime("25:00")).toBe(false);
	});

	it("is a declarative setting with sentence-case text and validation", async () => {
		const tab = new CheckpointSettingTab({} as never, {} as never);
		const flat = (items: unknown[]): Record<string, unknown>[] =>
			items.flatMap((i) => {
				const o = i as { items?: unknown[] } & Record<string, unknown>;
				return o.items ? flat(o.items) : [o];
			});
		const def = flat(tab.getSettingDefinitions()).find((d) => (d.control as { key?: string } | undefined)?.key === "eveningTime");
		expect(def).toBeDefined();
		expect(def!.name).toBe("Evening time");
		const control = def!.control as { type: string; validate: (v: string) => unknown };
		expect(control.type).toBe("text");
		expect(await control.validate("20:00")).toBeUndefined();
		expect(await control.validate("8pm")).toEqual(expect.any(String));
	});
});
