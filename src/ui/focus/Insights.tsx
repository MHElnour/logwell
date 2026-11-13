import { useEffect, useMemo, useState } from "preact/hooks";
import { ASSIGN_LABEL, DELETE_LABEL, EDIT_LABEL } from "../../app/FocusService";
import { type FocusRound, type FocusSetNode, focusHistoryTree, focusOverview, focusedSec } from "../../domain/focus";
import type { QueryContext } from "../../domain/queries";
import type { FocusGap, FocusSession } from "../../domain/types";
import type { DbData } from "../../persistence/schema";
import { Icon, IconButton, hueClass } from "../common";
import { formatDate } from "../format";
import { useUniqueId } from "../hooks";
import type { MenuSpec, UiHost } from "../host";
import { ICON } from "../icons";
import { notifyWrite } from "../writeNotice";
import { dotClass, focusedText, gapSec, roundStatusText, roundsText, setDotClasses, timeRange } from "./format";

// The right column: the overview (today, then all time) and the history by day.

export function Overview(props: { host: UiHost; state: DbData; ctx: QueryContext }) {
	const { host, state, ctx } = props;
	const headingId = useUniqueId("cp-focus-overview");
	const o = useMemo(() => focusOverview(state.focusSessions.values(), ctx.today, ctx.zone), [state.focusSessions, ctx.today, ctx.zone]);
	return (
		<section class="cp-focus-overview" aria-labelledby={headingId}>
			<h3 id={headingId} class="cp-focus-side-heading">
				Overview
			</h3>
			<div class="cp-focus-stats">
				<StatTile host={host} label="Today" icon={ICON.today} hue="" count={o.todayCount} sec={o.todaySec} />
				<StatTile host={host} label="All time" icon={ICON.focusAllTime} hue={hueClass("blue")} count={o.totalCount} sec={o.totalSec} />
			</div>
		</section>
	);
}

/** One tile of the overview: its name, then Pomos and Focused. */
function StatTile(props: { host: UiHost; label: string; icon: string; hue: string; count: number; sec: number }) {
	const labelId = useUniqueId("cp-focus-stat");
	return (
		<div class={`cp-focus-stat ${props.hue}`.trim()} role="group" aria-labelledby={labelId}>
			<div id={labelId} class="cp-focus-stat-label">
				<Icon host={props.host} icon={props.icon} />
				<span>{props.label}</span>
			</div>
			<dl class="cp-focus-figs">
				<Figure caption="Pomos" value={String(props.count)} />
				<Figure caption="Focused" value={focusedText(props.sec)} />
			</dl>
		</div>
	);
}

/** One figure with its caption. The caption comes first for a screen reader; the stylesheet draws the value above it. */
function Figure(props: { caption: string; value: string }) {
	return (
		<div class="cp-focus-fig">
			<dt class="cp-focus-fig-cap">{props.caption}</dt>
			<dd class="cp-focus-fig-value">{props.value}</dd>
		</div>
	);
}

const PAGE = 50;

/** The id of the set whose timer is running, so its record reads "in progress". Changes rarely, so it re-renders rarely. */
function useActiveSetId(host: UiHost): string | null {
	const focus = host.app.focus;
	const [id, setId] = useState<string | null>(() => focus.timer()?.setId ?? null);
	useEffect(() => {
		const sync = () => setId(focus.timer()?.setId ?? null);
		sync();
		return focus.bus.on("focus", sync);
	}, [focus]);
	return id;
}

