import { describe, expect, it } from "vitest";
import { parseQuickAdd } from "../../src/parsing";
import { BERLIN, NY, at, chipLines, dateSpecOf, makeCtx } from "./helpers";

// "tonight" is today at the evening time setting (default 20:00), a datetime in
// the configured zone; an explicit time wins.

const parse = (input: string, o: Parameters<typeof makeCtx>[0] = {}) => parseQuickAdd(input, makeCtx(o));

describe("tonight", () => {
	it("is today at 20:00 by default", () => {
		const r = parse("Call mom tonight");
		expect(r.title).toBe("Call mom");
		expect(r.fields.scheduled).toEqual(dateSpecOf("2026-10-01T20:00", NY));
		expect(chipLines(r)).toEqual(["applied|scheduled|tonight"]);
	});

	it("uses the configured evening time, in the configured zone", () => {
		const r = parse("Call mom tonight", { eveningTime: "19:30", zone: BERLIN, now: at(BERLIN, "2026-10-01T12:00") });
		expect(r.fields.scheduled).toEqual(dateSpecOf("2026-10-01T19:30", BERLIN));
	});

	it("is today's date in the zone even when it is already late", () => {
		const r = parse("Call mom tonight", { now: at(NY, "2026-10-01T23:30"), eveningTime: "21:15" });
		expect(r.fields.scheduled).toEqual(dateSpecOf("2026-10-01T21:15", NY));
	});

	it("an explicit time wins over the evening time", () => {
		const r = parse("Call tonight at 9", { eveningTime: "19:30" });
		expect(r.fields.scheduled).toEqual(dateSpecOf("2026-10-01T21:00", NY));
		expect(chipLines(r)).toEqual(["applied|scheduled|tonight at 9"]);
		const r2 = parse("Call tonight at 8:15pm", { eveningTime: "19:30" });
		expect(r2.fields.scheduled).toEqual(dateSpecOf("2026-10-01T20:15", NY));
	});

	it("keeps the existing meridiem choice for an ambiguous bare hour without 'tonight'", () => {
		const r = parse("Call at 9", { eveningTime: "19:30" });
		expect(r.chips[0]!.status).toBe("choice");
	});

	it("an evening time in a spring-forward gap follows the DST rule", () => {
		const r = parse("Call tonight", { now: at(NY, "2026-03-08T01:00"), eveningTime: "02:30" });
		expect(r.fields.scheduled).toEqual(dateSpecOf("2026-03-08T03:30", NY));
		expect(chipLines(r)).toEqual(["applied|scheduled|tonight|w=dst-gap"]);
	});

	it("other day parts still give a date only", () => {
		expect(parse("Call tomorrow morning").fields.scheduled).toEqual({ kind: "date", date: "2026-10-02" });
	});

	it("a dismissed 'tonight' stays in the title", () => {
		const r = parse("Call tonight");
		const chip = r.chips[0]!;
		const dismissed = parse("Call tonight", { decisions: [{ span: chip.span, text: chip.text, kind: "literal" }] });
		expect(dismissed.fields.scheduled).toBeUndefined();
		expect(dismissed.title).toBe("Call tonight");
	});
});
