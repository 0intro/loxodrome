/* A section is flat, not a card, on every screen (docs/workspace-surfaces.md
 * "A section is flat"): its legend over its rows, a hairline under it running
 * to its carrier's edges, its text at the carrier's own inset. ONE rule in
 * app.css for both layouts and both apps; each carrier states the padding a
 * section bleeds back over beside the padding itself. What a type checker
 * cannot see: every rule is screen-only (a bare Ctrl+P puts a tab or a surface
 * on paper, where the cards stay), the rule never sets `display` (NotamLoader
 * and the period popover lay their fieldsets out), each bleed equals its
 * carrier's padding (a larger one would scroll the carrier sideways), and
 * every section sits inside a carrier at all. Components are read through the
 * compiler's own parser. */

import { readFileSync } from 'node:fs';
import { parse } from 'svelte/compiler';
import { describe, expect, it } from 'vitest';

import { cssRulesOf, type CssRule } from './helpers/cssRules';

const src = (file: string): string => readFileSync(file, 'utf8');

const rulesFor = (rules: CssRule[], selector: string): CssRule[] => rules.filter((r) => r.selectors.includes(selector));
const px = (v: string | undefined): number => parseFloat(v ?? 'NaN');
/** The inline half of a padding shorthand. */
const inline = (padding: string): string => {
	const parts = padding.split(' ');
	return parts.length === 1 ? parts[0] : parts[1];
};

const APP = cssRulesOf('src/app.css');
const VIEWER = 'src/notam/app.css';
const CARRIERS = ':is(.tab-panel, .popover-panel, .surface-panel)';
const SECTION = `${CARRIERS} fieldset.group`;

describe('one flat section for every screen', () => {
	it('flattens the section on screen only, bleeding by its carrier and setting its text at that inset', () => {
		const flat = rulesFor(APP, SECTION);
		expect(flat.length).toBe(1);
		expect(flat[0].parents).toEqual(['@media screen']);
		expect([...flat[0].decls]).toEqual([
			['--flat-inset', 'var(--flat-bleed, 0px)'],
			['margin-inline', 'calc(-1 * var(--flat-bleed, 0px))'],
			['padding', '4px var(--flat-inset) 12px'],
			['border-width', '0 0 1px'],
			['border-radius', '0'],
		]);
	});

	it('wins over the card by coming after it, at the card\'s specificity', () => {
		const card = APP.findIndex((r) => r.selectors.includes('.tab-panel fieldset.group') && r.parents.length === 0);
		const flat = APP.findIndex((r) => r.selectors.includes(SECTION));
		expect(card).toBeGreaterThanOrEqual(0);
		expect(flat).toBeGreaterThan(card);
		expect(rulesFor(APP, `${SECTION} legend`)[0]?.decls.get('padding')).toBe('0');
	});

	it('drops the last hairline only when nothing shown follows the section', () => {
		const last = rulesFor(APP, `${SECTION}:not(:has(~ :not([hidden])))`);
		expect(last.length).toBe(1);
		expect(last[0].parents).toEqual(['@media screen']);
		expect(last[0].decls.get('border-bottom-width')).toBe('0');
	});

	it('never sets the fieldset\'s display, and keeps no layout\'s or app\'s own copy', () => {
		const flatRules = [...APP, ...cssRulesOf(VIEWER)].filter(
			(r) => r.parents.includes('@media screen') && r.selectors.some((s) => s.includes('fieldset.group')),
		);
		expect(flatRules.length).toBeGreaterThan(0);
		for (const r of flatRules) {
			expect(r.decls.has('display'), r.selectors.join(', ')).toBe(false);
			expect(r.selectors.some((s) => s.includes('mobile-ui')), r.selectors.join(', ')).toBe(false);
		}
		expect(cssRulesOf(VIEWER).filter((r) => r.selectors.some((s) => s.includes('fieldset.group')))).toEqual([]);
	});
});

