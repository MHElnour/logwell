import { type App, SecretComponent, type Setting, type SettingDefinitionItem, type SettingGroupItem } from "obsidian";
import { type CheckpointSettings, DEFAULT_SETTINGS, TICKTICK_PULL_RANGE } from "../app/settings";
import { SYNCED_LIST_OPEN_MAX } from "../app/taskIndex";
import type { SyncService } from "../app/SyncService";
import { linkedLists } from "../app/syncMarks";
import type { TickTickDevicePort, TickTickSecretPort } from "../app/ports";
import { plural } from "../domain/text";
import type { DbData } from "../persistence/schema";
import { formatAgo } from "../ui/format";
import type { TickTickScheduler } from "./tickTickScheduler";
import { unlinkListFlow } from "./tickTickFlow";

// The "TickTick sync" group of the settings tab. Rows that
// follow the state (token, device switch, status, linked lists) are evaluated each time the tab renders and after
// `refresh()`. The token field is Obsidian's secret field, which stores a secret's name and never its value.

/** What the group reads and drives of the open database; null while none is open. */
export interface TickTickSettingsSession {
	app: { tickTickSecret: Pick<TickTickSecretPort, "get">; tickTickDevice: TickTickDevicePort; store: { state: DbData } };
	tickTick: Pick<TickTickScheduler, "status" | "refresh" | "syncNow">;
	sync: Pick<SyncService, "unlinkList">;
}

export interface TickTickSettingsDeps {
	app: App;
	settings: () => CheckpointSettings;
	/** Saves one setting and tells the plugin (the schedule follows). */
	setSetting: (key: "tickTickSecretId", value: string) => Promise<void>;
	session: () => TickTickSettingsSession | null | undefined;
	/** Draws the group again. */
	refresh: () => void;
	notify: (message: string) => void;
	error: (err: unknown) => void;
	now: () => number;
}

export const ONE_DEVICE_TEXT = "TickTick sync is on for this device. Keep it off on your other devices: only one device should sync.";
const LIMITS_NOTE = `A synced list holds at most ${SYNCED_LIST_OPEN_MAX} open tasks. TickTick's free plan allows 9 lists and 99 open tasks per list; Logwell cannot see your plan, so going over that shows an error.`;

export function tickTickSettingItems(deps: TickTickSettingsDeps): SettingDefinitionItem[] {
	const session = () => deps.session() ?? null;
	const hasToken = () => session()?.app.tickTickSecret.get() != null;
	const on = () => hasToken() && session()?.app.tickTickDevice.isEnabled() === true;
	const lists = () => {
		const s = session();
		// By name here, unlike the sync's list order.
		return s === null ? [] : linkedLists(s.app.store.state).sort((a, b) => a.name.localeCompare(b.name));
	};

	const rows: SettingGroupItem[] = [
		{
			name: "TickTick token",
			desc: "In TickTick: avatar > Settings > Account > API Token. Create one, then choose or create a secret for it here. It is kept in Obsidian's secret storage, never in your vault.",
			render: (setting: Setting) => {
				setting.addComponent((el) =>
					new SecretComponent(deps.app, el).setValue(hasToken() ? deps.settings().tickTickSecretId : "").onChange((value) => {
						void deps
							.setSetting("tickTickSecretId", value)
							.then(() => session()?.tickTick.refresh())
							.then(deps.refresh)
							.catch(deps.error);
					}),
				);
			},
		},
		{
			name: "Sync with TickTick on this device",
			desc: "Turn this on for one device only. Your other devices' edits reach TickTick through it.",
			render: (setting: Setting) => {
				const s = session();
				setting.addToggle((toggle) =>
					toggle
						.setValue(on())
						.setDisabled(s === null || !hasToken())
						.onChange((value) => {
							if (s === null) return;
							s.app.tickTickDevice.setEnabled(value);
							s.tickTick.refresh();
							if (value) deps.notify(ONE_DEVICE_TEXT);
							deps.refresh();
						}),
				);
			},
		},
		{
			name: "Sync status",
			visible: on,
			render: (setting: Setting) => {
				const s = session();
				if (s === null) return;
				const { lastSyncAt, error } = s.tickTick.status();
				const count = plural(lists().length, "list");
				setting.setName(lastSyncAt === null ? `Not synced yet · ${count}` : `Synced ${formatAgo(lastSyncAt, deps.now())} · ${count}`);
				if (error !== null) setting.setDesc(`The last sync stopped: ${error}`);
				setting.addButton((button) =>
					button.setButtonText("Sync now").onClick(() => {
						button.setDisabled(true);
						void s.tickTick
							.syncNow()
							.catch(deps.error)
							.finally(deps.refresh);
					}),
				);
			},
		},
		{
			name: "Pull from TickTick every",
			desc: "Minutes, 5 to 60. Your Logwell edits are always sent within a few seconds.",
			control: {
				type: "number",
				key: "tickTickPullMinutes",
				min: TICKTICK_PULL_RANGE.min,
				max: TICKTICK_PULL_RANGE.max,
				step: 1,
				defaultValue: DEFAULT_SETTINGS.tickTickPullMinutes,
				disabled: () => !on(),
				validate: (v) =>
					Number.isInteger(v) && v >= TICKTICK_PULL_RANGE.min && v <= TICKTICK_PULL_RANGE.max
						? undefined
						: `Use a whole number from ${TICKTICK_PULL_RANGE.min} to ${TICKTICK_PULL_RANGE.max}.`,
			},
		},
		{
			name: "Create notes from TickTick descriptions",
			desc: "A synced task's TickTick description becomes a note in the description note folder, linked to the task. Edits to it sync both ways. Notes you link yourself are never changed or sent.",
			control: { type: "toggle", key: "tickTickNotes", disabled: () => !on() },
		},
		{
			name: "Linked lists",
			desc: `Link a list from its menu in the sidebar (Sync with TickTick…). ${LIMITS_NOTE}`,
			visible: on,
		},
	];
	for (const list of lists()) {
		rows.push({
			name: list.name,
			visible: on,
			render: (setting: Setting) => {
				setting.addButton((button) =>
					button.setButtonText("Unlink").onClick(() => {
						const s = session();
						if (s === null) return;
						button.setDisabled(true);
						const flow = { state: () => s.app.store.state, sync: s.sync, notify: deps.notify, error: deps.error, linked: () => s.tickTick.refresh() };
						void unlinkListFlow(flow, list.listId).finally(deps.refresh);
					}),
				);
			},
		});
	}
	return [{ type: "group", heading: "TickTick sync", items: rows }];
}
