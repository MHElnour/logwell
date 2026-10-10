// @vitest-environment happy-dom
import type { RequestUrlParam } from "obsidian";
import { describe, expect, it } from "vitest";
import { MemoryTickTickSecret, TickTickError } from "../../src/app/ports";
import { TICKTICK_API_BASE, TickTickHttp, type TickTickRequest } from "../../src/obsidian/tickTickHttp";

// The tag endpoints. GET /tag lists the account's tags; POST /tag creates one (an existing name is
// a silent no-op on TickTick's side).

function setup(replies: { status?: number; text: string }[]) {
	const secret = new MemoryTickTickSecret();
	secret.set("token");
	const calls: RequestUrlParam[] = [];
	const request: TickTickRequest = (param) => {
		calls.push(param);
		const next = replies.shift();
		if (next === undefined) return Promise.reject(new Error("no reply queued"));
		return Promise.resolve({ status: next.status ?? 200, headers: {}, text: next.text });
	};
	return { api: new TickTickHttp(secret, request), calls };
}

describe("tags", () => {
	it("listTags: GET /tag, keeping name, label and parent", async () => {
		const { api, calls } = setup([
			{ text: JSON.stringify([{ name: "home", label: "Home", color: "#fff", sortOrder: 1, type: 1 }, { name: "calls", label: "Calls", parent: "home" }, { name: "bare" }]) },
		]);
		const tags = await api.listTags();
		expect(calls[0]).toMatchObject({ url: `${TICKTICK_API_BASE}/tag`, method: "GET" });
		expect(tags).toEqual([
			{ name: "home", label: "Home" },
			{ name: "calls", label: "Calls", parent: "home" },
			{ name: "bare", label: "bare" },
		]);
	});

	it("listTags: an unreadable record is skipped; an answer that is not a list is a bad response", async () => {
		const { api } = setup([{ text: JSON.stringify([{ label: "no name" }, 7, { name: "ok" }]) }, { text: JSON.stringify({ name: "x" }) }]);
		expect(await api.listTags()).toEqual([{ name: "ok", label: "ok" }]);
		await expect(api.listTags()).rejects.toBeInstanceOf(TickTickError);
	});

	it("createTag: POST /tag with name, label and parent; an empty answer is accepted", async () => {
		const { api, calls } = setup([{ text: "" }, { text: JSON.stringify({ name: "home", label: "Home" }) }]);
		await api.createTag({ name: "calls", label: "Calls", parent: "home" });
		expect(calls[0]).toMatchObject({ url: `${TICKTICK_API_BASE}/tag`, method: "POST" });
		expect(JSON.parse(calls[0]!.body as string)).toEqual({ name: "calls", label: "Calls", parent: "home" });
		await api.createTag({ name: "home", label: "Home" });
		expect(JSON.parse(calls[1]!.body as string)).toEqual({ name: "home", label: "Home" });
	});

	it("createTag: a server error may have been applied", async () => {
		const { api } = setup([{ status: 500, text: "" }]);
		await expect(api.createTag({ name: "x", label: "X" })).rejects.toMatchObject({ kind: "server", maybePartial: true });
	});
});
