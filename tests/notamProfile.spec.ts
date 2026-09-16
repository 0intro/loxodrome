/* Pure specs for the route-profile NOTAM bands ($lib/route/notamProfile):
 * the inclusion rule (profile families, FIR-wide and activation exclusions,
 * geometry-bearing gate), the zero-width track walk (spans, multi-area
 * merge by id, boundary inclusivity, close-at-route-end), the OPADD limit
 * precedence (F/G over the Q-line band, 000/999 defaults = unknown), the
 * draw-ready placement (terrain-following AGL edges, open tops, key
 * prefix, validity tooltip) and the activation-hatch tooltip join (RTBA
 * per-zone windows). No Svelte state: the activation-representation test
 * is injected, as in the components. */

import { describe, it, expect } from 'vitest';
import {
	bandActivationInfo,
	computeNotamProfileBands,
	notamObstacleMarks,
	notamProfileLimits,
	placeNotamBands,
	profileRelevantNotam,
} from '$lib/route/notamProfile';
import { extractObstacleHeights } from '$lib/notam/obstacleHeights';
import { computeCeilingFt, type TerrainSample } from '$lib/route/routeProfile';
import { parseNotams } from '$lib/notam';
import type { Notam, NotamCoordinate, QualifierLine } from '$lib/notam/types';
import type { VLimit } from '$lib/vertical/limits';
import type { Waypoint } from '$lib/state/route.svelte';

function wp(id: string, lat: number, lon: number, alt = 3000): Waypoint {
	return { id, lat, lon, kind: 'free', alt, altAuto: true };
}

const psn = (lat: number, lon: number, radiusNM?: number): NotamCoordinate => ({
	lat,
	lon,
	original: '',
	type: 'psn',
	...(radiusNM != null ? { radius: radiusNM, radiusUnit: 'NM' as const } : {}),
});
const qcoord = (lat: number, lon: number, radiusNM: number | null): NotamCoordinate => ({
	lat,
	lon,
	original: '',
	type: 'qualifierLine',
	...(radiusNM != null ? { radius: radiusNM, radiusUnit: 'NM' as const } : {}),
});
const qual = (lower: number, upper: number): QualifierLine => ({
	fir: 'LFFF',
	code: 'QRRCA',
	traffic: 'IV',
	purpose: 'BO',
	scope: 'W',
	lower,
	upper,
	lat: 48,
	lon: 2,
	radius: 10,
});

function mkNotam(over: Partial<Notam> & { id: string }): Notam {
	return {
		fullContent: '',
		coordinates: [],
		icaoCodes: ['LFFF'],
		isPolygon: false,
		startDate: new Date('2026-07-10T06:00:00Z'),
		endDate: new Date('2026-07-12T20:00:00Z'),
		permanent: false,
		estimated: false,
		qCode: 'QRRCA',
		obstacleType: '',
		serviceStatus: '',
		qualifier: null,
		fgLower: null,
		fgUpper: null,
		replaces: null,
		...over,
	};
}
const idx = (notam: Notam, index: number): { notam: Notam; index: number } => ({ notam, index });
const keepAll = (): boolean => false;

// North-south route along the 2E meridian, 48N -> 49N (~60 NM).
const ROUTE = [wp('a', 48, 2), wp('b', 49, 2)];

describe('profileRelevantNotam', () => {
	it('keeps restriction / warning / obstacle families with published geometry', () => {
		const poly = mkNotam({
			id: 'R1',
			qCode: 'QRRCA',
			isPolygon: true,
			coordinates: [psn(48, 2), psn(48, 2.5), psn(48.5, 2.5), psn(48.5, 2)],
		});
		const pje = mkNotam({ id: 'W1', qCode: 'QWPLW', coordinates: [psn(48.2, 2, 2)] });
		const farm = mkNotam({ id: 'O1', qCode: 'QOBCE', coordinates: [psn(48.2, 2, 0.5)] });
		expect(profileRelevantNotam(poly)).toBe(true);
		expect(profileRelevantNotam(pje)).toBe(true);
		expect(profileRelevantNotam(farm)).toBe(true);
	});

	it('drops navcom / service families even with geometry', () => {
		const vor = mkNotam({ id: 'N1', qCode: 'QNVAS', coordinates: [psn(48.2, 2, 25)] });
		expect(profileRelevantNotam(vor)).toBe(false);
	});

	it('drops Q-line-only entries at ANY radius: influence circles are not boundaries', () => {
		const qCircle = mkNotam({ id: 'Q1', qCode: 'QRRCA', coordinates: [qcoord(48.2, 2, 10)] });
		const firWide = mkNotam({ id: 'F1', qCode: 'QRRCA', coordinates: [qcoord(48, 2, 999)] });
		const noRadius = mkNotam({ id: 'F2', qCode: 'QRRCA', coordinates: [qcoord(48, 2, null)] });
		expect(profileRelevantNotam(qCircle)).toBe(false);
		expect(profileRelevantNotam(firWide)).toBe(false);
		expect(profileRelevantNotam(noRadius)).toBe(false);
	});

	it('drops bare positions (no lateral extent for a zero-width track)', () => {
		const barePsn = mkNotam({ id: 'P1', qCode: 'QWPLW', coordinates: [psn(48.2, 2)] });
		expect(profileRelevantNotam(barePsn)).toBe(false);
	});
});