describe('each carrier states the padding its sections bleed back over', () => {
	const CASES = [
		{ file: 'src/lib/components/Sidebar.svelte', base: '.panel-body', bleed: '.panel-body' },
		{ file: VIEWER, base: '.viewer-panel-body', bleed: '.viewer-panel-body', plain: true },
		{ file: 'src/lib/components/phone/PhonePages.svelte', base: '.page-body', bleed: '.page-body' },
		{ file: 'src/lib/components/HeadOverlay.svelte', base: '.sheet-body', bleed: '.sheet-body' },
		{ file: 'src/lib/components/OfflineModal.svelte', base: '.body', bleed: '.body' },
		{ file: 'src/lib/components/AircraftEditorModal.svelte', base: '.body', bleed: '.body' },
	];
	for (const c of CASES) {
		it(`${c.file.split('/').pop()}'s ${c.base} bleeds by its own inline padding, on screen only`, () => {
			const rules = cssRulesOf(c.file);
			const base = rulesFor(rules, c.base).find((r) => r.parents.length === 0 && r.decls.has('padding'));
			expect(base, `${c.base}'s padding`).toBeDefined();
			const bleed = rulesFor(rules, c.bleed).filter((r) => r.decls.has('--flat-bleed'));
			expect(bleed.length).toBe(1);
			expect(bleed[0].parents).toEqual(['@media screen']);
			expect(bleed[0].decls.get('--flat-bleed')).toBe(inline(base!.decls.get('padding')!));
		});
	}

	it('the desktop popup bleeds by its own 4 px and its panel\'s 8', () => {
		const rules = cssRulesOf('src/lib/components/PopupMenu.svelte');
		const own = px(rulesFor(rules, '.menu').find((r) => r.decls.has('padding'))?.decls.get('padding'));
		const panel = px(inline(rulesFor(rules, '.menu > :global(.popover-panel)')[0].decls.get('padding')!));
		const bleed = rulesFor(rules, '.menu').filter((r) => r.decls.has('--flat-bleed'));
		expect(bleed.length).toBe(1);
		expect(bleed[0].parents).toEqual(['@media screen']);
		expect(px(bleed[0].decls.get('--flat-bleed'))).toBe(own + panel);
	});

	it('a phone\'s Offline and viewer page pad 12 like every phone carrier, and bleed by it', () => {
		const offline = rulesFor(cssRulesOf('src/lib/components/OfflineModal.svelte'), ':global(:root.mobile-ui) .body').find((r) => r.decls.has('--flat-bleed'));
		const viewer = rulesFor(cssRulesOf(VIEWER), ':root.mobile-ui .viewer-panel.page .viewer-panel-body')[0];
		for (const r of [offline, viewer]) {
			expect(r?.parents).toEqual(['@media screen']);
			expect(r?.decls.get('padding-inline')).toBe('12px');
			expect(r?.decls.get('--flat-bleed')).toBe('12px');
		}
	});

	it('stacks Offline\'s sections on the tabs\' 12 px rhythm, its packs bleeding with them, on screen', () => {
		const rules = cssRulesOf('src/lib/components/OfflineModal.svelte');
		const body = rulesFor(rules, '.body').find((r) => r.parents.includes('@media screen') && r.decls.has('display'));
		expect(body?.decls.get('flex-direction')).toBe('column');
		expect(body?.decls.get('gap')).toBe('12px');
		const pack = rulesFor(rules, '.pack').find((r) => r.decls.has('margin-inline'));
		expect(pack?.parents).toEqual(['@media screen']);
		expect(pack?.decls.get('margin-inline')).toBe('calc(-1 * var(--flat-inset, 0px))');
		expect(pack?.decls.get('padding-inline')).toBe('var(--flat-inset, 0)');
		// After the row's own `padding: 8px 0`, which wins at the same weight
		// and put the rows' text flush against the box's edge.
		const own = rules.findIndex((r) => r.selectors.includes('.pack') && r.parents.length === 0 && r.decls.has('padding'));
		expect(own).toBeGreaterThanOrEqual(0);
		expect(rules.indexOf(pack!)).toBeGreaterThan(own);
	});

	it('runs the settings\' danger rule to the edges like the sections\' hairlines, on screen', () => {
		const zone = rulesFor(cssRulesOf('src/lib/components/tabs/SettingsTab.svelte'), '.danger-zone').find((r) => r.decls.has('margin-inline'));
		expect(zone?.parents).toEqual(['@media screen']);
		expect(zone?.decls.get('margin-inline')).toBe('calc(-1 * var(--flat-bleed, 0px))');
		expect(zone?.decls.get('padding-inline')).toBe('var(--flat-bleed, 0)');
	});

	it('sets the route apart from the Route tab\'s first section by a rule at the panel\'s level, on screen', () => {
		const route = cssRulesOf('src/lib/components/tabs/RouteTab.svelte');
		const rule = rulesFor(route, '.head-rule').find((r) => r.decls.has('border-top'));
		expect(rule?.parents).toEqual(['@media screen']);
		expect(rule?.decls.get('margin')).toBe('0 calc(-1 * var(--flat-bleed, 0px))');
		expect(rule?.decls.get('border-top')).toBe('1px solid var(--border)');
		// Off paper, where the sections keep their cards.
		expect(rulesFor(route, '.head-rule').find((r) => r.parents.length === 0)?.decls.get('display')).toBe('none');
		// Whichever block ends the route gives up its bottom margin above the
		// rule, which then sits the panel's gap under it, as a section's
		// hairline sits its padding under its rows.
		const flush = route.find((r) => r.selectors.includes('.summary:has(+ .head-rule)'));
		expect(flush?.parents).toEqual(['@media screen']);
		expect(flush?.selectors).toEqual(['.hint:has(+ .head-rule)', '.wp-list:has(+ .head-rule)', '.summary:has(+ .head-rule)']);
		expect(flush?.decls.get('margin-bottom')).toBe('0');
	});

	it('stands right before the Route tab\'s first section', () => {
		const ast = parse(src('src/lib/components/tabs/RouteTab.svelte'), { modern: true });
		const before = (nodes: Node[]): string | null => {
			for (let i = 0; i < nodes.length; i++) {
				if (isSection(nodes[i])) {
					const blocks = nodes.slice(0, i).filter((n) => ['RegularElement', 'IfBlock', 'EachBlock'].includes(n.type));
					const prev = blocks[blocks.length - 1];
					return prev?.type === 'RegularElement' ? `${prev.name}.${classOf(prev).join('.')}` : (prev?.type ?? null);
				}
				for (const k of [nodes[i].fragment?.nodes, nodes[i].nodes, nodes[i].body?.nodes].filter(Boolean) as Node[][]) {
					const found = before(k);
					if (found !== null) return found;
				}
			}
			return null;
		};
		expect(before(ast.fragment.nodes as unknown as Node[])).toBe('hr.head-rule');
	});
});

