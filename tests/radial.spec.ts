/* Unit tests for the pure VOR radial (QDM / QDR) computation
 * (src/lib/route/radial.ts): the VOR-family predicate, the leg magnetic course
 * (which the QDM / QDR mirror, so they match the nav-log MC column), per-leg
 * placement of the entries, nearest-VOR selection, and the station label. */

import { describe, it, expect } from 'vitest';
import {
	ON_FIELD_VOR_RADIUS_NM,
	isVor,
	nearestVor,
	legMagneticCourse,
	radialStationLabel,
	waypointRadialEntries,
} from '$lib/route/radial';
import { initialBearingDeg } from '$lib/notam/geometry';
import { magneticFromTrue } from '$lib/route/magnetic';
import { fmtTrack } from '$lib/route/format';
import type { Navaid, NavaidType } from '$lib/data/navaids';

const YEAR = 2026.0;

function nv(
	type: NavaidType,
	ident: string,
	lat: number,
	lon: number,
	freq = '',
	channel = '',
): Navaid {
	return { id: `${type}:${ident}`, type, ident, name: ident, lat, lon, freq, channel, elev: null, source: 'fr' };
}

// Melun (LFPM) VOR/DME, MLN 113.6.
const MLN = nv('VOR-DME', 'MLN', 48.45578, 2.81329, '113.6');

describe('isVor', () => {
	const cases: [NavaidType, boolean][] = [
		['VOR', true],
		['VOR-DME', true],
		['VORTAC', true],
		['DME', false],
		['TACAN', false],
		['NDB', false],
		['ILS', false],
		['ILS-DME', false],
		['LOC', false],
		['WAYPOINT', false],
		['VFR_REPORTING_POINT', false],
	];
	for (const [t, exp] of cases) {
		it(`${t} -> ${exp}`, () => {
			expect(isVor(t)).toBe(exp);
		});
	}
});

describe('legMagneticCourse', () => {
	it('matches the nav-log MC formula (initial true track, mid-leg variation)', () => {
		const a = { lat: 48.0, lon: 2.0 };
		const b = { lat: 47.6, lon: 1.2 };
		const t = initialBearingDeg(a.lat, a.lon, b.lat, b.lon);
		const expected = magneticFromTrue(t, (a.lat + b.lat) / 2, (a.lon + b.lon) / 2, YEAR);
		expect(legMagneticCourse(a, b, YEAR)).toBeCloseTo(expected, 9);
	});
});

describe('waypointRadialEntries (per-leg placement, equals the MC column)', () => {
	const A = { lat: 48.2, lon: 1.8 };
	const C = { lat: 48.6, lon: 3.9 };

	it('puts the inbound QDM on the previous (non-VOR) waypoint, = leg MC', () => {
		// A -> MLN: MLN is the next fix's VOR, so its QDM sits here, on A's row.
		const entries = waypointRadialEntries(A, null, MLN, MLN, YEAR);
		const mc = fmtTrack(legMagneticCourse(A, MLN, YEAR));
		expect(entries).toEqual([
			{ stationLine: 'VOR/DME MLN 113.600', bearingLine: `QDM ${mc}`, navaidId: MLN.id },
		]);
	});

	it('puts the outbound QDR on the VOR itself, = leg MC', () => {
		// MLN -> C: MLN is this fix's VOR, so its QDR sits on MLN's row.
		const entries = waypointRadialEntries(MLN, MLN, C, null, YEAR);
		const mc = fmtTrack(legMagneticCourse(MLN, C, YEAR));
		expect(entries).toEqual([
			{ stationLine: 'VOR/DME MLN 113.600', bearingLine: `QDR ${mc}`, navaidId: MLN.id },
		]);
	});

	it('a VOR-to-VOR leg shows QDR (own) then QDM (next), both = leg MC', () => {
		const cdn = nv('VOR', 'CDN', 48.6, 3.9, '115.5');
		const entries = waypointRadialEntries(MLN, MLN, cdn, cdn, YEAR);
		const mc = fmtTrack(legMagneticCourse(MLN, cdn, YEAR));
		// The two entries name DIFFERENT stations, which is what the nav log's
		// per-line map flash resolves against.
		expect(entries).toEqual([
			{ stationLine: 'VOR/DME MLN 113.600', bearingLine: `QDR ${mc}`, navaidId: MLN.id },
			{ stationLine: 'VOR CDN 115.500', bearingLine: `QDM ${mc}`, navaidId: cdn.id },
		]);
	});

	it('never shows both QDM and QDR for the same station', () => {
		// Current ~0.6 NM from MLN and the next fix also resolves to MLN: only the
		// outbound QDR remains (the redundant same-station QDM is dropped).
		const near = { lat: MLN.lat + 0.01, lon: MLN.lon };
		const entries = waypointRadialEntries(near, MLN, C, MLN, YEAR);
		expect(entries).toHaveLength(1);
		expect(entries[0].bearingLine.startsWith('QDR ')).toBe(true);
	});

	it('no entries at the last fix or a zero-length leg', () => {
		expect(waypointRadialEntries(MLN, MLN, null, null, YEAR)).toEqual([]);
		expect(waypointRadialEntries(MLN, MLN, { lat: MLN.lat, lon: MLN.lon }, null, YEAR)).toEqual([]);
	});
});

describe('nearestVor', () => {
	const a = nv('VOR', 'AAA', 48.0, 2.0);
	const b = nv('VOR-DME', 'BBB', 48.02, 2.0); // ~1.2 NM north of (48, 2)
	const c = nv('VORTAC', 'CCC', 49.0, 2.0); // ~60 NM away
	const vors = [a, b, c];

	it('returns the closest VOR within the radius', () => {
		expect(nearestVor(48.0, 2.0, vors, 2)?.ident).toBe('AAA');
		expect(nearestVor(48.02, 2.0, vors, 2)?.ident).toBe('BBB');
	});

	it('returns null when none is within the radius', () => {
		expect(nearestVor(0, 0, vors, 2)).toBeNull();
	});

	it('the on-field radius covers VOR-DME CAV from the LFOK ARP (2.39 NM, Vatry)', () => {
		const cav = nv('VOR-DME', 'CAV', 48.78109, 4.14693, '111.65');
		expect(nearestVor(48.77333, 4.20616, [cav], ON_FIELD_VOR_RADIUS_NM)?.ident).toBe('CAV');
	});
});

describe('radialStationLabel', () => {
	it('shows type, ident, and 3-decimal frequency', () => {
		expect(radialStationLabel(nv('VOR-DME', 'MLN', 48.45, 2.81, '113.6'))).toBe('VOR/DME MLN 113.600');
		expect(radialStationLabel(nv('VOR', 'CDN', 45, 1, '115.5'))).toBe('VOR CDN 115.500');
		// No frequency: just type and ident.
		expect(radialStationLabel(nv('VORTAC', 'XYZ', 45, 1))).toBe('VORTAC XYZ');
	});
});