describe('computeNotamProfileBands', () => {
	it('walks a circle into one span around its abeam point', () => {
		const n = mkNotam({ id: 'C1', coordinates: [psn(48.5, 2, 5)] });
		const bands = computeNotamProfileBands(ROUTE, [idx(n, 7)], keepAll);
		expect(bands).toHaveLength(1);
		expect(bands[0].id).toBe('C1');
		expect(bands[0].index).toBe(7);
		expect(bands[0].spans).toHaveLength(1);
		// Centre abeam ~30 NM, radius 5: enter ~25, leave ~35 (1 NM sampling).
		expect(bands[0].spans[0].enterNM).toBeGreaterThan(23.5);
		expect(bands[0].spans[0].enterNM).toBeLessThan(26.5);
		expect(bands[0].spans[0].leaveNM).toBeGreaterThan(33.5);
		expect(bands[0].spans[0].leaveNM).toBeLessThan(36.5);
	});

	it('containment is boundary-inclusive (distance == radius is inside)', () => {
		// Zero-radius circle exactly on the first sample: <= keeps it.
		const n = mkNotam({ id: 'T1', coordinates: [psn(48, 2, 0)] });
		const bands = computeNotamProfileBands(ROUTE, [idx(n, 0)], keepAll);
		expect(bands).toHaveLength(1);
		expect(bands[0].spans[0].enterNM).toBe(0);
	});

	it('merges multi-area entries by id into one band with disjoint spans', () => {
		const a = mkNotam({ id: 'M1', coordinates: [psn(48.2, 2, 2)] });
		const b = mkNotam({ id: 'M1', coordinates: [psn(48.8, 2, 2)] });
		const bands = computeNotamProfileBands(ROUTE, [idx(a, 3), idx(b, 4)], keepAll);
		expect(bands).toHaveLength(1);
		expect(bands[0].index).toBe(3);
		expect(bands[0].spans).toHaveLength(2);
	});

	it('unions EVERY polygon ring of a multi-area group, not just the first', () => {
		// Zone 1 well west of the track, zone 2 crossing it: the band must
		// come from zone 2 (the union contract; a first-ring-only walk
		// found no span at all here).
		const west = mkNotam({
			id: 'M2',
			isPolygon: true,
			coordinates: [psn(48.2, 1), psn(48.2, 1.4), psn(48.4, 1.4), psn(48.4, 1)],
		});
		const onTrack = mkNotam({
			id: 'M2',
			isPolygon: true,
			coordinates: [psn(48.6, 1.9), psn(48.6, 2.1), psn(48.8, 2.1), psn(48.8, 1.9)],
		});
		const bands = computeNotamProfileBands(ROUTE, [idx(west, 1), idx(onTrack, 2)], keepAll);
		expect(bands).toHaveLength(1);
		expect(bands[0].spans).toHaveLength(1);
		// Zone 2 spans ~36-48 NM along the 48N -> 49N track.
		expect(bands[0].spans[0].enterNM).toBeGreaterThan(34);
		expect(bands[0].spans[0].leaveNM).toBeLessThan(50);
	});

	it('closes a span still containing the track at the destination', () => {
		const n = mkNotam({ id: 'E1', coordinates: [psn(49, 2, 3)] });
		const bands = computeNotamProfileBands(ROUTE, [idx(n, 0)], keepAll);
		expect(bands).toHaveLength(1);
		const total = bands[0].spans[0].leaveNM;
		expect(total).toBeGreaterThan(59);
		expect(total).toBeLessThan(61.5);
	});

	it('excludes entries the activation callback claims are hatched instead', () => {
		const act = mkNotam({ id: 'ACT1', coordinates: [psn(48.5, 2, 5)] });
		const bands = computeNotamProfileBands(ROUTE, [idx(act, 0)], (n) => n.id === 'ACT1');
		expect(bands).toHaveLength(0);
	});

	it('returns nothing for a degenerate route', () => {
		const n = mkNotam({ id: 'C1', coordinates: [psn(48.5, 2, 5)] });
		expect(computeNotamProfileBands([wp('a', 48, 2)], [idx(n, 0)], keepAll)).toHaveLength(0);
	});
});

