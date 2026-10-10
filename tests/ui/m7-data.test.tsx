// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { makeReadOnly } from "../app/harness";
import { type CalMount, click, mountCal } from "./m3-helpers";
import { q } from "./m7-helpers";

// The Data section's Export CSV button. The file writing is the host's (tests/app).

const mounted: CalMount[] = [];
afterEach(() => {
	for (const m of mounted.splice(0)) m.unmount();
});
async function mount() {
	const m = await mountCal();
	mounted.push(m);
	return m;
}
const button = (m: CalMount, text: string) =>
	[...m.root.querySelectorAll<HTMLButtonElement>(".cp-data button")].find((b) => b.textContent?.trim() === text)!;

describe("Export CSV", () => {
	it("sits next to Export backup, with the help text, and calls host.exportCsv once per click", async () => {
		const m = await mount();
		const calls: string[] = [];
		m.host.exportCsv = async () => void calls.push("csv");
		m.host.exportBackup = async () => void calls.push("backup");
		await click(m.root.querySelector('.cp-rail [aria-label="Data"]'));
		const csv = button(m, "Export CSV");
		const names = [...csv.parentElement!.querySelectorAll("button")].map((b) => b.textContent?.trim());
		expect(names.indexOf("Export CSV")).toBe(names.indexOf("Export backup") + 1);
		expect(q(m.root, ".cp-data").textContent).toContain(
			"One CSV file per entity (tasks, lists, sections, tags, occurrences, focus sessions, habits, check-ins) in a new folder in your vault.",
		);
		await click(csv);
		expect(calls).toEqual(["csv"]);
	});

	it("shows an error from the export and stays usable", async () => {
		const m = await mount();
		m.host.exportCsv = async () => {
			throw new Error("Could not write the export.");
		};
		await click(m.root.querySelector('.cp-rail [aria-label="Data"]'));
		await click(button(m, "Export CSV"));
		expect(m.host.messages).toContain("Could not write the export.");
		expect(button(m, "Export CSV").disabled).toBe(false);
	});

	it("is disabled with a reason while the database is read-only, like Export backup", async () => {
		const m = await mount();
		await makeReadOnly(m.h);
		m.h.app.store.notifyStatus();
		await click(m.root.querySelector('.cp-rail [aria-label="Data"]'));
		const csv = button(m, "Export CSV");
		expect(csv.disabled).toBe(true);
		expect(m.root.querySelector(`#${CSS.escape(csv.getAttribute("aria-describedby") ?? "none")}`)?.textContent).toContain("read-only");
	});
});