type Node = {
	type: string;
	name?: string;
	attributes?: { type: string; name?: string; value?: unknown }[];
	fragment?: { nodes: Node[] };
	nodes?: Node[];
	body?: { nodes: Node[] };
	expression?: unknown;
};

function classOf(n: Node): string[] {
	const attr = n.attributes?.find((a) => a.type === 'Attribute' && a.name === 'class');
	const value = attr?.value;
	if (!Array.isArray(value)) return [];
	return value
		.filter((v: { type: string }) => v.type === 'Text')
		.map((v: { data: string }) => v.data)
		.join(' ')
		.split(/\s+/)
		.filter(Boolean);
}

/** The class lists around every node `match` accepts, innermost last. */
function stacksOf(file: string, match: (n: Node) => boolean): string[][][] {
	const ast = parse(src(file), { modern: true });
	const found: string[][][] = [];
	const walk = (nodes: Node[], stack: string[][]): void => {
		for (const n of nodes) {
			if (match(n)) found.push(stack);
			const next = n.type === 'RegularElement' ? [...stack, classOf(n)] : stack;
			for (const k of [n.fragment?.nodes, n.nodes, n.body?.nodes].filter(Boolean) as Node[][]) walk(k, next);
			for (const key of ['consequent', 'alternate', 'fallback', 'pending', 'then', 'catch']) {
				const branch = (n as unknown as Record<string, { nodes?: Node[] } | null>)[key];
				if (branch?.nodes) walk(branch.nodes, next);
			}
		}
	};
	walk(ast.fragment.nodes, []);
	return found;
}

const isSection = (n: Node): boolean => n.type === 'RegularElement' && n.name === 'fieldset' && classOf(n).includes('group');
const carried = (stack: string[][]): boolean => stack.some((c) => c.some((k) => ['tab-panel', 'popover-panel', 'surface-panel'].includes(k)));

describe('the aircraft editor\'s cards are flat sections too', () => {
	const WORKBOOK = cssRulesOf('src/styles/workbook.css');
	const CARD = '.aircraft-editor-box .body .card';

	it('flattens every card on screen only, bleeding by the window\'s padding, after the card it overrides', () => {
		const flat = rulesFor(WORKBOOK, CARD).filter((r) => r.parents.length > 0);
		expect(flat.length).toBe(1);
		expect(flat[0].parents).toEqual(['@media screen']);
		expect([...flat[0].decls]).toEqual([
			['margin-inline', 'calc(-1 * var(--flat-bleed, 0px))'],
			['padding-inline', 'var(--flat-bleed, 0)'],
			['border-width', '0 0 1px'],
			['border-radius', '0'],
		]);
		const card = WORKBOOK.findIndex((r) => r.selectors.includes(CARD) && r.parents.length === 0);
		expect(card).toBeGreaterThanOrEqual(0);
		expect(WORKBOOK.indexOf(flat[0])).toBeGreaterThan(card);
		const last = rulesFor(WORKBOOK, `${CARD}:not(:has(~ .card))`);
		expect(last.map((r) => [r.parents, r.decls.get('border-bottom-width')])).toEqual([[['@media screen'], '0']]);
		// One rule for both layouts: the phone's own copy is gone.
		expect(WORKBOOK.some((r) => r.selectors.some((x) => x.includes(':root.mobile-ui .aircraft-editor-box')))).toBe(false);
	});

	it('keeps the M&B columns\' cards to their column while the two sit side by side', () => {
		const page = cssRulesOf('src/lib/components/aircrafteditor/MassBalanceEditPage.svelte');
		const col = rulesFor(page, '.col').find((r) => r.parents.length === 0)!;
		const cols = rulesFor(page, '.cols').find((r) => r.parents.length === 0)!;
		// Two flex bases and the gap: the width from which the columns share a line.
		const basis = px(col.decls.get('flex')!.split(' ')[2]);
		const side = 2 * basis + px(cols.decls.get('gap'));
		const beside = rulesFor(page, '.col > .card');
		expect(beside.map((r) => r.parents)).toEqual([['@media screen', `@container (width >= ${side}px)`]]);
		expect(Object.fromEntries(beside[0].decls)).toEqual({ 'margin-inline': '0', 'padding-inline': '0' });
		const stacked = rulesFor(page, '.col:not(:last-child) > .card:last-child');
		expect(stacked.map((r) => r.parents)).toEqual([['@media screen', `@container (width < ${side}px)`]]);
		expect(stacked[0].decls.get('border-bottom-width')).toBe('1px');
	});
});

