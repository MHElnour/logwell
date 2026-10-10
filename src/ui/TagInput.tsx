import { useState } from "preact/hooks";
import type { CheckpointApp } from "../app/App";
import { TAG_DEPTH_MESSAGE, hasAllowedTagDepth, isValidTagKey, tagNameRefusal } from "../domain/tags";
import { useUniqueId } from "./hooks";

/**
 * Tag chips plus an input. Existing tags resolve case-insensitively; a
 * new tag needs an explicit "New tag: …" click.
 */
export function TagInput(props: {
	app: CheckpointApp;
	value: string[];
	onChange: (keys: string[]) => void;
	onError: (err: unknown) => void;
	normalize: (raw: string) => string;
	/** The details pane draws its own pills; the entry then shows only the input. */
	hideChips?: boolean;
	inputLabel?: string;
}) {
	const { app, value } = props;
	const [text, setText] = useState("");
	const listId = useUniqueId("cp-tags");
	const tags = app.store.state.tags;
	const key = props.normalize(text);
	const exists = key !== "" && tags.has(key);
	const validKey = isValidTagKey(key);
	const tooDeep = validKey && !hasAllowedTagDepth(key);
	// A name is used once, whatever its parent.
	const refusal = key !== "" && !exists && validKey && !tooDeep ? tagNameRefusal(tags, key) : null;
	const canCreate = key !== "" && !exists && validKey && !tooDeep && refusal === null;

	const add = (k: string) => {
		if (!value.includes(k)) props.onChange([...value, k]);
		setText("");
	};

	const create = async () => {
		try {
			const tag = await app.tags.create(text);
			add(tag.key);
		} catch (err) {
			props.onError(err);
		}
	};

	return (
		<div class="cp-tag-input">
			{props.hideChips !== true && (
			<div class="cp-chips">
				{value.map((k) => (
					<span key={k} class={`cp-chip cp-tag cp-tag-${tags.get(k)?.color ?? "none"}`}>
						@{tags.get(k)?.displayName ?? k}
						<button
							type="button"
							class="cp-chip-remove"
							aria-label={`Remove tag ${tags.get(k)?.displayName ?? k}`}
							onClick={() => props.onChange(value.filter((x) => x !== k))}
						>
							×
						</button>
					</span>
				))}
			</div>
			)}
			<div class="cp-tag-entry">
				<input
					type="text"
					list={listId}
					placeholder="Add tag"
					aria-label={props.inputLabel ?? "Add tag"}
					value={text}
					onInput={(e) => setText(e.currentTarget.value)}
					onKeyDown={(e) => {
						if (e.key !== "Enter") return;
						if (key === "") return;
						e.preventDefault();
						e.stopPropagation();
						if (exists) add(key);
						else if (canCreate) void create();
					}}
				/>
				<datalist id={listId}>
					{[...tags.values()]
						.filter((t) => !value.includes(t.key))
						.map((t) => (
							<option key={t.key} value={t.displayName} />
						))}
				</datalist>
				{exists && (
					<button type="button" onClick={() => add(key)}>
						Add
					</button>
				)}
				{canCreate && (
					<button type="button" onClick={() => void create()}>
						New tag: {key}
					</button>
				)}
				{key !== "" && !exists && !canCreate && (
					<span class="cp-hint">{tooDeep ? TAG_DEPTH_MESSAGE : refusal !== null ? refusal : "Letters, digits, - _ / only"}</span>
				)}
			</div>
		</div>
	);
}
