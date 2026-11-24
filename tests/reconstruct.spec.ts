/* Unit tests for dead-reckoning name-only waypoint positions. Rather than
 * hand-compute coordinates (which would just re-implement the WMM), assert the
 * invariants: a placed point sits the saved distance from its seed, and the
 * magnetic course recovered from the placed geometry matches the saved course. */

import { describe, it, expect } from 'vitest';
import { equirectangularDistanceM, initialBearingDeg } from '$lib/notam/geometry';
import type { LatLon } from '$lib/notam/types';
import { magneticFromTrue } from '$lib/route/magnetic';
import { reconstructPositions } from '$lib/route/reconstruct';
import type { LoadedWaypoint } from '$lib/route/yaml';

const YEAR = 2026.0;
const SEED: LatLon = { lat: 48.6, lon: 2.4 };
const C = 62; // magnetic course
const D = 6; // NM

function distNM(a: LatLon, b: LatLon): number {
	return equirectangularDistanceM(a.lat, a.lon, b.lat, b.lon) / 1852;
}

/** Magnetic course of the hop a -> b, sampling declination at `at` (the seed used
 *  to place the point), to match how deadReckon inverts the saved course. */
function recoveredCourse(a: LatLon, b: LatLon, at: LatLon): number {
	return magneticFromTrue(initialBearingDeg(a.lat, a.lon, b.lat, b.lon), at.lat, at.lon, YEAR);
}

describe('reconstructPositions', () => {
	it('places a name-only point forward from the previous fix', () => {
		// leg (course/distance) lives on the seed (hop seed -> target).
		const wps: LoadedWaypoint[] = [{ ident: 'A', course: C, distance: D }, { name: 'z' }];
		const pos = reconstructPositions(wps, [SEED, null], YEAR);
		const p = pos[1];
		expect(p).not.toBeNull();
		expect(distNM(SEED, p!)).toBeCloseTo(D, 1);
		expect(recoveredCourse(SEED, p!, SEED)).toBeCloseTo(C, 0);
	});

	it('places a name-only point backward from the next fix', () => {
		// leg lives on the target (hop target -> seed); placed behind the seed.
		const wps: LoadedWaypoint[] = [{ name: 'z', course: C, distance: D }, { ident: 'B' }];
		const pos = reconstructPositions(wps, [null, SEED], YEAR);
		const p = pos[0];
		expect(p).not.toBeNull();
		expect(distNM(p!, SEED)).toBeCloseTo(D, 1);
		// The saved course describes the hop p -> seed.
		expect(recoveredCourse(p!, SEED, SEED)).toBeCloseTo(C, 0);
	});

	it('fills a chain of consecutive name-only points', () => {
		const wps: LoadedWaypoint[] = [
			{ ident: 'A', course: 90, distance: 5 },
			{ name: 'm', course: 45, distance: 4 },
			{ name: 'n' },
		];
		const pos = reconstructPositions(wps, [SEED, null, null], YEAR);
		expect(pos[1]).not.toBeNull();
		expect(pos[2]).not.toBeNull();
		expect(distNM(SEED, pos[1]!)).toBeCloseTo(5, 1);
		expect(distNM(pos[1]!, pos[2]!)).toBeCloseTo(4, 1);
	});

	it('treats a dropped ident as a barrier, not a seed', () => {
		// index 1 is a dropped ident (known null, has ident); index 2's only
		// neighbour is that barrier, so it cannot be placed.
		const wps: LoadedWaypoint[] = [
			{ ident: 'A' },
			{ ident: 'X' },
			{ name: 'z', course: C, distance: D },
		];
		const pos = reconstructPositions(wps, [SEED, null, null], YEAR);
		expect(pos[1]).toBeNull();
		expect(pos[2]).toBeNull();
	});

	it('leaves all name-only points null when there is no seed', () => {
		const wps: LoadedWaypoint[] = [
			{ name: 'a', course: C, distance: D },
			{ name: 'b', course: C, distance: D },
			{ name: 'c' },
		];
		const pos = reconstructPositions(wps, [null, null, null], YEAR);
		expect(pos).toEqual([null, null, null]);
	});

	it('needs both course and distance', () => {
		const wps: LoadedWaypoint[] = [{ ident: 'A', course: C }, { name: 'z' }];
		const pos = reconstructPositions(wps, [SEED, null], YEAR);
		expect(pos[1]).toBeNull();
	});
});
