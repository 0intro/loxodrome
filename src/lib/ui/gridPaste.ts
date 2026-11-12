/* A block of cells pasted into a table of boxes. A spreadsheet copies its
 * cells as text, a tab between two cells and a line per row, and a flight
 * manual's grid typed into a spreadsheet used to go into the aircraft editor
 * one box at a time: 36 boxes for a small POH grid, each a chance to slip.
 * Pasted into a box of a table carrying this action, the block fills right
 * and down from that box, each box as if typed (its own input handler), the
 * table first growing the rows (a POH grid the columns too) the block
 * reaches. A single value pastes as ever.
 *
 * The boxes say where they sit, `data-row` and `data-col`, logical rather
 * than the table's own rows and cells, so a POH grid's max- and min-mass
 * sub-rows and its roll and 15 m columns line up as the manual prints them;
 * `data-grid` names a table's other grids (that grid's axes). A figure reads
 * the French way too, a decimal comma and grouping spaces, as one pasted
 * figure does ($lib/ui/numberDecimalComma); a cell that is no number leaves
 * its number box as it was, and an empty one empties it, as in a spreadsheet.
 * Spaces join a figure's digits only where they group its thousands: a row
 * copied from a PDF ("0.205 500") is two cells, never the 0.205500 their
 * removal would read. */

import { tick } from 'svelte';
import { pastedDecimal } from './numberDecimalComma';

/** A line that is one figure, its thousands grouped by spaces and a decimal
 *  part saying so (1 156,66, 1 156.66): without one, "235 485" is a roll and
 *  a distance. */
const ONE_FIGURE = /^-?\d{1,3}( \d{3})+[.,]\d+$/;

/** The block a pasted text holds, rows of cells, or null for one value: a
 *  line without a tab. Tab-separated, as every spreadsheet copies; lines
 *  without a tab split at semicolons where every line holds one (a French
 *  CSV, whose commas are decimal), else at spaces (a row copied from a PDF),
 *  a figure whose spaces group its thousands kept whole. A spreadsheet groups
 *  with the no-break spaces, which never split a cell. */
export function parsePastedGrid(text: string): string[][] | null {
	const lines = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
	const tabbed = lines.some((l) => l.includes('\t'));
	if (lines.length < 2 && !tabbed) {
		return null;
	}
	if (tabbed || lines.every((l) => l.includes(';'))) {
		const sep = tabbed ? '\t' : ';';
		return lines.map((l) => l.split(sep).map((c) => c.trim()));
	}
	return lines.map((l) => {
		const line = l.trim();
		return ONE_FIGURE.test(line) ? [line] : line.split(/ +/);
	});
}

/** A whole part grouped by spaces, with or without a decimal point. */
const GROUPED = /^-?\d{1,3}(\s\d{3})+(\.\d*)?$/;

/** A pasted cell as a number box reads it, or null when it is no number:
 *  spaces anywhere but between groups of thousands make none. */
export function pastedFigure(cell: string): string | null {
	const s = cell.trim();
	if (s === '') {
		return '';
	}
	const figure = pastedDecimal(s) ?? (!/\s/.test(s) || GROUPED.test(s) ? s.replace(/\s/g, '') : null);
	return figure !== null && Number.isFinite(Number(figure)) ? figure : null;
}

export interface GridPasteOptions {
	/** Make room for a block reaching `rows` rows and `cols` columns of the
	 *  grid named (counts from 0, the block's far corner plus one). */
	grow?: ((grid: string, rows: number, cols: number) => void) | undefined;
}

type Box = HTMLInputElement;

/** The most a paste grows a table by: a block copied by mistake (a whole
 *  sheet) must not add a thousand rows. A POH grid's 30 altitudes and 12
 *  columns fit. */
const MAX_ROWS = 60;
const MAX_COLS = 24;

export function gridPaste(
	node: HTMLElement,
	options: GridPasteOptions = {},
): { update: (o: GridPasteOptions) => void; destroy: () => void } {
	let grow = options.grow;

	const boxesOf = (grid: string): Map<string, Box> => {
		const out = new Map<string, Box>();
		for (const box of node.querySelectorAll<Box>('input[data-row][data-col]')) {
			if ((box.dataset.grid ?? '') === grid) {
				out.set(`${box.dataset.row}:${box.dataset.col}`, box);
			}
		}
		return out;
	};

	const onPaste = (e: ClipboardEvent): void => {
		const target = e.target;
		if (!(target instanceof HTMLInputElement) || target.dataset.row === undefined || target.dataset.col === undefined) {
			return;
		}
		const pasted = parsePastedGrid(e.clipboardData?.getData('text/plain') ?? '');
		if (pasted === null) {
			return;
		}
		const block = pasted.slice(0, MAX_ROWS).map((line) => line.slice(0, MAX_COLS));
		e.preventDefault();
		const grid = target.dataset.grid ?? '';
		const row0 = Number(target.dataset.row);
		const col0 = Number(target.dataset.col);
		grow?.(grid, row0 + block.length, col0 + Math.max(...block.map((line) => line.length)));
		// The rows grown are drawn by the next flush.
		void tick().then(() => {
			const boxes = boxesOf(grid);
			block.forEach((line, i) =>
				line.forEach((cell, j) => {
					const box = boxes.get(`${row0 + i}:${col0 + j}`);
					if (!box || box.disabled || box.readOnly) {
						return;
					}
					const value = box.type === 'number' ? pastedFigure(cell) : cell;
					if (value === null) {
						return;
					}
					box.value = value;
					box.dispatchEvent(new Event('input', { bubbles: true }));
				}),
			);
			target.focus();
		});
	};

	node.addEventListener('paste', onPaste);
	return {
		update(o: GridPasteOptions): void {
			grow = o.grow;
		},
		destroy(): void {
			node.removeEventListener('paste', onPaste);
		},
	};
}
