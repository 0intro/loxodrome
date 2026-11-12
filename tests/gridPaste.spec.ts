/* Cells copied from a spreadsheet, pasted into a table of boxes
 * ($lib/ui/gridPaste): a flight manual's grid typed into a spreadsheet used
 * to go into the aircraft editor one box at a time. The block fills right
 * and down from the box it lands in, each box as if typed, the table growing
 * first where the block reaches past it; a single value pastes as ever. The
 * parse runs here as is; the action through stand-ins for the elements, the
 * node project having no DOM (the browser drive pastes for real). */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gridPaste, parsePastedGrid, pastedFigure } from '$lib/ui/gridPaste';
import { pastedDecimal } from '$lib/ui/numberDecimalComma';

describe('a pasted block', () => {
	it('reads a spreadsheet’s copy: a tab between cells, a line per row', () => {
		expect(parsePastedGrid('235\t485\r\n265\t545\r\n')).toEqual([
			['235', '485'],
			['265', '545'],
		]);
		expect(parsePastedGrid('Front seats\t0.41\t80\n')).toEqual([['Front seats', '0.41', '80']]);
		// One column copied: a cell a line.
		expect(parsePastedGrid('0.0000005\n0.9\n0.025\n290')).toEqual([['0.0000005'], ['0.9'], ['0.025'], ['290']]);
		// A French CSV: semicolons, its commas decimal.
		expect(parsePastedGrid('2,05;500\n2,4;900')).toEqual([
			['2,05', '500'],
			['2,4', '900'],
		]);
	});

	it('parts a row copied from a PDF at its spaces, a figure grouped by them kept whole', () => {
		// Joined, "0.205 500" read 0.2055 in the arm box and "235 485" 235485.
		expect(parsePastedGrid('0.205 500\n0.564  500\n')).toEqual([
			['0.205', '500'],
			['0.564', '500'],
		]);
		expect(parsePastedGrid('235 485\n265 545')).toEqual([
			['235', '485'],
			['265', '545'],
		]);
		expect(parsePastedGrid('1 156,66\n1 200.5')).toEqual([['1 156,66'], ['1 200.5']]);
		// A spreadsheet groups with a no-break space, which parts no cell.
		expect(parsePastedGrid('1\u00a0156,66\n900')).toEqual([['1\u00a0156,66'], ['900']]);
	});

	it('leaves one value to the box', () => {
		expect(parsePastedGrid('235')).toBeNull();
		expect(parsePastedGrid('235\n')).toBeNull();
		expect(parsePastedGrid('Front; rear')).toBeNull();
	});

	it('reads a figure the French way too, and refuses what is no number', () => {
		expect(pastedFigure(' 1 234,5 ')).toBe('1234.5');
		expect(pastedFigure('0.41')).toBe('0.41');
		expect(pastedFigure('-0,000214')).toBe('-0.000214');
		expect(pastedFigure('')).toBe('');
		expect(pastedFigure('n/a')).toBeNull();
		expect(pastedFigure('1,234.5')).toBeNull();
		expect(pastedFigure('1 156.66')).toBe('1156.66');
		// Spaces that group nothing make no figure, never two joined.
		expect(pastedFigure('0.205 500')).toBeNull();
		expect(pastedFigure('0,205 500')).toBeNull();
	});

	it('is never read as one figure by the decimal-comma rule', () => {
		expect(pastedDecimal('235,5\t485,2')).toBeNull();
		expect(pastedDecimal('235,5\n485,2')).toBeNull();
	});
});

/* Stand-ins: a box carries its place in `dataset`, the table finds its
 * boxes, and an input event is what the box's own handler would see. */
class FakeInput {
	value: string;
	type: string;
	disabled = false;
	readOnly = false;
	dataset: Record<string, string>;
	events: string[] = [];
	focus = vi.fn();
	constructor(row: number, col: number, opts: { type?: string; grid?: string; value?: string } = {}) {
		this.type = opts.type ?? 'number';
		this.value = opts.value ?? '';
		this.dataset = { row: String(row), col: String(col), ...(opts.grid ? { grid: opts.grid } : {}) };
	}
	dispatchEvent(e: Event): boolean {
		this.events.push(e.type);
		return true;
	}
}

