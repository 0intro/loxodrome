/* The rise gate compares each LANE of the corridor with the same lane under
 * the aircraft (nav/terrainAlert.ts). It compared the ground ahead with the
 * HIGHEST ground within the whole 0.25 NM half-width around the aircraft, so
 * a slope beside the track raised the baseline, and terrain straight ahead
 * standing above the aircraft never alerted: a pilot keeping to one side of a
 * valley flew into a spur unwarned.
 *
 * Real capsule fold (peekCapsuleGround at z12 over synthetic tiles), real
 * state module, real pure fold. World: a valley floor at 300 m; a side slope
 * 1000 m (3281 ft) high from 380 m north of the track (inside the 463 m
 * half-width); a spur ON the track (within 150 m either side) 1020 m
 * (3346 ft) high, 20 s ahead. The aircraft flies level east at 3 000 ft,
 * 120 kt: the spur is 346 ft ABOVE it, 20 s away. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecodedTile } from '$lib/map/terrain';
import type { TrackPoint } from '$lib/nav/trace';

const world = vi.hoisted(() => ({ side: true, spurLon: 0 }));

const LAT = 46;
const LON0 = 6;
const M_PER_DEG_LAT = 111_320;

vi.mock('$lib/map/terrain', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/map/terrain')>();
	const height = (lat: number, lon: number): number => {
		const northM = (lat - LAT) * M_PER_DEG_LAT;
		if (lon >= world.spurLon && Math.abs(northM) <= 150) {
			return 1020;
		}
		if (world.side && northM >= 380) {
			return 1000;
		}
		return 300;
	};
	const lookup = (z: number, x: number, y: number): DecodedTile => {
		const max = new Int16Array(256 * 256);
		for (let row = 0; row < 256; row++) {
			const lat = real.tileRowLat(z, y, row);
			for (let col = 0; col < 256; col++) {
				max[row * 256 + col] = height(lat, real.tileColLon(z, x, col));
			}
		}
		return { z, tx: x, ty: y, mean: max, max, min: max };
	};
	return {
		...real,
		peekCapsuleGround: (
			a: Parameters<typeof real.peekCapsuleGround>[0],
			b: Parameters<typeof real.peekCapsuleGround>[1],
			opts: Parameters<typeof real.peekCapsuleGround>[2],
		) => real.peekCapsuleGround(a, b, { ...opts, z: 12 }, lookup),
		visitTiles: () => Promise.resolve({ visited: 0, missing: 0, sea: 0 }),
		terrainTileDue: () => false,
		elevationFtAt: () => Promise.resolve(984),
		peekElevationFtAt: () => undefined,
	};
});
const none = vi.hoisted(() => ({ airports: [] as unknown[], obstacles: [] as unknown[] }));
vi.mock('$lib/state/data.svelte', () => ({
	dataState: { airspacesLoaded: false, airportsLoaded: true, obstaclesLoaded: true },
	getAirspaces: () => [],
	getSupaips: () => [],
	getAirports: () => none.airports,
	getNavaids: () => [],
	getObstacles: () => none.obstacles,
	airportByIdent: () => null,
	navaidById: () => null,
	ensureAirports: () => Promise.resolve([]),
	ensureAirspaces: () => Promise.resolve(null),
	ensureNavaids: () => Promise.resolve([]),
	ensureObstacles: () => Promise.resolve([]),
	ensureSupaip: () => Promise.resolve([]),
}));
vi.mock('$lib/state/routeTerrain.svelte', () => ({ routeTerrainSamples: () => null }));

const DLON = (120 * 1852) / 3600 / (M_PER_DEG_LAT * Math.cos((LAT * Math.PI) / 180));
const T0 = Date.parse('2026-07-08T13:40:00Z');

function trace(): TrackPoint[] {
	const pts: TrackPoint[] = [];
	for (let i = 0; i < 20; i++) {
		pts.push({ lat: LAT, lon: LON0 + i * DLON, altFt: 3000, timeMs: T0 + i * 1000, speedKt: 120, trackDeg: 90 });
	}
	return pts;
}

async function evalWith(side: boolean) {
	vi.resetModules();
	world.side = side;
	world.spurLon = LON0 + (19 + 20) * DLON; // 20 s ahead of the last fix
	const { importTrace, setPlayhead } = await import('$lib/state/navRecording.svelte');
	importTrace(trace(), 'msl');
	setPlayhead(T0 + 19_000);
	const { terrainAlerts } = await import('$lib/state/terrainAlert.svelte');
	return terrainAlerts();
}

describe('the rise gate compares each lane with the same lane under the aircraft', () => {
	beforeEach(() => {
		world.side = true;
	});

	it('control: the spur alone (no side slope) is a warning', async () => {
		const r = await evalWith(false);
		expect(r?.alerts.map((a) => `${a.kind}:${a.level}`)).toEqual(['terrain:warning']);
	});

	it('a slope 380 m to the side no longer disarms a spur 346 ft above the path, 20 s ahead', async () => {
		const r = await evalWith(true);
		// What a pilot flying at 3 000 ft into 3 346 ft terrain should get:
		expect(r?.alerts.map((a) => `${a.kind}:${a.level}`)).toEqual(['terrain:warning']);
	});
});