describe('notamProfileLimits', () => {
	const aglLower: VLimit = { ft: 0, ref: 'AGL', value: 0, unit: 'ft', sfc: true };
	const aglUpper: VLimit = { ft: 800, ref: 'AGL', value: 800, unit: 'ft' };

	it('F)/G) wins over the Q-line band and keeps the datum', () => {
		const n = mkNotam({ id: 'L1', fgLower: aglLower, fgUpper: aglUpper, qualifier: qual(10, 20) });
		const l = notamProfileLimits(n);
		expect(l.known).toBe(true);
		expect(l.lower?.ref).toBe('AGL');
		expect(l.upper?.ft).toBe(800);
	});

	it('a lone F) keeps the upper open', () => {
		const n = mkNotam({ id: 'L2', fgLower: aglLower });
		const l = notamProfileLimits(n);
		expect(l.known).toBe(true);
		expect(l.upper).toBeNull();
	});

	it('falls back to a finite Q-line band as STD flight levels', () => {
		const n = mkNotam({ id: 'L3', qualifier: qual(20, 65) });
		const l = notamProfileLimits(n);
		expect(l.known).toBe(true);
		expect(l.lower).toMatchObject({ ft: 2000, ref: 'STD', unit: 'FL' });
		expect(l.upper).toMatchObject({ ft: 6500, ref: 'STD', unit: 'FL' });
	});

	it('maps Q 000 to a terrain-hugging SFC and Q 999 to UNL', () => {
		const n = mkNotam({ id: 'L4', qualifier: qual(0, 65) });
		const l = notamProfileLimits(n);
		expect(l.lower).toMatchObject({ ref: 'AGL', sfc: true });
		const m = notamProfileLimits(mkNotam({ id: 'L5', qualifier: qual(20, 999) }));
		expect(m.upper?.unl).toBe(true);
	});

	it('treats the bare OPADD defaults (000/999) and no data as unknown', () => {
		expect(notamProfileLimits(mkNotam({ id: 'L6', qualifier: qual(0, 999) })).known).toBe(false);
		expect(notamProfileLimits(mkNotam({ id: 'L7' })).known).toBe(false);
	});
});

