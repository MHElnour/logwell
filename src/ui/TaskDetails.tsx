import { categoryText } from "./icons";
import type { TargetedEvent } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { type QueryContext, isDeadlineMissed, isOverdue, quadrantOf } from "../domain/queries";
import { describeRule, explicitRule, versionAt } from "../domain/recurrence";
import { normalizeTagKey } from "../domain/tags";
import { DURATION_RANGE_MESSAGE, MAX_DURATION_MIN, isDurationMinutes, subtasksOf } from "../domain/tasks";
import { dateSpecDate } from "../domain/time";
import type { ID, Task } from "../domain/types";
import type { DbData } from "../persistence/schema";
import { QUADRANTS, deleteTask, duplicateTask, moveToCategory, priorityItems, priorityLabel, toggleComplete, updateTask } from "./actions";
import { DateSpecField, Icon, IconButton, SrOnly, TaskCheckbox, hueClass } from "./common";
import { PRIORITY_HUE, PRIORITY_NAME, dateTone, detailsDateText, dueSpecOf, formatInstant } from "./format";
import type { UiHost } from "./host";
import { useUniqueId } from "./hooks";
import { focusedText } from "./focus/format";
import { focusTotalsOf } from "./focus/totals";
import { ICON, categoryIcon } from "./icons";
import { type RepeatChoice, sameChoice } from "./repeat";
import { hasRepeatEditRequest, isPaneShown, onRepeatEditRequest, setRepeat } from "./repeatActions";
import { RepeatField } from "./RepeatPicker";
import { TagInput } from "./TagInput";
import { InlineAddBar } from "./quickadd/InlineAddBar";

// The shared details pane.

/** The details pane at the right of a section: the selected task's details, or nothing. */
export function DetailsPane({ selectedId, onSelect, ...rest }: { host: UiHost; state: DbData; ctx: QueryContext; selectedId: ID | null; onSelect: (id: ID | null) => void }) {
	if (selectedId === null) return null;
	return (
		<aside class="cp-details-pane">
			<TaskDetails {...rest} taskId={selectedId} onSelect={onSelect} onClose={() => onSelect(null)} />
		</aside>
	);
}

