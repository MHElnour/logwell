import { describe, expect, it } from "vitest";
import { CheckpointApp } from "../../src/app/App";
import { MemoryTickTickDevice, MemoryTickTickSecret } from "../../src/app/ports";
import { DEFAULT_SETTINGS, sanitizeSettings } from "../../src/app/settings";
import { sequentialIds } from "../helpers";
import { harness as storeHarness } from "../persistence/fixtures";
import { FakeNotes } from "./harness";

const SETTINGS = { zone: () => "Europe/Berlin", noteFolder: () => "Task notes", upcomingDays: () => 14, weekStart: () => "MO" as const, eveningTime: () => "20:00" };

// The TickTick settings and the ports for the token and the device flag.
// Nothing reads them yet.

describe("TickTick settings", () => {
	it("default to a 5 minute pull and no description notes", () => {
		expect(DEFAULT_SETTINGS.tickTickPullMinutes).toBe(5);
		expect(DEFAULT_SETTINGS.tickTickNotes).toBe(false);
		expect(sanitizeSettings({})).toMatchObject({ tickTickPullMinutes: 5, tickTickNotes: false });
	});

	it.each([5, 6, 30, 60])("keep a pull interval of %i", (minutes) => {
		expect(sanitizeSettings({ tickTickPullMinutes: minutes }).tickTickPullMinutes).toBe(minutes);
	});

	// 5 to 60 minutes; there is no "never" (0).
	it.each([
		[0, 5],
		[1, 5],
		[4, 5],
		[-1, 5],
		[61, 60],
		[1000, 60],
		[30.4, 30],
		[Number.POSITIVE_INFINITY, 5],
	])("bring a pull interval of %s into 5 to 60 (%s)", (minutes, expected) => {
		expect(sanitizeSettings({ tickTickPullMinutes: minutes }).tickTickPullMinutes).toBe(expected);
	});

	it.each(["5", null, Number.NaN])("fall back to 5 for a pull interval that is not a number (%s)", (minutes) => {
		expect(sanitizeSettings({ tickTickPullMinutes: minutes }).tickTickPullMinutes).toBe(5);
	});

	it("keep a boolean notes flag and drop anything else", () => {
		expect(sanitizeSettings({ tickTickNotes: true }).tickTickNotes).toBe(true);
		expect(sanitizeSettings({ tickTickNotes: "yes" }).tickTickNotes).toBe(false);
	});
});

describe("in-memory TickTick ports", () => {
	it("the secret port keeps a token until it is cleared", () => {
		const secret = new MemoryTickTickSecret();
		expect(secret.get()).toBeNull();
		secret.set("tok-1");
		expect(secret.get()).toBe("tok-1");
		secret.clear();
		expect(secret.get()).toBeNull();
		secret.set("");
		expect(secret.get()).toBeNull();
	});

	it("the device port is off until turned on", () => {
		const device = new MemoryTickTickDevice();
		expect(device.isEnabled()).toBe(false);
		device.setEnabled(true);
		expect(device.isEnabled()).toBe(true);
		device.setEnabled(false);
		expect(device.isEnabled()).toBe(false);
	});

	it("the app uses them when no host ports are given, and the given ones otherwise", () => {
		const h = storeHarness();
		const plain = new CheckpointApp(h.store, h.clock, sequentialIds("a"), SETTINGS, new FakeNotes());
		expect(plain.tickTickSecret).toBeInstanceOf(MemoryTickTickSecret);
		expect(plain.tickTickDevice).toBeInstanceOf(MemoryTickTickDevice);
		const secret = new MemoryTickTickSecret();
		const device = new MemoryTickTickDevice();
		const wired = new CheckpointApp(
			h.store,
			h.clock,
			sequentialIds("b"),
			SETTINGS,
			new FakeNotes(),
			undefined,
			undefined,
			undefined,
			undefined,
			secret,
			device,
		);
		expect(wired.tickTickSecret).toBe(secret);
		expect(wired.tickTickDevice).toBe(device);
	});
});