describe('placeNotamBands', () => {
	const terrain: TerrainSample[] = [
		{ distNM: 0, elevFt: 1000 },
		{ distNM: 5, elevFt: 2000 },
		{ distNM: 10, elevFt: 1500 },
	];
	const band = (over: Partial<import('$lib/route/notamProfile').NotamCorridorBand>) => ({
		id: 'B1',
		index: 0,
		vLower: null,
		vUpper: null,
		knownExtent: false,
		permanent: false,
		estimated: false,
		startDate: new Date('2026-07-10T06:00:00Z'),
		endDate: new Date('2026-07-12T20:00:00Z'),
		qCode: 'QRRCA',
		spans: [{ enterNM: 0, leaveNM: 10 }],
		...over,
	});

	it('AGL limits follow the terrain like airspace bands (the RTBA shape)', () => {
		const [p] = placeNotamBands(
			[
				band({
					vLower: { ft: 0, ref: 'AGL', value: 0, unit: 'ft', sfc: true },
					vUpper: { ft: 800, ref: 'AGL', value: 800, unit: 'ft' },
					knownExtent: true,
				}),
			],
			terrain,
		);
		expect(p.key).toBe('notam:B1');
		expect(p.rtba).toBe(false); // never pecked: not an airspace identity
		expect(p.limitsText).toBe('SFC – 800 ft ASFC');
		expect(p.prohibited).toBe(false); // QRR* restricted area, not the RP subject
		// A prohibited-area NOTAM (Q subject RP) marks the band forbidden-tier.
		const [rp] = placeNotamBands([band({ qCode: 'QRPCA' })], terrain);
		expect(rp.prohibited).toBe(true);
		expect(p.spans[0].lowerPts.map((v) => v.altFt)).toEqual([1000, 2000, 1500]);
		expect(p.spans[0].upperPts.map((v) => v.altFt)).toEqual([1800, 2800, 2300]);
		expect(p.minFt).toBe(1000);
		expect(p.maxFt).toBe(2800);
	});

	it('a missing upper draws open-topped and stays out of the ceiling autoscale', () => {
		const placed = placeNotamBands(
			[
				band({
					vLower: { ft: 2000, ref: 'AMSL', value: 2000, unit: 'ft' },
					vUpper: null,
					knownExtent: true,
				}),
			],
			[],
		);
		expect(placed[0].topOpen).toBe(true);
		expect(placed[0].spans[0].upperPts).toEqual([]);
		// computeCeilingFt sees the drawn floor, never the Infinity top (which
		// would peg the 66000 clamp): base 10000 padded 10% rounds to 15000.
		expect(computeCeilingFt([], [], placed)).toBe(15000);
	});

	it('sorts by floor and prints the validity with PERM / EST', () => {
		const placed = placeNotamBands(
			[
				band({
					id: 'HIGH/26',
					vLower: { ft: 6500, ref: 'STD', value: 65, unit: 'FL' },
					vUpper: { ft: 9500, ref: 'STD', value: 95, unit: 'FL' },
					knownExtent: true,
					permanent: true,
				}),
				band({
					id: 'LOW/26',
					vLower: { ft: 0, ref: 'AGL', value: 0, unit: 'ft', sfc: true },
					vUpper: { ft: 2000, ref: 'AMSL', value: 2000, unit: 'ft' },
					knownExtent: true,
					estimated: true,
				}),
			],
			[],
		);
		expect(placed.map((p) => p.notamId)).toEqual(['LOW/26', 'HIGH/26']);
		expect(placed[1].tooltip).toContain('NOTAM HIGH/26');
		expect(placed[1].tooltip).toContain('– PERM');
		expect(placed[0].tooltip).toContain(' EST');
	});

	it('keeps the dashed unknown-extent convention', () => {
		const [p] = placeNotamBands([band({})], []);
		expect(p.knownExtent).toBe(false);
		expect(p.tooltip).toContain('? – ?');
	});
});

describe('extractObstacleHeights', () => {
	it('reads the French crane wording (metres converted, both figures)', () => {
		const r = extractObstacleHeights(
			'GRUE ERIGEE 483012N 0023045E HAUTEUR : 45M (148FT). ALT AU SOMMET : 542FT',
		);
		expect(r.hgtFt).toBe(148);
		expect(r.topFt).toBe(542);
	});

	it('reads the English wording (bilingual invariance)', () => {
		const r = extractObstacleHeights('CRANE ERECTED HEIGHT 350FT AGL, TOP ELEVATION 1650FT AMSL');
		expect(r.hgtFt).toBe(350);
		expect(r.topFt).toBe(1650);
	});

	it('converts a metric summit and keeps the tallest of several machines', () => {
		const r = extractObstacleHeights(
			'EOLIENNES : HAUTEUR 120M PUIS HAUTEUR 150M. SOMMET : 165M',
		);
		expect(r.hgtFt).toBe(492); // 150 m, the tallest
		expect(r.topFt).toBe(541); // 165 m
	});

	it('returns nulls when the text states nothing usable', () => {
		const r = extractObstacleHeights('OBSTACLE LIGHT UNSERVICEABLE');
		expect(r.topFt).toBeNull();
		expect(r.hgtFt).toBeNull();
	});
});

