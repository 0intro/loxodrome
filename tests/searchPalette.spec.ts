/* The palette's pieces on the search engine: NOTAMs, actions, and the order
 * of the groups (src/lib/search/notams.ts, actions.ts, combine.ts). */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import type { IndexedNotam } from '$lib/state/notam.svelte';
import { rankNotams } from '$lib/search/notams';
import { rankActions } from '$lib/search/actions';
import { orderGroups } from '$lib/search/combine';
import { prepareQuery } from '$lib/search/query';
import { CLASS, type Hit, type Ranked } from '$lib/search/rank';
import { TIER } from '$lib/search/match';
import { rankAirports } from '$lib/search/airports';
import { rankNavaids } from '$lib/search/navaids';
import { rankPlaces } from '$lib/search/places';
import type { Airport } from '$lib/data/airports';
import type { Navaid } from '$lib/data/navaids';
import type { Place } from '$lib/data/places';

function notam(index: number, id: string, codes: string[]): IndexedNotam {
	return { index, notam: { id, icaoCodes: codes } } as unknown as IndexedNotam;
}

describe('rankNotams', () => {
	const items = [
		notam(0, 'B1234/26', ['LFPN']),
		notam(1, 'A0042/26', ['LFPG', 'LFPO']),
		notam(2, 'A0042/26', ['LFPG', 'LFPO']),
		notam(3, 'A0420/26', ['LFOX']),
	];
	const ids = (q: string): string[] => rankNotams(items, prepareQuery(q), 6).hits.map((h) => `${h.item.notam.id}@${h.item.index}`);

	it('finds a NOTAM by its id before its locations, one row per NOTAM', () => {
		expect(ids('A0042/26')).toEqual(['A0042/26@1']);
		expect(ids('a004')).toEqual(['A0042/26@1']);
		expect(ids('A0')).toEqual(['A0042/26@1', 'A0420/26@3']);
	});

	it('finds one by an A) location, exact before prefix', () => {
		expect(ids('LFPO')).toEqual(['A0042/26@1']);
		expect(ids('LFP')).toEqual(['B1234/26@0', 'A0042/26@1']);
	});

	it('is empty for an empty query', () => {
		expect(ids(' ')).toEqual([]);
	});

	it('finds a NOTAM by its own number under a location prefix', () => {
		// The parser labels the second of two NOTAMs sharing a number with
		// its location (LOWS-A0958/26), and a pasted SOFIA bulletin keeps its
		// header prefix in every id (LPPP-A6117/25). Typed bare, the number
		// found neither.
		const labelled = [
			notam(0, 'A0958/26', ['LFSB']),
			notam(1, 'LOWS-A0958/26', ['LOWS']),
			notam(2, 'LPPP-A6117/25', ['LPPT']),
		];
		const find = (q: string): string[] =>
			rankNotams(labelled, prepareQuery(q), 6).hits.map((h) => `${h.item.notam.id}@${h.item.index}`);
		expect(find('A0958/26')).toEqual(['A0958/26@0', 'LOWS-A0958/26@1']);
		expect(find('a0958')).toEqual(['A0958/26@0', 'LOWS-A0958/26@1']);
		expect(find('A6117')).toEqual(['LPPP-A6117/25@2']);
		expect(find('LOWS-A0958/26')).toEqual(['LOWS-A0958/26@1']);
	});

	it('finds the NOTAMs outside the period, after the period’s own at the same match', () => {
		// The NOTAMs tab lists them under Outside the period, still
		// selectable. Under a 6 h look-ahead the palette ranked the period's
		// NOTAMs alone, so a number read off that list answered No matches.
		const inside = [notam(5, 'A0105/26', ['LFPO'])];
		const outside = [notam(1, 'A0101/26', ['LFPO']), notam(2, 'B0100/26', ['LFPG'])];
		const find = (q: string): string[] =>
			rankNotams(inside, prepareQuery(q), 6, outside).hits.map((h) => `${h.item.notam.id}@${h.item.index}`);
		expect(find('B0100/26')).toEqual(['B0100/26@2']);
		expect(find('lfpg')).toEqual(['B0100/26@2']);
		// Earlier in the briefing, the lapsed one still comes second.
		expect(find('LFPO')).toEqual(['A0105/26@5', 'A0101/26@1']);
		expect(find('A010')).toEqual(['A0105/26@5', 'A0101/26@1']);
	});

	it('is handed both halves of the window by the palette', () => {
		const src = readFileSync('src/lib/components/SearchPalette.svelte', 'utf8');
		expect(src).toContain('const outsideNotams = $derived(outOfWindowNotams());');
		expect(src).toContain('rankNotams(visibleNotams(), q, GROUP_CAP, outsideNotams)');
	});
});

