import { useRef, useState } from "preact/hooks";
import type { QueryContext } from "../domain/queries";
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
	const idle = toConfig(minutes);

	const change = (patch: Partial<SetMinutes>) => {
		const next = { ...latest.current, ...patch };
		latest.current = next;
		setMinutes(next);
		void host.setFocusConfig(toConfig(next)).catch((err: unknown) => host.error(err));
	};
	const start = () => {
		const task = picked !== "" && state.tasks.has(picked) ? picked : null;
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
			<TaskPicker host={host} state={state} timer={timer} picked={picked} onPick={setPicked} />
			{timer?.needsRecovery === true && <RecoveryBanner host={host} timer={timer} />}
			<Ring host={host} timer={timer} now={now} idle={idle} summary={summary} />
			{timer === null && summary !== null && <SetSummary summary={summary} />}
			<Buttons host={host} timer={timer} again={summary !== null} start={start} />
			{timer === null ? <SetSettings minutes={minutes} onChange={change} /> : <SetLine minutes={toMinutes(timer.config)} />}
		</>
	);
}
