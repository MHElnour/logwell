import { describe, expect, it } from "vitest";
import { QuickAddModel } from "../../src/ui/quickadd/QuickAddModel";
import { appHarness } from "../app/harness";

// Priority in the Quick Add model: the typed token, the manual setter (the "more menu"), and
// the manual-value rule: a manual value turns a typed token into a suggestion, accepting replaces it.

async function model() {
	const h = await appHarness();
	const saved: string[] = [];
	const m = new QuickAddModel(
		{
			app: h.app,
			preset: {},
			locale: () => "en",
			resolveNote: () => [],
			onSaved: (title) => saved.push(title),
			onError: (e) => {
				throw e;
			},
			keepOpen: () => true,
			onClose: () => undefined,
		},
		() => undefined,
	);
	return { h, m, saved };
}

describe("QuickAddModel priority", () => {
	it("exposes the typed priority and a priority chip; none by default", async () => {
		const { m } = await model();
		expect(m.priorityValue()).toBe(0);
		m.setInput("Pay rent !2");
		expect(m.priorityValue()).toBe(2);
		expect(m.result.chips.map((c) => `${c.kind}:${c.status}`)).toEqual(["priority:applied"]);
	});

	it("saves the typed priority and removes the accepted span from the title", async () => {
		const { h, m, saved } = await model();
		m.setInput("Pay rent !high");
		expect(await m.submit()).toBe("saved");
		expect(saved).toEqual(["Pay rent"]);
		const task = [...h.app.store.state.tasks.values()][0]!;
		expect(task).toMatchObject({ title: "Pay rent", priority: 1 });
	});

	it("a task without a token saves with priority 0", async () => {
		const { h, m } = await model();
		m.setInput("Pay rent");
		await m.submit();
		expect([...h.app.store.state.tasks.values()][0]!.priority).toBe(0);
	});

	it("dismissing the chip keeps the text and saves no priority", async () => {
		const { h, m } = await model();
		m.setInput("Pay rent !1");
		m.dismiss(m.result.chips[0]!);
		expect(m.priorityValue()).toBe(0);
		await m.submit();
		expect([...h.app.store.state.tasks.values()][0]).toMatchObject({ title: "Pay rent !1", priority: 0 });
	});

	it("the last typed token wins and the earlier one stays in the title", async () => {
		const { h, m } = await model();
		m.setInput("Pay !1 rent !3");
		expect(m.priorityValue()).toBe(3);
		await m.submit();
		expect([...h.app.store.state.tasks.values()][0]).toMatchObject({ title: "Pay !1 rent", priority: 3 });
	});

	it("a manual priority is saved when nothing is typed", async () => {
		const { h, m } = await model();
		m.setInput("Pay rent");
		m.setPriority(2);
		expect(m.priorityValue()).toBe(2);
		await m.submit();
		expect([...h.app.store.state.tasks.values()][0]!.priority).toBe(2);
	});

	it("B4 pattern: a manual priority wins over a typed token, which becomes a suggestion; accepting replaces the manual value", async () => {
		const { h, m } = await model();
		m.setInput("Pay rent !1");
		m.setPriority(3);
		expect(m.priorityValue()).toBe(3);
		const chip = m.result.chips[0]!;
		expect(chip).toMatchObject({ kind: "priority", status: "suggestion", notice: "Replace priority?" });
		m.accept(chip);
		expect(m.priorityValue()).toBe(1);
		expect(m.result.chips[0]).toMatchObject({ status: "applied" });
		await m.submit();
		expect([...h.app.store.state.tasks.values()][0]).toMatchObject({ title: "Pay rent", priority: 1 });
	});

	it("a manual none overrides a typed token and is saved as none", async () => {
		const { h, m } = await model();
		m.setInput("Pay rent !1");
		m.setPriority(0);
		expect(m.priorityValue()).toBe(0);
		await m.submit();
		expect([...h.app.store.state.tasks.values()][0]).toMatchObject({ priority: 0 });
	});

	it("reset after a save clears the manual priority", async () => {
		const { m } = await model();
		m.setInput("A");
		m.setPriority(1);
		await m.submit();
		expect(m.priorityValue()).toBe(0);
		expect(m.manual.has("priority")).toBe(false);
	});

	it("rejects an invalid manual priority", async () => {
		const { m } = await model();
		expect(() => m.setPriority(9 as never)).toThrow();
	});
});
