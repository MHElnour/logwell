import { describe, expect, it } from "vitest";
import { CheckpointSettingTab } from "../../src/obsidian/SettingTab";
import { DEFAULT_SETTINGS, isValidEveningTime, sanitizeSettings } from "../../src/app/settings";
import { CheckpointApp } from "../../src/app/App";
import { MemoryTickTickDevice, MemoryTickTickSecret } from "../../src/app/ports";
import { sequentialIds } from "../helpers";
import { harness as storeHarness } from "../persistence/fixtures";
import { FakeNotes } from "./harness";

describe("setting texts", () => {
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
});

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

describe("focus settings", () => {
	it("defaults", () => {
		const s = sanitizeSettings({});
		expect(s).toMatchObject({ focusRounds: 4, focusMin: 25, breakMin: 5, longBreakMin: 15, soundTheme: "chime", soundVolume: 60, discardShortFocus: true });
		expect(sanitizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
	});

	it("keeps valid values at the edges of the ranges", () => {
		const s = sanitizeSettings({ focusRounds: 8, focusMin: 180, breakMin: 1, longBreakMin: 60, soundVolume: 0, soundTheme: "none", discardShortFocus: false });
		expect(s).toMatchObject({ focusRounds: 8, focusMin: 180, breakMin: 1, longBreakMin: 60, soundVolume: 0, soundTheme: "none", discardShortFocus: false });
		expect(sanitizeSettings({ soundVolume: 100, focusRounds: 1 })).toMatchObject({ soundVolume: 100, focusRounds: 1 });
	});

	it("drops values out of range, not whole, or of the wrong type", () => {
		const s = sanitizeSettings({
			focusRounds: 9,
			focusMin: 0,
			breakMin: 2.5,
			longBreakMin: "15",
			soundVolume: 101,
			soundTheme: "siren",
			discardShortFocus: "yes",
		});
		expect(s).toEqual(DEFAULT_SETTINGS);
		expect(sanitizeSettings({ focusRounds: 0, soundVolume: -1, focusMin: 181, breakMin: 61, longBreakMin: 61 })).toEqual(DEFAULT_SETTINGS);
	});
});

describe("TickTick settings", () => {
	const SETTINGS = { zone: () => "Europe/Berlin", noteFolder: () => "Task notes", upcomingDays: () => 14, weekStart: () => "MO" as const, eveningTime: () => "20:00" };

	// The TickTick settings and the ports for the token and the device flag.
	// Nothing reads them yet.

	describe("TickTick settings", () => {
		it("default to a 5 minute pull and no description notes", () => {
			expect(DEFAULT_SETTINGS.tickTickPullMinutes).toBe(5);
			expect(DEFAULT_SETTINGS.tickTickNotes).toBe(false);
			expect(sanitizeSettings({})).toMatchObject({ tickTickPullMinutes: 5, tickTickNotes: false });
		});

		it.each([5, 6, 30, 60])("keep a pull interval of %i", (minutes) => {
			expect(sanitizeSettings({ tickTickPullMinutes: minutes }).tickTickPullMinutes).toBe(minutes);
		});

		// 5 to 60 minutes; there is no "never" (0).
		it.each([
			[0, 5],
			[1, 5],
			[4, 5],
			[-1, 5],
			[61, 60],
			[1000, 60],
			[30.4, 30],
			[Number.POSITIVE_INFINITY, 5],
		])("bring a pull interval of %s into 5 to 60 (%s)", (minutes, expected) => {
			expect(sanitizeSettings({ tickTickPullMinutes: minutes }).tickTickPullMinutes).toBe(expected);
		});

		it.each(["5", null, Number.NaN])("fall back to 5 for a pull interval that is not a number (%s)", (minutes) => {
			expect(sanitizeSettings({ tickTickPullMinutes: minutes }).tickTickPullMinutes).toBe(5);
		});

		it("keep a boolean notes flag and drop anything else", () => {
			expect(sanitizeSettings({ tickTickNotes: true }).tickTickNotes).toBe(true);
			expect(sanitizeSettings({ tickTickNotes: "yes" }).tickTickNotes).toBe(false);
		});
	});

	describe("in-memory TickTick ports", () => {
		it("the secret port keeps a token until it is cleared", () => {
			const secret = new MemoryTickTickSecret();
			expect(secret.get()).toBeNull();
			secret.set("tok-1");
			expect(secret.get()).toBe("tok-1");
			secret.clear();
			expect(secret.get()).toBeNull();
			secret.set("");
			expect(secret.get()).toBeNull();
		});

		it("the device port is off until turned on", () => {
			const device = new MemoryTickTickDevice();
			expect(device.isEnabled()).toBe(false);
			device.setEnabled(true);
			expect(device.isEnabled()).toBe(true);
			device.setEnabled(false);
			expect(device.isEnabled()).toBe(false);
		});

		it("the app uses them when no host ports are given, and the given ones otherwise", () => {
			const h = storeHarness();
			const plain = new CheckpointApp(h.store, h.clock, sequentialIds("a"), SETTINGS, new FakeNotes());
			expect(plain.tickTickSecret).toBeInstanceOf(MemoryTickTickSecret);
			expect(plain.tickTickDevice).toBeInstanceOf(MemoryTickTickDevice);
			const secret = new MemoryTickTickSecret();
			const device = new MemoryTickTickDevice();
			const wired = new CheckpointApp(
				h.store,
				h.clock,
				sequentialIds("b"),
				SETTINGS,
				new FakeNotes(),
				undefined,
				undefined,
				undefined,
				undefined,
				secret,
				device,
			);
			expect(wired.tickTickSecret).toBe(secret);
			expect(wired.tickTickDevice).toBe(device);
		});
	});
});

describe("dateLocale setting", () => {
	it("defaults to en and keeps en-GB", () => {
		expect(DEFAULT_SETTINGS.dateLocale).toBe("en");
		expect(sanitizeSettings({ dateLocale: "en-GB" }).dateLocale).toBe("en-GB");
	});
	it("drops invalid values", () => {
		expect(sanitizeSettings({ dateLocale: "de" }).dateLocale).toBe("en");
		expect(sanitizeSettings({ dateLocale: 3 }).dateLocale).toBe("en");
		expect(sanitizeSettings(null).dateLocale).toBe("en");
	});
});
