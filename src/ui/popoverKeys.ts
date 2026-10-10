// Shared by the popovers of the add bar and the repeat picker: the keys every popover has.

// tagName, not instanceof: the view can live in a popout window with its own HTMLElement classes.
const isInput = (el: EventTarget | null): boolean => {
	const tag = (el as HTMLElement | null)?.tagName;
	return tag === "INPUT" || tag === "SELECT";
};

export function focusables(root: HTMLElement): HTMLElement[] {
	return [...root.querySelectorAll<HTMLElement>("button, input, select")].filter(
		(e) => !(e as HTMLButtonElement).disabled && e.getAttribute("tabindex") !== "-1",
	);
}

/** The keys every popover shares. */
export function popoverKeyDown(e: KeyboardEvent, root: HTMLElement | null, close: () => void): void {
	if (e.isComposing) return;
	if (e.key === "Escape") {
		e.preventDefault();
		e.stopPropagation();
		close();
	} else if (e.key === "Enter") {
		// The focused control acts on its own (a button's click); the form must not save.
		e.stopPropagation();
		if (isInput(e.target)) e.preventDefault();
	} else if (e.key === "Tab" && root !== null) {
		const list = focusables(root);
		const first = list[0];
		const last = list[list.length - 1];
		if (first === undefined || last === undefined) {
			e.preventDefault();
			return;
		}
		const active = root.ownerDocument.activeElement;
		if (e.shiftKey && (active === first || !root.contains(active))) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && (active === last || !root.contains(active))) {
			e.preventDefault();
			first.focus();
		}
	}
}
