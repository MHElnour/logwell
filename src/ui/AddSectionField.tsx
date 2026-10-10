import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ID } from "../domain/types";
import { useUniqueId } from "./hooks";
import type { UiHost } from "./host";
import { createSection } from "./sectionActions";

// The inline "section name" field: at the bottom of a list view and in the board's
// "+ Add section" column. Enter creates the section; Escape closes only this field; a duplicate name
// stays in the field with the message under it.

export function AddSectionField(props: {
	host: UiHost;
	/** The list the section belongs to. */
	categoryId: ID;
	/** Closes the field: after a create, on Escape, or on a blur with nothing typed. */
	onClose: () => void;
	cls?: string;
}) {
	const { host } = props;
	const inputRef = useRef<HTMLInputElement>(null);
	const busy = useRef(false);
	const [error, setError] = useState("");
	const errorId = useUniqueId("cp-section-error");
	// Focus is ref-based, and set in a layout effect: a passive effect runs after the next frame, so keys
	// typed (or sent) in the first moment after the field appears would miss it.
	useLayoutEffect(() => {
		inputRef.current?.focus();
	}, []);
	const submit = async () => {
		const input = inputRef.current;
		if (input === null || busy.current) return;
		busy.current = true;
		const result = await createSection(host, props.categoryId, input.value);
		busy.current = false;
		if (result.ok) props.onClose();
		else {
			setError(result.message);
			inputRef.current?.focus();
		}
	};
	return (
		<div class={`cp-section-add-field${props.cls === undefined ? "" : ` ${props.cls}`}`}>
			<input
				ref={inputRef}
				type="text"
				class="cp-section-name-input"
				aria-label="Section name"
				aria-invalid={error !== ""}
				aria-describedby={error !== "" ? errorId : undefined}
				placeholder="Section name"
				maxLength={80}
				onInput={() => error !== "" && setError("")}
				onKeyDown={(e) => {
					if (e.key === "Escape") {
						// Only the field closes: not the details pane, not the app.
						e.preventDefault();
						e.stopPropagation();
						props.onClose();
					} else if (e.key === "Enter" && !e.isComposing) {
						e.preventDefault();
						e.stopPropagation();
						void submit();
					}
				}}
				onBlur={(e) => {
					if (e.currentTarget.value.trim() === "" && !busy.current) props.onClose();
				}}
			/>
			{error !== "" && (
				<p class="cp-section-error" id={errorId} role="alert">
					{error}
				</p>
			)}
		</div>
	);
}
