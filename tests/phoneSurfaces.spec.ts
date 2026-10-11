/* The phone surfaces after the 2026-10 edge-to-edge pass
 * (docs/workspace-surfaces.md "Phones"): the cross-file agreements and the
 * screen-only scope a type checker cannot see. Components are read through
 * the compiler's own parser (the surfaceMounts / navlogCompact precedent):
 * template structure from its fragment, CSS from its stylesheet with every
 * rule's enclosing at-rules, so "inside @media screen" is a fact and not a
 * string search. */

import { readFileSync } from 'node:fs';
import { parse } from 'svelte/compiler';
import { describe, expect, it } from 'vitest';

import { cssRulesOf, type CssRule } from './helpers/cssRules';

const src = (file: string): string => readFileSync(file, 'utf8');

/** The rules whose selector list contains exactly `selector`. */
function rulesFor(rules: CssRule[], selector: string): CssRule[] {
	return rules.filter((r) => r.selectors.includes(selector));
}

type Node = { type: string; name?: string; attributes?: { type: string; name?: string; value?: unknown }[]; fragment?: { nodes: Node[] }; nodes?: Node[]; body?: { nodes: Node[] } };

function classOf(n: Node): string[] {
	const attr = n.attributes?.find((a) => a.type === 'Attribute' && a.name === 'class');
	const value = attr?.value;
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.filter((v: { type: string }) => v.type === 'Text')
		.map((v: { data: string }) => v.data)
		.join(' ')
		.split(/\s+/)
		.filter(Boolean);
}

/** Every element `tag.cls` of a component's template, each with the classes
 *  of the elements around it, innermost first. */
function ancestorsOf(file: string, tag: string, cls: string): string[][] {
	const ast = parse(src(file), { modern: true });
	const found: string[][] = [];
	const walk = (nodes: Node[], stack: string[][]): void => {
		for (const n of nodes) {
			const isEl = n.type === 'RegularElement';
			if (isEl && n.name === tag && classOf(n).includes(cls)) {
				found.push(stack.map((c) => c.join('.')).reverse());
			}
			const next = isEl ? [...stack, classOf(n)] : stack;
			const kids = [n.fragment?.nodes, n.nodes, n.body?.nodes].filter(Boolean) as Node[][];
			for (const k of kids) {
				walk(k, next);
			}
			// Blocks keep their branches under their own keys.
			for (const key of ['consequent', 'alternate', 'fallback', 'pending', 'then', 'catch']) {
				const branch = (n as unknown as Record<string, { nodes?: Node[] } | null>)[key];
				if (branch?.nodes) {
					walk(branch.nodes, next);
				}
			}
		}
	};
	walk(ast.fragment.nodes, []);
	return found;
}

describe('a wide table pans on its own, never the whole surface', () => {
	const CASES = [
		{ file: 'src/lib/components/aircrafteditor/PerfGridEditor.svelte', table: 'etable', wrap: 'grid-scroll' },
		{ file: 'src/lib/components/aircrafteditor/MassBalanceEditPage.svelte', table: 'stations', wrap: 'table-scroll' },
		{ file: 'src/lib/components/aircrafteditor/GeneralPage.svelte', table: 'settings', wrap: 'table-scroll' },
		{ file: 'src/lib/components/flightprep/PerformancePage.svelte', table: 'poh-table', wrap: 'grid-wrap' },
		{ file: 'src/lib/components/AixmDiagnosticsTable.svelte', table: 'diag-table', wrap: 'diag-scroll' },
	];

	for (const c of CASES) {
		it(`${c.table} sits in its own .${c.wrap}`, () => {
			const at = ancestorsOf(c.file, 'table', c.table);
			expect(at.length).toBeGreaterThan(0);
			for (const chain of at) {
				expect(chain[0], `${c.table}'s parent`).toBe(c.wrap);
			}
		});

		it(`.${c.wrap} scrolls on screen only, paper never clipping it`, () => {
			const rules = rulesFor(cssRulesOf(c.file), `.${c.wrap}`);
			const scrolls = rules.filter((r) => r.decls.get('overflow-x') === 'auto');
			expect(scrolls.length).toBeGreaterThan(0);
			for (const r of scrolls) {
				// Either the scroller itself is screen-only, or paper undoes it.
				const screenOnly = r.parents[0] === '@media screen';
				const undoneOnPaper = rules.some((p) => p.parents[0] === '@media print' && p.decls.get('overflow') === 'visible');
				expect(screenOnly || undoneOnPaper, `.${c.wrap} would clip on paper`).toBe(true);
			}
		});
	}
});

