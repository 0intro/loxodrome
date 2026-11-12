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
	addWaypointFromSnap,
	clearRoute,
	routeHistory,
	routeTokenPosition,
	setRouteFromText,
	serializeRoute,
	activeRoute,
	setWaypointFreqs,
	undoRoute,
	type WaypointAnchor,
} from '$lib/state/route.svelte';
import type { WaypointResolver } from '$lib/route/anchorChoice';

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
	it('rejects a pair past 90 / 180 degrees, like its two siblings', () => {
		expect(parseCoordToken('48.82,200.5')).toBeNull();
		expect(parseCoordToken('91,2.62')).toBeNull();
		expect(parseCoordToken('-90,180')).not.toBeNull();
	});

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

	// A longitude of 100° or more prints 3 decimals (6 significant figures), a
	// rounding of up to 5e-4 that the field's text then carries: the point must
	// still be found again, its name, altitude and notes with it.
	it.each([
		['Nouméa', -22.27583, 166.45833],
		['Half Moon Bay', 37.51333, -122.50111],
		['Bora Bora', -16.44444, -151.75111],
	])('keeps a named free point at %s through an edit of the text', (label, lat, lon) => {
		clearRoute();
		const w = addWaypointFromSnap({ lat, lon, kind: 'free', label });
		const id = w.id;
		setRouteFromText(`${serializeRoute()} `, () => null);
		const wps = activeRoute().waypoints;
		expect(wps).toHaveLength(1);
		expect(wps[0].id).toBe(id);
		expect(wps[0].label).toBe(label);
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

// The field's tokens split on whitespace and commas, so an identifier holding
// either (IE "RIVERSTOWN VILLAGE", IT "MJNW1=PASSO DEL TURCHINO") or a named
// free point (a town) travels as its position, the pin carrying what it is.
describe('setRouteFromText: a pick the field cannot spell', () => {
	const resolve = (tok: string): WaypointAnchor | null =>
		tok.toUpperCase() === 'LFPL'
			? { lat: 48.72, lon: 2.38, kind: 'airport', refId: 'LFPL', ident: 'LFPL', label: 'Paris' }
			: null;
	const riverstown = {
		lat: 53.69028,
		lon: -8.27139,
		kind: 'navaid',
		refId: 'IE:VRP:EIDW:RIVERSTOWN',
		ident: 'RIVERSTOWN VILLAGE',
	} as const;

	it('prints an identifier holding a space as its position, and keeps it through an edit', () => {
		clearRoute();
		const w = addWaypointFromSnap(riverstown);
		expect(serializeRoute()).toBe(formatGarminCoord(riverstown.lat, riverstown.lon));
		const { unresolved } = setRouteFromText(`${serializeRoute()} `, () => null);
		expect(unresolved).toEqual([]);
		const wps = activeRoute().waypoints;
		expect(wps).toHaveLength(1);
		expect(wps[0].id).toBe(w.id);
		expect(wps[0].kind).toBe('navaid');
		expect(wps[0].ident).toBe('RIVERSTOWN VILLAGE');
		clearRoute();
	});

	it('pins such an anchor on the coordinate token it travels as', () => {
		clearRoute();
		const tok = formatGarminCoord(riverstown.lat, riverstown.lon);
		setRouteFromText(`LFPL ${tok}`, resolve, { pin: { index: 1, anchor: riverstown } });
		const w = activeRoute().waypoints[1];
		expect(w.kind).toBe('navaid');
		expect(w.ident).toBe('RIVERSTOWN VILLAGE');
		expect(w.lat).toBe(riverstown.lat);
		expect(w.picked).toBe(true);
		expect(serializeRoute()).toBe(`LFPL ${tok}`);
		clearRoute();
	});

	it('names a free point from its pin, at the pin\'s own position', () => {
		clearRoute();
		const town = { kind: 'free', lat: 48.43512, lon: 2.16021, label: 'Étampes' } as const;
		const tok = formatGarminCoord(town.lat, town.lon);
		setRouteFromText(`LFPL ${tok}`, resolve, { pin: { index: 1, anchor: town } });
		const w = activeRoute().waypoints[1];
		expect(w.kind).toBe('free');
		expect(w.label).toBe('Étampes');
		expect(w.lat).toBe(48.43512);
		expect(w.lon).toBe(2.16021);
		// The name stays through the next keystroke, like any named free point.
		setRouteFromText(`${serializeRoute()} `, resolve);
		expect(activeRoute().waypoints[1].label).toBe('Étampes');
		clearRoute();
	});

	it('leaves a pin naming another position, or a free pin on an identifier, unused', () => {
		clearRoute();
		setRouteFromText('LFPL N48,0000/E2,0000', resolve, {
			pin: { index: 1, anchor: { kind: 'free', lat: 47, lon: 3, label: 'Elsewhere' } },
		});
		expect(activeRoute().waypoints[1].label).toBeUndefined();
		setRouteFromText('LFPL', resolve, { pin: { index: 0, anchor: { kind: 'free', lat: 1, lon: 2, label: 'x' } } });
		expect(activeRoute().waypoints[0].kind).toBe('airport');
		clearRoute();
	});
});

// KCIR names Calvi's IR reporting point and Cairo Regional, Illinois; the
// route field resolves it where the route around it is (route/anchorChoice.ts).
describe('setRouteFromText: an identifier naming several features', () => {
	const LFKC: WaypointAnchor = { lat: 42.52436, lon: 8.79301, kind: 'airport', refId: 'LFKC', ident: 'LFKC' };
	const LFKO: WaypointAnchor = { lat: 41.66028, lon: 8.89389, kind: 'airport', refId: 'LFKO', ident: 'LFKO' };
	const CAIRO: WaypointAnchor = { lat: 37.06447, lon: -89.21956, kind: 'airport', refId: 'KCIR', ident: 'KCIR' };
	const VRP: WaypointAnchor = { lat: 42.64444, lon: 8.93167, kind: 'navaid', refId: 'WPT:8397617', ident: 'KCIR', label: 'KC-IR' };
	const table = (withVrp: boolean): Record<string, WaypointAnchor[]> => ({
		LFKC: [LFKC],
		LFKO: [LFKO],
		KCIR: withVrp ? [CAIRO, VRP] : [CAIRO],
	});
	const resolver = (withVrp = true): WaypointResolver => {
		const t = table(withVrp);
		return Object.assign((tok: string) => t[tok.toUpperCase()]?.[0] ?? null, {
			candidates: (tok: string) => t[tok.toUpperCase()] ?? [],
		});
	};

	it('places it where the route passes', () => {
		clearRoute();
		setRouteFromText('LFKC KCIR LFKO', resolver());
		const w = activeRoute().waypoints[1];
		expect(w.kind).toBe('navaid');
		expect(w.refId).toBe('WPT:8397617');
		expect(w.picked).toBeUndefined();
		clearRoute();
	});

	it('moves a point typed before the navaids loaded once they have, keeping the waypoint', () => {
		clearRoute();
		setRouteFromText('LFKC KCIR LFKO', resolver(false));
		const before = activeRoute().waypoints[1];
		expect(before.refId).toBe('KCIR'); // Cairo, the only candidate yet
		before.notes = 'call Calvi';
		before.alt = 3500;
		setRouteFromText('LFKC KCIR LFKO', resolver(true));
		const after = activeRoute().waypoints[1];
		expect(after.id).toBe(before.id);
		expect(after.refId).toBe('WPT:8397617');
		expect(after.notes).toBe('call Calvi');
		expect(after.alt).toBe(3500);
		clearRoute();
	});

	it('keeps a feature the pilot picked on the map through an edit of the text', () => {
		clearRoute();
		setRouteFromText('LFKC', resolver());
		addWaypointFromSnap(CAIRO); // the menu's "Add waypoint" on Cairo itself
		expect(activeRoute().waypoints[1].picked).toBe(true);
		setRouteFromText('LFKC KCIR LFKO', resolver());
		const w = activeRoute().waypoints[1];
		expect(w.refId).toBe('KCIR');
		expect(w.picked).toBe(true);
		clearRoute();
	});

	it('takes the autocomplete pick as the token pin', () => {
		clearRoute();
		setRouteFromText('LFKC KCIR LFKO', resolver(), { pin: { index: 1, anchor: CAIRO } });
		const w = activeRoute().waypoints[1];
		expect(w.refId).toBe('KCIR');
		expect(w.picked).toBe(true);
		// The pick survives the next keystroke, which carries no pin.
		setRouteFromText('LFKC KCIR LFKO LFKC', resolver());
		expect(activeRoute().waypoints[1].refId).toBe('KCIR');
		clearRoute();
	});

	it('lets the map centre place a lone point, and nothing once the route has a certain one', () => {
		clearRoute();
		setRouteFromText('KCIR', resolver(), { near: { lat: 42.5, lon: 8.8 } });
		expect(activeRoute().waypoints[0].refId).toBe('WPT:8397617');
		setRouteFromText('KCIR', resolver(), { near: { lat: 38, lon: -89 } });
		expect(activeRoute().waypoints[0].refId).toBe('KCIR');
		setRouteFromText('LFKC KCIR', resolver(), { near: { lat: 38, lon: -89 } });
		expect(activeRoute().waypoints[1].refId).toBe('WPT:8397617');
		clearRoute();
	});

	it('answers the autocomplete reference where the route resolves the token', () => {
		clearRoute();
		setRouteFromText('LFKC KCIR LFKO', resolver());
		expect(routeTokenPosition('LFKC KCIR LFKO', 1, resolver())).toEqual({ lat: VRP.lat, lon: VRP.lon });
		expect(routeTokenPosition('LFKC KCIR LFKO', 0, resolver())).toEqual({ lat: LFKC.lat, lon: LFKC.lon });
		expect(routeTokenPosition('LFKC N48,8200/E2,62000', 1, resolver())).toEqual({ lat: 48.82, lon: 2.62 });
		expect(routeTokenPosition('LFKC', 3, resolver())).toBeNull();
		clearRoute();
	});

	it('is one undo step per typing session, as before', () => {
		clearRoute();
		const serial = routeHistory.serial;
		setRouteFromText('LFKC', resolver());
		setRouteFromText('LFKC KCIR', resolver());
		setRouteFromText('LFKC KCIR LFKO', resolver());
		expect(routeHistory.serial).toBe(serial + 1);
		undoRoute();
		expect(activeRoute().waypoints).toHaveLength(0);
		clearRoute();
	});
});
