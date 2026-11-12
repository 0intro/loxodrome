/* Aerodromes on the search engine (src/lib/search/airports.ts): the order
 * the Airports tab lists them in and the palette and the route field read. */

import { describe, it, expect } from 'vitest';
import type { Airport } from '$lib/data/airports';
import { rankAirports } from '$lib/search/airports';
import { prepareQuery } from '$lib/search/query';

function ap(ident: string, name: string, lat: number, lon: number, extra: Partial<Airport> = {}): Airport {
	return { ident, iata: '', name, city: '', country: 'FR', type: 'small_airport', lat, lon, ...extra } as Airport;
}
const PARIS = { lat: 48.86, lon: 2.35 };
const ranked = (
	rows: Airport[],
	q: string,
	ref: { lat: number; lon: number } | null = PARIS,
	cap = 50,
	keep?: (a: Airport) => boolean,
): string[] =>
	rankAirports(rows, prepareQuery(q), { ref, cap, keep }).hits.map((h) => h.item.ident);

describe('rankAirports', () => {
	it('lists the nearest first among equal matches, wherever they are filed', () => {
		const rows = [
			ap('FMEP', 'Saint-Pierre Pierrefonds', -21.32, 55.42, { type: 'medium_airport' }),
			ap('CYSJ', 'Saint John', 45.32, -65.89, { type: 'medium_airport' }),
			ap('LFOR', 'SAINT ANDRE DE L EURE', 48.9, 1.25),
			ap('LFFR', 'SAINT REMY DE PROVENCE', 43.83, 4.84),
		];
		expect(ranked(rows, 'saint')).toEqual(['LFOR', 'LFFR', 'CYSJ', 'FMEP']);
	});

	it('sinks heliports under airfields and closed fields under both', () => {
		const rows = [
			ap('LF0001', 'PARIS NECKER HOPITAL', 48.85, 2.32, { type: 'heliport' }),
			ap('LF41', 'PARIS BRETIGNY (CLOSED)', 48.6, 2.33, { type: 'closed' }),
			ap('LFPO', 'PARIS ORLY', 48.73, 2.36, { type: 'large_airport' }),
		];
		expect(ranked(rows, 'paris')).toEqual(['LFPO', 'LF0001', 'LF41']);
	});

	it('keeps identifiers ahead of names: ICAO, then IATA, then the words', () => {
		const rows = [ap('LFPG', 'PARIS CHARLES DE GAULLE', 49.01, 2.55, { iata: 'CDG' }), ap('CDGX', 'CDG STRIP', 47.5, 0.5)];
		expect(ranked(rows, 'CDG')).toEqual(['LFPG', 'CDGX']);
	});

	it('finds a town however it is written, in any word order', () => {
		const rows = [
			ap('LFBM', 'MONT DE MARSAN', 43.91, -0.51),
			ap('LFBU', 'ANGOULEME BRIE CHAMPNIERS', 45.73, 0.22),
			ap('LFLY', 'LYON BRON', 45.73, 4.94, { city: 'LYON' }),
		];
		expect(ranked(rows, 'Mont-de-Marsan')).toEqual(['LFBM']);
		expect(ranked(rows, 'Angoulême')).toEqual(['LFBU']);
		expect(ranked(rows, 'bron lyon')).toEqual(['LFLY']);
	});

	it('filters before the cap, and counts every match', () => {
		const rows = [ap('LFAA', 'A', 48.9, 2.3), ap('LFAB', 'B', 48.9, 2.4), ap('LFAC', 'C', 48.9, 2.5)];
		const r = rankAirports(rows, prepareQuery('LFA'), { ref: PARIS, cap: 1, keep: (a) => a.ident !== 'LFAA' });
		expect(r.total).toBe(2);
		expect(r.hits.map((h) => h.item.ident)).toEqual(['LFAB']);
	});

	it('orders by ident without a reference', () => {
		const rows = [ap('LFAZ', 'Z', 48.86, 2.35), ap('LFAA', 'A', 10, 10)];
		expect(ranked(rows, 'LFA', null)).toEqual(['LFAA', 'LFAZ']);
	});
});