describe('notamObstacleMarks', () => {
	const ground = (): number => 500; // flat 500 ft terrain under the route

	it('marks a bare-position crane at its stated top, projected on the track', () => {
		const crane = mkNotam({
			id: 'O1',
			qCode: 'QOBCE',
			coordinates: [psn(48.5, 2)],
			fullContent: 'GRUE HAUTEUR : 45M (148FT). ALT AU SOMMET : 542FT',
		});
		const marks = notamObstacleMarks(ROUTE, [0, 60], [idx(crane, 4)], 5, ground);
		expect(marks).toHaveLength(1);
		expect(marks[0].topFt).toBe(542);
		expect(marks[0].baseFt).toBe(542 - 148);
		expect(marks[0].index).toBe(4);
		expect(marks[0].distNM).toBeGreaterThan(28);
		expect(marks[0].distNM).toBeLessThan(32);
	});

	it('falls back to G) against the ground, then to ground + height', () => {
		const viaFg = mkNotam({
			id: 'O2',
			qCode: 'QOBCE',
			coordinates: [psn(48.5, 2)],
			fgUpper: { ft: 800, ref: 'AGL', value: 800, unit: 'ft' },
		});
		expect(notamObstacleMarks(ROUTE, [0, 60], [idx(viaFg, 0)], 5, ground)[0].topFt).toBe(1300);
		const viaHgt = mkNotam({
			id: 'O3',
			qCode: 'QOBCE',
			coordinates: [psn(48.5, 2)],
			fullContent: 'MAT HAUTEUR : 100M',
		});
		expect(notamObstacleMarks(ROUTE, [0, 60], [idx(viaHgt, 0)], 5, ground)[0].topFt).toBe(828);
	});

	it('skips what it cannot place honestly', () => {
		const noFigures = mkNotam({ id: 'O4', qCode: 'QOBCE', coordinates: [psn(48.5, 2)] });
		const offTrack = mkNotam({
			id: 'O5',
			qCode: 'QOBCE',
			coordinates: [psn(48.5, 2.2)], // ~8 NM abeam at lat 48.5
			fullContent: 'ALT AU SOMMET : 900FT',
		});
		const banded = mkNotam({
			id: 'O6',
			qCode: 'QOBCE',
			coordinates: [psn(48.5, 2, 0.5)], // psn circle: an area, bands instead
			fullContent: 'ALT AU SOMMET : 900FT',
		});
		const notObstacle = mkNotam({
			id: 'W9',
			qCode: 'QWPLW',
			coordinates: [psn(48.5, 2)],
			fullContent: 'ALT AU SOMMET : 900FT',
		});
		const marks = notamObstacleMarks(
			ROUTE,
			[0, 60],
			[idx(noFigures, 0), idx(offTrack, 1), idx(banded, 2), idx(notObstacle, 3)],
			5,
			ground,
		);
		expect(marks).toHaveLength(0);
	});

	it('marks every position of a multi-machine entry with the shared figures', () => {
		const farm = mkNotam({
			id: 'O7',
			qCode: 'QOLCE',
			coordinates: [psn(48.3, 2), psn(48.6, 2)],
			fullContent: 'EOLIENNES HAUTEUR 150M',
		});
		const marks = notamObstacleMarks(ROUTE, [0, 60], [idx(farm, 0)], 5, ground);
		expect(marks).toHaveLength(2);
		expect(marks[0].topFt).toBe(500 + 492);
		expect(marks[0].distNM).toBeLessThan(marks[1].distNM);
	});
});

describe('bandActivationInfo', () => {
	const RTBA = `LFFA-Z0289/26
Q) LFXX/QRRCA/IV/BO/W/000/085/4721N00505E062
A) LFEE LFFF LFMM
B) 2606011130 C) 2606011330
E) ZONES AIRFORCE RTBA ACT
ZONE R45C ARBOIS
1130-1230:ACTIVE
ZONE R45S2 LANGRES
1130-1330:ACTIVE
F) SFC
G) FL085
`;

	it('lists the activating ids and the RTBA zone windows for THIS airspace', () => {
		const [n] = parseNotams(RTBA);
		const from = Date.parse('2026-06-01T00:00:00Z');
		const to = Date.parse('2026-06-01T23:59:00Z');
		const info = bandActivationInfo('LFR45C', [idx(n, 0)], from, to);
		expect(info.notamIds).toEqual(['LFFA-Z0289/26']);
		expect(info.windows).toHaveLength(1);
		expect(info.windows[0]).toContain('11:30');
		expect(info.windows[0]).toContain('12:30');
		// The sibling zone's window does not leak in.
		const other = bandActivationInfo('LFR45S2', [idx(n, 0)], from, to);
		expect(other.windows[0]).toContain('13:30');
	});

	it('a non-RTBA activation contributes its id with no windows', () => {
		const n = mkNotam({ id: 'A100/26', qCode: 'QRRCA', fullContent: 'LF-R123 ACTIVE' });
		const info = bandActivationInfo('LFR123', [idx(n, 0)], 0, Infinity);
		expect(info.notamIds).toEqual(['A100/26']);
		expect(info.windows).toEqual([]);
	});
});
