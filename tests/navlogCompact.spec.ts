/* The phone's nav log, edge to edge in its pane like the profile strip
 * (NavLogSheet's `compact` prop; docs/nav-ux-review.md finding 24): the
 * cross-file agreements a type checker cannot see, and the class gates that
 * keep the rendition off paper.
 *
 * The Waypoint track is sized off the pane, `calc(100cqi - 246px)`, so that
 * 246 must be the six numeric tracks' sum, or the visible part of the sheet
 * stops short of the Waypoint column's right border or cuts into it; the
 * track's floor plus that sum is the registry's phoneMinWidthPx; the pane
 * wide enough for the whole sheet is the sum plus the two prose columns'
 * minimums. Every compact rule sits inside @media screen: the class stays
 * mounted while a phone prints the live surface, and .sheet.compact
 * out-specifies the print block. The CSS is read through the compiler's own
 * parser (the surfaceMounts.spec.ts precedent): a string scan would trip on
 * the block's own header comment, which names the class outside the block. */

import { render } from 'svelte/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { surfaceDef } from '$lib/surfaces';

import { cssRulesOf, type CssRule } from './helpers/cssRules';
import { installLeafletNode } from './helpers/leafletNode';

vi.mock('$lib/weather/openMeteo', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/weather/openMeteo')>();
	return {
		...actual,
		// No forecast is ever fetched here: a departure past the endpoint's
		// range is refused before any request is made.
		fetchWindColumns: () => Promise.reject(new Error('no forecast is fetched in this spec')),
		// The run metadata is never asked of the network from a spec.
		fetchModelRun: () => Promise.resolve(null),
	};
});

// The sheet's import graph reaches the map layers, which extend Leaflet's
// classes as they load: real Leaflet, over the few browser properties it
// reads at import.
installLeafletNode();
const { default: NavLogSheet } = await import('$lib/components/NavLogSheet.svelte');
const { default: NavLogSchedule } = await import('$lib/components/NavLogSchedule.svelte');
const { flightPrep } = await import('$lib/state/flightPrep.svelte');
const { ensureRouteWindFor, pruneRouteWind } = await import('$lib/state/routeWind.svelte');

type Route = import('$lib/state/route.svelte').Route;

/** The one rule with exactly this selector list inside exactly these at-rules. */
function ruleAt(rules: CssRule[], selector: string, parents: string[]): CssRule {
	const found = rules.filter((r) => r.selectors.join(', ') === selector && r.parents.join(' ') === parents.join(' '));
	expect(found, `${parents.join(' ')} { ${selector} }`).toHaveLength(1);
	return found[0];
}

/** A grid track list split at its top-level spaces (a `max(...)` or
 *  `minmax(...)` track keeps its own). */
function tracks(value: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let cur = '';
	for (const ch of value) {
		depth += ch === '(' ? 1 : ch === ')' ? -1 : 0;
		if (ch === ' ' && depth === 0) {
			if (cur !== '') {
				out.push(cur);
			}
			cur = '';
		} else {
			cur += ch;
		}
	}
	if (cur !== '') {
		out.push(cur);
	}
	return out;
}

const px = (track: string): number => {
	const m = /^(\d+)px$/.exec(track);
	expect(m, `${track} is not a plain px track`).not.toBeNull();
	return Number(m![1]);
};

const SCREEN = ['@media screen'];
const sheetRules = cssRulesOf('src/lib/components/NavLogSheet.svelte');
const schedRules = cssRulesOf('src/lib/components/NavLogSchedule.svelte');
const modalRules = cssRulesOf('src/lib/components/NavLogModal.svelte');

describe('the compact rendition stays on screen', () => {
	it('keeps every compact rule inside @media screen', () => {
		for (const [rules, cls] of [
			[sheetRules, '.sheet.compact'],
			[schedRules, '.sched.compact'],
		] as const) {
			const compact = rules.filter((r) => r.selectors.some((s) => s.includes(cls)));
			// Not vacuous: the block is there to be checked.
			expect(compact.length).toBeGreaterThan(0);
			for (const r of compact) {
				expect(r.parents[0], `${r.selectors.join(', ')}`).toBe('@media screen');
			}
		}
		// The container the sheet queries is declared on screen only too:
		// containment must never touch the print flow.
		for (const r of sheetRules.filter((x) => x.decls.has('container') || x.decls.has('container-type'))) {
			expect(r.parents[0]).toBe('@media screen');
		}
	});
});

/** The compact grid's own rule (the pane narrower than the whole sheet) and
 *  its tracks: six numeric, Waypoint, Notes. */
function panRule(): { pan: CssRule; panTracks: string[]; numeric: number[]; sum: number } {
	const pan = ruleAt(sheetRules, '.sheet.compact .navlog', SCREEN);
	const panTracks = tracks(pan.decls.get('grid-template-columns') ?? '');
	const numeric = panTracks.slice(0, 6).map(px);
	return { pan, panTracks, numeric, sum: numeric.reduce((a, b) => a + b, 0) };
}

