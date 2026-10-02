import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseNotams } from '$lib/notam';
import type { Notam, LatLon } from '$lib/notam';
import { NM_TO_METERS } from '$lib/notam/units';
import type { Airspace } from '$lib/data/airspaces';
import { FIR_WIDE_RADIUS_NM, isFirWideEntry } from '$lib/notam/geometry';
import {
	corridorIntersectsCircle,
	corridorIntersectsRing,
	corridorNotamIds,
	entryOnCorridor,
	type CorridorOptions,
} from '$lib/route/notamCorridor';

const HALF_15NM = 15 * NM_TO_METERS;

// A west-east route along latitude 48 (segments lie on a parallel, so the
// hand-computed degree distances below are exact under the planar model).
const ROUTE: LatLon[] = [
	{ lat: 48, lon: 0 },
	{ lat: 48, lon: 2 },
];

function bboxOf(ring: [number, number][]): {
	minLat: number;
	minLon: number;
	maxLat: number;
	maxLon: number;
} {
	let minLat = Infinity;
	let minLon = Infinity;
	let maxLat = -Infinity;
	let maxLon = -Infinity;
	for (const [lat, lon] of ring) {
		if (lat < minLat) minLat = lat;
		if (lat > maxLat) maxLat = lat;
		if (lon < minLon) minLon = lon;
		if (lon > maxLon) maxLon = lon;
	}
	return { minLat, minLon, maxLat, maxLon };
}

function firRow(id: string, ring: [number, number][]): Airspace {
	return {
		id,
		key: `${id}|${id}`,
		type: 'FIR',
		name: id,
		category: 'fir',
		ring,
		bbox: bboxOf(ring),
	} as unknown as Airspace;
}

/** Minimal Q-line-fallback entry (the parser's no-E-geometry shape). */
function qlineNotam(opts: {
	id?: string;
	fir?: string;
	codes?: string[];
	radius?: number;
	qCode?: string;
	lat?: number;
	lon?: number;
}): Notam {
	return {
		id: opts.id ?? 'Q0001/26',
		icaoCodes: opts.codes ?? ['LFFF'],
		qCode: opts.qCode ?? 'QSTAH',
		isPolygon: false,
		coordinates: [
			{
				lat: opts.lat ?? 48.5,
				lon: opts.lon ?? 1,
				original: '',
				type: 'qualifierLine',
				...(opts.radius !== undefined
					? { radius: opts.radius, radiusUnit: 'NM' as const }
					: {}),
			},
		],
		qualifier: {
			fir: opts.fir ?? 'LFFF',
			code: opts.qCode ?? 'QSTAH',
			traffic: 'IV',
			purpose: 'BO',
			scope: 'E',
			lower: 0,
			upper: 999,
			lat: opts.lat ?? 48.5,
			lon: opts.lon ?? 1,
			radius: opts.radius ?? null,
		},
	} as unknown as Notam;
}

describe('corridorIntersectsRing', () => {
	it('keeps a route enclosed by a large ring (waypoint-inside branch)', () => {
		const ring: [number, number][] = [[47, -1], [49, -1], [49, 3], [47, 3]];
		expect(corridorIntersectsRing(ROUTE, HALF_15NM, ring)).toBe(true);
	});

	it('catches a skinny strip crossing mid-segment (edge-crossing branch)', () => {
		// Vertical 0.01-deg-wide strip: every vertex is ~111 km off the
		// track (far beyond 15 NM) and no waypoint is inside, so only the
		// edge-vs-segment test can see it. This is the case a 1 NM route
		// sampler can step over.
		const ring: [number, number][] = [[47, 1], [49, 1], [49, 1.01], [47, 1.01]];
		expect(corridorIntersectsRing(ROUTE, HALF_15NM, ring)).toBe(true);
	});

	it('keeps a small ring abeam within the half-width, drops one beyond', () => {
		// Nearest vertex 0.2 deg lat = 22.3 km off the track: inside 15 NM
		// (27.8 km). At 0.4 deg (44.5 km) it must drop.
		const near: [number, number][] = [[48.2, 0.5], [48.25, 0.5], [48.25, 0.6], [48.2, 0.6]];
		const far: [number, number][] = [[48.4, 0.5], [48.45, 0.5], [48.45, 0.6], [48.4, 0.6]];
		expect(corridorIntersectsRing(ROUTE, HALF_15NM, near)).toBe(true);
		expect(corridorIntersectsRing(ROUTE, HALF_15NM, far)).toBe(false);
	});

	it('catches a ring edge nearest a route VERTEX mid-edge (vertex-vs-edge branch)', () => {
		// Tall rectangle east of the route end: its vertices are hundreds of
		// km away, nothing crosses, but its western edge passes ~14.9 km
		// (0.2 deg lon at lat 48) from the waypoint at (48, 1).
		const route: LatLon[] = [{ lat: 48, lon: 0 }, { lat: 48, lon: 1 }];
		const ring: [number, number][] = [[40, 1.2], [56, 1.2], [56, 3], [40, 3]];
		expect(corridorIntersectsRing(route, HALF_15NM, ring)).toBe(true);
	});
});

