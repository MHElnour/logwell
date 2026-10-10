import { describe, expect, it } from "vitest";
import { INBOX_NAME } from "../../src/domain/types";
import { manualPills } from "../../src/ui/quickadd/manualPills";
import type { QuickAddModel } from "../../src/ui/quickadd/QuickAddModel";

// Issue 27: a list that cannot be found is called "Inbox" everywhere, the Quick Add manual pill included.

function fakeModel(categoryId: string): QuickAddModel {
	return {
		manual: new Set(["category"]),
		parent: undefined,
		tagKeys: null,
		urgent: false,
		important: false,
		vals: { categoryId },
		env: { app: { settings: { zone: () => "UTC" }, queryContext: () => ({ today: "2026-01-01" }), categories: { list: () => [] }, tags: { list: () => [] } } },
		revertManual: () => undefined,
	} as unknown as QuickAddModel;
}

describe("missing list name", () => {
	it("is Inbox in the manual category pill", () => {
		const pill = manualPills(fakeModel("deleted-list")).find((p) => p.kind === "category");
		expect(pill?.label).toBe(`List: ${INBOX_NAME}`);
		expect(pill?.label).toBe("List: Inbox");
	});
});