export function TaskDetails(props: {
	host: UiHost;
	state: DbData;
	ctx: QueryContext;
	taskId: ID;
	onSelect: (id: ID | null) => void;
	onClose: () => void;
}) {
	const { host, state, ctx } = props;
	const task = state.tasks.get(props.taskId);
	const [showInfo, setShowInfo] = useState(false);
	const [showFields, setShowFields] = useState(false);
	const [addingTag, setAddingTag] = useState(false);
	// "Edit repeat…" in a row menu opens this pane's Repeat picker (repeatActions.requestRepeatEdit).
	const [repeatRequest, setRepeatRequest] = useState(0);
	// Bumped when the date field refuses to clear a repeating task's schedule, so the field shows the date again.
	const [scheduleResets, setScheduleResets] = useState(0);
	const rootRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		// Background sections keep hidden copies of this pane: only a visible one takes the request.
		const visible = () => isPaneShown(rootRef.current);
		const open = (id: ID): boolean => {
			if (id !== props.taskId || !visible()) return false;
			setShowFields(true);
			setRepeatRequest((n) => n + 1);
			return true;
		};
		if (hasRepeatEditRequest(props.taskId, visible())) open(props.taskId);
		return onRepeatEditRequest(open);
	}, [props.taskId]);
	// Details are mounted in more than one section at a time.
	const categoryId = useUniqueId("cp-details-category");
	const quadrantId = useUniqueId("cp-details-quadrant");
	const labelId = useUniqueId("cp-details-label");
	if (task === undefined) {
		return (
			<div class="cp-details cp-empty-state">
				<p>This task is no longer available. It may have been deleted.</p>
				<button type="button" onClick={props.onClose}>
					Close
				</button>
			</div>
		);
	}
	const parent = task.parentId === null ? undefined : state.tasks.get(task.parentId);
	// A repeating task has no schedule of its own; its current occurrence is what the pane shows and edits.
	const rec = task.recurrence;
	const schedule = host.app.effectiveSchedule(task);
	const dueSpec = dueSpecOf(task, schedule);
	// The rule in force today (a later version that has not started yet is not the repeat the task has now).
	const dateText = detailsDateText(task, ctx.zone, ctx.today, { schedule, repeat: rec === null ? null : describeRule(rec, ctx.today) });
	// Spelled out from the series' own anchor (not from the date on screen), so the line and a Custom → Done agree with the row chip.
	const repeatChoice: RepeatChoice | null = rec === null ? null : { rule: explicitRule(versionAt(rec, ctx.today).rule, rec.anchor), end: rec.end };
	// The picker names weekdays and days from the current occurrence (the series' first date may be long past), and
	// its Weekly and Monthly presets store them, so the hint and the stored rule agree.
	const repeatAnchor = schedule !== null ? dateSpecDate(schedule, ctx.zone) : rec !== null ? rec.anchor : ctx.today;
	const tone = task.status === "completed" ? "none" : dateTone(dueSpec, ctx.zone, ctx.today);
	const category = state.categories.get(task.categoryId);
	const listIcon = categoryIcon(category?.icon);
	const priorityHue = PRIORITY_HUE[task.priority];
	const focusSec = focusTotalsOf(state).get(task.id) ?? 0;

	const menu = (evt: MouseEvent) =>
		host.showMenu(evt, [
			{ title: "Duplicate", icon: "copy", run: () => void duplicateTask(host, task).then((c) => c && props.onSelect(c.id)) },
			{
				title: "Make subtask of…",
				icon: "corner-down-right",
				disabled: task.parentId !== null || subtasksOf(state.tasks.values(), task.id).length > 0,
				run: () =>
					void host.pickTask(task.id).then(async (pid) => {
						if (pid === null) return;
						try {
							await host.app.tasks.setParent(task.id, pid);
						} catch (err) {
							host.error(err);
						}
					}),
			},
			{
				title: "Make top-level task",
				icon: "corner-left-up",
				disabled: task.parentId === null,
				run: () => void host.app.tasks.setParent(task.id, null).catch((err: unknown) => host.error(err)),
			},
			{ title: "Urgent", icon: "zap", checked: task.urgent, run: () => void updateTask(host, task, { urgent: !task.urgent }) },
			{ title: "Important", icon: "star", checked: task.important, run: () => void updateTask(host, task, { important: !task.important }) },
			"separator",
			{ title: showInfo ? "Hide ID and timestamps" : "Show ID and timestamps", icon: "info", run: () => setShowInfo(!showInfo) },
			"separator",
			{
				title: "Delete",
				icon: "trash-2",
				warning: true,
				run: () => void deleteTask(host, task).then((ok) => ok && props.onSelect(null)),
			},
		]);

	return (
		<div class="cp-details" aria-labelledby={labelId} ref={rootRef}>
			<SrOnly id={labelId}>Task details</SrOnly>
			<div class="cp-details-top">
				<TaskCheckbox
					done={task.status === "completed"}
					title={task.title}
					priority={task.priority}
					onToggle={() => void toggleComplete(host, task)}
				/>
				<button
					type="button"
					class={`cp-due-chip is-${tone}${isOverdue(task, ctx) ? " is-overdue" : ""}${isDeadlineMissed(task, ctx) ? " is-missed" : ""}${dueSpec === null ? " is-empty" : ""}`}
					aria-expanded={showFields}
					aria-label={`Date and details: ${dateText}`}
					onClick={() => setShowFields(!showFields)}
				>
					<Icon host={host} icon={ICON.clock} />
					<span>{dateText}</span>
				</button>
				<div class="cp-details-top-actions">
					<IconButton
						host={host}
						icon={ICON.flag}
						label={`Priority: ${PRIORITY_NAME[task.priority]}`}
						cls={`cp-priority-button${priorityHue === null ? "" : ` cp-hue-${priorityHue}`}`}
						onClick={(e) => host.showMenu(e, priorityItems(host, task, priorityLabel))}
					/>
					<IconButton host={host} icon="more-horizontal" label="More task actions" onClick={menu} />
					<IconButton host={host} icon="x" label="Close details" cls="cp-details-close" onClick={props.onClose} />
				</div>
			</div>

			<TitleEditor key={task.id} host={host} task={task} />

			{parent !== undefined && (
				<div class="cp-parent-link">
					Subtask of{" "}
					<button type="button" class="cp-link-button" onClick={() => props.onSelect(parent.id)}>
						{parent.title}
					</button>
				</div>
			)}

			{showFields && (
			<div class="cp-details-fields">
				<DateSpecField
					key={`scheduled-${scheduleResets}`}
					host={host}
					label="Scheduled"
					value={schedule}
					zone={ctx.zone}
					// Clearing the date of a repeating task would end the series: the repeat is changed in the Repeat field.
					clearable={rec === null}
					onChange={(spec) => {
						if (spec === null && rec !== null) {
							host.notify("Change the repeat instead of clearing the date.");
							setScheduleResets((n) => n + 1);
							return;
						}
						void updateTask(host, task, { scheduled: spec });
					}}
				/>
				{/* A subtask does not repeat. */}
				{task.parentId === null && (
					<RepeatField
						value={repeatChoice}
						anchor={repeatAnchor}
						today={ctx.today}
						weekStart={host.settings().weekStart}
						setIcon={(el, icon) => host.setIcon(el, icon)}
						explicitPresets
						openRequest={repeatRequest}
						onChange={(choice) => {
							// The picker hands back what it was given when nothing changed: that is no edit (no version, no notice).
							if (sameChoice(choice, repeatChoice)) return;
							void setRepeat(host, task, choice, repeatAnchor);
						}}
					/>
				)}
				{/* A repeating task has no deadline, so the field is not offered (a deadline is cleared when it starts repeating). */}
				{rec === null && (
					<DateSpecField
						host={host}
						label="Deadline"
						value={task.deadline}
						zone={ctx.zone}
						onChange={(spec) => void updateTask(host, task, { deadline: spec })}
					/>
				)}
				<DurationField key={`${task.id}-${task.plannedDurationMin}`} host={host} task={task} />
				<div class="cp-field">
					<label for={categoryId}>List</label>
					<select
						id={categoryId}
						class="dropdown"
						value={task.categoryId}
						disabled={task.parentId !== null}
						title={task.parentId !== null ? "A subtask stays in its parent's list" : undefined}
						onChange={(e: TargetedEvent<HTMLSelectElement>) =>
							void updateTask(host, task, { categoryId: e.currentTarget.value })
						}
					>
						{host.app.categories.list().map((c) => (
							<option key={c.id} value={c.id}>
								{categoryText(c)}
							</option>
						))}
					</select>
				</div>
				<div class="cp-field">
					<label for={quadrantId}>Matrix</label>
					<select
						id={quadrantId}
						class="dropdown"
						value={quadrantOf(task)}
						onChange={(e: TargetedEvent<HTMLSelectElement>) => {
							const q = QUADRANTS.find((x) => x.id === e.currentTarget.value);
							if (q !== undefined) void updateTask(host, task, { urgent: q.urgent, important: q.important });
						}}
					>
						{QUADRANTS.map((q) => (
							<option key={q.id} value={q.id}>
								{q.label}
							</option>
						))}
					</select>
				</div>
			</div>
			)}

			<DescriptionArea host={host} task={task} onSelect={props.onSelect} />

			<div class="cp-details-section cp-details-tags">
				<div class="cp-section-heading">Tags</div>
				<div class="cp-tag-row">
					{task.tagKeys.map((k) => (
						<span key={k} class={`cp-tag-pill ${hueClass(state.tags.get(k)?.color)}`}>
							@{state.tags.get(k)?.displayName ?? k}
							<button
								type="button"
								class="cp-tag-remove"
								aria-label={`Remove tag ${state.tags.get(k)?.displayName ?? k}`}
								onClick={() => void updateTask(host, task, { tagKeys: task.tagKeys.filter((x) => x !== k) })}
							>
								×
							</button>
						</span>
					))}
					<button
						type="button"
						class="cp-add-tag"
						aria-label="Add tag"
						aria-expanded={addingTag}
						onClick={() => setAddingTag(!addingTag)}
					>
						<Icon host={host} icon={ICON.add} />
					</button>
				</div>
				{addingTag && (
					<TagInput
						app={host.app}
						value={task.tagKeys}
						hideChips={true}
						inputLabel="Tag name"
						onChange={(keys) => void updateTask(host, task, { tagKeys: keys })}
						onError={(err) => host.error(err)}
						normalize={normalizeTagKey}
					/>
				)}
			</div>

			{task.parentId === null && <Subtasks key={task.id} host={host} state={state} task={task} onSelect={props.onSelect} />}

			<div class="cp-details-foot">
				<button type="button" class="cp-list-button" onClick={() => void moveToCategory(host, task)} disabled={task.parentId !== null}>
					{listIcon.kind === "emoji" ? (
						<span class="cp-emoji" aria-hidden="true">
							{listIcon.text}
						</span>
					) : (
						<Icon host={host} icon={listIcon.name} fallback={ICON.list} />
					)}
					<span>{category?.name ?? "Inbox"}</span>
				</button>
				<span class="cp-foot-spacer" />
				{focusSec > 0 && <span class="cp-focus-total">{`${focusedText(focusSec)} focused`}</span>}
				<button
					type="button"
					class="cp-focus-button mod-cta"
					onClick={() => void host.startFocus(task.id).catch((err: unknown) => host.error(err))}
				>
					<Icon host={host} icon={ICON.railFocus} />
					<span>Focus</span>
				</button>
			</div>

			{showInfo && (
				<dl class="cp-details-info">
					<dt>ID</dt>
					<dd>
						<code>{task.id}</code>
					</dd>
					<dt>Created</dt>
					<dd>{formatInstant(task.createdAt, ctx.zone)}</dd>
					<dt>Modified</dt>
					<dd>{formatInstant(task.modifiedAt, ctx.zone)}</dd>
					{task.completedAt !== null && (
						<>
							<dt>Completed</dt>
							<dd>{formatInstant(task.completedAt, ctx.zone)}</dd>
						</>
					)}
				</dl>
			)}
		</div>
	);
}

