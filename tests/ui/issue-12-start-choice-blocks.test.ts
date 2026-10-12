import { describe, expect, it, vi } from "vitest";
import { QuickAddModel } from "../../src/ui/quickadd/QuickAddModel";
import { appHarness } from "../app/harness";

// Repeating tasks rule 19 (#12): `every year on <date>` starts on that date. While the date's hour is still a choice,
// Enter does not save: it opens the chip's alternatives (like an unknown list), and the choice saves the task anchored
// on the chosen date, never on today. Europe/Berlin, Wednesday 2026-10-07.

async function model() {
	const h = await appHarness();
	h.clock.set("2026-10-07T08:00:00.000Z");
	const m = new QuickAddModel(
		{
			app: h.app,
			preset: {},
			locale: () => "en",
			resolveNote: () => [],
			onSaved: () => undefined,
			onError: (e) => {
				throw e;
			},
			keepOpen: () => true,
			onClose: () => undefined,
		},
		() => undefined,
	);
	return { h, m };
}

describe("a yearly repeat whose start is a choice (#12)", () => {
	it.each(["Birthday every year on May 5 at 7", "Birthday every year on Feb 29 at 9"])("%s: Enter opens the choice, choosing saves on the chosen date", async (input) => {
		const { h, m } = await model();
		m.setInput(input);
		const start = m.result.chips.find((c) => c.kind === "scheduled")!;
		expect(start.status).toBe("choice");
		expect(await m.submit()).toBe("blocked");
		expect(m.openChipId).toBe(start.id);
		expect(m.panelKind(start)).toBe("alternatives");
		expect([...h.app.store.state.tasks.values()]).toHaveLength(0);
		// The second choice (19:00 / 21:00) saves the task on that date and time.
		const value = start.alternatives![1]!.value!;
		m.setChipDate(start, value);
		await vi.waitFor(() => expect([...h.app.store.state.tasks.values()]).toHaveLength(1));
		const tasks = [...h.app.store.state.tasks.values()];
		expect(tasks[0]!.title).toBe("Birthday");
		expect(tasks[0]!.recurrence).toMatchObject({ anchor: value.kind === "datetime" ? value.local.slice(0, 10) : value.date, versions: [{ rule: { freq: "yearly", time: value.kind === "datetime" ? value.local.slice(11, 16) : null } }] });
	});

	it("choosing from a chip the user opened does not save", async () => {
		const { h, m } = await model();
		m.setInput("Birthday every year on May 5 at 7");
		const start = m.result.chips.find((c) => c.kind === "scheduled")!;
		m.activate(start);
		m.setChipDate(start, start.alternatives![0]!.value!);
		await Promise.resolve();
		expect([...h.app.store.state.tasks.values()]).toHaveLength(0);
		expect(m.result.blocking).toEqual([]);
		expect(await m.submit()).toBe("saved");
	});
});
