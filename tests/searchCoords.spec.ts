/* A position typed into the search (src/lib/search/coords.ts): the forms a
 * pilot copies from a chart, a NOTAM, a GPS or a phone's map, and never an
 * identifier read as one (docs/search.md "Coordinates"). */

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCoordQuery, rankCoords } from '$lib/search/coords';

const ETAMPES = { lat: 48.82, lon: 2.62 };

function near(got: { lat: number; lon: number } | null, want: { lat: number; lon: number }): boolean {
	return got !== null && Math.abs(got.lat - want.lat) < 1e-4 && Math.abs(got.lon - want.lon) < 1e-4;
}

describe('parseCoordQuery', () => {
	it('reads the route field’s tokens, the spaces taken out', () => {
		for (const q of ['48.82,2.62', '48.82, 2.62', 'N48492E002372', 'N4849.2 E00237.2', '484912N 0023712E', 'N48,8200/E2,62000']) {
			expect(near(parseCoordQuery(q), ETAMPES), q).toBe(true);
		}
	});

	it('reads a signed decimal pair split by blanks, a point or a comma for the decimals', () => {
		for (const q of ['48.82 2.62', '48,82 2,62', '  48.82   2.62 ']) {
			expect(near(parseCoordQuery(q), ETAMPES), q).toBe(true);
		}
		expect(near(parseCoordQuery('-22.27583 166.45833'), { lat: -22.27583, lon: 166.45833 })).toBe(true);
		expect(near(parseCoordQuery('-22.27583, 166.45833'), { lat: -22.27583, lon: 166.45833 })).toBe(true);
	});

	it('reads one hemisphere letter per axis, before or after, with or without marks', () => {
		const cases = [
			'48.82N 2.62E',
			'48.82n, 2.62e',
			'N48.82 E2.62',
			'N 48.82 / E 2.62',
			'N 48° 49.2\' E 002° 37.2\'',
			'48°49\'12"N 002°37\'12"E',
			'48°49′12″N 2°37′12″E',
			'48º49’12”N 2º37’12”E',
		];
		for (const q of cases) {
			expect(near(parseCoordQuery(q), ETAMPES), q).toBe(true);
		}
		// The place panel's own form, seconds with decimals.
		expect(near(parseCoordQuery('48°26\'04.92"N 002°09\'42.12"E'), { lat: 48.4347, lon: 2.1617 })).toBe(true);
		expect(near(parseCoordQuery('33.9425N 118.4081W'), { lat: 33.9425, lon: -118.4081 })).toBe(true);
		expect(near(parseCoordQuery('S22.27583 E166.45833'), { lat: -22.27583, lon: 166.45833 })).toBe(true);
	});

	it('reads no identifier, word or half a position as one', () => {
		const none = [
			'',
			'N12',
			'5N1',
			'LFPN',
			'Nice',
			'West',
			'12 34',
			'48.82',
			'91.0 2.0',
			'48.0 181.0',
			'48°61\'N 2°E',
			'48.5°30\'N 2°E',
			'48.82N 2.62N',
			'N0012/26',
			'S2N',
			'LF-R45A',
		];
		for (const q of none) {
			expect(parseCoordQuery(q), q).toBeNull();
		}
	});

	it('reads no committed aerodrome or navaid ident as a position', () => {
		const files = readdirSync('public/data').filter((f) => /(^|-)(airports|navaids)(\.next)?\.json$/.test(f));
		expect(files.length).toBeGreaterThan(20);
		const read: string[] = [];
		for (const f of files) {
			const doc = JSON.parse(readFileSync(`public/data/${f}`, 'utf8')) as { fields: string[]; rows: unknown[][] };
			const col = doc.fields.indexOf('ident');
			for (const r of doc.rows) {
				const ident = r[col];
				if (typeof ident === 'string' && parseCoordQuery(ident) !== null) {
					read.push(`${f}: ${ident}`);
				}
			}
		}
		expect(read).toEqual([]);
	});
});

describe('rankCoords', () => {
	it('is one row for a position and none for anything else', () => {
		expect(rankCoords('48.82 2.62').hits.map((h) => h.item)).toEqual([{ lat: 48.82, lon: 2.62 }]);
		expect(rankCoords('LFOX').hits).toEqual([]);
	});

	it('is the palette’s first group, and its pick opens the place panel', () => {
		const src = readFileSync('src/lib/components/SearchPalette.svelte', 'utf8');
		expect(src).toContain("{ id: 'coords' as const, ranked: coordGroup, place: 'first' as const }");
		expect(src).toContain('selectPlace(positionPlace(lat, lon));');
	});
});
