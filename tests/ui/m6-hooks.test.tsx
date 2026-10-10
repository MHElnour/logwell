// @vitest-environment happy-dom
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useClockTime } from "../../src/ui/hooks";
import type { UiHost } from "../../src/ui/host";

// The clock the Habits page's "Now" badge reads.

let now = new Date("2026-10-04T18:30:10.000Z");
const host = { app: { clock: { now: () => now } } } as unknown as UiHost;

function Probe(props: { zone: string; seen: string[] }) {
	const time = useClockTime(host, props.zone);
	props.seen.push(time);
	return <span class="t">{time}</span>;
}

let root: HTMLElement;
beforeEach(() => {
	vi.useFakeTimers();
	now = new Date("2026-10-04T18:30:10.000Z");
	root = document.createElement("div");
	document.body.appendChild(root);
});
afterEach(async () => {
	await act(() => render(null, root));
	root.remove();
	vi.useRealTimers();
});

describe("useClockTime", () => {
	it("reads the wall time in the zone and re-renders when the minute changes, not before", async () => {
		const seen: string[] = [];
		await act(() => render(<Probe zone="Europe/Berlin" seen={seen} />, root));
		expect(root.textContent).toBe("20:30");
		const renders = seen.length;
		// Same minute: the poll runs but nothing re-renders.
		now = new Date("2026-10-04T18:30:40.000Z");
		await act(() => {
			vi.advanceTimersByTime(30_000);
		});
		expect(seen).toHaveLength(renders);
		// The next minute: the next poll re-renders with the new time.
		now = new Date("2026-10-04T18:31:05.000Z");
		await act(() => {
			vi.advanceTimersByTime(30_000);
		});
		expect(root.textContent).toBe("20:31");
		expect(seen.length).toBeGreaterThan(renders);
	});

	it("clears its interval when the component unmounts", async () => {
		const seen: string[] = [];
		const base = vi.getTimerCount();
		await act(() => render(<Probe zone="Europe/Berlin" seen={seen} />, root));
		expect(vi.getTimerCount()).toBe(base + 1);
		await act(() => render(null, root));
		expect(vi.getTimerCount()).toBe(base);
		// A later minute does not render a removed component.
		const renders = seen.length;
		now = new Date("2026-10-04T18:45:00.000Z");
		await act(() => {
			vi.advanceTimersByTime(60_000);
		});
		expect(seen).toHaveLength(renders);
	});
});
