/* The terrain alert's obstacle gather (corridorObstacles in
 * state/terrainAlert.svelte.ts) wraps at the antimeridian as the ground half
 * does: its search box was not wrapped, nor the obstacle's longitude
 * difference, so an obstacle just across the antimeridian from the aircraft
 * was never in the corridor. 52 N, eastbound at 120 kt and 900 ft over the
 * sea, a 1 000 ft mast 20 s ahead. */

import { describe, expect, it, vi } from 'vitest';
import type { DecodedTile } from '$lib/map/terrain';
import type { TrackPoint } from '$lib/nav/trace';

vi.mock('$lib/map/terrain', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/map/terrain')>();
	const lookup = (z: number, x: number, y: number): DecodedTile => {
		const band = new Int16Array(256 * 256); // 0 m: the sea
		return { z, tx: x, ty: y, mean: band, max: band, min: band };
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
		elevationFtAt: () => Promise.resolve(0),
		peekElevationFtAt: () => undefined,
	};
});
const data = vi.hoisted(() => ({ airports: [] as unknown[], obstacles: [] as unknown[] }));
vi.mock('$lib/state/data.svelte', () => ({
	dataState: { airspacesLoaded: false, airportsLoaded: true, obstaclesLoaded: true },
	getAirspaces: () => [],
	getSupaips: () => [],
	getAirports: () => data.airports,
	getNavaids: () => [],
	getObstacles: () => data.obstacles,
	airportByIdent: () => null,
	navaidById: () => null,
	ensureAirports: () => Promise.resolve([]),
	ensureAirspaces: () => Promise.resolve(null),
	ensureNavaids: () => Promise.resolve([]),
	ensureObstacles: () => Promise.resolve([]),
	ensureSupaip: () => Promise.resolve([]),
}));
vi.mock('$lib/state/routeTerrain.svelte', () => ({ routeTerrainSamples: () => null }));

const LAT = 52;
const DLON = (120 * 1852) / 3600 / (111_320 * Math.cos((LAT * Math.PI) / 180));
const T0 = Date.parse('2026-07-08T13:40:00Z');
const wrap = (lon: number): number => ((lon + 540) % 360) - 180;

/** The alert rows with the aircraft's last fix at `lastLon` and the mast
 *  20 s ahead of it. */
async function rows(lastLon: number): Promise<string[] | undefined> {
	vi.resetModules();
	const pts: TrackPoint[] = [];
	for (let i = 0; i < 20; i++) {
		pts.push({
			lat: LAT,
			lon: wrap(lastLon - (19 - i) * DLON),
			altFt: 900,
			timeMs: T0 + i * 1000,
			speedKt: 120,
			trackDeg: 90,
		});
	}
	data.obstacles = [
		{
			id: 'm1',
			type: 'mast',
			name: 'MAST',
			lat: LAT,
			lon: wrap(lastLon + 20 * DLON),
			elev: 1000,
			hgt: 900,
			lit: true,
			group: false,
			rmk: '',
			source: 'faa',
		},
	];
	const { importTrace, setPlayhead } = await import('$lib/state/navRecording.svelte');
	importTrace(pts, 'msl');
	setPlayhead(T0 + 19_000);
	const { terrainAlerts } = await import('$lib/state/terrainAlert.svelte');
	return terrainAlerts()?.alerts.map((a) => `${a.kind}:${a.level}`);
}

describe('an obstacle across the antimeridian', () => {
	it('warns a degree short of it', async () => {
		expect(await rows(178.99)).toEqual(['obstacle:warning']);
	});
	it('warns just across it, as short of it', async () => {
		expect(await rows(179.99)).toEqual(['obstacle:warning']);
	});
});