describe('corridorIntersectsCircle', () => {
	const route: LatLon[] = [{ lat: 48, lon: 0 }, { lat: 48, lon: 1 }];

	it('passes iff distance <= halfWidth + radius', () => {
		// Centre 0.5 deg lat = 55.7 km off the track; 15 NM half-width.
		expect(corridorIntersectsCircle(route, HALF_15NM, 48.5, 0.5, 30000)).toBe(true);
		expect(corridorIntersectsCircle(route, HALF_15NM, 48.5, 0.5, 20000)).toBe(false);
	});

	it('treats a radius-less position as a point', () => {
		expect(corridorIntersectsCircle(route, HALF_15NM, 48.1, 0.5, 0)).toBe(true);
		expect(corridorIntersectsCircle(route, HALF_15NM, 48.6, 0.5, 0)).toBe(false);
	});
});

describe('isFirWideEntry', () => {
	it('flags the whole-FIR sentinel and the radius-less Q-line entry', () => {
		expect(isFirWideEntry(qlineNotam({ radius: FIR_WIDE_RADIUS_NM }))).toBe(true);
		expect(isFirWideEntry(qlineNotam({}))).toBe(true); // no radius at all
	});

	it('keeps large-but-finite circles and real positions geometric', () => {
		expect(isFirWideEntry(qlineNotam({ radius: 400 }))).toBe(false);
		const psn = {
			...qlineNotam({}),
			coordinates: [{ lat: 48, lon: 1, original: '', type: 'psn' }],
		} as unknown as Notam;
		expect(isFirWideEntry(psn)).toBe(false);
	});
});

describe('entryOnCorridor', () => {
	it('passes when ANY coordinate of a multi-position entry is in reach', () => {
		const n = {
			id: 'W0001/26',
			icaoCodes: ['LFFF'],
			qCode: 'QWULW',
			isPolygon: false,
			coordinates: [
				{ lat: 44, lon: 5, original: '', type: 'psn' },
				{ lat: 48.1, lon: 1, original: '', type: 'psn' },
			],
			qualifier: null,
		} as unknown as Notam;
		expect(entryOnCorridor(n, ROUTE, HALF_15NM)).toBe(true);
	});
});

