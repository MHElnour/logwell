// @vitest-environment happy-dom
import { render } from "preact";
import { afterEach, describe, expect, it } from "vitest";
import { AppRoot, type AppRootHandle } from "../../src/ui/AppRoot";
import { SectionRelay } from "../../src/ui/sectionRelay";
import { appHarness } from "../app/harness";
import { U1Host, settle } from "./u1-helpers";

// "Open calendar" and "Open search" on a tab that is not open yet showed Tasks: the request came
// before AppRoot registered its handle (a post-paint effect) and was dropped. SectionRelay keeps it.

const roots: HTMLElement[] = [];
afterEach(() => {
	for (const r of roots.splice(0)) {
		render(null, r);
		r.remove();
	}
});

/** Mounts AppRoot the way CheckpointView.renderApp does. */
async function mount(relay: SectionRelay, order: "show-before-mount" | "show-right-after-mount" | "show-after-effects") {
	(HTMLElement.prototype as unknown as { empty: () => void }).empty = function (this: HTMLElement) {
		this.replaceChildren();
	};
	const h = await appHarness();
	const host = new U1Host(h);
	const root = document.createElement("div");
	document.body.appendChild(root);
	roots.push(root);
	const view = () => <AppRoot host={host} initialSection={relay.pending} handle={(handle: AppRootHandle) => relay.attach(handle)} />;
	if (order === "show-before-mount") relay.show("calendar");
	render(view(), root);
	// Effects have not run yet: the handle is not registered. This is the window the bug lived in.
	if (order === "show-right-after-mount") relay.show("calendar");
	await settle();
	if (order === "show-after-effects") {
		relay.show("calendar");
		await settle();
	}
	return { root, rerender: async () => (render(view(), root), await settle()) };
}

const visibleSection = (root: HTMLElement) => {
	const shown = [...root.querySelectorAll<HTMLElement>(".cp-section")].filter((s) => !s.hidden);
	expect(shown).toHaveLength(1);
	return shown[0]!.querySelector(".cp-calendar") !== null ? "calendar" : shown[0]!.querySelector(".cp-search") !== null ? "search" : "tasks";
};

describe("SectionRelay with the real app root", () => {
	it("a request made right after the mount, before the handle exists, is delivered (the bug)", async () => {
		const m = await mount(new SectionRelay(), "show-right-after-mount");
		expect(visibleSection(m.root)).toBe("calendar");
	});

	it("a request made before the first render seeds the first paint and is not lost", async () => {
		const relay = new SectionRelay();
		const m = await mount(relay, "show-before-mount");
		expect(visibleSection(m.root)).toBe("calendar");
		expect(relay.pending).toBeNull();
	});

	it("a request made once the handle exists goes straight through", async () => {
		const m = await mount(new SectionRelay(), "show-after-effects");
		expect(visibleSection(m.root)).toBe("calendar");
	});

	it("a re-render does not replay or lose the section the user moved to", async () => {
		const relay = new SectionRelay();
		const m = await mount(relay, "show-right-after-mount");
		relay.show("search");
		await settle();
		expect(visibleSection(m.root)).toBe("search");
		await m.rerender();
		expect(visibleSection(m.root)).toBe("search");
	});
});

describe("SectionRelay", () => {
	const spy = () => {
		const shown: string[] = [];
		const habits: [string, boolean | undefined][] = [];
		return {
			shown,
			habits,
			handle: {
				showSection: (s: string) => void shown.push(s),
				showHabit: (id: string, focus?: boolean) => void habits.push([id, focus]),
			} as unknown as AppRootHandle,
		};
	};

	it("keeps only the latest queued request and delivers it once on attach", () => {
		const relay = new SectionRelay();
		const { shown, handle } = spy();
		relay.show("calendar");
		relay.show("search");
		expect(relay.pending).toBe("search");
		relay.attach(handle);
		relay.attach(handle); // the root re-registers on every render
		expect(shown).toEqual(["search"]);
		expect(relay.pending).toBeNull();
	});

	it("after detach, requests wait for the next root", () => {
		const relay = new SectionRelay();
		const first = spy();
		relay.attach(first.handle);
		relay.show("calendar");
		relay.detach();
		relay.show("search");
		expect(first.shown).toEqual(["calendar"]);
		const second = spy();
		relay.attach(second.handle);
		expect(second.shown).toEqual(["search"]);
	});

	it("the today request is carried like any section", () => {
		const relay = new SectionRelay();
		const { shown, handle } = spy();
		relay.show("today");
		relay.attach(handle);
		expect(shown).toEqual(["today"]);
	});

	it("queues showHabit before attach and replays it once on attach", () => {
		const relay = new SectionRelay();
		const { habits, handle } = spy();
		relay.showHabit("h-1", true);
		expect(relay.pending).toBe("habits");
		expect(habits).toEqual([]);
		relay.attach(handle);
		relay.attach(handle); // the root re-registers on every render
		expect(habits).toEqual([["h-1", true]]);
		expect(relay.pending).toBeNull();
	});

	it("a section then a habit (the openHabits order): both are delivered, the section first", () => {
		const relay = new SectionRelay();
		const { shown, habits, handle } = spy();
		relay.show("habits");
		relay.showHabit("h-1", false);
		relay.attach(handle);
		expect(shown).toEqual(["habits"]);
		expect(habits).toEqual([["h-1", false]]);
	});

	it("a section requested after a queued habit wins: the habit is dropped", () => {
		const relay = new SectionRelay();
		const { shown, habits, handle } = spy();
		relay.showHabit("h-1", true);
		relay.show("calendar");
		expect(relay.pending).toBe("calendar");
		relay.attach(handle);
		expect(shown).toEqual(["calendar"]);
		expect(habits).toEqual([]);
	});

	it("showHabit goes straight through once the handle exists, and waits again after detach", () => {
		const relay = new SectionRelay();
		const first = spy();
		relay.attach(first.handle);
		relay.showHabit("h-1", true);
		relay.detach();
		relay.showHabit("h-2", false);
		expect(first.habits).toEqual([["h-1", true]]);
		const second = spy();
		relay.attach(second.handle);
		expect(second.habits).toEqual([["h-2", false]]);
	});
});