describe('the phone detail sheet runs its tables and weather bands edge to edge', () => {
	const SHEET = 'src/lib/components/DetailSurface.svelte';
	/** Each bleeder, its own file, the element that bleeds, and what makes it
	 *  bleed beyond the margin (`margin-inline` back over the sheet's padding). */
	const BLEEDERS = [
		{ file: 'src/lib/components/detail/AirportDetail.svelte', sel: ':global(.detail-box) .runways-wrap' },
		{ file: 'src/lib/components/detail/FrequencyList.svelte', sel: ':global(.detail-box) .freqs' },
		{ file: 'src/lib/components/detail/SupAipDetail.svelte', sel: ':global(.detail-box) .freqs' },
		{ file: 'src/lib/components/detail/MetarReadout.svelte', sel: ':global(.detail-box) .card' },
		{ file: 'src/lib/components/detail/WeatherSection.svelte', sel: ':global(.detail-box) .card' },
	];

	it('is the phone sheet alone: .detail-box is DetailSurface\'s box and no one else\'s', () => {
		expect(src(SHEET)).toContain('boxClass="detail-box"');
		const others = [
			'src/lib/components/DetailPanel.svelte',
			'src/notam/App.svelte',
		].filter((f) => src(f).includes('detail-box'));
		expect(others).toEqual([]);
	});

	it('publishes the sheet\'s inline padding on screen only, equal to the padding', () => {
		const rules = rulesFor(cssRulesOf(SHEET), '.detail-scroll');
		const pads = rules.filter((r) => r.decls.has('--detail-pad'));
		expect(pads.length).toBe(1);
		expect(pads[0].parents).toEqual(['@media screen']);
		const padding = rules.find((r) => r.decls.has('padding'))!.decls.get('padding')!;
		expect(padding.split(' ')[1]).toBe(pads[0].decls.get('--detail-pad'));
	});

	for (const b of BLEEDERS) {
		it(`${b.file.split('/').pop()} bleeds by the sheet's padding, on screen only`, () => {
			const rules = cssRulesOf(b.file);
			const sheetRules = rules.filter((r) => r.selectors.some((s) => s.startsWith(':global(.detail-box)')));
			expect(sheetRules.length).toBeGreaterThan(0);
			for (const r of sheetRules) {
				expect(r.parents, r.selectors.join(', ')).toEqual(['@media screen']);
			}
			const bleed = rulesFor(rules, b.sel);
			expect(bleed.map((r) => r.decls.get('margin-inline'))).toContain('calc(-1 * var(--detail-pad, 0px))');
		});
	}

	it('insets a bled table\'s text by the same padding, first and last cells', () => {
		for (const [file, table] of [
			['src/lib/components/detail/AirportDetail.svelte', '.runways :is(th, td)'],
			['src/lib/components/detail/FrequencyList.svelte', '.freqs td'],
			['src/lib/components/detail/SupAipDetail.svelte', '.freqs td'],
		]) {
			const rules = cssRulesOf(file);
			expect(rulesFor(rules, `:global(.detail-box) ${table}:first-child`)[0]?.decls.get('padding-left'), file).toBe('var(--detail-pad, 4px)');
			expect(rulesFor(rules, `:global(.detail-box) ${table}:last-child`)[0]?.decls.get('padding-right'), file).toBe('var(--detail-pad, 4px)');
		}
	});
});