function table(rows: number, cols: number, types: string[] = []) {
	const boxes: FakeInput[] = [];
	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < cols; c++) {
			boxes.push(new FakeInput(r, c, { type: types[c] }));
		}
	}
	let onPaste: ((e: unknown) => void) | null = null;
	const node = {
		addEventListener: (_type: string, fn: (e: unknown) => void) => (onPaste = fn),
		removeEventListener: () => (onPaste = null),
		querySelectorAll: () => boxes,
	};
	const paste = (target: FakeInput, text: string) => {
		const e = { target, clipboardData: { getData: () => text }, preventDefault: vi.fn() };
		onPaste!(e);
		return e;
	};
	return { node: node as unknown as HTMLElement, boxes, paste };
}

const at = (boxes: FakeInput[], r: number, c: number, grid?: string): FakeInput =>
	boxes.find((b) => b.dataset.row === String(r) && b.dataset.col === String(c) && b.dataset.grid === grid)!;

describe('a table of boxes', () => {
	beforeEach(() => {
		vi.stubGlobal('HTMLInputElement', FakeInput);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('fills right and down from the box the block lands in, each box as if typed', async () => {
		const { node, boxes, paste } = table(3, 3);
		gridPaste(node);
		const e = paste(at(boxes, 1, 1), '235\t485\n265,5\t545\n');
		expect(e.preventDefault).toHaveBeenCalled();
		await Promise.resolve();
		await new Promise((r) => setTimeout(r, 0));
		expect([at(boxes, 1, 1).value, at(boxes, 1, 2).value, at(boxes, 2, 1).value, at(boxes, 2, 2).value]).toEqual([
			'235',
			'485',
			'265.5',
			'545',
		]);
		expect(at(boxes, 1, 1).events).toEqual(['input']);
		expect(at(boxes, 0, 0).value).toBe('');
		expect(at(boxes, 0, 0).events).toEqual([]);
	});

	it('grows the table first where the block reaches past it', async () => {
		const { node, boxes, paste } = table(1, 2);
		const grow = vi.fn((_grid: string, rows: number) => {
			for (let r = boxes.length / 2; r < rows; r++) {
				boxes.push(new FakeInput(r, 0), new FakeInput(r, 1));
			}
		});
		gridPaste(node, { grow });
		paste(at(boxes, 0, 0), '2.05\t500\n2.4\t900\n2.4\t1150\n');
		expect(grow).toHaveBeenCalledWith('', 3, 2);
		await new Promise((r) => setTimeout(r, 0));
		expect(boxes.map((b) => b.value)).toEqual(['2.05', '500', '2.4', '900', '2.4', '1150']);
	});

	it('keeps a text box’s text, and leaves a number box a cell holds no number for', async () => {
		const { node, boxes, paste } = table(1, 3, ['text', 'number', 'number']);
		at(boxes, 0, 2).value = '80';
		gridPaste(node);
		paste(at(boxes, 0, 0), 'Rear bench\t1,19\tn/a');
		await new Promise((r) => setTimeout(r, 0));
		expect(boxes.map((b) => b.value)).toEqual(['Rear bench', '1.19', '80']);
	});

	it('passes a disabled box by, and keeps to the grid the box belongs to', async () => {
		const { node, boxes, paste } = table(2, 2);
		at(boxes, 1, 0).disabled = true;
		const axis = new FakeInput(0, 0, { grid: 'temps', value: '-20' });
		boxes.push(axis);
		gridPaste(node);
		paste(at(boxes, 0, 0), '1\t2\n3\t4');
		await new Promise((r) => setTimeout(r, 0));
		expect([at(boxes, 0, 0).value, at(boxes, 0, 1).value, at(boxes, 1, 0).value, at(boxes, 1, 1).value]).toEqual(['1', '2', '', '4']);
		expect(axis.value).toBe('-20');
	});

	it('leaves a single value, and a box outside any grid, to the browser', () => {
		const { node, boxes, paste } = table(1, 1);
		gridPaste(node);
		expect(paste(at(boxes, 0, 0), '235').preventDefault).not.toHaveBeenCalled();
		const loose = new FakeInput(0, 0);
		delete (loose.dataset as Record<string, string | undefined>).row;
		expect(paste(loose, '1\t2').preventDefault).not.toHaveBeenCalled();
	});
});
