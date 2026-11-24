/* Unit tests for the steering geometry (nav/steering): which side of the
 * planned course the aircraft is on, the sign the cross-track distance needs
 * to be read as an instruction. */

import { describe, it, expect } from 'vitest';
import { crossTrackSide, splitRouteAtNM, steerDeg } from '$lib/nav/steering';

describe('steerDeg', () => {
	it('signs the turn: positive right, negative left', () => {
		// Tracking 100 with the waypoint on 090: ten degrees left of track.
		expect(steerDeg(90, 100)).toBe(-10);
		expect(steerDeg(100, 90)).toBe(10);
	});

	it('takes the short way round north', () => {
		expect(steerDeg(10, 350)).toBe(20);
		expect(steerDeg(350, 10)).toBe(-20);
	});

	it('is zero on the bearing and half a turn on the reciprocal', () => {
		expect(steerDeg(268, 268)).toBe(0);
		expect(Math.abs(steerDeg(45, 225))).toBe(180);
	});
});

describe('crossTrackSide', () => {
	// An eastbound leg along the equator.
	const A = { lat: 0, lon: 0 };
	const B = { lat: 0, lon: 1 };
	const side = (lat: number, lon: number): number =>
		crossTrackSide(lat, lon, A.lat, A.lon, B.lat, B.lon);

	it('calls north of an eastbound leg a LEFT error', () => {
		expect(side(0.1, 0.5)).toBe(-1);
	});

	it('calls south of an eastbound leg a RIGHT error', () => {
		expect(side(-0.1, 0.5)).toBe(1);
	});

	it('is zero on the course and on a degenerate leg', () => {
		expect(side(0, 0.5)).toBe(0);
		expect(crossTrackSide(0.1, 0.5, 0, 0, 0, 0)).toBe(0);
	});

	it('flips with the leg direction, not with the position', () => {
		// Same point, the leg flown the other way: what was left is now right.
		expect(crossTrackSide(0.1, 0.5, B.lat, B.lon, A.lat, A.lon)).toBe(1);
	});

	it('holds away from the equator, where a degree of longitude is shorter', () => {
		// A northbound leg at 48 N: east of it is a RIGHT error.
		expect(crossTrackSide(48.5, 2.1, 48, 2, 49, 2)).toBe(1);
		expect(crossTrackSide(48.5, 1.9, 48, 2, 49, 2)).toBe(-1);
	});
});

describe('splitRouteAtNM', () => {
	// Two 60 NM equator legs.
	const wps = [
		{ lat: 0, lon: 0 },
		{ lat: 0, lon: 1 },
		{ lat: 0, lon: 2 },
	];

	it('cuts the second leg where the aircraft is, sharing the cut point', () => {
		const s = splitRouteAtNM(wps, 90);
		expect(s).not.toBeNull();
		expect(s!.flown).toHaveLength(3);
		// A degree of equator longitude is 60.1 NM on this axis, so 90 NM lands
		// just short of the leg's midpoint.
		expect(s!.flown[2][1]).toBeCloseTo(1.5, 2);
		// The active leg runs from the cut to the leg's end waypoint.
		expect(s!.activeLeg[0]).toEqual(s!.flown[2]);
		expect(s!.activeLeg[1][1]).toBeCloseTo(2, 6);
	});

	it('keeps the whole first leg ahead at the start', () => {
		const s = splitRouteAtNM(wps, 0);
		expect(s!.flown).toEqual([
			[0, 0],
			[0, 0],
		]);
		expect(s!.activeLeg[1][1]).toBeCloseTo(1, 6);
	});

	it('is null past the end and for a degenerate route', () => {
		expect(splitRouteAtNM(wps, 500)).toBeNull();
		expect(splitRouteAtNM([{ lat: 0, lon: 0 }], 0)).toBeNull();
		expect(splitRouteAtNM(wps, -1)).toBeNull();
	});
});
