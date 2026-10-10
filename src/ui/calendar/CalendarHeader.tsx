import type { ComponentChildren, Ref } from "preact";
import { Icon, IconButton, SrOnly } from "../common";
import { useUniqueId } from "../hooks";
import type { UiHost } from "../host";
import { ICON } from "../icons";
import type { CalendarMode } from "./format";

/** Title, navigation, the Week/Month toggle and the Unscheduled toggle. */
export function CalendarHeader(props: {
	host: UiHost;
	title: string;
	titleId: string;
	mode: CalendarMode;
	onMode: (mode: CalendarMode) => void;
	onStep: (step: 1 | -1) => void;
	onToday: () => void;
	unscheduledOpen: boolean;
	unscheduledCount: number;
	onToggleUnscheduled: () => void;
	/** The Unscheduled toggle, so the section can return focus to it when the drawer closes. */
	toggleRef?: Ref<HTMLButtonElement>;
	/** The ⋯ view menu, last in the row. */
	viewMenu?: ComponentChildren;
}) {
	const { host, mode } = props;
	const modeLabelId = useUniqueId("cp-cal-mode-label");
	const unit = mode === "week" ? "week" : "month";
	return (
		<header class="cp-main-header cp-cal-header">
			<h2 class="cp-main-title cp-cal-title" id={props.titleId}>
				{props.title}
			</h2>
			<div class="cp-cal-nav">
				<IconButton host={host} icon={ICON.calPrev} label={`Previous ${unit}`} onClick={() => props.onStep(-1)} />
				<button type="button" class="cp-cal-btn cp-cal-today" aria-label="Today" onClick={props.onToday}>
					<Icon host={host} icon={ICON.calToday} />
					<span aria-hidden="true">Today</span>
				</button>
				<IconButton host={host} icon={ICON.calNext} label={`Next ${unit}`} onClick={() => props.onStep(1)} />
			</div>
			<SrOnly id={modeLabelId}>Calendar view</SrOnly>
			<div class="cp-cal-mode" role="group" aria-labelledby={modeLabelId}>
				{(["week", "month"] as const).map((m) => (
					<button
						key={m}
						type="button"
						class={`cp-cal-btn cp-cal-mode-btn${mode === m ? " is-on" : ""}`}
						aria-pressed={mode === m}
						onClick={() => props.onMode(m)}
					>
						{m === "week" ? "Week" : "Month"}
					</button>
				))}
			</div>
			<button
				type="button"
				ref={props.toggleRef}
				class={`cp-cal-btn cp-cal-unscheduled-toggle${props.unscheduledOpen ? " is-on" : ""}`}
				aria-label="Unscheduled"
				aria-pressed={props.unscheduledOpen}
				onClick={props.onToggleUnscheduled}
			>
				<Icon host={host} icon={ICON.calUnscheduled} />
				<span aria-hidden="true">Unscheduled</span>
				<span class="cp-count-pill" aria-hidden="true">
					{props.unscheduledCount}
				</span>
			</button>
			{props.viewMenu}
		</header>
	);
}
