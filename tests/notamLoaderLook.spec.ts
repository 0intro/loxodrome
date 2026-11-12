/* The two NOTAM loaders look alike (docs/notam-viewer.md "The loader card fits
 * too"): Loxodrome's NotamLoader and the viewer's BriefingLoader share their
 * paste box and the briefing-site links over it, each ONE rule in app.css, and
 * each loader states only the paste box's SIZE, the cap and the floor its card
 * works the box's height out between. What a type checker cannot see: a look
 * property creeping back into one loader (the viewer's box set its size and
 * face alone and wore the browser's own field, its links the browser's own
 * blue), a loader losing its own size, the rules reaching the boxes at all
 * (both render inside NotamsTab's `.tab-panel`, the viewer mounting the shared
 * tab around its own loader), and the viewer's notes and its one caution
 * styled at all. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { cssRulesOf } from './helpers/cssRules';

const APP = cssRulesOf('src/app.css');
const NOTAM_LOADER = 'src/lib/components/NotamLoader.svelte';
const BRIEFING_LOADER = 'src/notam/BriefingLoader.svelte';
const LOADERS: Record<string, [cap: string, floor: string]> = {
	[NOTAM_LOADER]: ['440px', '140px'],
	[BRIEFING_LOADER]: ['420px', '140px'],
};
const SIZE = new Set(['height', 'min-height', 'block-size', 'min-block-size']);

const appRule = (selector: string): Record<string, string> => {
	const rules = APP.filter((r) => r.selectors.includes(selector));
	expect(rules.length, selector).toBe(1);
	expect(rules[0].parents, selector).toEqual([]);
	return Object.fromEntries(rules[0].decls);
};

describe('one paste box for both loaders', () => {
	it('states the look once, in app.css, on every medium', () => {
		expect(appRule('.tab-panel .notam-input')).toEqual({
			'inline-size': '100%',
			padding: '8px 10px',
			'font-family': 'ui-monospace, "SF Mono", "Cascadia Code", consolas, monospace',
			'font-size': 'var(--fs-sm)',
			'line-height': '1.5',
			color: 'var(--text)',
			background: 'var(--surface-2)',
			border: '1px solid var(--border)',
			'border-radius': 'var(--radius)',
			resize: 'vertical',
		});
		expect(appRule('.tab-panel .notam-input:focus-visible')).toEqual({
			outline: '2px solid var(--accent)',
			'outline-offset': '-1px',
		});
	});

	it('leaves each loader its own size and nothing else', () => {
		for (const [file, [cap, floor]] of Object.entries(LOADERS)) {
			const own = cssRulesOf(file).filter((r) => r.selectors.some((s) => s.includes('.notam-input')));
			expect(own.length, file).toBe(1);
			expect([...own[0].decls.keys()].filter((p) => !SIZE.has(p)), file).toEqual([]);
			expect([...own[0].decls.values()], file).toEqual([cap, floor]);
		}
	});

	it('marks both boxes, each inside the tab the rule reaches', () => {
		for (const file of Object.keys(LOADERS)) {
			expect(readFileSync(file, 'utf8'), file).toMatch(/<textarea\s+class="notam-input"/);
		}
		const tab = readFileSync('src/lib/components/tabs/NotamsTab.svelte', 'utf8');
		expect(tab).toMatch(/<div class="tab-panel"[^>]*>[\s\S]*\{@render loader\(/);
		expect(readFileSync('src/notam/App.svelte', 'utf8')).toMatch(/<NotamsTab\b[\s\S]*\{#snippet loader\b[\s\S]*<BriefingLoader\b/);
	});
});

describe('one pair of briefing-site links', () => {
	it('states the links once, in app.css', () => {
		expect(appRule('.tab-panel .ext-links')).toEqual({ display: 'flex', 'flex-wrap': 'wrap', gap: '14px' });
		expect(appRule('.tab-panel .ext-link')).toEqual({
			'align-self': 'flex-start',
			'font-size': 'var(--fs-sm)',
			color: 'var(--accent)',
			'text-decoration': 'none',
		});
		expect(appRule('.tab-panel .ext-link:hover')).toEqual({ 'text-decoration': 'underline' });
		expect(appRule('.tab-panel .ext-link:focus-visible')).toEqual({
			outline: '2px solid var(--accent)',
			'outline-offset': '1px',
		});
	});

	it('leaves neither loader a copy of its own', () => {
		for (const file of Object.keys(LOADERS)) {
			const own = cssRulesOf(file).filter((r) => r.selectors.some((s) => /\.ext-links?\b/.test(s)));
			expect(own.map((r) => r.selectors.join(', ')), file).toEqual([]);
			expect(readFileSync(file, 'utf8').match(/<a\s+class="ext-link"/g)?.length, file).toBe(2);
		}
	});
});

describe('the viewer\'s notes read as Loxodrome\'s', () => {
	it('sizes its notes and inks its caution', () => {
		const own = cssRulesOf(BRIEFING_LOADER);
		const twin = cssRulesOf(NOTAM_LOADER);
		const decls = (rules: typeof own, sel: string): Record<string, string> | undefined => {
			const r = rules.find((x) => x.selectors.includes(sel) && x.parents.length === 0);
			return r && Object.fromEntries(r.decls);
		};
		expect(decls(own, '.small')).toEqual(decls(twin, '.small'));
		expect(decls(own, '.small')).toEqual({ 'font-size': '11px' });
		expect(decls(own, '.warn')).toEqual({ margin: '0', 'font-size': '12px', color: 'var(--workbook-orange)' });
		expect(readFileSync(BRIEFING_LOADER, 'utf8')).toMatch(/<p class="warn" role="alert">/);
	});
});
