/** `parent.createEl` with a class (empty means none), attributes and text content, in that argument order. */
export function el<K extends keyof HTMLElementTagNameMap>(
	parent: HTMLElement,
	tag: K,
	cls = "",
	attrs: Record<string, string> = {},
	text?: string,
): HTMLElementTagNameMap[K] {
	const node = parent.createEl(tag, { cls: cls === "" ? undefined : cls, attr: attrs });
	if (text !== undefined) node.textContent = text;
	return node;
}