describe('corridorNotamIds', () => {
	const LFFF_RING: [number, number][] = [[47, 0], [50, 0], [50, 5], [47, 5]];
	const baseOpts: CorridorOptions = {
		halfWidthNM: 15,
		firWideRule: 'fir-cross',
		airspaces: [firRow('LFFF', LFFF_RING)],
		lookupAirport: null,
	};
	const ROUTE_IN_LFFF: LatLon[] = [{ lat: 48, lon: 1 }, { lat: 48.5, lon: 2 }];
	const ROUTE_OUTSIDE: LatLon[] = [{ lat: 40, lon: 10 }, { lat: 41, lon: 11 }];

	it('fir-cross keeps a FIR-wide NOTAM iff the corridor crosses its FIR', () => {
		const n = qlineNotam({ radius: 999 });
		expect(corridorNotamIds([n], [ROUTE_IN_LFFF], baseOpts).has(n.id)).toBe(true);
		expect(corridorNotamIds([n], [ROUTE_OUTSIDE], baseOpts).has(n.id)).toBe(false);
	});

	it('honours the include / exclude variants', () => {
		const n = qlineNotam({ radius: 999 });
		expect(
			corridorNotamIds([n], [ROUTE_OUTSIDE], { ...baseOpts, firWideRule: 'include' }).has(n.id),
		).toBe(true);
		expect(
			corridorNotamIds([n], [ROUTE_IN_LFFF], { ...baseOpts, firWideRule: 'exclude' }).has(n.id),
		).toBe(false);
	});

	it('fails open when the FIR dataset is absent or the FIR is unknown', () => {
		const n = qlineNotam({ radius: 999 });
		expect(
			corridorNotamIds([n], [ROUTE_OUTSIDE], { ...baseOpts, airspaces: null }).has(n.id),
		).toBe(true);
		// The SIA multi-FIR placeholder resolves to no loaded FIR row.
		const placeholder = qlineNotam({ fir: 'LFXX', codes: ['LFXX'], radius: 999 });
		expect(
			corridorNotamIds([placeholder], [ROUTE_OUTSIDE], baseOpts).has(placeholder.id),
		).toBe(true);
	});

	it('a multi-FIR NOTAM passes through any of its A) FIRs', () => {
		const n = qlineNotam({ fir: 'LFXX', codes: ['LFMM', 'LFFF'], radius: 999 });
		expect(corridorNotamIds([n], [ROUTE_IN_LFFF], baseOpts).has(n.id)).toBe(true);
	});

	it('checklists follow the FIR-wide rule (no carve-out)', () => {
		const n = qlineNotam({ qCode: 'QKKKK', radius: 999 });
		expect(corridorNotamIds([n], [ROUTE_IN_LFFF], baseOpts).has(n.id)).toBe(true);
		expect(corridorNotamIds([n], [ROUTE_OUTSIDE], baseOpts).has(n.id)).toBe(false);
	});

	it('per-id: one on-corridor entry passes every entry of the source NOTAM', () => {
		const farPolygon = {
			id: 'R9999/26',
			icaoCodes: ['LFFF'],
			qCode: 'QRTCA',
			isPolygon: true,
			coordinates: [
				{ lat: 52, lon: 10, original: '', type: 'psn' },
				{ lat: 52.2, lon: 10, original: '', type: 'psn' },
				{ lat: 52.2, lon: 10.2, original: '', type: 'psn' },
			],
			qualifier: null,
		} as unknown as Notam;
		const nearPosition = {
			id: 'R9999/26',
			icaoCodes: ['LFFF'],
			qCode: 'QRTCA',
			isPolygon: false,
			coordinates: [{ lat: 48.1, lon: 1.5, original: '', type: 'psn' }],
			qualifier: null,
		} as unknown as Notam;
		const ids = corridorNotamIds([farPolygon, nearPosition], [ROUTE_IN_LFFF], baseOpts);
		expect(ids.has('R9999/26')).toBe(true);
	});

	it('falls back to the A) idents for an entry with no geometry at all', () => {
		const n = {
			id: 'F0001/26',
			icaoCodes: ['LFAI'],
			qCode: '',
			isPolygon: false,
			coordinates: [],
			qualifier: null,
		} as unknown as Notam;
		const onField: CorridorOptions = {
			...baseOpts,
			airspaces: null,
			lookupAirport: () => ({ lat: 48.2, lon: 1.2 }),
		};
		const farField: CorridorOptions = {
			...baseOpts,
			airspaces: null,
			lookupAirport: () => ({ lat: 44, lon: 8 }),
		};
		const unknown: CorridorOptions = { ...baseOpts, airspaces: null, lookupAirport: null };
		expect(corridorNotamIds([n], [ROUTE_IN_LFFF], onField).has(n.id)).toBe(true);
		expect(corridorNotamIds([n], [ROUTE_IN_LFFF], farField).has(n.id)).toBe(false);
		expect(corridorNotamIds([n], [ROUTE_IN_LFFF], unknown).has(n.id)).toBe(true);
	});
});

