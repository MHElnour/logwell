import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, sanitizeSettings } from "../../src/app/settings";

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
