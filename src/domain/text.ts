// Small text helpers shared by every layer. Pure.

/** "1 task", "3 tasks": the count and the word, plural by adding an s unless `many` is given ("entry", "entries"). */
export function plural(n: number, word: string, many = `${word}s`): string {
	return `${n} ${n === 1 ? word : many}`;
}
