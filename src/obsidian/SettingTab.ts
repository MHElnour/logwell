import { type App, PluginSettingTab, type SettingDefinitionItem } from "obsidian";
import { type CheckpointSettings, DEFAULT_SETTINGS, FOCUS_RANGES, UPCOMING_DAYS_RANGE, isValidEveningTime, sanitizeSettings } from "../app/settings";
import { deviceZone } from "../domain/ports";
import { isValidZone } from "../domain/time";
import type CheckpointPlugin from "../main";
import { DB_EXTENSION } from "../persistence/schema";
import { gitSyncRow } from "./gitSync";
import { plainNotice, showError } from "./notices";
import { tickTickSettingItems } from "./tickTickSettings";

/** Declarative settings (minAppVersion 1.13.0). */
export class CheckpointSettingTab extends PluginSettingTab {
	private readonly gitSync = gitSyncRow({
		files: () => this.app.vault.adapter,
		notify: plainNotice,
		error: (err) => showError(err),
		refresh: () => this.refreshDomState(),
	});

	constructor(
		app: App,
		private readonly plugin: CheckpointPlugin,
	) {
		super(app, plugin);
	}

	override getControlValue(key: string): unknown {
		return this.plugin.settings[key as keyof CheckpointSettings];
	}

	override async setControlValue(key: string, value: unknown): Promise<void> {
		const next = sanitizeSettings({ ...this.plugin.settings, [key]: value });
		this.plugin.settings = next;
		await this.plugin.saveSettings();
		await this.plugin.onSettingChanged(key as keyof CheckpointSettings);
	}

	override getSettingDefinitions(): SettingDefinitionItem[] {
		// Read each time the tab shows: the Git sync row appears once the vault is known to need it.
		void this.gitSync.check();
		return [
			{
				type: "group",
				heading: "Database",
				items: [
					{
						name: "Active database",
						desc: "The .cpbase file that Quick Add, commands and the app use.",
						control: {
							type: "file",
							key: "activeDatabasePath",
							placeholder: "Logwell.cpbase",
							filter: (file) => file.extension === DB_EXTENSION,
						},
					},
					this.gitSync.item,
					{
						name: "Create database",
						desc: "Create a new .cpbase file and make it active.",
						action: () => void this.plugin.createDatabase(),
					},
				],
			},
			{
				type: "group",
				heading: "Tasks",
				items: [
					{
						name: "Description note folder",
						desc: "New description notes are created here. The folder is created when first needed.",
						control: { type: "folder", key: "noteFolder", placeholder: "Task notes", includeRoot: true },
					},
					{
						name: "Upcoming days",
						desc: "How many days the Upcoming list covers, starting today.",
						control: { type: "number", key: "upcomingDays", min: UPCOMING_DAYS_RANGE.min, max: UPCOMING_DAYS_RANGE.max, step: 1, defaultValue: DEFAULT_SETTINGS.upcomingDays },
					},
					{
						name: "Keep quick add open after saving",
						desc: "Useful for adding several tasks in a row.",
						control: { type: "toggle", key: "keepQuickAddOpen" },
					},
				],
			},
			{
				type: "group",
				heading: "Appearance",
				items: [
					{
						name: "Accent",
						desc: "Theme accent follows your Obsidian theme. Pick a color to keep it fixed whatever the theme.",
						control: {
							type: "dropdown",
							key: "accent",
							options: { theme: "Theme accent", purple: "Purple", blue: "Blue", green: "Green", orange: "Orange" },
						},
					},
				],
			},
			{
				type: "group",
				heading: "Focus",
				items: [
					{
						name: "Sound theme",
						desc: "One sound each for the start of a focus, the start of a break and a finished set.",
						control: {
							type: "dropdown",
							key: "soundTheme",
							options: { chime: "Chime", soft: "Soft", digital: "Digital", none: "None" },
						},
					},
					{
						name: "Sound volume",
						control: { type: "slider", key: "soundVolume", min: FOCUS_RANGES.soundVolume.min, max: FOCUS_RANGES.soundVolume.max, step: 5 },
					},
					{
						name: "Play",
						desc: "Hear the three sounds of the current theme at the current volume.",
						action: () => this.plugin.sound.preview(),
					},
					{
						name: "Skip focus rounds under a minute",
						desc: "A focus round that you end with Stop or Finish within a minute is not saved, except a Finish on the last round of a set that already has a saved round. You can undo it from the notice.",
						control: { type: "toggle", key: "discardShortFocus" },
					},
				],
			},
			{
				type: "group",
				heading: "Time",
				items: [
					{
						name: "Time zone",
						desc: `An IANA zone such as Europe/Berlin. Leave empty to use the device zone (${deviceZone()}).`,
						control: {
							type: "text",
							key: "timeZone",
							placeholder: deviceZone(),
							validate: (v) => (v === "" || isValidZone(v) ? undefined : "Unknown time zone."),
						},
					},
					{
						name: "Week starts on",
						control: {
							type: "dropdown",
							key: "weekStart",
							options: { MO: "Monday", SU: "Sunday", SA: "Saturday" },
						},
					},
					{
						name: "Evening time",
						desc: "What \"tonight\" means in quick add and the date picker: today at this time (24-hour HH:mm).",
						control: {
							type: "text",
							key: "eveningTime",
							placeholder: "20:00",
							validate: (v) => (isValidEveningTime(v) ? undefined : "Use 24-hour HH:mm, for example 20:00."),
						},
					},
					{
						name: "Date order",
						desc: "How quick add reads dates such as 10/5.",
						control: {
							type: "dropdown",
							key: "dateLocale",
							options: { en: "Month/day (10/5 is October 5)", "en-GB": "Day/month (10/5 is 5 October)" },
						},
					},
				],
			},
			// The TickTick sync group.
			...tickTickSettingItems({
				app: this.app,
				settings: () => this.plugin.settings,
				setSetting: (key, value) => this.setControlValue(key, value),
				session: () => this.plugin.session,
				refresh: () => this.update(),
				notify: plainNotice,
				error: showError,
				now: () => Date.now(),
			}),
		];
	}
}
