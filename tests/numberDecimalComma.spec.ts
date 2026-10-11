/* A number box's decimal notation (docs/i18n.md: aviation values keep the
 * point-decimal notation in both languages). Firefox shows a box's value by the
 * box's language, so under the French interface "1.5" read "1,5" while the
 * same box's grey placeholder, and every other figure, read "1.15": every
 * number box is marked English, which Firefox follows (Chromium follows the
 * browser's locale, which no markup changes). And a typed or pasted comma
 * becomes a dot ($lib/ui/numberDecimalComma), where Chromium under an English
 * locale used to DROP it, reading "2,25" as 225. The listener is driven in the
 * browsers; here, the markup of every component and the paste rule. */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'svelte/compiler';
import { describe, expect, it } from 'vitest';
import { pastedDecimal } from '$lib/ui/numberDecimalComma';

function svelteFiles(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const p = path.join(dir, name);
		if (statSync(p).isDirectory()) {
			svelteFiles(p, out);
		} else if (name.endsWith('.svelte')) {
			out.push(p);
		}
	}
	return out;
}

type AttrValue = { type: string; data?: string }[] | true | { type: string };
interface Element {
	type: string;
	name?: string;
	attributes?: { type: string; name?: string; value?: AttrValue }[];
}

function staticAttr(el: Element, name: string): string | null | undefined {
	const a = el.attributes?.find((x) => x.type === 'Attribute' && x.name === name);
	if (!a) {
		return undefined;
	}
	if (Array.isArray(a.value) && a.value.every((v) => v.type === 'Text')) {
		return a.value.map((v) => v.data ?? '').join('');
	}
	return null;
}

/** Every `<input type="number">` of a component, wherever it sits in blocks,
 *  snippets and components' children. */
function numberInputs(file: string): Element[] {
	const ast = parse(readFileSync(file, 'utf8'), { modern: true });
	const found: Element[] = [];
	const seen = new Set<object>();
	const visit = (node: unknown): void => {
		if (node === null || typeof node !== 'object' || seen.has(node)) {
			return;
		}
		seen.add(node);
		const el = node as Element;
		if (el.type === 'RegularElement' && el.name === 'input' && staticAttr(el, 'type') === 'number') {
			found.push(el);
		}
		for (const [key, value] of Object.entries(node)) {
			if (key !== 'metadata' && key !== 'instance' && key !== 'module' && key !== 'css') {
				visit(value);
			}
		}
	};
	visit(ast.fragment);
	return found;
}

describe('every number box shows the point-decimal notation', () => {
	const files = svelteFiles('src').filter((f) => readFileSync(f, 'utf8').includes('type="number"'));

	it('finds the number boxes it guards', () => {
		const count = files.reduce((n, f) => n + numberInputs(f).length, 0);
		expect(count).toBeGreaterThanOrEqual(70);
	});

	for (const file of files) {
		it(`${file.replace(/^src\//, '')} marks each of its number boxes English`, () => {
			for (const el of numberInputs(file)) {
				expect(staticAttr(el, 'lang'), file).toBe('en');
			}
		});
	}
});

/* A box's minimum is also its step grid's base: with min 0.01 and the step
 * 0.1 its own value asks (decimalStep), 1.3 sat off the grid, the spinner
 * stepped it to 1.31 and the browser counted it invalid (Firefox paints that).
 * So a minimum sits on the grid: a whole number under a step read from the
 * value, a multiple of a fixed step. */
describe('every number box steps on its own grid', () => {
	const files = svelteFiles('src').filter((f) => readFileSync(f, 'utf8').includes('type="number"'));
	for (const file of files) {
		it(`${file.replace(/^src\//, '')} sets no minimum off its step grid`, () => {
			for (const el of numberInputs(file)) {
				const min = staticAttr(el, 'min');
				if (min === undefined || min === null) {
					continue;
				}
				const step = staticAttr(el, 'step');
				if (typeof step === 'string' && step !== 'any') {
					const ratio = Number(min) / Number(step);
					expect(Math.abs(ratio - Math.round(ratio)), `${file} min ${min} step ${step}`).toBeLessThan(1e-9);
				} else {
					expect(Number.isInteger(Number(min)), `${file} min ${min} under a step read from the value`).toBe(true);
				}
			}
		});
	}
});

describe('a pasted figure', () => {
	it('reads a lone comma as the decimal point, its grouping spaces dropped', () => {
		expect(pastedDecimal('2,25')).toBe('2.25');
		expect(pastedDecimal(' 1 234,5 ')).toBe('1234.5');
		expect(pastedDecimal('1\u202f156,66')).toBe('1156.66');
		expect(pastedDecimal('-0,000214')).toBe('-0.000214');
	});

	it('leaves a figure without a comma, or with both marks, to the box', () => {
		expect(pastedDecimal('2.25')).toBeNull();
		expect(pastedDecimal('1,234.5')).toBeNull();
		expect(pastedDecimal('')).toBeNull();
	});

	it('reads one spreadsheet cell, which ends with a line break', () => {
		// Excel and LibreOffice add one: left to the box, Chromium under an
		// English locale read 225 again.
		expect(pastedDecimal('2,25\n')).toBe('2.25');
		expect(pastedDecimal('2,25\r\n')).toBe('2.25');
	});

	it('makes no figure of spaces that group nothing', () => {
		// Removed, they would read 0.205500.
		expect(pastedDecimal('0,205 500')).toBeNull();
		expect(pastedDecimal('12 34,5')).toBeNull();
	});
});
