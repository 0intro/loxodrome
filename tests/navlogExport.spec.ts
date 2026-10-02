/* The saved nav-log snapshot (src/lib/route/navlogExport.ts): the pure leg
 * math and formatting of buildSaveRoutes, with the state modules mocked
 * (the interactions.spec idiom) so no dataset or terrain fetch runs. Pins:
 * still-air vs wind-corrected ETE, the fmtWind snapshot, distanceRemaining
 * from the leg start, the mocked safety altitudes, the freqsManual
 * passthrough, and the alternate flag. */

import { describe, it, expect, vi } from 'vitest';
import type { Route, Waypoint } from '$lib/state/route.svelte';

const m = vi.hoisted(() => ({
	winds: [] as ({ dirDeg: number; speedKt: number; source: string } | null)[],
	mins: [] as (number | null)[],
	minAltOpts: null as { vfr?: boolean; marginFt?: number } | null,
	airports: [] as unknown[],
}));

vi.mock('$lib/state/data.svelte', () => ({
	ensureAirports: () => Promise.resolve([]),
	ensureAirspaces: () => Promise.resolve(null),
	ensureNavaids: () => Promise.resolve([]),
	ensureObstacles: () => Promise.reject(new Error('offline')), // exercises the catch
	getAirports: () => m.airports,
	getAirspaces: () => null,
	getNavaids: () => [],
	navaidById: () => null,
}));
vi.mock('$lib/state/routeWind.svelte', () => ({
	ensureRouteWindFor: () => Promise.resolve(),
	effectiveRouteWinds: () => m.winds,
	firstDepartureMs: () => null,
}));
vi.mock('$lib/state/routeTerrain.svelte', () => ({ routeTerrainSamples: () => null }));
vi.mock('$lib/state/windAloft.svelte', () => ({ windAloft: { tempTas: false } }));
vi.mock('$lib/state/freqOverride.svelte', () => ({
	resolveAirportRadios: (a: { radios: unknown[] }) => ({ radios: a.radios, flags: [] }),
	resolveScheduleRadios: (s: unknown) => s,
}));
vi.mock('$lib/route/minAltitude', () => ({
	computeMinAltitudes: (
		_pts: unknown,
		_obstacles: unknown,
		opts: { vfr?: boolean; marginFt?: number },
	) => {
		m.minAltOpts = opts;
		return Promise.resolve(m.mins);
	},
}));

import { buildSaveRoutes } from '$lib/route/navlogExport';

const wp = (id: string, lat: number, lon: number, extra: Partial<Waypoint> = {}): Waypoint => ({
	id, lat, lon, kind: 'free', alt: 2000, altAuto: false, ...extra,
});

const route = (waypoints: Waypoint[], alternate = false): Route => ({
	id: 'route-1', name: null, waypoints, selectedWaypointId: null, alternate,
});

const SETTINGS = {
	cruiseSpeedKt: 100,
	vfr: true,
	defaultAltitudeFt: 2000,
	airportFreqsInNavlog: false,
	enrouteFreqsInNavlog: false,
	vorRadialsInNavlog: false,
	minAltCorridorRadiusNM: 5,
};

// One degree of latitude due north: ~60 NM, true track ~360.
const NORTH = [wp('w1', 48, 2), wp('w2', 49, 2)];

describe('buildSaveRoutes', () => {
	it('still-air legs: ETE from the cruise speed, no heading, no wind text', async () => {
		m.winds = [null];
		m.mins = [4500];
		const [r] = await buildSaveRoutes([route(NORTH)], SETTINGS);
		expect(r.legs).toHaveLength(1);
		const leg = r.legs![0];
		const d = leg.distance!;
		expect(d).toBeCloseTo(60, 0);
		expect(leg.ete).toBeCloseTo((d / 100) * 60, 6);
		expect(leg.heading).toBeUndefined();
		expect(leg.wind).toBeUndefined();
		expect(leg.safetyAltitude).toBe(4500);
		expect(leg.distanceRemaining).toBeCloseTo(d, 9);
		expect(r.alternate).toBe(false);
		// The MSA scan rides the settings' flight rules (terrain-aware margin),
		// never a fixed scalar margin.
		expect(m.minAltOpts?.vfr).toBe(true);
		expect(m.minAltOpts?.marginFt).toBeUndefined();
	});

	it('a direct headwind slows the ETE, keeps heading = course, and prints the wind', async () => {
		m.winds = [{ dirDeg: 360, speedKt: 20, source: 'forecast' }];
		m.mins = [null];
		const [r] = await buildSaveRoutes([route(NORTH, true)], SETTINGS);
		const leg = r.legs![0];
		// Ground speed 80 kt against the 100 kt TAS.
		expect(leg.ete).toBeCloseTo((leg.distance! / 80) * 60, 6);
		expect(leg.heading).toBeCloseTo(leg.course!, 9); // zero drift on a pure headwind
		expect(leg.wind).toBe('360°/20 kt');
		expect(leg.safetyAltitude).toBeNull();
		expect(r.alternate).toBe(true);
	});

	it('remaining distance counts from each leg START; manual frequencies pass through', async () => {
		m.winds = [null, null];
		m.mins = [null, null];
		const wps = [wp('w1', 48, 2, { freqsManual: 'TWR : 118.605\n\nSIV : 120.150' }), wp('w2', 49, 2), wp('w3', 50, 2)];
		const [r] = await buildSaveRoutes([route(wps)], SETTINGS);
		const [l1, l2] = r.legs!;
		expect(l1.distanceRemaining).toBeCloseTo(l1.distance! + l2.distance!, 6);
		expect(l2.distanceRemaining).toBeCloseTo(l2.distance!, 6);
		expect(r.info![0].frequencies).toBe('TWR : 118.605\n\nSIV : 120.150');
		expect(r.info![1].frequencies).toBeUndefined();
	});

	it("prints an aerodrome's published services without guard", async () => {
		// EGKK publishes 121.500 under its tower and its director alike, which
		// coalescing turned into a "TWR / APP : 121.500" line of its own.
		m.winds = [null];
		m.mins = [null];
		m.airports = [
			{
				ident: 'EGKK',
				type: 'large_airport',
				radios: [
					{ freq: '126.825', unit: 'APP', call: 'GATWICK DIRECTOR' },
					{ freq: '121.500', unit: 'APP', call: 'GATWICK DIRECTOR' },
					{ freq: '124.230', unit: 'TWR', call: 'GATWICK TOWER' },
					{ freq: '121.500', unit: 'TWR', call: 'GATWICK TOWER' },
				],
			},
		];
		try {
			const wps = [wp('w1', 51.15, -0.19, { kind: 'airport', ident: 'EGKK' }), wp('w2', 52, -0.19)];
			const [r] = await buildSaveRoutes([route(wps)], { ...SETTINGS, airportFreqsInNavlog: true });
			expect(r.info![0].frequencies).toBe('TWR : 124.230\nAPP : 126.825');
		} finally {
			m.airports = [];
		}
	});

	it('no cruise speed: distances and courses still export, ETE stays undefined', async () => {
		m.winds = [null];
		m.mins = [];
		const [r] = await buildSaveRoutes([route(NORTH)], { ...SETTINGS, cruiseSpeedKt: null });
		const leg = r.legs![0];
		expect(leg.distance).toBeCloseTo(60, 0);
		expect(leg.course).toBeGreaterThanOrEqual(0);
		expect(leg.course).toBeLessThan(360);
		expect(leg.ete).toBeUndefined();
		expect(leg.safetyAltitude).toBeNull();
	});
});