/** Clearing the title restores the previous value with a message. */
function TitleEditor({ host, task }: { host: UiHost; task: Task }) {
	const [value, setValue] = useState(task.title);
	const committed = useRef(task.title);
	useEffect(() => {
		if (task.title !== committed.current) {
			committed.current = task.title;
			setValue(task.title);
		}
	}, [task.title]);
	const commit = async () => {
		if (value.trim() === "") {
			setValue(task.title);
			host.notify("A task needs a title. The previous title was restored.");
			return;
		}
		if (value.trim() === task.title) return;
		committed.current = value.trim();
		const ok = await updateTask(host, task, { title: value });
		if (!ok) setValue(task.title);
	};
	return (
		<textarea
			class="cp-details-title"
			aria-label="Task title"
			rows={1}
			value={value}
			onInput={(e) => setValue(e.currentTarget.value)}
			onBlur={() => void commit()}
			onKeyDown={(e) => {
				if (e.key === "Enter") {
					e.preventDefault();
					e.currentTarget.blur();
				} else if (e.key === "Escape") {
					setValue(task.title);
				}
			}}
		/>
	);
}

function DurationField({ host, task }: { host: UiHost; task: Task }) {
	const [value, setValue] = useState(task.plannedDurationMin?.toString() ?? "");
	const id = useUniqueId("cp-details-duration");
	const commit = () => {
		const text = value.trim();
		const next = text === "" ? null : Number(text);
		if (next === task.plannedDurationMin) return;
		if (next !== null && !isDurationMinutes(next)) {
			host.notify(DURATION_RANGE_MESSAGE);
			setValue(task.plannedDurationMin?.toString() ?? "");
			return;
		}
		void updateTask(host, task, { plannedDurationMin: next });
	};
	return (
		<div class="cp-field">
			<label for={id}>Duration (min)</label>
			<input
				id={id}
				type="number"
				min={1}
				max={MAX_DURATION_MIN}
				step={1}
				value={value}
				onInput={(e) => setValue(e.currentTarget.value)}
				onBlur={commit}
				onKeyDown={(e) => e.key === "Enter" && commit()}
			/>
		</div>
	);
}

