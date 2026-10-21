import { describe, expect, it } from "vitest";
import { type StatusFilter, statusAccepts } from "../../src/domain/queries";
import type { TaskStatus } from "../../src/domain/types";

// The status rule every filter, the Completed view and a task block share.

describe("statusAccepts", () => {
	it.each<[string, StatusFilter, TaskStatus, boolean]>([
		["open accepts an open task", "open", "open", true],
		["open refuses a completed task, or a done occurrence", "open", "completed", false],
		["completed accepts a completed task, or a done occurrence", "completed", "completed", true],
		["completed refuses an open task", "completed", "open", false],
		["all accepts an open task", "all", "open", true],
		["all accepts a completed task, or a done occurrence", "all", "completed", true],
	])("%s", (_name, filter, status, expected) => {
		expect(statusAccepts(filter, status)).toBe(expected);
	});
});