describe('every section sits inside a carrier', () => {
	const OWN = [
		'src/lib/components/tabs/LayersTab.svelte',
		'src/lib/components/tabs/NavigationTab.svelte',
		'src/lib/components/tabs/RouteTab.svelte',
		'src/lib/components/tabs/SettingsTab.svelte',
		'src/lib/components/tabs/WeatherTab.svelte',
		'src/lib/components/FiltersPopover.svelte',
		'src/lib/components/ViewConditionsPopover.svelte',
		'src/lib/components/flightprep/OnBoardForm.svelte',
		'src/lib/components/OfflineModal.svelte',
		'src/lib/components/phone/PhonePages.svelte',
		'src/lib/components/phone/NearestAerodromes.svelte',
		'src/lib/components/phone/SupAipList.svelte',
		'src/notam/LayersPopover.svelte',
		'src/notam/SettingsPopover.svelte',
	];
	for (const file of OWN) {
		it(`${file.split('/').pop()}'s sections`, () => {
			const stacks = stacksOf(file, isSection);
			expect(stacks.length).toBeGreaterThan(0);
			for (const s of stacks) expect(carried(s), file).toBe(true);
		});
	}

	it('the NOTAM loaders\' sections, through the tab that renders them', () => {
		for (const file of ['src/lib/components/NotamLoader.svelte', 'src/notam/BriefingLoader.svelte']) {
			expect(stacksOf(file, isSection).length, file).toBeGreaterThan(0);
		}
		const renders = stacksOf('src/lib/components/tabs/NotamsTab.svelte', (n) => n.type === 'RenderTag' && (n.expression as { callee?: { name?: string } } | undefined)?.callee?.name === 'loader');
		expect(renders.length).toBeGreaterThan(0);
		for (const s of renders) expect(carried(s)).toBe(true);
	});
});

describe('what the flat sections take with them', () => {
	it('the barb legend\'s canvas keeps the card\'s width on screen, so its bitmap fits the card on paper', () => {
		const rules = cssRulesOf('src/lib/components/tabs/WeatherTab.svelte');
		// The draw lays five samples out at a 52 px pitch from a 4 px margin.
		const draw = src('src/lib/components/tabs/WeatherTab.svelte');
		expect(draw).toContain('const pitch = Math.min(52, (w - 4) / samples.length);');
		const base = rulesFor(rules, '.legend').find((r) => r.parents.length === 0);
		expect(px(base?.decls.get('max-inline-size'))).toBe(5 * 52 + 4);
		const card = APP.find((r) => r.selectors.includes('.tab-panel fieldset.group') && r.parents.length === 0)!;
		const cardInline = 2 * (px(inline(card.decls.get('padding')!)) + px(card.decls.get('border')));
		const screen = rulesFor(rules, '.legend').find((r) => r.parents.includes('@media screen'));
		expect(screen?.decls.get('inline-size')).toBe(`calc(100% - ${cardInline}px)`);
	});

	it('the desktop tab title is a title, on screen only', () => {
		const title = rulesFor(APP, ':root:not(.mobile-ui) .tab-panel h2');
		expect(title.length).toBe(1);
		expect(title[0].parents).toEqual(['@media screen']);
		expect(title[0].decls.get('text-transform')).toBe('none');
		expect(title[0].decls.get('color')).toBe('var(--text)');
	});

	it('the account dialog\'s re-auth step is a tonal block on screen, its stroke on paper', () => {
		const rules = rulesFor(cssRulesOf('src/lib/components/AccountModal.svelte'), '.acc-sudo');
		expect(rules.find((r) => r.parents.length === 0)?.decls.get('border')).toBe('1px solid var(--border)');
		const screen = rules.find((r) => r.parents.includes('@media screen'));
		expect(screen?.decls.get('border-color')).toBe('transparent');
		expect(screen?.decls.get('background')).toBe('var(--surface-2)');
	});
});