describe('a phone sheet and the hairline lists inside sections', () => {
	// The sections themselves are one rule for every screen:
	// tests/flatSections.spec.ts.
	it('lines a sheet\'s every line up at its own padding, a panel taking none inline', () => {
		const r = rulesFor(cssRulesOf('src/lib/components/HeadOverlay.svelte'), '.sheet-body > :global(.popover-panel)');
		expect(r.length).toBe(1);
		expect(r[0].parents).toEqual(['@media screen']);
		expect(r[0].decls.get('padding')).toBe('6px 0');
	});

	it('runs a section\'s hairline lists to the edges, their text at the section\'s inset', () => {
		const LISTS = [
			{ file: 'src/lib/components/phone/NearestAerodromes.svelte', list: '.near', row: '.near .row' },
			{ file: 'src/lib/components/phone/SupAipList.svelte', list: '.sups', row: '.sups .row' },
			{ file: 'src/lib/components/phone/PhonePages.svelte', list: '.prep-row', row: '.prep-row' },
			{ file: 'src/lib/components/OfflineModal.svelte', list: '.pack', row: '.pack' },
		];
		for (const l of LISTS) {
			const rules = cssRulesOf(l.file);
			const list = rulesFor(rules, l.list).find((r) => r.decls.has('margin-inline'));
			expect(list?.parents, l.file).toEqual(['@media screen']);
			expect(list?.decls.get('margin-inline'), l.file).toBe('calc(-1 * var(--flat-inset, 0px))');
			const row = rulesFor(rules, l.row).find((r) => r.decls.has('padding-inline'));
			expect(row?.parents, l.file).toEqual(['@media screen']);
			expect(row?.decls.get('padding-inline'), l.file).toMatch(/^var\(--flat-inset, (0|4px)\)$/);
		}
	});
});

describe('the workbook windows on a phone: their air, their cards, their heads', () => {
	const WINDOWS = [
		'src/lib/components/FlightPrepModal.svelte',
		'src/lib/components/AircraftEditorModal.svelte',
		'src/lib/components/FlightsModal.svelte',
	];

	for (const file of WINDOWS) {
		it(`${file.split('/').pop()} gives its body 8 px on a phone, on screen only`, () => {
			const phone = rulesFor(cssRulesOf(file), ':global(:root.mobile-ui) .body').filter((r) => r.decls.has('padding'));
			expect(phone.length).toBe(1);
			expect(phone[0].parents).toEqual(['@media screen']);
			expect(phone[0].decls.get('padding')).toBe('8px');
		});
	}

	it('lets the aircraft editor\'s flat cards bleed by that 8 px, on screen only', () => {
		// The cards' rule is every screen's (tests/flatSections.spec.ts); a
		// phone only narrows what they bleed over.
		const body = rulesFor(cssRulesOf('src/lib/components/AircraftEditorModal.svelte'), ':global(:root.mobile-ui) .body')[0];
		expect(body.parents).toEqual(['@media screen']);
		expect(body.decls.get('--flat-bleed')).toBe(body.decls.get('padding'));
	});

	it('lets the flights title yield to its tabs on a phone screen, never on paper', () => {
		const h2 = rulesFor(cssRulesOf('src/lib/components/FlightsModal.svelte'), ':global(:root.mobile-ui) h2');
		expect(h2.length).toBe(1);
		expect(h2[0].parents).toEqual(['@media screen']);
		expect(h2[0].decls.get('display')).toBe('none');
	});

	it('keeps a page tab\'s label on one line on a phone, the head scrolling instead', () => {
		const tab = rulesFor(cssRulesOf('src/lib/components/PageTabs.svelte'), ':global(:root.mobile-ui) .page-tab');
		expect(tab.length).toBe(1);
		expect(tab[0].parents).toEqual(['@media screen']);
		expect(tab[0].decls.get('white-space')).toBe('nowrap');
	});
});
