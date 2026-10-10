import type { CheckpointSettings } from "../app/settings";

/**
 * The class that remaps `--cp-accent` (styles.css). It goes on the same element
 * as `.cp-theme`, `.checkpoint-view` or the Quick Add modal, because the derived
 * tokens (accent-soft, accent-text) resolve where they are declared.
 */
export function accentClass(settings: Pick<CheckpointSettings, "accent">): string {
	return `cp-accent-${settings.accent}`;
}
