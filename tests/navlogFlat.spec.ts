/* The desktop reads the nav log FLAT (docs/workspace-surfaces.md "A section
 * is flat"): the surface's box is the sheet's frame, so the modal body gives
 * up its 16 px, the grid drops its own left and right edges where it meets
 * the box (keeping its top rule and the total row's), and the text outside
 * the grid insets itself by 12 px. What a type checker cannot see: the class
 * gates keep every print and measuring mount out (they are never interactive,
 * the kneeboard and A4 renditions refuse it, the phone's compact grid wins),
 * and every rule is screen-only. The compact twin: tests/navlogCompact.spec.ts. */

import { readFileSync } from 'node:fs';
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';

import { cssRulesOf, type CssRule } from './helpers/cssRules';
import { installLeafletNode } from './helpers/leafletNode';

vi.mock('$lib/weather/openMeteo', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/weather/openMeteo')>();
	return {
		...actual,
		fetchWindColumns: () => Promise.reject(new Error('no forecast is fetched in this spec')),
		fetchModelRun: () => Promise.resolve(null),
	};
});

installLeafletNode();
const { default: NavLogSheet } = await import('$lib/components/NavLogSheet.svelte');
const { default: NavLogSchedule } = await import('$lib/components/NavLogSchedule.svelte');

type Route = import('$lib/state/route.svelte').Route;

function classesOf(html: string, tag: string, cls: string): string[] {
	const m = new RegExp(`<${tag} class="(${cls}(?: [^"]*)?)"`).exec(html);
	expect(m, `<${tag} class="${cls} ...">`).not.toBeNull();
	return m![1].split(/\s+/);
}

function route(): Route {
	return {
		id: 'navlog-flat',
		name: null,
		selectedWaypointId: null,
		waypoints: [47, 47.5, 48].map((lat, i) => ({
			id: `navlog-flat-${i}`,
			lat,
			lon: 2,
			kind: 'free' as const,
			alt: 3000,
			altAuto: true,
		})),
	};
}

const SHEET = 'src/lib/components/NavLogSheet.svelte';
const SCHED = 'src/lib/components/NavLogSchedule.svelte';
const MODAL = 'src/lib/components/NavLogModal.svelte';

describe('the class gates keep paper out of the flat log', () => {
	it('makes the sheet flat only on the interactive desktop mount', () => {
		const r = route();
		const sheet = (props: Record<string, unknown>): string[] =>
			classesOf(render(NavLogSheet, { props: { route: r, ...props } }).body, 'div', 'sheet');
		expect(sheet({ interactive: true, flat: true })).toContain('flat');
		expect(sheet({ interactive: true })).not.toContain('flat');
		expect(sheet({ flat: true })).not.toContain('flat');
		expect(sheet({ interactive: true, flat: true, kneeboard: true })).not.toContain('flat');
		expect(sheet({ interactive: true, flat: true, portrait: true })).not.toContain('flat');
		const both = sheet({ interactive: true, flat: true, compact: true });
		expect(both).toContain('compact');
		expect(both).not.toContain('flat');
	});

	it('makes the schedule flat only off paper and off the phone', () => {
		const r = route();
		const sched = (props: Record<string, unknown>): string[] =>
			classesOf(render(NavLogSchedule, { props: { route: r, ...props } }).body, 'section', 'sched');
		expect(sched({ flat: true })).toContain('flat');
		expect(sched({})).not.toContain('flat');
		expect(sched({ flat: true, kneeboard: true })).not.toContain('flat');
		expect(sched({ flat: true, portrait: true })).not.toContain('flat');
		expect(sched({ flat: true, compact: true })).not.toContain('flat');
	});

	it('passes flat from the modal\'s interactive mounts alone, its body following', () => {
		const src = readFileSync(MODAL, 'utf8');
		expect(src).toContain('<div class="body" class:flat={!ui.isMobile}>');
		expect(src.match(/(?<!:)\bflat=\{!ui\.isMobile\}/g)?.length).toBe(2);
		expect(readFileSync('src/lib/components/flightprep/PrintDoc.svelte', 'utf8')).not.toMatch(/\bflat=/);
		const body = cssRulesOf(MODAL).filter((r) => r.selectors.includes('.body.flat'));
		expect(body.length).toBe(1);
		expect(body[0].parents).toEqual(['@media screen']);
		expect(body[0].decls.get('padding')).toBe('0');
	});
});

describe('the box is the frame, on screen only', () => {
	it('drops the grid\'s side edges, keeps its top rule, insets the title line', () => {
		const rules = cssRulesOf(SHEET).filter((r) => r.selectors.some((s) => s.startsWith('.sheet.flat')));
		expect(rules.length).toBeGreaterThan(0);
		for (const r of rules) {
			expect(r.parents[0], r.selectors.join(', ')).toBe('@media screen');
			expect(r.decls.has('border-top'), r.selectors.join(', ')).toBe(false);
		}
		const at = (sel: string): CssRule => rules.find((r) => r.selectors.includes(sel))!;
		expect(at('.sheet.flat .navlog').decls.get('border-left')).toBe('0');
		expect(at('.sheet.flat .wcell').selectors).toContain('.sheet.flat .hcell.edge');
		expect(at('.sheet.flat .wcell').decls.get('border-right-width')).toBe('0');
		expect(at('.sheet.flat .title-line').decls.get('margin')).toBe('0');
		expect(at('.sheet.flat .title-line').decls.get('padding')).toBe('10px 12px 8px');
	});

	it('insets the schedule\'s heading, notes and outer cells by the same 12 px', () => {
		const rules = cssRulesOf(SCHED).filter((r) => r.selectors.some((s) => s.startsWith('.sched.flat')));
		expect(rules.length).toBeGreaterThan(0);
		for (const r of rules) expect(r.parents[0], r.selectors.join(', ')).toBe('@media screen');
		const at = (sel: string): CssRule => rules.find((r) => r.selectors.includes(sel))!;
		expect(at('.sched.flat h3').decls.get('padding-inline')).toBe('12px');
		expect(at('.sched.flat .nav :is(th, td):first-child').decls.get('padding-left')).toBe('12px');
		expect(at('.sched.flat .nav :is(th, td):last-child').decls.get('padding-right')).toBe('12px');
	});
});