describe('corridorNotamIds over the curated fixtures', () => {
	const positions = parseNotams(
		readFileSync(new URL('./fixtures/positions', import.meta.url), 'utf-8'),
	);
	const areas = parseNotams(
		readFileSync(new URL('./fixtures/areas', import.meta.url), 'utf-8'),
	);
	const opts: CorridorOptions = {
		halfWidthNM: 15,
		firWideRule: 'exclude',
		airspaces: null,
		lookupAirport: null,
	};

	it('includes a French PSN NOTAM when the track passes by, not otherwise', () => {
		// LFFA-W2942/24: PSN 484024N 0030441E (48.673 N, 3.078 E).
		const near = corridorNotamIds(
			positions,
			[[{ lat: 48.5, lon: 3.078 }, { lat: 48.9, lon: 3.078 }]],
			opts,
		);
		const far = corridorNotamIds(
			positions,
			[[{ lat: 44, lon: 0 }, { lat: 44, lon: 1 }]],
			opts,
		);
		expect(near.has('LFFA-W2942/24')).toBe(true);
		expect(far.has('LFFA-W2942/24')).toBe(false);
	});

	it('reaches through a French RAYON: the circle extends the corridor', () => {
		// W0470/26: PSN 460450.1N 0061455E RAYON 2000M (46.0806 N, 6.2486 E).
		// With a 0.5 NM half-width (926 m), a track 2.5 km abeam only matches
		// through the NOTAM's own 2000 m radius; 4.6 km abeam stays out.
		const tight: CorridorOptions = { ...opts, halfWidthNM: 0.5 };
		const inReach = corridorNotamIds(
			positions,
			[[{ lat: 45.9, lon: 6.281 }, { lat: 46.3, lon: 6.281 }]],
			tight,
		);
		const outOfReach = corridorNotamIds(
			positions,
			[[{ lat: 45.9, lon: 6.3086 }, { lat: 46.3, lon: 6.3086 }]],
			tight,
		);
		expect(inReach.has('W0470/26')).toBe(true);
		expect(outOfReach.has('W0470/26')).toBe(false);
	});

	it('includes a multi-zone SUP AIP trigger via the one zone the track crosses', () => {
		// LFFA-R2339/25 emits one entry per ZRT polygon; the track crosses
		// 'ZRT COTENTIN HIGH' (around 49.3-50.0 N, 1.1-0.9 W) and stays far
		// from every other zone. A German track sees none of them.
		const through = corridorNotamIds(
			areas,
			[[{ lat: 49.6, lon: -1.5 }, { lat: 49.6, lon: -0.5 }]],
			opts,
		);
		const elsewhere = corridorNotamIds(
			areas,
			[[{ lat: 52, lon: 10 }, { lat: 53, lon: 11 }]],
			opts,
		);
		expect(through.has('LFFA-R2339/25')).toBe(true);
		expect(elsewhere.has('LFFA-R2339/25')).toBe(false);
	});
});

describe('corridorNotamIds over the Europe briefing (perf smoke)', () => {
	it('filters ~10k NOTAMs against a 4-leg route in well under a second', () => {
		const notams = parseNotams(
			readFileSync(new URL('./fixtures/Europe-20260203.txt', import.meta.url), 'utf-8'),
		);
		const pruatlas = JSON.parse(
			readFileSync(
				new URL('../public/data/pruatlas-firs.json', import.meta.url),
				'utf-8',
			),
		) as { rows: unknown[][] };
		const firs = pruatlas.rows.map((r) =>
			firRow(String(r[0]), r[12] as [number, number][]),
		);
		// Paris - Lyon - Marseille - Nice.
		const route: LatLon[] = [
			{ lat: 48.85, lon: 2.35 },
			{ lat: 45.76, lon: 4.84 },
			{ lat: 43.3, lon: 5.37 },
			{ lat: 43.66, lon: 7.21 },
		];
		const t0 = Date.now();
		const ids = corridorNotamIds(notams, [route], {
			halfWidthNM: 15,
			firWideRule: 'fir-cross',
			airspaces: firs,
			lookupAirport: null,
		});
		const elapsed = Date.now() - t0;
		const total = new Set(notams.map((n) => n.id)).size;
		expect(ids.size).toBeGreaterThan(0);
		expect(ids.size).toBeLessThan(total / 2); // a real subset, not a pass-through
		expect(elapsed).toBeLessThan(1000); // generous CI bound; ~tens of ms locally
	});
});