export function History(props: { host: UiHost; state: DbData; ctx: QueryContext }) {
	const { host, state, ctx } = props;
	const headingId = useUniqueId("cp-focus-history");
	const [shown, setShown] = useState(PAGE);
	const activeSetId = useActiveSetId(host);
	// Open sets, by key. Per view: it is not saved. A set starts closed; the set whose timer runs is opened once,
	// when it becomes the running set, and then keeps the state the user gives it.
	const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(activeSetId === null ? [] : [activeSetId]));
	useEffect(() => {
		if (activeSetId !== null) setOpen((cur) => (cur.has(activeSetId) ? cur : new Set(cur).add(activeSetId)));
	}, [activeSetId]);
	const days = useMemo(() => focusHistoryTree(state.focusSessions.values(), ctx.zone, activeSetId), [state.focusSessions, ctx.zone, activeSetId]);
	const total = state.focusSessions.size;
	const toggle = (key: string) =>
		setOpen((cur) => {
			const next = new Set(cur);
			if (!next.delete(key)) next.add(key);
			return next;
		});
	// Paging counts rounds but never cuts a set in two.
	let left = shown;
	const pages = days.map((d) => {
		const sets: FocusSetNode[] = [];
		for (const set of d.sets) {
			if (left <= 0) break;
			sets.push(set);
			left -= set.rounds.length;
		}
		return { day: d, sets };
	});
	return (
		<section class="cp-focus-history" aria-labelledby={headingId}>
			<h3 id={headingId} class="cp-focus-side-heading">
				Focus record
			</h3>
			{total === 0 ? (
				<p class="cp-focus-empty">No focus yet. Finished rounds appear here.</p>
			) : (
				pages.map(({ day, sets }) =>
					sets.length === 0 ? null : (
						<div key={day.day} class="cp-focus-day">
							<h4 class="cp-focus-day-heading">
								<span class="cp-focus-day-name">{formatDate(day.day, ctx.today)}</span>
								<span class="cp-focus-day-total">{focusedText(day.totalSec)}</span>
							</h4>
							<div class="cp-focus-sets">
								{sets.map((set) => (
									<SetNode key={set.key} host={host} state={state} ctx={ctx} set={set} open={open.has(set.key)} onToggle={() => toggle(set.key)} />
								))}
							</div>
						</div>
					),
				)
			)}
			{pages.some((p) => p.sets.length < p.day.sets.length) ? (
				<button type="button" class="cp-focus-more" onClick={() => setShown(shown + PAGE)}>
					Show more
				</button>
			) : null}
			<Legend />
		</section>
	);
}

/** What the status dots mean. Each round carries its status as words too, so this is decoration. */
function Legend() {
	const items: [string, string][] = [
		["Completed", "is-completed"],
		["Finished early", "is-early"],
		["Stopped or split", "is-stopped"],
		["Recovered", "is-recovered"],
	];
	return (
		<div class="cp-focus-legend" aria-hidden="true">
			{items.map(([label, cls]) => (
				<span key={cls}>
					<i class={`cp-focus-status-dot ${cls}`} />
					{label}
				</span>
			))}
		</div>
	);
}

/** The live title, else the snapshot marked "(deleted)"; no task at all reads "No task". */
function taskLabel(state: DbData, s: FocusSession): string {
	if (s.taskId === null) return "No task";
	const task = state.tasks.get(s.taskId);
	if (task !== undefined) return task.title;
	return `${s.taskTitleSnapshot === "" ? "Task" : s.taskTitleSnapshot} (deleted)`;
}

/** What a set was worked on: its task, or "Several tasks" when its rounds differ (each round then shows its own). */
function setTitle(state: DbData, set: FocusSetNode): string {
	return set.mixedTasks ? "Several tasks" : taskLabel(state, set.rounds[0]!.session);
}

/** "2 of 6 rounds", or "2 rounds" for records that do not know the plan. */
function setCountText(set: FocusSetNode): string {
	const n = set.roundCount;
	return set.plannedRounds === null ? roundsText(n) : `${n} of ${roundsText(set.plannedRounds)}`;
}

function setEndText(set: FocusSetNode): string {
	switch (set.end) {
		case "done":
			return "done";
		case "recovered":
			return "recovered";
		case "active":
			return "in progress";
		case "stopped":
			return set.roundCount > 1 || set.plannedRounds !== 1 ? `stopped after round ${set.endedAfter}` : "stopped";
	}
}

function SetNode(props: { host: UiHost; state: DbData; ctx: QueryContext; set: FocusSetNode; open: boolean; onToggle: () => void }) {
	const { host, state, ctx, set, open } = props;
	const bodyId = useUniqueId("cp-focus-set-body");
	const range = timeRange(set, ctx.zone, " – ");
	const dots = useMemo(() => setDotClasses(set.rounds.map((r) => r.session)), [set.rounds]);
	const none = !set.mixedTasks && set.rounds[0]!.session.taskId === null;
	// Read out between the parts of the heading; the eye gets the gaps of the meta line.
	const comma = <span class="cp-sr-only">, </span>;
	return (
		<div class={`cp-focus-set is-end-${set.end}${open ? "" : " is-closed"}`}>
			<button type="button" class="cp-focus-set-head" aria-expanded={open} aria-controls={open ? bodyId : undefined} onClick={props.onToggle}>
				<span class="cp-focus-set-title">
					<b class={`cp-focus-set-name${none ? " is-none" : ""}`}>{setTitle(state, set)}</b>
					<span class="cp-focus-set-meta">
						{comma}
						<span class="cp-focus-set-dots" aria-hidden="true">
							{dots.map((cls) => (
								<i key={cls} class={`cp-focus-status-dot ${cls}`} />
							))}
						</span>
						<span class="cp-focus-set-count">{setCountText(set)}</span>
						{comma}
						<span class="cp-focus-set-range">{range}</span>
						{comma}
						<span class="cp-focus-set-end">{setEndText(set)}</span>
						{comma}
					</span>
				</span>
				<span class="cp-focus-set-sum">{focusedText(set.totalSec)}</span>
				<Icon host={host} icon="chevron-down" cls="cp-focus-set-twisty" />
			</button>
			{open && (
				<ol id={bodyId} class="cp-focus-rounds">
					{set.rounds.map((r) => (
						<Round key={r.session.id} host={host} state={state} ctx={ctx} round={r} showTask={set.mixedTasks} />
					))}
				</ol>
			)}
		</div>
	);
}

