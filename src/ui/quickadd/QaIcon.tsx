import { useLayoutEffect, useRef } from "preact/hooks";

/** An Obsidian icon in a span, for the add bar (it has no UiHost in the modal, so it takes setIcon). */
export type SetIcon = (el: HTMLElement, icon: string) => void;

export function QaIcon({ setIcon, name, cls }: { setIcon: SetIcon; name: string; cls?: string }) {
	const ref = useRef<HTMLSpanElement>(null);
	useLayoutEffect(() => {
		const el = ref.current;
		if (el === null) return;
		el.replaceChildren();
		setIcon(el, name);
	}, [name]);
	return <span ref={ref} class={`cp-icon ${cls ?? ""}`} aria-hidden="true" />;
}
