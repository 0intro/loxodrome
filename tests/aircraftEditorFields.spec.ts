/* The aircraft editor's boxes are as wide as what they hold, and every box
 * on a page starts on one label column (styles/workbook.css, the editor's
 * half). From June to October 2026 a generic
 * `.field input:not([type="checkbox"], [type="radio"]) { flex: 1 }`, weighted
 * by its :not() argument, outranked `.field .num { flex: 0 0 90px }`, and
 * every number box ran 1246 px across a 1920 px window. Now the shared rules
 * are scoped by a zero-weight :where(), the control look sets no width, and
 * each kind of value takes its width from one token, so nothing generic can
 * outrank a width again. Table cells hide the spinner Firefox always draws
 * (the Route tab's wind boxes do the same); a field's number box keeps room
 * for it. */

import { describe, expect, it } from 'vitest';
import { cssRulesOf, type CssRule } from './helpers/cssRules';

const SHEET = cssRulesOf('src/styles/workbook.css');
const SCOPE = '.aircraft-editor-box .body';
const editorRules = SHEET.filter((r) => r.selectors.some((s) => s.includes('.aircraft-editor-box')));

function only(selector: string): CssRule {
	const found = editorRules.filter((r) => r.selectors.includes(selector));
	expect(found, selector).toHaveLength(1);
	return found[0];
}

describe('the editor’s measures', () => {
	const tokens = only(SCOPE);

	it('declares every width once, on the body', () => {
		const names = [...tokens.decls.keys()].filter((k) => k.startsWith('--'));
		expect(names).toEqual([
			'--label-w',
			'--field-gap',
			'--w-num',
			'--w-code',
			'--w-icao',
			'--w-type',
			'--w-name',
			'--w-long',
			'--w-cell',
			'--w-coef',
			'--w-item',
			'--w-setting',
			'--measure',
		]);
		for (const r of editorRules) {
			if (r !== tokens) {
				expect([...r.decls.keys()].filter((k) => k.startsWith('--w-') || k === '--measure'), r.selectors.join()).toEqual([]);
			}
		}
	});

	it('sizes boxes in ch of their face, the long box in px for the measure', () => {
		for (const [name, chars] of [['--w-num', 7], ['--w-cell', 7], ['--w-coef', 11]] as const) {
			expect(tokens.decls.get(name), name).toMatch(new RegExp(`^calc\\(${chars}ch \\+ \\d+px\\)$`));
		}
		expect(tokens.decls.get('--w-long')).toMatch(/^\d+px$/);
		expect(tokens.decls.get('--measure')).toBe('calc(var(--label-w) + var(--field-gap) + var(--w-long))');
	});

	it('gives every box a label column of one width', () => {
		const label = only(`:where(${SCOPE}) .field > span:first-child`);
		expect(label.decls.get('flex')).toBe('0 0 var(--label-w)');
	});
});

describe('no generic rule can outrank a width', () => {
	it('scopes every shared rule by a zero-weight :where(), the flat card and the tokens apart', () => {
		for (const r of editorRules) {
			for (const s of r.selectors) {
				const plain = s === SCOPE || s.startsWith(`${SCOPE} .card`);
				expect(plain || /:where\(\.aircraft-editor-box\b/.test(s), s).toBe(true);
			}
		}
	});

	it('sets no width and no growth in the control look', () => {
		const look = editorRules.filter((r) => r.selectors.some((s) => /:where\(input:not\(\[type="checkbox"\], \[type="radio"\]\), select, textarea\)$/.test(s)));
		expect(look).toHaveLength(1);
		const s = look[0].selectors[0];
		// Weightless whole: the scope, the carriers and the elements each in a :where().
		expect(s).toBe(`:where(${SCOPE}) :where(.field, .coefs) :where(input:not([type="checkbox"], [type="radio"]), select, textarea)`);
		for (const key of ['width', 'inline-size', 'flex-grow', 'flex-basis']) {
			expect(look[0].decls.has(key), key).toBe(false);
		}
		expect(look[0].decls.get('flex')).toBe('0 1 auto');
	});

	it('lets no editor rule grow a box to fill its row', () => {
		for (const r of editorRules) {
			expect(r.decls.get('flex'), r.selectors.join()).not.toBe('1');
		}
	});

	it('takes each kind’s width from its token', () => {
		const kinds: [string, string][] = [
			['.num', '--w-num'],
			['.w-code', '--w-code'],
			['.w-icao', '--w-icao'],
			['.w-type', '--w-type'],
			['.w-name', '--w-name'],
			['.w-long', '--w-long'],
			['.cell', '--w-cell'],
			['.text-cell', '--w-item'],
			['.setting-cell', '--w-setting'],
			['.coef', '--w-coef'],
		];
		for (const [kind, token] of kinds) {
			expect(only(`:where(${SCOPE}) ${kind}`).decls.get('inline-size'), kind).toBe(`var(${token})`);
		}
		expect(only(`:where(${SCOPE}) .etable input.axis`).decls.get('inline-size')).toBe('var(--w-cell)');
	});
});

describe('the POH grid’s axis boxes', () => {
	it('keep the focus border, the one ring they have, after their own border', () => {
		const axis = SHEET.indexOf(only(`:where(${SCOPE}) .etable input.axis`));
		const focus = SHEET.indexOf(only(`:where(${SCOPE}) .etable input:focus`));
		// Same weight: the later rule wins, and outline is none on focus.
		expect(focus).toBeGreaterThan(axis);
		expect(SHEET[focus].decls.get('outline')).toBe('none');
	});
});

describe('the spinner', () => {
	it('is hidden in a table’s cells and a coefficient’s box, the arrow keys still stepping', () => {
		const hide = only(`:where(${SCOPE}) :is(.etable, .coefs) input[type="number"]`);
		expect(hide.decls.get('appearance')).toBe('textfield');
	});

	it('keeps its room in a field’s number box', () => {
		const tokens = only(SCOPE);
		const chrome = Number(/\+ (\d+)px/.exec(tokens.decls.get('--w-num')!)![1]);
		const cell = Number(/\+ (\d+)px/.exec(tokens.decls.get('--w-cell')!)![1]);
		// Padding and border, plus Firefox's ~20 px spinner.
		expect(chrome - cell).toBeGreaterThanOrEqual(20);
	});
});

describe('the touch floor', () => {
	it('keys off :root.touch-ui and leaves the POH grids dense', () => {
		const touch = editorRules.filter((r) => r.selectors.some((s) => s.startsWith(':root.touch-ui')));
		expect(touch.length).toBeGreaterThan(0);
		const floor = touch.find((r) => r.decls.get('min-block-size') === '44px');
		expect(floor).toBeDefined();
		expect(floor!.selectors.some((s) => s.includes('.etable:not(.poh)'))).toBe(true);
		expect(floor!.selectors.some((s) => /\.etable(?!:not\(\.poh\))/.test(s))).toBe(false);
	});

	it('gives the x and + buttons a 44 px target outside the POH grid only', () => {
		const target = editorRules.filter((r) => r.selectors.some((s) => s.startsWith(':root.touch-ui') && s.includes('.icon')));
		expect(target.length).toBeGreaterThan(0);
		for (const r of target) {
			for (const s of r.selectors) {
				expect(s, s).toContain('.icon:not(.poh .icon)');
			}
		}
	});
});
