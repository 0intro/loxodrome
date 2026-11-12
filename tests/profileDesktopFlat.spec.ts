/* The vertical profiles on the desktop (docs/route-profile.md "Desktop: flat",
 * docs/map-profile.md): the dock is the frame, so the chart runs to its edges,
 * the axes stay in the chart's own gutters, and the sliders take their quiet
 * form; the column profile's floor follows the pointer. What a type checker
 * cannot see: every rule is screen-only and steps aside while the surface
 * prints (a print lays the box out before the paper does, so the paper keeps
 * the box it has always measured), and the quiet form never reaches a finger.
 * Components are read through the compiler's own parser (the phoneSurfaces /
 * surfaceMounts precedent). */

import { readFileSync } from 'node:fs';
import { parse } from 'svelte/compiler';
import { describe, expect, it } from 'vitest';
import { COLUMN_MAX_PX, COLUMN_MIN_MOUSE_PX, COLUMN_MIN_PX, columnWidthPx } from '$lib/components/verticalProfile';

import { cssRulesOf } from './helpers/cssRules';

const src = (file: string): string => readFileSync(file, 'utf8');

type Node = { type: string; name?: string; attributes?: { type: string; name?: string; value?: unknown; start: number; end: number }[]; fragment?: { nodes: Node[] }; nodes?: Node[] };

/** Every element or component named `name` in a template, with its attributes'
 *  source text by name. */
function elements(file: string, name: string): Map<string, string>[] {
	const text = src(file);
	const ast = parse(text, { modern: true });
	const found: Map<string, string>[] = [];
	const walk = (nodes: Node[]): void => {
		for (const n of nodes) {
			if ((n.type === 'Component' || n.type === 'RegularElement') && n.name === name) {
				found.push(new Map((n.attributes ?? []).filter((a) => a.name).map((a) => [a.name!, text.slice(a.start, a.end)])));
			}
			const kids = [n.fragment?.nodes, n.nodes].filter(Boolean) as Node[][];
			for (const k of kids) {
				walk(k);
			}
			for (const key of ['consequent', 'alternate', 'fallback', 'pending', 'then', 'catch', 'body']) {
				const branch = (n as unknown as Record<string, { nodes?: Node[] } | null>)[key];
				if (branch?.nodes) {
					walk(branch.nodes);
				}
			}
		}
	};
	walk(ast.fragment.nodes);
	return found;
}

const PROFILES = [
	'src/lib/components/RouteProfileModal.svelte',
	'src/lib/components/NavProfileModal.svelte',
	'src/lib/components/VerticalProfileModal.svelte',
];

describe('the desktop profiles are flat, on screen only, never while printing', () => {
	for (const file of PROFILES) {
		const name = file.split('/').pop();

		it(`${name}'s body is flat off the strip and off a print`, () => {
			const bodies = elements(file, 'div').filter((a) => (a.get('class') ?? '').includes('"body"'));
			expect(bodies.length).toBe(1);
			// A class directive is named by its class: `flat` here.
			expect(bodies[0].get('flat')).toBe('class:flat={!compact && !printing}');
		});

		it(`${name}'s flat rules are screen-only`, () => {
			const flat = cssRulesOf(file).filter((r) => r.selectors.some((s) => s.includes('.body.flat')));
			expect(flat.length).toBeGreaterThan(0);
			for (const r of flat) {
				expect(r.parents, r.selectors.join(', ')).toEqual(['@media screen']);
			}
			const pad = flat.find((r) => r.selectors.includes('.body.flat') && r.decls.has('padding'));
			expect(pad?.decls.get('padding')).toBe('0');
		});

		it(`${name}'s sliders are quiet except while printing`, () => {
			const sliders = elements(file, 'RangeSlider');
			expect(sliders.length).toBeGreaterThan(0);
			for (const s of sliders) {
				expect(s.get('slim')).toBe('slim={!printing}');
			}
		});
	}
});

describe('the quiet slider never reaches a finger', () => {
	it('keeps every slim rule behind :root:not(.touch-ui)', () => {
		const rules = cssRulesOf('src/lib/components/RangeSlider.svelte').filter((r) => r.selectors.some((s) => s.includes('.slim')));
		expect(rules.length).toBeGreaterThan(0);
		for (const r of rules) {
			for (const s of r.selectors) {
				expect(s.startsWith(':global(:root:not(.touch-ui))'), s).toBe(true);
			}
		}
		const rail = rules.find((r) => r.selectors.includes(':global(:root:not(.touch-ui)) .rslider.vertical.slim'));
		expect(rail?.decls.get('width')).toBe('12px');
	});

	it('fits its handles inside the rail, smaller than the full control\'s', () => {
		const rules = cssRulesOf('src/lib/components/RangeSlider.svelte');
		const px = (sel: string, prop: string): number => {
			const r = rules.find((x) => x.selectors.includes(sel) && x.decls.has(prop));
			expect(r, `${sel} { ${prop} }`).toBeDefined();
			return parseFloat(r!.decls.get(prop)!);
		};
		const q = ':global(:root:not(.touch-ui))';
		// Across the rail: no wider than it.
		expect(px(`${q} .vertical.slim .handle`, 'width')).toBeLessThanOrEqual(px(`${q} .rslider.vertical.slim`, 'width'));
		expect(px(`${q} .horizontal.slim .handle`, 'height')).toBeLessThanOrEqual(px(`${q} .rslider.horizontal.slim`, 'height'));
		// Along it: shorter than the full control's handle.
		expect(px(`${q} .vertical.slim .handle`, 'height')).toBeLessThan(px('.vertical .handle', 'height'));
		expect(px(`${q} .horizontal.slim .handle`, 'width')).toBeLessThan(px('.horizontal .handle', 'width'));
	});
});

describe('the column floor follows the pointer', () => {
	it('lets a mouse take 12 px columns, a finger 22', () => {
		expect(COLUMN_MIN_MOUSE_PX).toBe(12);
		expect(columnWidthPx(30, 366, COLUMN_MIN_MOUSE_PX)).toBe(12);
		expect(columnWidthPx(30, 366)).toBe(COLUMN_MIN_PX);
		expect(columnWidthPx(1, 366, COLUMN_MIN_MOUSE_PX)).toBe(COLUMN_MAX_PX);
	});

	it('is a finger\'s on the phone, under touch-ui and on paper', () => {
		expect(src('src/lib/components/VerticalProfileModal.svelte')).toContain(
			'const colFloor = $derived(compact || ui.touchUi || printing ? COLUMN_MIN_PX : COLUMN_MIN_MOUSE_PX);',
		);
	});

	it('reads touch-ui from the same criterion each app stamps the class with', () => {
		expect(src('src/App.svelte')).toMatch(/ui\.touchUi = touch;\s*document\.documentElement\.classList\.toggle\('touch-ui', touch\);/);
		expect(src('src/notam/App.svelte')).toMatch(/ui\.touchUi = coarse\.matches;\s*document\.documentElement\.classList\.toggle\('touch-ui', coarse\.matches\);/);
	});
});
