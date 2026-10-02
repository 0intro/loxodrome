/* One stalled corridor tile request no longer blinds the terrain alert
 * (state/terrainAlert.svelte.ts WARM_STALL_MS). The alert warms ONE batch at a
 * time, and the flag holding the next one back was cleared only when the batch
 * settled: a request left open by a fading mobile link held it for good, the
 * corridor ahead was never asked for again, and the alert read "not read" for
 * the rest of the flight (391 of 391 seconds, six and a half minutes east at
 * 120 kt). Here the first request never settles at all, which the tile fetch's
 * own timeout now also prevents (terrainFetchTimeout.spec). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { TrackPoint } from '$lib/nav/trace';

const asked: string[] = [];
let stalled = false;
vi.mock('$lib/offline/passiveStore', () => ({
	passiveFetchBlob: (url: string): Promise<Blob | null> => {
		const parts = url.split('/');
		const z = Number(parts.at(-3));
		const x = Number(parts.at(-2));
		const y = Number(parts.at(-1));
		asked.push(`${z}/${x}/${y}`);
		if (!stalled) {
			stalled = true;
			return new Promise(() => {}); // the first request never settles
		}
		const raw = gunzipSync(readFileSync('tests/fixtures/terrain-12-2125-1464.tile'));
		const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
		view.setUint8(8, z);
		view.setUint32(12, x, true);
		view.setUint32(16, y, true);
		return Promise.resolve(new Blob([gzipSync(raw)]));
	},
}));
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

const LAT = 45.63;
const LON0 = 6.7;
const DLON = (120 * 1852) / 3600 / (111_320 * Math.cos((LAT * Math.PI) / 180));
const T0 = Date.parse('2026-07-08T13:40:00Z');
const settle = async (): Promise<void> => {
	for (let i = 0; i < 30; i++) {
		await new Promise((r) => setTimeout(r, 0));
	}
};

afterEach(() => {
	vi.useRealTimers();
});

describe('a stalled corridor tile request', () => {
	it('does not stop the corridor ahead from being warmed', { timeout: 60_000 }, async () => {
		// The wall clock moves with the playhead, as it does while recording:
		// the guard is about the network, which runs on the wall clock.
		vi.useFakeTimers({ toFake: ['Date'] });
		const pts: TrackPoint[] = [];
		for (let i = 0; i < 400; i++) {
			pts.push({ lat: LAT, lon: LON0 + i * DLON, altFt: 12000, timeMs: T0 + i * 1000, speedKt: 120, trackDeg: 90 });
		}
		const { importTrace, setPlayhead } = await import('$lib/state/navRecording.svelte');
		importTrace(pts, 'msl');
		const { terrainAlerts } = await import('$lib/state/terrainAlert.svelte');
		let last = null as ReturnType<typeof terrainAlerts>;
		for (let t = 5; t <= 395; t += 2) {
			vi.setSystemTime(T0 + t * 1000);
			setPlayhead(T0 + t * 1000);
			last = terrainAlerts();
			await settle();
		}
		const distinct = new Set(asked);
		// Six and a half minutes east at 120 kt cross ~13 NM: several z12
		// tiles beyond the first batch must have been asked for.
		expect(distinct.size).toBeGreaterThan(4);
		expect(last?.unread).toBe(false);
	});
});
