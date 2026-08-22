/* The route field's coordinate notations: the pure parse / format helpers, plus an
 * integration round-trip through the route-text state pipeline
 * (setRouteFromText -> waypoints -> serializeRoute). */

import { describe, it, expect } from 'vitest';
import {
	parseCoordToken,
	parsePackedCoord,
	formatGarminCoord,
	looksLikeCoordToken,
} from '$lib/route/coordToken';
import { latLonToSofiaToken } from '$lib/sofia/client';
import {
	clearRoute,
	setRouteFromText,
	serializeRoute,
	activeRoute,
	setWaypointFreqs,
	type WaypointAnchor,
} from '$lib/state/route.svelte';

describe('parseCoordToken (the Garmin Pilot notation)', () => {
	it('parses the example route waypoints (comma decimal, slash separator)', () => {
		expect(parseCoordToken('N48,8200/E2,62000')).toEqual({ lat: 48.82, lon: 2.62 });
		expect(parseCoordToken('N48,4500/E2,81000')).toEqual({ lat: 48.45, lon: 2.81 });
		expect(parseCoordToken('N48,3500/E2,80000')).toEqual({ lat: 48.35, lon: 2.8 });
	});

	it('negates the S and W hemispheres', () => {
		expect(parseCoordToken('S12,5000/W034,2500')).toEqual({ lat: -12.5, lon: -34.25 });
	});

	it('accepts a dot decimal as well as a comma, case-insensitively', () => {
		expect(parseCoordToken('N48.82/E2.62')).toEqual({ lat: 48.82, lon: 2.62 });
		expect(parseCoordToken('n48,82/e2,62')).toEqual({ lat: 48.82, lon: 2.62 });
	});

	it('rejects out-of-range latitude / longitude', () => {
		expect(parseCoordToken('N91,0/E2,0')).toBeNull();
		expect(parseCoordToken('N48,0/E181,0')).toBeNull();
	});

	it('rejects non-coordinates (idents, a missing slash)', () => {
		expect(parseCoordToken('LFPL')).toBeNull();
		expect(parseCoordToken('PMN')).toBeNull();
		expect(parseCoordToken('N48,8200 E2,62000')).toBeNull(); // space, not slash
		expect(parseCoordToken('48,82/2,62')).toBeNull(); // no hemisphere letters
	});
});

