import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { QueryContext } from "../domain/queries";
import { isOpen } from "../domain/tasks";
import type { DbData } from "../persistence/schema";
import { Buttons, RecoveryBanner, type SetMinutes, SetLine, SetSettings, SetSummary, TaskPicker, toConfig, toMinutes } from "./focus/Controls";
import { History, Overview } from "./focus/Insights";
import { Ring } from "./focus/Ring";
import { useFocus, useUniqueId } from "./hooks";
import type { UiHost } from "./host";

// The Focus section: one calm timer stage in the middle and a slim column with the
// overview and the focus record. One column below about 860 px (a container query in styles.css).
// The timer itself lives in app.focus; this component only draws it and sends commands.

export function FocusSection(props: { host: UiHost; state: DbData; ctx: QueryContext; visible: boolean }) {
	const { host, state, ctx } = props;
	const titleId = useUniqueId("cp-focus-title");
	return (
		<div class="cp-focus">
			<div class="cp-focus-main">
				<h2 id={titleId} class="cp-sr-only">
					Focus
				</h2>
				<div class="cp-focus-body">
					<section class="cp-focus-timer" aria-labelledby={titleId}>
						<div class="cp-focus-stage">
							<TimerPanel host={host} state={state} visible={props.visible} />
						</div>
					</section>
					<aside class="cp-focus-insights">
						<Overview state={state} ctx={ctx} />
						<History host={host} state={state} ctx={ctx} />
					</aside>
				</div>
			</div>
		</div>
	);
}

/** Everything that changes every second lives here, so the record beside it does not re-render. */
function TimerPanel(props: { host: UiHost; state: DbData; visible: boolean }) {
	const { host, state } = props;
	const { timer, summary, now } = useFocus(host, props.visible);
	const [minutes, setMinutes] = useState<SetMinutes>(() => toMinutes(host.focusConfig()));
	// Clicks in a row on two fields must build on each other, so the latest values live in a ref too.
	const latest = useRef(minutes);
	latest.current = minutes;
	const [picked, setPicked] = useState<string>("");
	// A pick is for the next set only: it goes when a set ends, finished or stopped. Keyed on "a timer runs", so a
	// pick made after the set ended stays. A layout effect, so the old pick is never painted beside the finished set.
	const running = timer !== null;
	useLayoutEffect(() => {
		if (!running) setPicked("");
	}, [running]);
	// The pick counts only while its task is open: completed or in Trash reads "No task".
	const pickedTask = picked === "" ? undefined : state.tasks.get(picked);
	const pick = pickedTask !== undefined && isOpen(pickedTask) ? picked : "";
	const idle = toConfig(minutes);

	const change = (patch: Partial<SetMinutes>) => {
		const next = { ...latest.current, ...patch };
		latest.current = next;
		setMinutes(next);
		void host.setFocusConfig(toConfig(next)).catch((err: unknown) => host.error(err));
	};
	const start = () => {
		const task = pick === "" ? null : pick;
		host.focusGesture();
		void host.app.focus.start(idle, task).then(
			(result) => {
				if (result.kind === "busy") host.notify("A focus timer is already running.");
			},
			(err: unknown) => host.error(err),
		);
	};

	return (
		<>
			<TaskPicker host={host} state={state} timer={timer} picked={pick} onPick={setPicked} />
			{timer?.needsRecovery === true && <RecoveryBanner host={host} timer={timer} />}
			<Ring host={host} timer={timer} now={now} idle={idle} summary={summary} />
			{timer === null && summary !== null && <SetSummary summary={summary} />}
			<Buttons host={host} timer={timer} again={summary !== null} start={start} />
			{timer === null ? <SetSettings host={host} minutes={minutes} onChange={change} /> : <SetLine minutes={toMinutes(timer.config)} />}
		</>
	);
}