describe('rankActions', () => {
	const actions = [
		{ id: 'navlog', label: 'Navigation log', state: '' },
		{ id: 'chart-fr500', label: 'France 1:500,000', state: 'Chart hidden' },
		{ id: 'chart-de500', label: 'Germany 1:500,000', state: 'Chart shown' },
	];
	const ids = (q: string): string[] => rankActions(actions, prepareQuery(q), 6).hits.map((h) => h.item.id);

	it('matches the label, and the state word beside it, in registry order', () => {
		expect(ids('nav')).toEqual(['navlog']);
		expect(ids('chart')).toEqual(['chart-fr500', 'chart-de500']);
		expect(ids('germ')).toEqual(['chart-de500']);
		expect(ids('xyz')).toEqual([]);
	});
});

function ranked(...hits: Partial<Hit<string>>[]): Ranked<unknown> {
	return {
		hits: hits.map((h) => ({ item: 'x', tier: TIER.NAME_PREFIX, cls: CLASS.OPEN, dist: 0, kind: 0, order: '', ...h })),
		total: hits.length,
	};
}

describe('orderGroups', () => {
	it('leads with the group whose first row is the best answer', () => {
		// "ABB": Asaba matches by its IATA code, the Abbeville navaid by its ident.
		const airports = { id: 'airports', ranked: ranked({ tier: TIER.ALT_IDENT_EXACT, dist: 5.2e6 }) };
		const navaids = { id: 'navaids', ranked: ranked({ tier: TIER.IDENT_EXACT, dist: 1.4e5, kind: 1 }) };
		expect(orderGroups([airports, navaids]).map((g) => g.id)).toEqual(['navaids', 'airports']);
	});

	it('leads with a town typed whole, before a waypoint whose ident it begins', () => {
		const town = (name: string, lat: number, lon: number, pop: number): Place => ({
			id: `fr:${name}`, country: 'FR', name, lat, lon, pop, admin: '', alt: '', commune: true,
		});
		const waypoint = (ident: string, lat: number, lon: number): Navaid =>
			({ id: ident, ident, name: '', type: 'WAYPOINT', lat, lon }) as unknown as Navaid;
		const cases = [
			{ q: 'Roma', place: town('Roma', 41.89, 12.48, 2318895), nav: waypoint('ROMAK', 44.6, 2.5), ad: null },
			{ q: 'Gap', place: town('Gap', 44.56, 6.08, 41293), nav: waypoint('GAPLA', 50.5, 8.9), ad: null },
			// The field the town names ranks by its name, under the waypoint
			// its ident begins: only the whole name moved up.
			{
				q: 'Agen',
				place: town('Agen', 44.2, 0.62, 32801),
				nav: waypoint('AGENO', 44.6, 1.1),
				ad: { ident: 'LFBA', iata: 'AGF', name: 'AGEN LA GARENNE', city: 'AGEN', lat: 44.17, lon: 0.59, type: 'medium_airport' } as Airport,
			},
		];
		for (const c of cases) {
			const q = prepareQuery(c.q);
			const ref = { lat: c.place.lat, lon: c.place.lon };
			const groups = orderGroups([
				{ id: 'airports', ranked: rankAirports(c.ad ? [c.ad] : [], q, { ref, cap: 6 }) },
				{ id: 'navaids', ranked: rankNavaids([c.nav], q, { ref, cap: 6 }) },
				{ id: 'places', ranked: rankPlaces([c.place], q, { ref, cap: 6 }) },
			]);
			expect(groups.map((g) => g.id), c.q).toEqual(c.ad ? ['places', 'navaids', 'airports'] : ['places', 'navaids']);
		}
	});

	it('drops empty groups, pins the first and last ones, and keeps the given order on a tie', () => {
		const a = { id: 'a', ranked: ranked({}) };
		const b = { id: 'b', ranked: ranked({}) };
		const empty = { id: 'empty', ranked: ranked() };
		const go = { id: 'go', ranked: ranked({ tier: TIER.IDENT_SUBSTRING }), place: 'first' as const };
		const countries = { id: 'countries', ranked: ranked({ tier: TIER.IDENT_EXACT }), place: 'last' as const };
		expect(orderGroups([countries, a, empty, b, go]).map((g) => g.id)).toEqual(['go', 'a', 'b', 'countries']);
	});
});

describe('the palette\'s scope', () => {
	const src = readFileSync('src/lib/components/SearchPalette.svelte', 'utf8');

	it('closes its list on "Search all countries", which Enter never takes by default and which keeps the palette open', () => {
		expect(src).toContain("if (debounced.trim() !== '' && searchAllState.phase !== 'on') {");
		expect(src).toContain("if (row && !(row.kind === 'all' && selKey === null)) {");
		expect(src).toMatch(/if \(row\.kind === 'all'\) \{\s*void searchAllCountries\(\);\s*inputEl\?\.focus\(\);\s*return;/);
	});

	it('names the countries held whole under every query', () => {
		expect(src).toContain('<p class="muted note scope">{scopeLine()}</p>');
	});
});
