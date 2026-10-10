import type { Quadrant } from "../../domain/queries";

// Presentation facts of the four quadrants. The flags and the grid order live in
// src/domain/matrix.ts; the names of the quadrants as menu items live in actions.ts (QUADRANTS).

interface QuadrantInfo {
	id: Quadrant;
	/** The roman numeral in the badge. */
	numeral: string;
	/** The colored title. */
	title: string;
	/** The faint subtitle. */
	subtitle: string;
	/** aria-label of the "+" button. */
	addLabel: string;
	/** CSS class that picks the quadrant's color (cp-q1 .. cp-q4). */
	cls: string;
}

export const QUADRANT_INFO: Record<Quadrant, QuadrantInfo> = {
	"urgent-important": { id: "urgent-important", numeral: "I", title: "Urgent & important", subtitle: "Do it", addLabel: "Add to urgent and important", cls: "cp-q1" },
	important: { id: "important", numeral: "II", title: "Important, not urgent", subtitle: "Plan it", addLabel: "Add to important, not urgent", cls: "cp-q2" },
	urgent: { id: "urgent", numeral: "III", title: "Urgent, not important", subtitle: "Delegate it", addLabel: "Add to urgent, not important", cls: "cp-q3" },
	neither: { id: "neither", numeral: "IV", title: "Neither", subtitle: "Drop it", addLabel: "Add to neither urgent nor important", cls: "cp-q4" },
};

/** The quadrant next to `from` in the 2x2 grid (I II / III IV), or null at the edge (no wrap). */
export function adjacentQuadrant(from: Quadrant, key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown", order: readonly Quadrant[]): Quadrant | null {
	const i = order.indexOf(from);
	const col = i % 2;
	const row = i >> 1;
	switch (key) {
		case "ArrowLeft":
			return col > 0 ? (order[i - 1] ?? null) : null;
		case "ArrowRight":
			return col < 1 ? (order[i + 1] ?? null) : null;
		case "ArrowUp":
			return row > 0 ? (order[i - 2] ?? null) : null;
		case "ArrowDown":
			return row < 1 ? (order[i + 2] ?? null) : null;
	}
}
