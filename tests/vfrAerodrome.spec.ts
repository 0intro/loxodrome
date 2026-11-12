/* Unit tests for the VFR-reporting-point -> aerodrome association. */

import { describe, it, expect } from 'vitest';
import { buildVfrAerodromeMap } from '$lib/data/vfrAerodrome';
import type { Airport } from '$lib/data/airports';
import type { Navaid } from '$lib/data/navaids';

function ap(ident: string, lat: number, lon: number, name: string): Airport {
	return { ident, lat, lon, name } as Airport;
}
function vfr(id: string, ident: string, lat: number, lon: number, ad = ''): Navaid {
	return { id, ident, name: ident, lat, lon, type: 'VFR_REPORTING_POINT', ad } as unknown as Navaid;
}

const airports = [
	ap('LFAQ', 49.97, 2.69, 'Albert Bray'),
	ap('NTAA', -17.55, -149.61, "Faa'a"),
	ap('LFPG', 49.0, 2.55, 'Paris CDG'),
	ap('LFMN', 43.66, 7.22, "Nice Côte d'Azur"),
	ap('LNMC', 43.73, 7.42, 'Monaco'),
];

describe('buildVfrAerodromeMap', () => {
	it('maps a point to the nearest airport whose ICAO ends with its first 2 ident chars', () => {
		const m = buildVfrAerodromeMap(airports, [vfr('n1', 'AQN', 50.0, 2.7)]);
		expect(m.get('n1')).toEqual({ ident: 'LFAQ', name: 'Albert Bray' });
	});

	it('maps an overseas point by the ICAO suffix (AA -> NTAA, not LFAA)', () => {
		const m = buildVfrAerodromeMap(airports, [vfr('n2', 'AAEA', -17.56, -149.5)]);
		expect(m.get('n2')).toEqual({ ident: 'NTAA', name: "Faa'a" });
	});

	it('ignores navaids that are not VFR reporting points', () => {
		const wpt = { id: 'w1', ident: 'AQABC', name: '', lat: 50, lon: 2.7, type: 'WAYPOINT' } as unknown as Navaid;
		expect(buildVfrAerodromeMap(airports, [wpt]).has('w1')).toBe(false);
	});

	it('drops a point with no suffix match, or one beyond the distance cap', () => {
		const m = buildVfrAerodromeMap(airports, [
			vfr('zz', 'ZZN', 50, 2.7), // no airport ICAO ends with "ZZ"
			vfr('far', 'AQN', 45.0, 2.7), // ~300 nm from LFAQ, the only "AQ" airport
		]);
		expect(m.has('zz')).toBe(false);
		expect(m.has('far')).toBe(false);
	});

	it('takes the aerodrome the AIP states over the guess', () => {
		// MNJS: the Monaco heliport's point, which the "MN" suffix would give
		// to Nice; ZZN, a prefix no aerodrome answers (as LFEA's "LF" is near
		// none), stating its own.
		const m = buildVfrAerodromeMap(airports, [vfr('mnjs', 'MNJS', 43.72, 7.4, 'LNMC'), vfr('stated', 'ZZN', 49.0, 2.6, 'LFPG')]);
		expect(m.get('mnjs')).toEqual({ ident: 'LNMC', name: 'Monaco' });
		expect(m.get('stated')).toEqual({ ident: 'LFPG', name: 'Paris CDG' });
	});

	it('gives none, not a guess, when the stated aerodrome is not loaded', () => {
		expect(buildVfrAerodromeMap(airports, [vfr('n1', 'AQN', 50.0, 2.7, 'LFXX')]).has('n1')).toBe(false);
	});
});
