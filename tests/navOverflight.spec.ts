/* Pins the overflown-aerodrome selection (nav/overflight.ts): the candidate
 * filter (open fields with a usable published frequency) and the pure
 * nearest-within-radius scan behind the in-flight strip's overflown-aerodrome
 * cell (state/navOverflight.svelte). */

import { describe, it, expect } from 'vitest';
import {
	nearestOverflown,
	overflightCandidates,
	OVERFLIGHT_RADIUS_NM,
} from '$lib/nav/overflight';
import { equirectangularDistanceM, M_PER_DEG } from '$lib/notam/geometry';
import { NM_TO_METERS } from '$lib/notam/units';
import type { Airport } from '$lib/data/airports';

const NONE: ReadonlySet<string> = new Set();
/** Degrees of latitude per NM, so fixtures can be placed by distance. */
const DEG_PER_NM = NM_TO_METERS / M_PER_DEG;

function ap(ident: string, lat: number, lon: number, over: Partial<Airport> = {}): Airport {
	return {
		ident,
		type: 'small_airport',
		name: ident,
		lat,
		lon,
		elevFt: null,
		transitionAltFt: null,
		country: 'FR',
		city: '',
		iata: '',
		runways: [],
		access: null,
		military: false,
		joint: false,
		vfr: true,
		ifr: false,
		radios: [{ freq: '123.500', unit: 'A/A', call: `${ident} A/A` }],
		source: null,
		charts: [],
		...over,
	};
}

describe('overflightCandidates', () => {
	it('keeps an open field with a usable published frequency and drops the rest', () => {
		const open = ap('LFAA', 48, 2);
		const closed = ap('LFBB', 48, 2, { type: 'closed' });
		const silent = ap('LFCC', 48, 2, { radios: [] });
		const blank = ap('LFDD', 48, 2, { radios: [{ freq: '  ', unit: 'A/A', call: '' }] });
		expect(overflightCandidates([open, closed, silent, blank])).toEqual([open]);
	});

	it('keeps a field whose one usable row sits among blank ones', () => {
		const a = ap('LFEE', 48, 2, {
			radios: [
				{ freq: '', unit: 'ATIS', call: '' },
				{ freq: '119.100', unit: 'TWR', call: 'EE TWR' },
			],
		});
		expect(overflightCandidates([a])).toEqual([a]);
	});
});

describe('nearestOverflown', () => {
	it('answers null with nothing inside the radius', () => {
		const far = ap('LFAA', 48 + 6 * DEG_PER_NM, 2);
		expect(nearestOverflown([far], 48, 2, OVERFLIGHT_RADIUS_NM, NONE)).toBeNull();
	});

	it('picks the nearest of several candidates', () => {
		const list = [
			ap('LFAA', 48 + 4 * DEG_PER_NM, 2),
			ap('LFBB', 48 + 1 * DEG_PER_NM, 2),
			ap('LFCC', 48 - 2 * DEG_PER_NM, 2),
		];
		const r = nearestOverflown(list, 48, 2, 5, NONE);
		expect(r?.airport.ident).toBe('LFBB');
		expect(r?.distNM).toBeCloseTo(1, 6);
	});

	it('takes a field just inside the radius and leaves one just outside', () => {
		const inside = ap('LFAA', 48 + 4.99 * DEG_PER_NM, 2);
		const outside = ap('LFBB', 48 + 5.01 * DEG_PER_NM, 2);
		expect(nearestOverflown([inside], 48, 2, 5, NONE)?.airport.ident).toBe('LFAA');
		expect(nearestOverflown([outside], 48, 2, 5, NONE)).toBeNull();
	});

	it('skips an excluded ident and yields the next-nearest', () => {
		const list = [ap('LFAA', 48 + 1 * DEG_PER_NM, 2), ap('LFBB', 48 + 3 * DEG_PER_NM, 2)];
		const r = nearestOverflown(list, 48, 2, 5, new Set(['LFAA']));
		expect(r?.airport.ident).toBe('LFBB');
	});

	it('matches the exclusion whatever the ident case', () => {
		const list = [ap('lfaa', 48 + 1 * DEG_PER_NM, 2)];
		expect(nearestOverflown(list, 48, 2, 5, new Set(['LFAA']))).toBeNull();
	});

	it('rejects a same-latitude field beyond the radius in longitude', () => {
		// 8 NM due east at 48N: inside the latitude band, outside the radius.
		const dLon = (8 * NM_TO_METERS) / (M_PER_DEG * Math.cos((48 * Math.PI) / 180));
		const east = ap('LFAA', 48, 2 + dLon);
		expect(nearestOverflown([east], 48, 2, 5, NONE)).toBeNull();
	});

	it('finds a candidate across the antimeridian', () => {
		const west = ap('PAAA', 0, -179.96);
		const r = nearestOverflown([west], 0, 179.96, 5, NONE);
		expect(r?.airport.ident).toBe('PAAA');
		expect(r?.distNM).toBeCloseTo((0.08 * M_PER_DEG) / NM_TO_METERS, 6);
	});

	it('reports the equirectangular distance in NM', () => {
		const a = ap('LFAA', 48.03, 2.05);
		const r = nearestOverflown([a], 48, 2, 5, NONE);
		expect(r?.distNM).toBeCloseTo(equirectangularDistanceM(48, 2, 48.03, 2.05) / NM_TO_METERS, 10);
	});

	it('answers null over an empty candidate list', () => {
		expect(nearestOverflown([], 48, 2, 5, NONE)).toBeNull();
	});
});
