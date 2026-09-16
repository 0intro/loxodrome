/* Pins the nearest-aerodromes list (nav/nearest.ts): the fixed-wing
 * candidate filter, the distance order with a stable tie-break, the radius,
 * the limit, the true bearing and the longest runway. */

import { describe, expect, it } from 'vitest';
import { NEAREST_LIMIT, NEAREST_RADIUS_NM, longestRunwayFt, nearestAerodromes, nearestCandidates } from '$lib/nav/nearest';
import { M_PER_DEG } from '$lib/notam/geometry';
import { NM_TO_METERS } from '$lib/notam/units';
import type { Airport, Runway } from '$lib/data/airports';

const DEG_PER_NM = NM_TO_METERS / M_PER_DEG;

function rwy(lengthFt: number | null): Runway {
	return {
		le: '07',
		he: '25',
		lengthFt,
		widthFt: null,
		surface: 'ASP',
		lit: false,
		leLdaFt: null,
		leToraFt: null,
		leTodaFt: null,
		leAsdaFt: null,
		heLdaFt: null,
		heToraFt: null,
		heTodaFt: null,
		heAsdaFt: null,
	} as Runway;
}

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
		radios: [],
		source: null,
		charts: [],
		pads: [],
		...over,
	};
}

describe('nearestCandidates', () => {
	it('keeps aerodromes of every size and drops heliports, seaplane bases and closed fields', () => {
		const list = [
			ap('LFAA', 48, 2),
			ap('LFBB', 48, 2, { type: 'medium_airport' }),
			ap('LFCC', 48, 2, { type: 'large_airport' }),
			ap('LFHH', 48, 2, { type: 'heliport' }),
			ap('LFSS', 48, 2, { type: 'seaplane_base' }),
			ap('LFXX', 48, 2, { type: 'closed' }),
		];
		expect(nearestCandidates(list).map((a) => a.ident)).toEqual(['LFAA', 'LFBB', 'LFCC']);
	});

	it('does not require a published frequency', () => {
		expect(nearestCandidates([ap('LFAA', 48, 2, { radios: [] })])).toHaveLength(1);
	});
});

describe('nearestAerodromes', () => {
	const here = { lat: 48, lon: 2 };
	const at = (ident: string, nmNorth: number, over: Partial<Airport> = {}): Airport =>
		ap(ident, here.lat + nmNorth * DEG_PER_NM, here.lon, over);

	it('lists by distance, nearest first', () => {
		const out = nearestAerodromes([at('C', 12), at('A', 3), at('B', 7)], here.lat, here.lon);
		expect(out.map((h) => h.airport.ident)).toEqual(['A', 'B', 'C']);
		expect(out[0].distNM).toBeCloseTo(3, 2);
		expect(out[2].distNM).toBeCloseTo(12, 2);
	});

	it('breaks a tie on the ident so the list is stable between poses', () => {
		const out = nearestAerodromes([at('LFZZ', 5), at('LFAA', 5)], here.lat, here.lon);
		expect(out.map((h) => h.airport.ident)).toEqual(['LFAA', 'LFZZ']);
	});

	it('looks no farther than the radius and no longer than the limit', () => {
		const far = at('FAR', NEAREST_RADIUS_NM + 1);
		expect(nearestAerodromes([far], here.lat, here.lon)).toEqual([]);
		const many = Array.from({ length: NEAREST_LIMIT + 4 }, (_, i) => at(`N${String(i).padStart(2, '0')}`, i + 1));
		expect(nearestAerodromes(many, here.lat, here.lon)).toHaveLength(NEAREST_LIMIT);
		expect(nearestAerodromes(many, here.lat, here.lon, { limit: 3 })).toHaveLength(3);
	});

	it('reports the true bearing from the position', () => {
		const north = at('N', 10);
		const south = at('S', -10);
		const out = nearestAerodromes([north, south], here.lat, here.lon);
		const byId = new Map(out.map((h) => [h.airport.ident, h.bearingTrueDeg]));
		expect(byId.get('N')).toBeCloseTo(0, 3);
		expect(byId.get('S')).toBeCloseTo(180, 3);
	});
});

describe('longestRunwayFt', () => {
	it('picks the longest stated length and ignores unknown ones', () => {
		expect(longestRunwayFt(ap('X', 0, 0, { runways: [rwy(2300), rwy(null), rwy(3900)] }))).toBe(3900);
		expect(longestRunwayFt(ap('X', 0, 0, { runways: [rwy(null)] }))).toBeNull();
		expect(longestRunwayFt(ap('X', 0, 0))).toBeNull();
	});
});
