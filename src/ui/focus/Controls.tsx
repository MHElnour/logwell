import { useMemo, useRef } from "preact/hooks";
import { FOCUS_RANGES } from "../../app/settings";
import type { ActiveTimer, FocusSetConfig } from "../../domain/focus";
import type { DbData } from "../../persistence/schema";
import { Icon } from "../common";
import { useUniqueId } from "../hooks";
import type { UiHost } from "../host";
import { focusedText, gapSec, roundsText, summaryText } from "./format";
import { PHASE_LABEL } from "./Ring";

// The stage around the ring: the "Focus on" pill, the buttons, the set settings or the set line,
// the set-done summary and the recovery banner.

/** The four set values in minutes, the way the form shows them. */
export interface SetMinutes {
	rounds: number;
	focusMin: number;
	breakMin: number;
	longBreakMin: number;
}

export const toMinutes = (c: FocusSetConfig): SetMinutes => ({
	rounds: c.rounds,
	focusMin: Math.round(c.focusSec / 60),
	breakMin: Math.round(c.breakSec / 60),
	longBreakMin: Math.round(c.longBreakSec / 60),
});

export const toConfig = (m: SetMinutes): FocusSetConfig => ({
	rounds: m.rounds,
	focusSec: m.focusMin * 60,
	breakSec: m.breakMin * 60,
	longBreakSec: m.longBreakMin * 60,
});

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(n)));

interface Field {
	key: keyof SetMinutes;
	label: string;
	min: number;
	max: number;
	unit: string;
	/** Steps by 5 above 5 (and by 1 at or below it) so a long range is quick to cross. */
	coarse: boolean;
	hint?: string;
}

const FIELDS: Field[] = [
	{ key: "rounds", label: "Rounds", ...FOCUS_RANGES.focusRounds, unit: "", coarse: false },
	{ key: "focusMin", label: "Focus", ...FOCUS_RANGES.focusMin, unit: "min", coarse: true },
	{ key: "breakMin", label: "Break", ...FOCUS_RANGES.breakMin, unit: "min", coarse: true },
	{ key: "longBreakMin", label: "Long break", ...FOCUS_RANGES.longBreakMin, unit: "min", coarse: true, hint: "After round 4, in sets over 4" },
];

/** The step for one click: 1, or 5 on a coarse field away from the low end. */
const stepFor = (value: number, dir: 1 | -1, coarse: boolean): number => (!coarse || value < 5 || (dir < 0 && value <= 5) ? 1 : 5);

/** One setting with its minus and plus buttons. Each click is one commit; clicks in a row read the value from a ref. */
function Stepper(props: { field: Field; value: number; onCommit: (n: number) => void }) {
	const { field, value } = props;
	const labelId = useUniqueId("cp-focus-field");
	const latest = useRef(value);
	latest.current = value;
	const bump = (dir: 1 | -1) => {
		const next = clamp(latest.current + dir * stepFor(latest.current, dir, field.coarse), field.min, field.max);
		if (next === latest.current) return;
		latest.current = next;
		props.onCommit(next);
	};
	const name = field.label.toLowerCase();
	return (
		<div class="cp-focus-field" role="group" aria-labelledby={labelId}>
			<div class="cp-focus-field-text">
				<span id={labelId} class="cp-focus-field-label">
					{field.label}
				</span>
				{field.hint !== undefined && <span class="cp-focus-hint">{field.hint}</span>}
			</div>
			<div class="cp-focus-stepper">
				<button type="button" class="cp-focus-step" aria-label={`Decrease ${name}`} aria-disabled={value <= field.min} onClick={() => bump(-1)}>
					{"−"}
				</button>
				<span class="cp-focus-value">
					{value}
					{field.unit !== "" && <span class="cp-focus-unit">{field.unit}</span>}
				</span>
				<button type="button" class="cp-focus-step" aria-label={`Increase ${name}`} aria-disabled={value >= field.max} onClick={() => bump(1)}>
					+
				</button>
			</div>
		</div>
	);
}

/** The compact settings panel, shown before a set. Changes arrive as patches so quick clicks on two fields do not lose one. */
export function SetSettings(props: { minutes: SetMinutes; onChange: (patch: Partial<SetMinutes>) => void }) {
	return (
		<div class="cp-focus-settings">
			{FIELDS.map((f) => (
				<Stepper key={f.key} field={f} value={props.minutes[f.key]} onCommit={(n) => props.onChange({ [f.key]: n })} />
			))}
		</div>
	);
}

/** The one-line summary that replaces the panel while a set runs. */
export function SetLine(props: { minutes: SetMinutes }) {
	const m = props.minutes;
	return <div class="cp-focus-setline">{`${roundsText(m.rounds)} · ${m.focusMin} min focus · ${m.breakMin} min break`}</div>;
}

