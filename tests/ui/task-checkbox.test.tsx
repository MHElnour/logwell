// @vitest-environment happy-dom
import { render } from "preact";
import { afterEach, describe, expect, it } from "vitest";
import { TaskCheckbox } from "../../src/ui/common";

// Details pane checkbox: the click handler cancels the native toggle. A real browser
// restores the old `checked` after dispatch, which can be after the re-render. The box must end up
// matching its prop.

let host: HTMLElement | null = null;
afterEach(() => {
	if (host !== null) render(null, host);
	host?.remove();
	host = null;
});

describe("TaskCheckbox", () => {
	it("matches its prop even when the browser restores the old state after the re-render", async () => {
		host = document.createElement("div");
		document.body.append(host);
		const draw = (done: boolean) =>
			render(<TaskCheckbox done={done} title="T" onToggle={() => draw(true)} />, host!);
		draw(false);
		const box = host.querySelector<HTMLInputElement>("input")!;
		box.click(); // onToggle re-renders at once, as a microtask-driven store update does
		box.checked = false; // what the browser does when it undoes a canceled click
		await new Promise((r) => window.setTimeout(r, 5));
		expect(box.checked).toBe(true);
		expect(box.getAttribute("aria-label")).toBe('Reopen "T"');
	});

	it("goes back to the prop when the toggle is refused", async () => {
		host = document.createElement("div");
		document.body.append(host);
		render(<TaskCheckbox done={false} title="T" onToggle={() => undefined} />, host);
		const box = host.querySelector<HTMLInputElement>("input")!;
		box.click();
		box.checked = true; // a browser that kept the native toggle
		await new Promise((r) => window.setTimeout(r, 5));
		expect(box.checked).toBe(false);
	});
});