describe('the Waypoint column takes the pane', () => {
	it('queries its own pane, never the viewport', () => {
		expect(ruleAt(sheetRules, '.sheet.compact .scroll', SCREEN).decls.get('container')).toBe(
			'navlog-pane / inline-size',
		);
	});

	it('ends the visible part on the Waypoint column border: the pane less the six numeric tracks', () => {
		const { pan, panTracks, sum } = panRule();
		expect(panTracks).toHaveLength(8);
		const m = /^max\((\d+)px, calc\(100cqi - (\d+)px\)\)$/.exec(panTracks[6]);
		expect(m, panTracks[6]).not.toBeNull();
		expect(Number(m![2])).toBe(sum);
		// The registry docks the log on a phone by the narrowest sheet that
		// still ends on that border: the numeric tracks and the floor.
		expect(surfaceDef('navlog').phoneMinWidthPx).toBe(sum + Number(m![1]));
		// Notes pans beyond the pane at its own width.
		expect(px(panTracks[7])).toBeGreaterThan(0);
		// The grid stays as wide as its tracks while Notes overflows the pane.
		expect(pan.decls.get('min-width')).toBe('max-content');
	});

	it('shows the whole sheet, nothing to pan, once the pane holds both prose columns', () => {
		const { pan, panTracks, numeric, sum } = panRule();
		const share = sheetRules.filter(
			(r) => r.selectors.join(', ') === '.sheet.compact .navlog' && r.parents[0] === '@media screen' && r.parents.length === 2,
		);
		expect(share).toHaveLength(1);
		const at = /^@container navlog-pane \(min-width: (\d+)px\)$/.exec(share[0].parents[1]);
		expect(at, share[0].parents[1]).not.toBeNull();
		const shareTracks = tracks(share[0].decls.get('grid-template-columns') ?? '');
		expect(shareTracks.slice(0, 6).map(px)).toEqual(numeric);
		const wp = /^minmax\((\d+)px, 1fr\)$/.exec(shareTracks[6]);
		const notes = /^minmax\((\d+)px, 1fr\)$/.exec(shareTracks[7]);
		expect(wp, shareTracks[6]).not.toBeNull();
		expect(notes, shareTracks[7]).not.toBeNull();
		expect(Number(at![1])).toBe(sum + Number(wp![1]) + Number(notes![1]));
		// Notes keeps the width it pans at.
		expect(Number(notes![1])).toBe(px(panTracks[7]));
		// No max-content floor bringing the pan back.
		expect(share[0].decls.get('min-width')).toBe('0');
		// Same specificity as the pan rule, so it must come after it.
		expect(sheetRules.indexOf(share[0])).toBeGreaterThan(sheetRules.indexOf(pan));
	});

	it('draws no outer frame where the sheet meets the screen', () => {
		const { pan } = panRule();
		expect(pan.decls.get('border-top')).toBe('0');
		expect(pan.decls.get('border-left')).toBe('0');
		expect(ruleAt(sheetRules, '.sheet.compact .wcell, .sheet.compact .hcell.edge', SCREEN).decls.get('border-right-width')).toBe(
			'0',
		);
	});

	it('gives the phone body no padding, the empty state its own inset', () => {
		expect(ruleAt(modalRules, ':global(:root.mobile-ui) .body', []).decls.get('padding')).toBe('0');
		expect(ruleAt(modalRules, ':global(:root.mobile-ui) .body > .muted', SCREEN).decls.get('padding')).toBe('12px 8px');
	});
});

function route(): Route {
	return {
		id: 'navlog-compact',
		name: null,
		selectedWaypointId: null,
		waypoints: [47, 47.5, 48].map((lat, i) => ({
			id: `navlog-compact-${i}`,
			lat,
			lon: 2,
			kind: 'free' as const,
			alt: 3000,
			altAuto: true,
		})),
	};
}

/** The class list of the first element opening with this tag and class. */
function classesOf(html: string, tag: string, cls: string): string[] {
	const m = new RegExp(`<${tag} class="(${cls}(?: [^"]*)?)"`).exec(html);
	expect(m, `<${tag} class="${cls} ...">`).not.toBeNull();
	return m![1].split(/\s+/);
}

afterEach(() => {
	pruneRouteWind([]);
	flightPrep.dossier.flightDate = null;
	flightPrep.dossier.departureTime = null;
});

describe('the class gates keep paper out of it', () => {
	it('makes the sheet compact only on the interactive mount', () => {
		const r = route();
		const sheet = (props: Record<string, unknown>): string[] =>
			classesOf(render(NavLogSheet, { props: { route: r, ...props } }).body, 'div', 'sheet');
		expect(sheet({ interactive: true, compact: true })).toContain('compact');
		expect(sheet({ interactive: true })).not.toContain('compact');
		// The measuring and print mounts are never interactive, and a
		// kneeboard card never compact, whatever they are passed.
		expect(sheet({ compact: true })).not.toContain('compact');
		expect(sheet({ interactive: true, compact: true, kneeboard: true })).not.toContain('compact');
	});

	it('makes the schedule compact only off paper', () => {
		const r = route();
		const sched = (props: Record<string, unknown>): string[] =>
			classesOf(render(NavLogSchedule, { props: { route: r, ...props } }).body, 'section', 'sched');
		expect(sched({ compact: true })).toContain('compact');
		expect(sched({})).not.toContain('compact');
		expect(sched({ compact: true, kneeboard: true })).not.toContain('compact');
		expect(sched({ compact: true, portrait: true })).not.toContain('compact');
	});

	it('marks the title line only while it carries a warning', async () => {
		const r = route();
		const title = (): string[] =>
			classesOf(render(NavLogSheet, { props: { route: r, interactive: true, compact: true } }).body, 'div', 'title-line');
		expect(title()).not.toContain('has-warn');
		// A departure past the endpoint's 15-day range: refused before any
		// request, and said on the sheet.
		flightPrep.dossier.flightDate = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
		flightPrep.dossier.departureTime = '10:00';
		await ensureRouteWindFor(r);
		const html = render(NavLogSheet, { props: { route: r, interactive: true, compact: true } }).body;
		expect(classesOf(html, 'div', 'title-line')).toContain('has-warn');
		expect(html).toContain('Departure beyond the 15-day forecast range');
	});
});