function Round(props: { host: UiHost; state: DbData; ctx: QueryContext; round: FocusRound; showTask: boolean }) {
	const { host, state, ctx, round, showTask } = props;
	const s = round.session;
	const range = timeRange(s, ctx.zone);
	const fail = (err: unknown) => host.error(err);
	const change = async () => {
		const id = await host.pickTask(s.taskId ?? "");
		if (id === null) return;
		try {
			const mark = host.app.store.undoMark();
			const wrote = await host.app.focus.assign(s.id, id);
			notifyWrite(host, { wrote, label: ASSIGN_LABEL }, "Assigned the focus record.", mark);
		} catch (err) {
			fail(err);
		}
	};
	const unassign = async () => {
		try {
			const mark = host.app.store.undoMark();
			const wrote = await host.app.focus.assign(s.id, null);
			notifyWrite(host, { wrote, label: ASSIGN_LABEL }, "Removed the task from the focus record.", mark);
		} catch (err) {
			fail(err);
		}
	};
	const remove = async () => {
		try {
			const mark = host.app.store.undoMark();
			await host.app.focus.deleteRecord(s.id);
			host.notifyUndo("Deleted the focus record.", DELETE_LABEL, mark);
		} catch (err) {
			fail(err);
		}
	};
	// Every item writes the file, so a read-only database offers none of them.
	const writable = host.app.store.readOnlyState === null;
	const menu: MenuSpec = !writable
		? []
		: [
				...(s.taskId === null
					? [{ title: "Assign to task…", icon: "link", run: () => void change() }]
					: [
							{ title: "Change task…", icon: "link", run: () => void change() },
							{ title: "Remove task", icon: "unlink", run: () => void unassign() },
						]),
				"separator" as const,
				{ title: "Delete record", icon: "trash-2", warning: true, run: () => void remove() },
			];
	return (
		<li class="cp-focus-rec">
			<i class={`cp-focus-status-dot ${dotClass(s)}`} aria-hidden="true" />
			<span class="cp-focus-round-what">
				<b class="cp-focus-round-name">{`Round ${round.number}`}</b>
				<small class="cp-focus-round-status">
					{`${range.replace("–", " – ")} · `}
					<em>{roundStatusText(s)}</em>
				</small>
			</span>
			<span class="cp-focus-round-time">{focusedText(focusedSec(s))}</span>
			{writable && (
				<IconButton
					host={host}
					icon="more-horizontal"
					label={`Actions for round ${round.number}, ${range}`}
					cls="cp-focus-round-more"
					onClick={(e) => host.showMenu(e, menu)}
				/>
			)}
			{showTask && <div class={`cp-focus-round-task${s.taskId === null ? " is-none" : ""}`}>{taskLabel(state, s)}</div>}
			{s.unobserved.map((g, i) => (
				<Gap key={`${g.start}-${i}`} host={host} session={s} gap={g} index={i} />
			))}
		</li>
	);
}

function Gap(props: { host: UiHost; session: FocusSession; gap: FocusGap; index: number }) {
	const { host, session, gap, index } = props;
	const length = focusedText(gapSec(gap));
	const set = async (included: boolean) => {
		try {
			const mark = host.app.store.undoMark();
			const wrote = await host.app.focus.includeGap(session.id, index, included);
			notifyWrite(host, { wrote, label: EDIT_LABEL }, included ? "Included the unobserved time." : "Excluded the unobserved time.", mark);
		} catch (err) {
			host.error(err);
		}
	};
	const note = gap.resolution === "pending" ? "not counted" : gap.resolution === "included" ? "included" : "excluded";
	return (
		<div class={`cp-focus-gap is-${gap.resolution}`}>
			<span class="cp-focus-gap-text">{`+${length} unobserved, ${note}`}</span>
			{gap.resolution !== "included" && (
				<button type="button" class="cp-focus-gap-include" aria-label={`Include ${length} of unobserved time`} onClick={() => void set(true)}>
					Include
				</button>
			)}
			{gap.resolution !== "excluded" && (
				<button type="button" class="cp-focus-gap-exclude" aria-label={`Exclude ${length} of unobserved time`} onClick={() => void set(false)}>
					Exclude
				</button>
			)}
		</div>
	);
}