describe('parsePackedCoord', () => {
	// 48 deg 49.2 min N, 2 deg 37.2 min E: the point the Garmin examples name.
	const point = { lat: 48.82, lon: 2.62 };

	it('reads the same point at every spelling', () => {
		expect(parsePackedCoord('N48492E002372')).toEqual(point); // DDMM.m
		expect(parsePackedCoord('N484912E0023712')).toEqual(point); // DDMMSS
		expect(parsePackedCoord('N4849.2E00237.2')).toEqual(point); // explicit mark
		expect(parsePackedCoord('N4849,2E00237,2')).toEqual(point); // comma mark
		expect(parsePackedCoord('n48492e002372')).toEqual(point); // lower case
	});

	it('reads whole minutes and tenths of a second', () => {
		const dm = parsePackedCoord('N4849E00237');
		expect(dm?.lat).toBeCloseTo(48 + 49 / 60, 6);
		expect(dm?.lon).toBeCloseTo(2 + 37 / 60, 6);
		const dmss = parsePackedCoord('N4849123E00237123');
		expect(dmss?.lat).toBeCloseTo(48 + 49 / 60 + 12.3 / 3600, 6);
		expect(dmss?.lon).toBeCloseTo(2 + 37 / 60 + 12.3 / 3600, 6);
	});

	it('reads the hemisphere-last order, including our own SOFIA token', () => {
		expect(parsePackedCoord('48492N002372E')).toEqual(point);
		expect(parsePackedCoord('484912N0023712E')).toEqual(point);
		const sofia = latLonToSofiaToken(48.8167, 2.6167);
		expect(sofia).toBe('4849N00237E');
		expect(parsePackedCoord(sofia)).toEqual(parsePackedCoord('N4849E00237'));
	});

	it('negates the S and W hemispheres', () => {
		const dmm = parsePackedCoord('S12303W034150');
		expect(dmm?.lat).toBeCloseTo(-12.505, 6);
		expect(dmm?.lon).toBeCloseTo(-34.25, 6);
		expect(parsePackedCoord('S123018W0341500')).toEqual(dmm); // the DDMMSS twin
		expect(parsePackedCoord('1230S03415W')).toEqual({ lat: -12.5, lon: -34.25 });
	});

	it('rejects a pair whose axes disagree on precision', () => {
		expect(parsePackedCoord('N48492E00237')).toBeNull(); // a dropped digit
		expect(parsePackedCoord('N4849E002372')).toBeNull();
		expect(parsePackedCoord('484912N00237E')).toBeNull();
	});

	it('rejects minutes or seconds at 60 and over', () => {
		expect(parsePackedCoord('N4860E00237')).toBeNull();
		expect(parsePackedCoord('N484960E0023700')).toBeNull();
	});

	it('rejects past 90 / 180 degrees, the poles themselves passing', () => {
		expect(parsePackedCoord('N9001E00000')).toBeNull();
		expect(parsePackedCoord('N4849E18100')).toBeNull();
		expect(parsePackedCoord('N9000E18000')).toEqual({ lat: 90, lon: 180 });
	});

	it('rejects bare degrees and a mark on anything but whole minutes or seconds', () => {
		expect(parsePackedCoord('N48E002')).toBeNull();
		expect(parsePackedCoord('N484E0023')).toBeNull();
		expect(parsePackedCoord('N48492.5E002372.5')).toBeNull();
		expect(parsePackedCoord('N4849123.5E00237123.5')).toBeNull();
	});

	it('rejects the other notations and every ident shape in the datasets', () => {
		expect(parsePackedCoord('N48,8200/E2,62000')).toBeNull();
		expect(parsePackedCoord('48.82,2.62')).toBeNull();
		for (const ident of ['N01', 'N1', 'S2', '001AB', '00A', 'LFPL', 'LFBC-24-M']) {
			expect(parsePackedCoord(ident)).toBeNull();
			expect(parseCoordToken(ident)).toBeNull();
		}
	});

	it('rejects a spaced pair, which the field reads as two tokens', () => {
		expect(parsePackedCoord('N4849 E00237')).toBeNull();
	});
});

describe('parseCoordToken (the decimal notation)', () => {
	it('parses a signed "lat,lon" pair', () => {
		expect(parseCoordToken('48.82,2.62')).toEqual({ lat: 48.82, lon: 2.62 });
		expect(parseCoordToken('-12.5,-34.25')).toEqual({ lat: -12.5, lon: -34.25 });
	});

	it('rejects a pair carrying a space', () => {
		expect(parseCoordToken('48.82, 2.62')).toBeNull();
	});
});

describe('formatGarminCoord', () => {
	it('emits 6 significant figures per axis, matching the example', () => {
		expect(formatGarminCoord(48.82, 2.62)).toBe('N48,8200/E2,62000');
		expect(formatGarminCoord(48.45, 2.81)).toBe('N48,4500/E2,81000');
	});

	it('uses S / W for negative degrees', () => {
		expect(formatGarminCoord(-12.5, -34.25)).toBe('S12,5000/W34,2500');
	});

	it('shrinks the decimal count as the integer part grows', () => {
		// A 3-integer-digit longitude keeps the axis at 6 total digits (3 decimals).
		expect(formatGarminCoord(9.5, 123.456)).toBe('N9,50000/E123,456');
	});

	it('round-trips through parseCoordToken', () => {
		const cases: [number, number][] = [
			[48.82, 2.62],
			[-33.9, 151.18],
			[0, 0],
			[-0.5, 179.999],
		];
		for (const [lat, lon] of cases) {
			const p = parseCoordToken(formatGarminCoord(lat, lon));
			expect(p).not.toBeNull();
			if (p) {
				expect(p.lat).toBeCloseTo(lat, 4);
				expect(p.lon).toBeCloseTo(lon, 4);
			}
		}
	});
});

describe('looksLikeCoordToken', () => {
	it('is true for a hemisphere prefix or any token carrying a slash', () => {
		expect(looksLikeCoordToken('N48')).toBe(true);
		expect(looksLikeCoordToken('N48,8200/E2,6')).toBe(true);
		expect(looksLikeCoordToken('S1')).toBe(true);
	});

	it('is true from the fourth digit of the hemisphere-last order', () => {
		expect(looksLikeCoordToken('4849')).toBe(true);
		expect(looksLikeCoordToken('4849N0023')).toBe(true);
	});

	it('is false for an ident being typed', () => {
		expect(looksLikeCoordToken('LFP')).toBe(false);
		expect(looksLikeCoordToken('PMN')).toBe(false);
		expect(looksLikeCoordToken('001AB')).toBe(false);
		expect(looksLikeCoordToken('00A')).toBe(false);
		expect(looksLikeCoordToken('')).toBe(false);
	});
});

