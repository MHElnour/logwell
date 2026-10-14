// A small RFC 4180 CSV reader and writer for tests/limits/limits-matrix.csv. A cell remembers whether it was
// quoted in the file, so writing the matrix back changes only the cells the harness filled in.

export interface Cell {
	v: string;
	/** Quoted in the source (kept on write even when not needed, so a diff shows only real changes). */
	q: boolean;
}

export function parseCsv(text: string): Cell[][] {
	const rows: Cell[][] = [];
	let row: Cell[] = [];
	let value = "";
	let quoted = false;
	let inQuotes = false;
	const endCell = (): void => {
		row.push({ v: value, q: quoted });
		value = "";
		quoted = false;
	};
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		if (inQuotes) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					value += '"';
					i++;
				} else inQuotes = false;
			} else value += ch;
			continue;
		}
		if (ch === '"' && value === "") {
			inQuotes = true;
			quoted = true;
		} else if (ch === ",") endCell();
		else if (ch === "\n" || ch === "\r") {
			if (ch === "\r" && text[i + 1] === "\n") i++;
			endCell();
			rows.push(row);
			row = [];
		} else value += ch;
	}
	if (value !== "" || quoted || row.length > 0) {
		endCell();
		rows.push(row);
	}
	return rows;
}

/** The values of a CSV text, row by row (what is written reads back: tests/app/csv-export.test.ts). */
export function csvValues(text: string): string[][] {
	return parseCsv(text).map((row) => row.map((c) => c.v));
}

function needsQuote(v: string): boolean {
	return /[",\r\n]/.test(v);
}

export function formatCsv(rows: readonly (readonly Cell[])[]): string {
	return rows.map((r) => r.map((c) => (c.q || needsQuote(c.v) ? `"${c.v.replace(/"/g, '""')}"` : c.v)).join(",") + "\n").join("");
}