/**
 * The subtask list and its add bar. The bar is the Quick Add editor with the parent as preset, so
 * it parses like the other bars. A typed #Category is shown as not applicable and ignored.
 */
function Subtasks({ host, state, task, onSelect }: { host: UiHost; state: DbData; task: Task; onSelect: (id: ID) => void }) {
	const subs = useMemo(() => subtasksOf(state.tasks.values(), task.id), [state.tasks, task.id]);
	return (
		<div class="cp-details-section">
			<div class="cp-section-heading">
				<span>Subtasks</span>
				{subs.length > 0 && <span class="cp-subtasks-count">{`${subs.filter((s) => s.status === "completed").length} / ${subs.length}`}</span>}
			</div>
			<ul class="cp-subtasks">
				{subs.map((s) => (
					<li key={s.id} class={s.status === "completed" ? "is-completed" : ""}>
						<TaskCheckbox done={s.status === "completed"} title={s.title} priority={s.priority} onToggle={() => void toggleComplete(host, s)} />
						<button type="button" class="cp-link-button" onClick={() => onSelect(s.id)}>
							{s.title}
						</button>
					</li>
				))}
			</ul>
			<InlineAddBar host={host} preset={{ categoryId: task.categoryId, parentId: task.id }} ariaLabel="Add subtask" placeholder="Add subtask" cls="cp-add-bar cp-add-subtask" />
		</div>
	);
}

