// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { makeReadOnly } from "../app/harness";
import { DB_PATH } from "../persistence/fixtures";
import { type AppMount, click, mountApp, q } from "./app-helpers";

// The Data section's Export CSV button. The file writing is the host's (tests/app).

const button = (m: AppMount, text: string) =>
	[...m.root.querySelectorAll<HTMLButtonElement>(".cp-data button")].find((b) => b.textContent?.trim() === text)!;

describe("Export CSV", () => {
	it("sits next to Export backup, with the help text, and calls host.exportCsv once per click", async () => {
		const m = await mountApp();
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
		const m = await mountApp();
		m.host.exportCsv = async () => {
			throw new Error("Could not write the export.");
		};
		await click(m.root.querySelector('.cp-rail [aria-label="Data"]'));
		await click(button(m, "Export CSV"));
		expect(m.host.messages).toContain("Could not write the export.");
		expect(button(m, "Export CSV").disabled).toBe(false);
	});

	it("is disabled with a reason while the database is read-only, like Export backup", async () => {
		const m = await mountApp();
		await makeReadOnly(m.h);
		m.h.app.store.notifyStatus();
		await click(m.root.querySelector('.cp-rail [aria-label="Data"]'));
		const csv = button(m, "Export CSV");
		expect(csv.disabled).toBe(true);
		expect(m.root.querySelector(`#${CSS.escape(csv.getAttribute("aria-describedby") ?? "none")}`)?.textContent).toContain("read-only");
	});
});

describe("#224: a file with Git merge markers", () => {
	const banner = (m: AppMount) => q(m.root, ".cp-banner-error");
	const labels = (el: Element) => [...el.querySelectorAll("button")].map((b) => b.textContent?.trim());

	async function openData(m: AppMount) {
		m.h.app.store.notifyStatus();
		await click(m.root.querySelector('.cp-rail [aria-label="Data"]'));
	}

	it("the banner says Git merged the database, what Restore backup does, and where the Git setting is; it offers no conflict view", async () => {
		const m = await mountApp();
		await makeReadOnly(m.h);
		await openData(m);
		const text = banner(m).textContent ?? "";
		expect(text).toContain("Git merged this database from two computers");
		expect(text).toContain("Restore backup keeps this computer's version");
		expect(text).toContain("Keep mine or Keep theirs");
		expect(text).toContain("Settings > Logwell > Database > Git sync");
		expect(labels(banner(m))).toEqual(["Restore backup"]);
	});

	it("the Data page names the copy a version-control merge copy with Dismiss only, and repeats the advice", async () => {
		const m = await mountApp();
		await makeReadOnly(m.h);
		await openData(m);
		const section = [...m.root.querySelectorAll(".cp-data-section")].find((s) => s.querySelector("h3")?.textContent === "Conflicts")!;
		const item = await vi.waitFor(() => q(section, "li"));
		expect(item.textContent).toContain("Version-control merge copy");
		expect(item.textContent).not.toContain("Damaged file copy");
		expect(labels(item)).toEqual(["Dismiss"]);
		expect(section.textContent).toContain("Restore backup keeps this computer's version");
	});

	it("a cut-off file keeps the damaged-file banner, conflict view button and copy name", async () => {
		const m = await mountApp();
		m.h.fs.files.set(DB_PATH, m.h.dbText().slice(0, 20));
		await m.h.store.handleExternalChange();
		await openData(m);
		expect(banner(m).textContent).toContain("Database file is damaged or has a merge conflict");
		expect(labels(banner(m))).toEqual(["Restore backup", "Open conflict view"]);
		const section = [...m.root.querySelectorAll(".cp-data-section")].find((s) => s.querySelector("h3")?.textContent === "Conflicts")!;
		const item = await vi.waitFor(() => q(section, "li"));
		expect(item.textContent).toContain("Damaged file copy");
	});
});