describe('setRouteFromText / serializeRoute (Garmin round-trip)', () => {
	const resolve = (tok: string): WaypointAnchor | null =>
		tok.toUpperCase() === 'LFPL'
			? { lat: 48.72, lon: 2.38, kind: 'airport', refId: 'LFPL', ident: 'LFPL', label: 'Paris' }
			: null;

	it('builds free waypoints from Garmin tokens mixed with idents', () => {
		clearRoute();
		const { unresolved } = setRouteFromText('LFPL N48,8200/E2,62000 N48,4500/E2,81000', resolve);
		expect(unresolved).toEqual([]);
		const wps = activeRoute().waypoints;
		expect(wps.map((w) => w.kind)).toEqual(['airport', 'free', 'free']);
		expect(wps[1].lat).toBeCloseTo(48.82, 4);
		expect(wps[1].lon).toBeCloseTo(2.62, 4);
		expect(wps[2].lat).toBeCloseTo(48.45, 4);
		clearRoute();
	});

	it('re-serialises free points in Garmin format (round-trip)', () => {
		clearRoute();
		setRouteFromText('LFPL N48,8200/E2,62000 N48,4500/E2,81000', resolve);
		expect(serializeRoute()).toBe('LFPL N48,8200/E2,62000 N48,4500/E2,81000');
		clearRoute();
	});

	it('still accepts the decimal lat,lon notation, re-emitting it as Garmin', () => {
		clearRoute();
		const { unresolved } = setRouteFromText('48.82,2.62', () => null);
		expect(unresolved).toEqual([]);
		expect(activeRoute().waypoints).toHaveLength(1);
		expect(activeRoute().waypoints[0].kind).toBe('free');
		expect(serializeRoute()).toBe('N48,8200/E2,62000');
		clearRoute();
	});

	it('keeps a reused ident waypoint\'s manual frequencies across a text edit', () => {
		clearRoute();
		setRouteFromText('LFPL', resolve);
		setWaypointFreqs(activeRoute().waypoints[0].id, 'TWR: 118.605');
		setRouteFromText('LFPL N48,8200/E2,62000', resolve); // reuse path, like notes
		expect(activeRoute().waypoints[0].freqsManual).toBe('TWR: 118.605');
		clearRoute();
	});

	it('builds free waypoints from packed tokens in either order, re-emitting them as Garmin', () => {
		clearRoute();
		const { unresolved } = setRouteFromText('LFPL N48492E002372 48492N002372E', resolve);
		expect(unresolved).toEqual([]);
		const wps = activeRoute().waypoints;
		expect(wps.map((w) => w.kind)).toEqual(['airport', 'free', 'free']);
		expect(wps[1].lat).toBeCloseTo(48.82, 4);
		expect(wps[1].lon).toBeCloseTo(2.62, 4);
		expect(wps[2].lat).toBeCloseTo(48.82, 4);
		expect(serializeRoute()).toBe('LFPL N48,8200/E2,62000 N48,8200/E2,62000');
		clearRoute();
	});

	it('keeps a comma-decimal packed token whole through the tokenizer', () => {
		clearRoute();
		const { unresolved } = setRouteFromText('N4849,2E00237,2', () => null);
		expect(unresolved).toEqual([]);
		expect(activeRoute().waypoints).toHaveLength(1);
		expect(serializeRoute()).toBe('N48,8200/E2,62000');
		clearRoute();
	});

	it('leaves an ident that starts like a coordinate to the resolver', () => {
		clearRoute();
		const idents = (tok: string): WaypointAnchor | null =>
			tok.toUpperCase() === 'N01'
				? { lat: 40.1, lon: -74.2, kind: 'airport', refId: 'N01', ident: 'N01' }
				: null;
		const { unresolved } = setRouteFromText('N01', idents);
		expect(unresolved).toEqual([]);
		expect(activeRoute().waypoints[0].ident).toBe('N01');
		clearRoute();
	});
});
