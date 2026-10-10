import type { Clock, IdGenerator } from "../domain/ports";
import type { QueryContext } from "../domain/queries";
import { scheduleResolver } from "../domain/recurrence";
import { todayIn } from "../domain/time";
import type { DateSpec, Task, WeekStart } from "../domain/types";
import type { DbData } from "../persistence/schema";
import { CategoryService, TagService } from "./CategoryService";
import { DataService } from "./DataService";
import { FocusService } from "./FocusService";
import { HabitService } from "./HabitService";
import {
	type ActiveTimerPort,
	type FocusSettingsPort,
	MemoryActiveTimer,
	MemoryReminderState,
	MemoryTickTickDevice,
	MemoryTickTickSecret,
	type NotePort,
	type ReminderStatePort,
	type RenameQueuePort,
	type SettingsPort,
	type TickTickDevicePort,
	type TickTickSecretPort,
} from "./ports";
import { RecurrenceService } from "./RecurrenceService";
import { AppStore, type StateHost } from "./store";
import { SectionService } from "./SectionService";
import { TaskService } from "./TaskService";

/** The app-layer composition root: one store and its services. */
export class CheckpointApp {
	readonly store: AppStore;
	readonly tasks: TaskService;
	/** Repeating tasks and their occurrences. */
	readonly recurrence: RecurrenceService;
	readonly categories: CategoryService;
	readonly sections: SectionService;
	readonly tags: TagService;
	readonly data: DataService;
	readonly focus: FocusService;
	readonly habits: HabitService;
	/** Where the habit reminder host keeps its device-local state. */
	readonly reminders: ReminderStatePort;
	/** The TickTick token. The session's sync reads it per request. */
	readonly tickTickSecret: TickTickSecretPort;
	/** "Sync with TickTick on this device". The session's sync scheduler reads it. */
	readonly tickTickDevice: TickTickDevicePort;

	constructor(
		host: StateHost,
		readonly clock: Clock,
		ids: IdGenerator,
		readonly settings: SettingsPort,
		readonly notes: NotePort,
		/** Where queued note renames are kept between sessions (default: memory only). */
		renames?: RenameQueuePort,
		/** Where the running focus timer is kept (default: memory only). */
		timers?: ActiveTimerPort,
		focusSettings?: FocusSettingsPort,
		/** Where the habit reminder state is kept (default: memory only). */
		reminders?: ReminderStatePort,
		/** Where the TickTick token is kept (default: memory only). */
		tickTickSecret?: TickTickSecretPort,
		/** Where this device's TickTick sync switch is kept (default: memory only). */
		tickTickDevice?: TickTickDevicePort,
	) {
		this.store = new AppStore(host, clock);
		this.recurrence = new RecurrenceService(this.store, settings, clock);
		this.tasks = new TaskService(this.store, ids, settings, notes, renames, undefined, this.recurrence);
		this.categories = new CategoryService(this.store, ids);
		this.sections = new SectionService(this.store, ids);
		this.tags = new TagService(this.store);
		this.data = new DataService(this.store);
		this.habits = new HabitService(this.store, clock, ids, settings);
		this.reminders = reminders ?? new MemoryReminderState();
		this.tickTickSecret = tickTickSecret ?? new MemoryTickTickSecret();
		this.tickTickDevice = tickTickDevice ?? new MemoryTickTickDevice();
		this.focus = new FocusService(
			this.store,
			clock,
			ids,
			timers ?? new MemoryActiveTimer(),
			focusSettings ?? { deviceId: () => host.data.meta.writtenBy, discardShortFocus: () => true },
		);
	}

	/** The memoized schedule resolver, valid for one state object and week start. */
	private scheduleCache: { state: DbData; weekStart: WeekStart; resolve: (task: Task) => DateSpec | null } | null = null;

	/**
	 * The context every view reads. `schedule` is the single reader of "when is it due": it resolves
	 * a repeating task's current occurrence against the store as it is when called, so a context a view kept
	 * across renders never shows stale dates.
	 */
	queryContext(): QueryContext {
		return { ...this.baseContext(this.settings.weekStart()), schedule: this.effectiveSchedule };
	}

	/** The context without a schedule resolver. */
	private baseContext(weekStart: WeekStart): QueryContext {
		const zone = this.settings.zone();
		return { today: todayIn(zone, this.clock), zone, upcomingDays: this.settings.upcomingDays(), weekStart };
	}

	/**
	 * When a task is due: its current occurrence if it repeats, else its schedule. For code that has
	 * a Task but no list entry (the details pane, the calendar drawer, search, focus).
	 */
	readonly effectiveSchedule = (task: Task): DateSpec | null => {
		// A plain task needs no resolver; this is the raw read of the fallback.
		if (task.recurrence === null) return task.scheduled;
		const state = this.store.state;
		const weekStart = this.settings.weekStart();
		let cache = this.scheduleCache;
		if (cache === null || cache.state !== state || cache.weekStart !== weekStart) {
			// The engine does not read `today` (the current occurrence does not move with the clock), so the
			// resolver is rebuilt only when the state or the week start changes.
			cache = { state, weekStart, resolve: scheduleResolver(state, this.baseContext(weekStart)) };
			this.scheduleCache = cache;
		}
		return cache.resolve(task);
	};
}
