/* Towns on the search engine (src/lib/search/places.ts): found by their own
 * name and by the names a pilot types for them, one tier under the same
 * match on a feature, nearer for being larger; and over the committed files
 * (docs/search.md "Towns"). */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Airport } from '$lib/data/airports';
import type { Place } from '$lib/data/places';
import { rankAirports } from '$lib/search/airports';
import { TIER } from '$lib/search/match';
import { namedTown, rankPlaces, sizeFactor, TOWN_TIER_SHIFT } from '$lib/search/places';
import { prepareQuery } from '$lib/search/query';
import { mergeRanked } from '$lib/search/rank';

const PARIS = { lat: 48.86, lon: 2.35 };

function place(id: string, name: string, lat: number, lon: number, pop: number | null, alt = ''): Place {
	return { id, country: id.slice(0, 2).toUpperCase(), name, lat, lon, pop, admin: '', alt, commune: id.startsWith('fr:') };
}

const MUNCHEN = place('de:2867714', 'München', 48.137, 11.575, 1505005, 'Munich');
const ETAMPES = place('fr:91223', 'Étampes', 48.435, 2.161, 26857);
const first = (rows: Place[], q: string) => rankPlaces(rows, prepareQuery(q), { ref: PARIS, cap: 5 }).hits[0];

describe('rankPlaces', () => {
	it('finds a town by its own name however it is typed, and by the names it is also known by', () => {
		for (const q of ['München', 'munchen', 'muenchen', 'Munich']) {
			expect(first([MUNCHEN, ETAMPES], q)?.item.id, q).toBe('de:2867714');
		}
		expect(first([MUNCHEN, ETAMPES], 'etampes')?.item.id).toBe('fr:91223');
	});

	it('ranks a town under the same match on a feature, and above the next', () => {
		expect(first([ETAMPES], 'Étampes')?.tier).toBe(TIER.NAME_EXACT + TOWN_TIER_SHIFT);
		const wienau = { ident: 'EDRW', iata: '', name: 'DIERDORF-WIENAU', city: '', type: 'small_airport', lat: 50.57, lon: 7.65 } as Airport;
		const wien = place('at:2761369', 'Wien', 48.208, 16.372, 1691468, 'Vienna|Vienne');
		const qw = prepareQuery('Wien');
		const both = mergeRanked<Airport | Place>(
			[rankAirports([wienau], qw, { ref: PARIS, cap: 5 }), rankPlaces([wien], qw, { ref: PARIS, cap: 5 })],
			5,
		);
		expect(both.hits.map((h) => ('ident' in h.item ? h.item.ident : h.item.id))).toEqual(['at:2761369', 'EDRW']);
		const lfox = { ident: 'LFOX', iata: '', name: 'ETAMPES', city: '', type: 'small_airport', lat: 48.38, lon: 2.08 } as Airport;
		const q = prepareQuery('Étampes');
		const merged = mergeRanked<Airport | Place>(
			[rankAirports([lfox], q, { ref: PARIS, cap: 5 }), rankPlaces([ETAMPES], q, { ref: PARIS, cap: 5 })],
			5,
		);
		expect(merged.hits.map((h) => ('ident' in h.item ? h.item.ident : h.item.id))).toEqual(['LFOX', 'fr:91223']);
	});

	it('names a town by its whole name or by the words it begins, never from inside a word', () => {
		const named = (q: string) => namedTown([MUNCHEN, ETAMPES], prepareQuery(q), PARIS)?.item.id ?? null;
		expect(named('Étampes')).toBe('fr:91223');
		expect(named('etamp')).toBe('fr:91223');
		expect(named('Munich')).toBe('de:2867714');
		expect(named('ampes')).toBeNull();
		expect(named('LFOX')).toBeNull();
		expect(named(' ')).toBeNull();
		// Of two namesakes, the one the engine ranks first: from Paris, the
		// Saint-Denis next door before the larger one on La Réunion.
		const nord = place('fr:93066', 'Saint-Denis', 48.936, 2.358, 113942);
		const reunion = place('fr:97411', 'Saint-Denis', -20.879, 55.448, 153810);
		expect(namedTown([reunion, nord], prepareQuery('Saint-Denis'), PARIS)?.item.id).toBe('fr:93066');
		expect(namedTown([reunion, nord], prepareQuery('Saint-Denis'), { lat: -21.1, lon: 55.5 })?.item.id).toBe('fr:97411');
	});

	it('takes the larger of two namesakes at a like distance', () => {
		expect(sizeFactor(null)).toBe(1);
		expect(sizeFactor(1_000_000)).toBeCloseTo(4, 2);
		// Two Saint-Martins, the village a bit nearer, the town larger.
		const village = place('fr:1', 'Saint-Martin', 48.9, 2.35, 400);
		const town = place('fr:2', 'Saint-Martin', 48.95, 2.35, 40000);
		expect(first([village, town], 'Saint-Martin')?.item.id).toBe('fr:2');
	});
});

/* The committed files, read as the app reads them. */
function committed(iso: string): Place[] {
	const doc = JSON.parse(readFileSync(`public/data/places-${iso}.json`, 'utf8')) as {
		admins: Record<string, string>;
		rows: [string, string, number, number, number | null, string | null, string][];
	};
	return doc.rows.map((r) => ({
		id: r[0],
		country: iso.toUpperCase(),
		name: r[1],
		lat: r[2],
		lon: r[3],
		pop: r[4],
		admin: r[5] !== null ? (doc.admins[r[5]] ?? '') : '',
		alt: r[6],
		commune: iso === 'fr',
	}));
}

describe('the committed towns', () => {
	const rows = [...committed('fr'), ...committed('de'), ...committed('at')];
	const top = (q: string): string | undefined => rankPlaces(rows, prepareQuery(q), { ref: PARIS, cap: 6 }).hits[0]?.item.id;

	it('finds a French commune by its own spelling, accents or not, in any word order', () => {
		expect(top('Étampes')).toBe('fr:91223');
		expect(top('etampes')).toBe('fr:91223');
		expect(top('saint etienne')).toBe('fr:42218');
		expect(top('St-Etienne')).toBe('fr:42218');
		expect(top('havre le')).toBe('fr:76351');
	});

	it('finds München and Wien by their local names and the ones a pilot types', () => {
		for (const q of ['München', 'Munchen', 'Munich']) {
			expect(top(q), q).toBe('de:2867714');
		}
		for (const q of ['Wien', 'Vienna']) {
			expect(top(q), q).toBe('at:2761369');
		}
		// Vienne is first the commune on the Rhône, then Wien by its French name.
		const vienne = rankPlaces(rows, prepareQuery('Vienne'), { ref: PARIS, cap: 6 }).hits.map((h) => h.item.id);
		expect(vienne[0]).toBe('fr:38544');
		expect(vienne).toContain('at:2761369');
	});
});
