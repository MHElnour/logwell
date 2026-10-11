import type { App } from "obsidian";
import { TAG_NAME_MAX, TAG_WITH_CHILDREN_MESSAGE } from "../domain/tags";
import type { TagDialogOptions, TagDialogValues } from "../ui/host";
import { el } from "./dom";
import { openFormModal } from "./formModal";
import { buildColorRow } from "./modals";

// The New tag / Edit tag dialog. The form is plain DOM (buildTagForm) so it is tested without a Modal, as
// buildNewListForm is; it reuses the New list form's classes and styles. The name is checked on every keystroke
// through the caller's check (one rule for the dialog and the service), and the submit button stays off until it passes.

let formSeq = 0;

const TAG_NAME_HINT = "Each tag name can be used only once in Logwell. Use letters, digits, hyphens (-) and underscores (_).";
const EMPTY_MESSAGE = "Enter a name.";

export interface TagFormDeps {
	submitLabel: "Create" | "Save";
	initial: TagDialogValues;
	parents: { key: string; label: string }[];
	parentLocked: boolean;
	check: (name: string, parent: string | null) => string | null;
	/** Resolves a message to show inline (the form stays as it is), or null when it saved. */
	onSubmit: (values: TagDialogValues) => Promise<string | null>;
	onCancel: () => void;
}

/** The New tag / Edit tag form in `container`: Name, Parent, Color, Cancel and Create or Save. Returns `focus()` for the name. */
export function buildTagForm(container: HTMLElement, deps: TagFormDeps): { focus: () => void } {
	const seq = ++formSeq;
	const form = el(container, "form", "cp-new-list cp-tag-form");

	// Name
	const nameId = `cp-tag-name-${seq}`;
	const hintId = `cp-tag-hint-${seq}`;
	const errorId = `cp-tag-error-${seq}`;
	el(form, "label", "cp-new-list-label", { for: nameId }, "Name");
	const name = el(form, "input", "cp-new-list-name", {
		type: "text",
		id: nameId,
		maxlength: String(TAG_NAME_MAX),
		placeholder: "Calls",
		autocomplete: "off",
		spellcheck: "false",
		"aria-describedby": `${hintId} ${errorId}`,
	});
	name.value = deps.initial.name;
	el(form, "p", "cp-tag-form-hint", { id: hintId }, TAG_NAME_HINT);
	const error = el(form, "p", "cp-new-list-error", { id: errorId, role: "alert" });
	error.hidden = true;

	// Parent
	const parentId = `cp-tag-parent-${seq}`;
	el(form, "label", "cp-new-list-label", { for: parentId }, "Parent");
	const parent = el(form, "select", "dropdown cp-tag-form-parent", { id: parentId });
	el(parent, "option", "", { value: "" }, "None");
	for (const p of deps.parents) el(parent, "option", "", { value: p.key }, p.label);
	// An edited tag from an older file may sit under a parent the list does not offer: keep it as a choice.
	const current = deps.initial.parent;
	if (current !== null && !deps.parents.some((p) => p.key === current)) el(parent, "option", "", { value: current }, current);
	parent.value = current ?? "";
	if (deps.parentLocked) {
		const lockId = `cp-tag-parent-hint-${seq}`;
		parent.disabled = true;
		parent.setAttribute("aria-describedby", lockId);
		el(form, "p", "cp-tag-form-hint", { id: lockId }, TAG_WITH_CHILDREN_MESSAGE);
	}

	// Color
	const colorLabelId = `cp-tag-colors-${seq}`;
	el(form, "span", "cp-new-list-label", { id: colorLabelId }, "Color");
	const colors = buildColorRow(form, colorLabelId, deps.initial.color);

	const actions = el(form, "div", "cp-new-list-actions");
	el(actions, "button", "", { type: "button" }, "Cancel").addEventListener("click", () => deps.onCancel());
	const submitButton = el(actions, "button", "mod-cta", { type: "submit" }, deps.submitLabel);

	const parentValue = (): string | null => (parent.value === "" ? null : parent.value);
	const showError = (message: string | null) => {
		error.textContent = message ?? "";
		error.hidden = message === null;
		if (message === null) name.removeAttribute("aria-invalid");
		else name.setAttribute("aria-invalid", "true");
	};
	// An empty new form says nothing until the name is touched; Edit starts filled in, so it is touched.
	let touched = deps.initial.name !== "";
	let busy = false;
	/** One check for typing and for submit: the first problem shows, and the button stays off while there is one. */
	const check = (): string | null => {
		const problem = deps.check(name.value, parentValue());
		showError(touched || problem !== EMPTY_MESSAGE ? problem : null);
		submitButton.disabled = busy || problem !== null;
		return problem;
	};
	name.addEventListener("input", () => {
		touched = true;
		check();
	});
	parent.addEventListener("change", () => void check());
	check();

	const submit = async () => {
		if (busy) return;
		touched = true;
		if (check() !== null) {
			name.focus();
			return;
		}
		busy = true;
		submitButton.disabled = true;
		try {
			// On success the caller closes the dialog; on a message everything chosen stays.
			const message = await deps.onSubmit({ name: name.value.trim(), parent: parentValue(), color: colors.value() });
			if (message !== null && message !== "") {
				showError(message);
				name.focus();
			}
		} finally {
			busy = false;
			submitButton.disabled = deps.check(name.value, parentValue()) !== null;
		}
	};
	form.addEventListener("submit", (e) => {
		e.preventDefault();
		void submit();
	});
	return { focus: () => name.focus() };
}

/** The New tag / Edit tag dialog. Resolves when it is gone: saved, or dismissed (Escape or Cancel). */
export async function tagDialog(app: App, options: TagDialogOptions, accentClass = ""): Promise<void> {
	await openFormModal<void>(app, options.title, "checkpoint-tag-dialog", accentClass, (content, done, cancel) =>
		buildTagForm(content, {
			submitLabel: options.submit,
			initial: options.initial,
			parents: options.parents,
			parentLocked: options.parentLocked,
			check: (name, parent) => options.check(name, parent),
			onSubmit: async (values) => {
				const message = await options.save(values);
				if (message === null) done();
				return message;
			},
			onCancel: cancel,
		}),
	);
}