/** "Focus on:" a task or none, drawn as a pill above the ring. During a focus the change goes through the host's Split or Reassign prompt. */
export function TaskPicker(props: { host: UiHost; state: DbData; timer: ActiveTimer | null; picked: string; onPick: (id: string) => void }) {
	const { host, state, timer } = props;
	const id = useUniqueId("cp-focus-task");
	const options = useMemo(() => {
		const open = [...state.tasks.values()].filter((t) => t.status === "open");
		open.sort((a, b) => a.title.localeCompare(b.title));
		return open;
	}, [state.tasks]);
	const running = timer?.taskId ?? "";
	const current = timer === null ? props.picked : running;
	const extra = current === "" || options.some((t) => t.id === current) ? undefined : state.tasks.get(current);
	const value = current === "" || options.some((t) => t.id === current) || extra !== undefined ? current : "";
	// The select always shows the running task: after a Split or Reassign prompt that was cancelled, nothing
	// re-renders, so the control is put back by hand.
	const shown = useRef(value);
	shown.current = value;
	const change = (select: HTMLSelectElement) => {
		const next = select.value;
		if (timer === null) {
			props.onPick(next);
			return;
		}
		const target = next === "" ? null : next;
		const done = timer.phase === "focus" ? host.startFocus(target) : host.app.focus.reassign(target);
		void done
			.catch((err: unknown) => host.error(err))
			.finally(() => {
				select.value = shown.current;
			});
	};
	return (
		<div class={`cp-focus-task${value === "" ? " is-none" : ""}`}>
			<Icon host={host} icon="target" cls="cp-focus-task-icon" />
			<label for={id} class="cp-sr-only">
				Focus on
			</label>
			<select id={id} value={value} onChange={(e) => change(e.currentTarget)}>
				<option value="">No task</option>
				{extra !== undefined && <option value={extra.id}>{extra.title}</option>}
				{options.map((t) => (
					<option key={t.id} value={t.id}>
						{t.title}
					</option>
				))}
			</select>
			<Icon host={host} icon="chevron-down" cls="cp-focus-task-chevron" />
		</div>
	);
}

function Ctl(props: { host: UiHost; icon: string; label: string; main?: boolean; disabled?: boolean; onClick: () => void }) {
	return (
		<button type="button" class={`cp-focus-ctl${props.main === true ? " is-main" : ""}`} disabled={props.disabled} onClick={props.onClick}>
			<span class="cp-focus-ctl-disc">
				<Icon host={props.host} icon={props.icon} />
			</span>
			<span class="cp-focus-ctl-cap">{props.label}</span>
		</button>
	);
}

/**
 * Start (or Start again after a finished set). While a set runs the row is symmetric around Pause / Resume:
 * Finish on the left during a focus round (Skip break during a break), Stop on the right. While the recovery
 * banner waits only Stop stays.
 */
export function Buttons(props: { host: UiHost; timer: ActiveTimer | null; again: boolean; start: () => void }) {
	const { host, timer } = props;
	const focus = host.app.focus;
	const fail = (p: Promise<unknown>) => void p.catch((err: unknown) => host.error(err));
	if (timer === null) {
		return (
			<div class="cp-focus-controls">
				<Ctl host={host} icon="play" label={props.again ? "Start again" : "Start"} main onClick={props.start} />
			</div>
		);
	}
	const prompt = timer.needsRecovery;
	return (
		<div class="cp-focus-controls">
			{!prompt &&
				(timer.phase === "focus" ? (
					<Ctl host={host} icon="check" label="Finish" onClick={() => fail(focus.finish())} />
				) : (
					<Ctl host={host} icon="skip-forward" label="Skip break" onClick={() => fail(focus.skip())} />
				))}
			{!prompt &&
				(timer.state === "running" ? (
					<Ctl host={host} icon="pause" label="Pause" main onClick={() => fail(focus.pause())} />
				) : (
					<Ctl host={host} icon="play" label="Resume" main onClick={() => fail(focus.resume())} />
				))}
			<Ctl host={host} icon="square" label="Stop" onClick={() => fail(focus.stop())} />
		</div>
	);
}

/** The finished set: "4 rounds · 1h 40m focused" under the ring. */
export function SetSummary(props: { summary: { rounds: number; focusedSec: number } }) {
	return (
		<div class="cp-focus-summary">
			<span class="cp-focus-summary-main">{summaryText(props.summary.rounds, props.summary.focusedSec)}</span>
		</div>
	);
}

/**
 * Shown while the timer waits for a decision, so the choice is reachable even when the
 * prompt window was dismissed. Discard asks first, because the page cannot offer an Undo.
 */
export function RecoveryBanner(props: { host: UiHost; timer: ActiveTimer }) {
	const { host, timer } = props;
	const titleId = useUniqueId("cp-focus-banner");
	const pendingSec = timer.unobserved.filter((g) => g.resolution === "pending").reduce((sum, g) => sum + gapSec(g), 0);
	const resolve = (choice: "resume" | "finish" | "discard") => void host.app.focus.resolveRecovery(choice).catch((err: unknown) => host.error(err));
	const discard = async () => {
		const ok = await host.choose("Discard this focus", "The running round and the rest of the set are dropped. Nothing is saved.", [
			{ label: "Discard", value: true, warning: true },
		]);
		if (ok === true) resolve("discard");
	};
	return (
		<div class="cp-focus-banner" role="group" aria-labelledby={titleId}>
			<div id={titleId} class="cp-focus-banner-title">
				The {PHASE_LABEL[timer.phase].toLowerCase()} timer was interrupted
			</div>
			<p>
				{pendingSec > 0
					? `${focusedText(pendingSec)} while the app was closed or asleep is not counted unless you include it in the history.`
					: "The timer stopped while the app was closed or asleep."}
			</p>
			<div class="cp-focus-banner-actions">
				<button type="button" class="mod-cta" onClick={() => resolve("resume")}>
					Resume
				</button>
				<button type="button" onClick={() => resolve("finish")}>
					Finish and save
				</button>
				<button type="button" class="mod-warning" onClick={() => void discard()}>
					Discard
				</button>
			</div>
		</div>
	);
}
