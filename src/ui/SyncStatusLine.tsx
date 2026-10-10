import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "./common";
import { formatAgo } from "./format";
import type { UiHost } from "./host";
import { ICON } from "./icons";

/**
 * The header line of a list linked to TickTick. "Synced with TickTick · Last sync 2 minutes ago";
 * where this device does not sync (no token, or the switch is off) it says so, as the link itself is in the database
 * and shared by every device. Re-reads after each sync of this device and once a minute.
 */
export function SyncStatusLine({ host }: { host: UiHost }) {
	const sync = host.tickTick;
	const [, bump] = useState(0);
	const ref = useRef<HTMLSpanElement>(null);
	useEffect(() => {
		if (sync === undefined) return;
		// Each sync, and a change of the device switch or the token (the scheduler announces both), redraws the line.
		const off = sync.onStatus(() => bump((n) => n + 1));
		// The element's own window, so the timer lives in a pop-out window too.
		const win = ref.current?.ownerDocument.defaultView ?? window;
		const timer = win.setInterval(() => bump((n) => n + 1), 60_000);
		return () => {
			off();
			win.clearInterval(timer);
		};
	}, [sync]);
	if (sync === undefined) return null;
	const last = sync.lastSyncAt();
	const text = !sync.ready()
		? "Linked to TickTick · sync is off on this device"
		: last === null
			? "Synced with TickTick"
			: `Synced with TickTick · Last sync ${formatAgo(last, host.app.clock.now().getTime())}`;
	return (
		<span class="cp-sync-status" ref={ref}>
			<Icon host={host} icon={ICON.sync} />
			<span>{text}</span>
		</span>
	);
}
