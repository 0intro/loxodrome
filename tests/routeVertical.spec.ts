/* Terrain-aware vertical evaluation of the route walks: AGL/ASFC limits
 * resolve against the route's terrain samples when supplied (the shared
 * routeTerrain cache in the app) and fall back to the conservative
 * endpoints when not, so a zone is never missed for lack of terrain. */

import { describe, it, expect } from 'vitest';
import { NO_ENTRY } from '$lib/data/airspaceEntry';
import {
	computeAirspaceSchedule,
	routeAirspaceKeysAtAltitude,
} from '$lib/route/airspaces';
import type { Airspace, VerticalLimit } from '$lib/data/airspaces';
import { fromTriple } from '$lib/vertical/limits';
import type { TerrainSample } from '$lib/map/terrain';
import type { Waypoint } from '$lib/state/route.svelte';

let nextId = 0;
function wp(lat: number, lon: number, alt: number): Waypoint {
	return { id: `t${nextId++}`, lat, lon, kind: 'free', alt, altAuto: false };
}

/** An axis-aligned box airspace on the equator (1 deg lon = 60 NM). */
function box(
	key: string,
	lonMin: number,
	lonMax: number,
	lower: VerticalLimit | null,
	upper: VerticalLimit | null,
): Airspace {
	const ring: [number, number][] = [
		[-0.5, lonMin],
		[-0.5, lonMax],
		[0.5, lonMax],
		[0.5, lonMin],
	];
	return {
		id: key,
		key,
		type: 'R',
		name: key,
		airClass: '',
		upper,
		lower,
		vUpper: fromTriple(upper, { legacyFl999Unl: true }),
		vLower: fromTriple(lower, { legacyFl999Unl: true }),
		vMax: null,
		vMnm: null,
		workHr: '',
		rmkWorkHr: '',
		rmk: '',
		entry: NO_ENTRY,
		radio: [],
		ring,
		subtype: '',
		category: 'restricted',
		source: 'fr',
		area: 1,
		bbox: { minLat: -0.5, minLon: lonMin, maxLat: 0.5, maxLon: lonMax },
	};
}

// A 30 NM equator run; the zone occupies its middle third (6..24 NM).
const route = [wp(0, 0, 3000), wp(0, 0.5, 3000)];
// The RTBA shape: SFC to 800 ft ASFC (LFR45C's band).
const rtba = box('LFR45C', 0.1, 0.4, ['HEI', '0', 'FT'], ['HEI', '800', 'FT']);

const FLAT = (elevFt: number): TerrainSample[] => [
	{ distNM: 0, elevFt },
	{ distNM: 30, elevFt },
];

function keys(airspaces: Airspace[], terrain?: TerrainSample[] | null): string[] {
	return [...routeAirspaceKeysAtAltitude(route, airspaces, 3000, terrain)].sort();
}

describe('AGL zones in the route walks', () => {
	it('includes a terrain-hugging zone over high ground (the LFR45C case)', () => {
		// 3000 ft AMSL over 2500 ft terrain = 500 ft AGL: genuinely inside
		// the SFC..800 ft ASFC band.
		expect(keys([rtba], FLAT(2500))).toEqual(['LFR45C']);
		const schedule = computeAirspaceSchedule(route, [rtba], 100, 3000, FLAT(2500));
		expect(schedule.map((e) => `${e.kind}:${e.key}`)).toEqual([
			'enter:LFR45C',
			'leave:LFR45C',
		]);
	});

	it('excludes it over low ground where the flight is well above the band', () => {
		expect(keys([rtba], FLAT(0))).toEqual([]);
	});

	it('is conservative (included) without terrain', () => {
		expect(keys([rtba], null)).toEqual(['LFR45C']);
		expect(keys([rtba])).toEqual(['LFR45C']);
	});

	it('treats failed tiles (null elevations) conservatively', () => {
		const holes: TerrainSample[] = [
			{ distNM: 0, elevFt: null },
			{ distNM: 30, elevFt: null },
		];
		expect(keys([rtba], holes)).toEqual(['LFR45C']);
	});

	it('maps walk samples to the NEAREST terrain sample (coarser profile)', () => {
		// Terrain known only at 0 / 15 / 30 NM; the middle of the route reads
		// the 2500 ft sample, so the zone appears there and only there.
		const coarse: TerrainSample[] = [
			{ distNM: 0, elevFt: 0 },
			{ distNM: 15, elevFt: 2500 },
			{ distNM: 30, elevFt: 0 },
		];
		const schedule = computeAirspaceSchedule(route, [rtba], null, 3000, coarse);
		expect(schedule).toHaveLength(2);
		expect(schedule[0].kind).toBe('enter');
		// Entered somewhere in the middle third, not at the lateral entry.
		expect(schedule[0].atNM).toBeGreaterThan(6);
		expect(schedule[1].atNM).toBeLessThanOrEqual(24);
	});
});

describe('bounded and unbounded limits in the walks', () => {
	it('keeps the strict floor: flying exactly at an AMSL floor is outside', () => {
		const tma = box('TMA', 0.1, 0.4, ['ALT', '3000', 'FT'], ['ALT', '5000', 'FT']);
		expect(keys([tma], FLAT(0))).toEqual([]);
	});

	it('excludes an FL195-UNL zone at a VFR altitude via its floor alone', () => {
		const upperR = box('LFR31H', 0.1, 0.4, ['STD', '195', 'FL'], ['STD', '999', 'FL']);
		expect(keys([upperR], FLAT(0))).toEqual([]);
		// Same with the ceiling missing entirely (legacy uk/es encoding):
		// the known floor now filters on its own.
		const nullTop = box('NULLTOP', 0.1, 0.4, ['STD', '195', 'FL'], null);
		expect(keys([nullTop], FLAT(0))).toEqual([]);
	});

	it('keeps a zone with no vertical data at all', () => {
		const bare = box('BARE', 0.1, 0.4, null, null);
		expect(keys([bare], FLAT(0))).toEqual(['BARE']);
	});
});
