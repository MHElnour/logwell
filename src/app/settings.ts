import { isClockTime } from "../domain/habits";
import { deviceZone } from "../domain/ports";
import { clamp } from "../domain/text";
import { isValidZone } from "../domain/time";
import type { DateLocale, WeekStart } from "../domain/types";

// Plugin settings (saved with saveData under plugin.settings).

/** Lives in src/domain/types; re-exported for the existing imports. */
export type { WeekStart } from "../domain/types";

/** Accent color: the theme's own, or a fixed one whatever the theme. */
export const ACCENTS = ["theme", "purple", "blue", "green", "orange"] as const;
export type Accent = (typeof ACCENTS)[number];

/** The sound theme for the focus moments. */
const SOUND_THEMES = ["chime", "soft", "digital", "none"] as const;
export type SoundTheme = (typeof SOUND_THEMES)[number];

/** Inclusive whole-number ranges of the focus settings. */
export const FOCUS_RANGES = {
	focusRounds: { min: 1, max: 8 },
	focusMin: { min: 1, max: 180 },
	breakMin: { min: 1, max: 60 },
	longBreakMin: { min: 1, max: 60 },
	soundVolume: { min: 0, max: 100 },
} as const;

export interface CheckpointSettings {
	/** Vault path of the active `.cpbase` database. */
	activeDatabasePath: string;
	/** Folder for new description notes. */
	noteFolder: string;
	/** IANA zone override; empty = the device zone. */
	timeZone: string;
	weekStart: WeekStart;
	dateLocale: DateLocale;
	/** What "tonight" means: today at this local time, HH:mm. */
	eveningTime: string;
	/** Days covered by Upcoming. */
	upcomingDays: number;
	/** Keep Quick Add open after saving, for batch capture. */
	keepQuickAddOpen: boolean;
	accent: Accent;
	/** The Obsidian Sync notice is shown once, when the first database is created. */
	syncNoticeShown: boolean;
	/** The last focus set values, written by the Focus page. */
	focusRounds: number;
	focusMin: number;
	breakMin: number;
	longBreakMin: number;
	soundTheme: SoundTheme;
	/** 0 to 100. */
	soundVolume: number;
	/** A focus under a minute that ends by Stop or Finish is not saved. */
	discardShortFocus: boolean;
	/** Minutes between TickTick pulls, 5 to 60. */
	tickTickPullMinutes: number;
	/** Pulled TickTick text becomes a description note. */
	tickTickNotes: boolean;
	/**
	 * The id of the secret that holds the TickTick token in Obsidian's secret storage. Obsidian's
	 * secret field stores a name, never the token; "" = no secret chosen. The token itself is never in `data.json`.
	 */
	tickTickSecretId: string;
}

/** The secret id used until the user chooses another one. */
export const TICKTICK_DEFAULT_SECRET_ID = "logwell-ticktick-token";

/** The inclusive whole-number range of the Upcoming days setting. */
export const UPCOMING_DAYS_RANGE = { min: 1, max: 60 } as const;

/** The inclusive whole-number range of `tickTickPullMinutes`. There is no "never". */
export const TICKTICK_PULL_RANGE = { min: 5, max: 60 } as const;

export const DEFAULT_SETTINGS: CheckpointSettings = {
	activeDatabasePath: "",
	noteFolder: "Task notes",
	timeZone: "",
	weekStart: "MO",
	dateLocale: "en",
	eveningTime: "20:00",
	upcomingDays: 14,
	keepQuickAddOpen: false,
	accent: "theme",
	syncNoticeShown: false,
	focusRounds: 4,
	focusMin: 25,
	breakMin: 5,
	longBreakMin: 15,
	soundTheme: "chime",
	soundVolume: 60,
	discardShortFocus: true,
	tickTickPullMinutes: 5,
	tickTickNotes: false,
	tickTickSecretId: TICKTICK_DEFAULT_SECRET_ID,
};

/** A 24-hour "HH:mm" with two digits each. */
export function isValidEveningTime(value: string): boolean {
	return isClockTime(value);
}

export const TRASH_RETENTION_DAYS = 30;

/** Fills defaults and drops invalid values from stored settings. */
export function sanitizeSettings(raw: unknown): CheckpointSettings {
	const s = { ...DEFAULT_SETTINGS };
	if (typeof raw !== "object" || raw === null) return s;
	const r = raw as Record<string, unknown>;
	if (typeof r.activeDatabasePath === "string") s.activeDatabasePath = r.activeDatabasePath;
	if (typeof r.noteFolder === "string") s.noteFolder = r.noteFolder;
	if (typeof r.timeZone === "string" && (r.timeZone === "" || isValidZone(r.timeZone))) s.timeZone = r.timeZone;
	if (r.weekStart === "MO" || r.weekStart === "SU" || r.weekStart === "SA") s.weekStart = r.weekStart;
	if (r.dateLocale === "en" || r.dateLocale === "en-GB") s.dateLocale = r.dateLocale;
	if (typeof r.eveningTime === "string" && isValidEveningTime(r.eveningTime)) s.eveningTime = r.eveningTime;
	if (typeof r.upcomingDays === "number" && Number.isInteger(r.upcomingDays) && r.upcomingDays >= UPCOMING_DAYS_RANGE.min && r.upcomingDays <= UPCOMING_DAYS_RANGE.max) {
		s.upcomingDays = r.upcomingDays;
	}
	if (typeof r.keepQuickAddOpen === "boolean") s.keepQuickAddOpen = r.keepQuickAddOpen;
	if (typeof r.accent === "string" && (ACCENTS as readonly string[]).includes(r.accent)) s.accent = r.accent as Accent;
	if (typeof r.syncNoticeShown === "boolean") s.syncNoticeShown = r.syncNoticeShown;
	for (const key of Object.keys(FOCUS_RANGES) as (keyof typeof FOCUS_RANGES)[]) {
		const v = r[key];
		const { min, max } = FOCUS_RANGES[key];
		if (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max) s[key] = v;
	}
	if (typeof r.soundTheme === "string" && (SOUND_THEMES as readonly string[]).includes(r.soundTheme)) {
		s.soundTheme = r.soundTheme as SoundTheme;
	}
	if (typeof r.discardShortFocus === "boolean") s.discardShortFocus = r.discardShortFocus;
	const pull = r.tickTickPullMinutes;
	// A number outside 5 to 60 (0 included) is brought to the nearest end.
	if (typeof pull === "number" && Number.isFinite(pull)) {
		s.tickTickPullMinutes = clamp(Math.round(pull), TICKTICK_PULL_RANGE.min, TICKTICK_PULL_RANGE.max);
	}
	if (typeof r.tickTickNotes === "boolean") s.tickTickNotes = r.tickTickNotes;
	// Obsidian's secret ids: lowercase letters, digits and single dashes. "" means none chosen.
	if (typeof r.tickTickSecretId === "string" && (r.tickTickSecretId === "" || /^[a-z0-9]+(-[a-z0-9]+)*$/u.test(r.tickTickSecretId))) {
		s.tickTickSecretId = r.tickTickSecretId;
	}
	return s;
}

export function displayZone(settings: CheckpointSettings): string {
	return settings.timeZone !== "" && isValidZone(settings.timeZone) ? settings.timeZone : deviceZone();
}