/** The description-area states: no note, linked, missing. */
function DescriptionArea({ host, task, onSelect }: { host: UiHost; task: Task; onSelect: (id: ID) => void }) {
	const [, setTick] = useState(0);
	const note = task.descriptionNote;
	useEffect(() => host.onNotesChanged(() => setTick((n) => n + 1)), [host]);
	const { tasks } = host.app;

	const link = async () => {
		const path = await host.pickNote();
		if (path !== null) await tasks.linkNote(task.id, path).catch((err: unknown) => host.error(err));
	};
	const create = async () => {
		try {
			const path = await tasks.createDescriptionNote(task.id);
			host.openNote(path, false);
		} catch (err) {
			host.error(err);
		}
	};
	const unlink = () => void tasks.unlinkNote(task.id).catch((err: unknown) => host.error(err));

	if (note === null) {
		return (
			<div class="cp-description is-empty">
				<button type="button" onClick={() => void link()}>
					Link existing note
				</button>
				<button type="button" onClick={() => void create()}>
					Create description note
				</button>
			</div>
		);
	}

	if (!tasks.noteExists(note.path)) {
		const suggestion = tasks.relinkSuggestion(task.id);
		return (
			<div class="cp-description is-missing" role="status">
				<p>
					Description note not found: <code>{note.path}</code>
				</p>
				<div class="cp-description-actions">
					{suggestion !== null && (
						<button type="button" class="mod-cta" onClick={() => void tasks.linkNote(task.id, suggestion)}>
							Relink to {suggestion}
						</button>
					)}
					<button type="button" onClick={() => void link()}>
						Relink
					</button>
					<button type="button" onClick={unlink}>
						Unlink
					</button>
				</div>
			</div>
		);
	}

	const also = tasks.alsoLinkedFrom(task.id);
	return (
		<div class="cp-description is-linked">
			<div class="cp-note-head">
				<Icon host={host} icon={ICON.note} />
				<span class="cp-note-name" title={note.path}>
					{note.path.split("/").pop()}
				</span>
				<IconButton
					host={host}
					icon={ICON.openNote}
					label="Open note"
					onClick={(e) => host.openNote(note.path, e.altKey)}
				/>
			</div>
			<NotePreview host={host} path={note.path} />
			{also.length > 0 && (
				<div class="cp-also-linked">
					Also linked from:{" "}
					{also.map((t, i) => (
						<span key={t.id}>
							{i > 0 && ", "}
							<button type="button" class="cp-link-button" onClick={() => onSelect(t.id)}>
								{t.title}
							</button>
						</span>
					))}
				</div>
			)}
			<div class="cp-description-actions">
				<button type="button" onClick={() => void link()}>
					Change
				</button>
				<button type="button" onClick={unlink}>
					Unlink
				</button>
			</div>
		</div>
	);
}

/** Rendered with MarkdownRenderer; re-rendered within ~1 s of an edit. */
function NotePreview({ host, path }: { host: UiHost; path: string }) {
	const ref = useRef<HTMLDivElement>(null);
	const [version, setVersion] = useState(0);
	useEffect(() => {
		let timer: number | null = null;
		const off = host.onNotesChanged((p) => {
			if (p !== path) return;
			if (timer !== null) window.clearTimeout(timer);
			timer = window.setTimeout(() => setVersion((v) => v + 1), 300);
		});
		return () => {
			off();
			if (timer !== null) window.clearTimeout(timer);
		};
	}, [host, path]);
	useEffect(() => {
		const el = ref.current;
		if (el === null) return;
		let dispose: (() => void) | null = null;
		let cancelled = false;
		void host.renderNote(path, el).then((d) => {
			if (cancelled) d();
			else dispose = d;
		});
		return () => {
			cancelled = true;
			dispose?.();
		};
	}, [host, path, version]);
	return <div ref={ref} class="cp-note-preview markdown-rendered" />;
}
