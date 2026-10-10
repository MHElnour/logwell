import type { UiHost, QuickAddPreset } from "../host";
import { QuickAddEditor } from "./QuickAddEditor";
import { useQuickAdd } from "./useQuickAdd";

/**
 * The inline add bar of a task list and of the details pane: the Quick Add editor with a preset.
 * Nothing in the preset is a manual value. It stays open after a save.
 */
export function InlineAddBar({ host, preset, ariaLabel, placeholder, cls }: {
	host: UiHost;
	preset: QuickAddPreset;
	ariaLabel: string;
	placeholder: string;
	cls: string;
}) {
	const model = useQuickAdd({
		app: host.app,
		preset,
		locale: () => host.settings().dateLocale,
		eveningTime: () => host.settings().eveningTime,
		resolveNote: (t) => host.resolveNoteLinks(t),
		onSaved: (title, warnings) => {
			if (warnings.length > 0) host.notify(`Added "${title}" (${warnings.join("; ")})`);
		},
		onError: (err) => host.error(err),
		keepOpen: () => true,
		onClose: () => undefined,
	});
	return (
		<div class={cls}>
			<QuickAddEditor
				model={model}
				attachTokenSuggest={(input, onBind) => host.attachTokenSuggest(input, onBind)}
				ariaLabel={ariaLabel}
				placeholder={placeholder}
				compact
				weekStart={host.settings().weekStart}
				setIcon={(el, icon) => host.setIcon(el, icon)}
				pickNote={() => host.pickNote()}
			/>
		</div>
	);
}
