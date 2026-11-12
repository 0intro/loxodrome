/* Airspaces on the search engine (src/lib/search/airspaces.ts): found by
 * their designator however a NOTAM or a chart writes it, and by name. */

import { describe, it, expect } from 'vitest';
import type { Airspace } from '$lib/data/airspaces';
import type { Airport } from '$lib/data/airports';
import { rankAirspaces } from '$lib/search/airspaces';
import { rankAirports } from '$lib/search/airports';
import { mergeRanked } from '$lib/search/rank';
import { TIER } from '$lib/search/match';
import { prepareQuery } from '$lib/search/query';

function zone(id: string, type: string, name: string, bbox = { minLat: 47, minLon: 1, maxLat: 48, maxLon: 2 }): Airspace {
	return { id, key: `${id}|${name}`, type, name, bbox, source: 'fr', category: 'restricted' } as unknown as Airspace;
}
const PARIS = { lat: 48.86, lon: 2.35 };
const rows = [
	zone('LFR45A', 'R', '45 A'),
	zone('LFR45S4', 'R', '45 S4'),
	zone('LFPM7.2', 'TMA', 'SEINE 7.2'),
	zone('EGD006A', 'D', '006A'),
	zone('LI43C39', 'R', 'LI R64 - CUNEO'),
];
const first = (q: string): { id: string; tier: number } | undefined => {
	const h = rankAirspaces(rows, prepareQuery(q), { ref: PARIS, cap: 5 }).hits[0];
	return h && { id: h.item.id, tier: h.tier };
};

describe('rankAirspaces', () => {
	it('finds a designator however it is written', () => {
		for (const q of ['LF-R45A', 'LFR45A', 'lfr45a', 'LF-R 45A', 'LF R 45 A', 'R 45 A', 'R45A']) {
			expect(first(q), q).toEqual({ id: 'LFR45A', tier: TIER.ALT_IDENT_EXACT });
		}
		expect(first('EG D6A')?.id).toBe('EGD006A');
		expect(first('EGD006A')?.id).toBe('EGD006A');
	});

	it('finds a designator written inside the name, as Italy files them', () => {
		expect(first('LI R64')?.id).toBe('LI43C39');
		expect(first('R64')?.id).toBe('LI43C39');
	});

	it('lists every zone a prefix opens, and finds one by name', () => {
		const ids = rankAirspaces(rows, prepareQuery('R45'), { ref: PARIS, cap: 5 }).hits.map((h) => h.item.id);
		expect(ids.sort()).toEqual(['LFR45A', 'LFR45S4']);
		expect(first('TMA SEINE')?.id).toBe('LFPM7.2');
		expect(first('seine 7')?.id).toBe('LFPM7.2');
	});

	it('lists a zone split into sub-rings once', () => {
		const split = [zone('LFR45A', 'R', '45 A'), zone('LFR45A', 'R', '45 A')];
		expect(rankAirspaces(split, prepareQuery('R45A'), { ref: PARIS, cap: 5 }).hits).toHaveLength(1);
	});

	it('measures its distance to the box, nothing inside it', () => {
		const inside = rankAirspaces([zone('LFR1', 'R', '1', { minLat: 48, minLon: 2, maxLat: 49, maxLon: 3 })], prepareQuery('R1'), {
			ref: PARIS,
			cap: 1,
		});
		expect(inside.hits[0].dist).toBe(0);
	});

	it('stays under an aerodrome filed under the same letters', () => {
		const ap = { ident: 'LFPG', iata: 'CDG', name: 'PARIS CHARLES DE GAULLE', city: '', type: 'large_airport', lat: 49, lon: 2.55 } as Airport;
		const q = prepareQuery('LFPG');
		const merged = mergeRanked<Airport | Airspace>(
			[rankAirports([ap], q, { ref: PARIS, cap: 5 }), rankAirspaces([zone('LFPG', 'CTR', 'CHARLES DE GAULLE')], q, { ref: PARIS, cap: 5 })],
			5,
		);
		expect(merged.hits.map((h) => h.kind)).toEqual([0, 2]);
	});
});
