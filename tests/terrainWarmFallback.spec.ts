/* When a corridor tile at the preferred level keeps failing (offline, a 5xx),
 * the terrain alert asks for the coarser level its read falls back to
 * (state/terrainAlert.svelte.ts warmCorridor). It asked for the preferred
 * level's tiles only, and those were never due again within the retry delay,
 * so the corridor stayed unread for as long as that level kept failing,
 * although a coarser level would have answered.
 *
 * Real state module, real peekCapsuleGround, real tile cache and queue; only
 * the store in front of the network is stubbed: every z12 read fails, every
 * other level answers a flat tile. */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { TrackPoint } from '$lib/nav/trace';

const asked: string[] = [];
vi.mock('$lib/offline/passiveStore', () => ({
	passiveFetchBlob: (url: string): Promise<Blob | null> => {
		const parts = url.split('/');
		const z = Number(parts.at(-3));
		const x = Number(parts.at(-2));
		const y = Number(parts.at(-1));
		asked.push(`${z}/${x}/${y}`);
		if (z === 12) {
			return Promise.reject(new Error('offline'));
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

// 45.63 N, where the corridor's preferred level is z12.
const LAT = 45.63;
const LON0 = 6.7;
const DLON = (120 * 1852) / 3600 / (111_320 * Math.cos((LAT * Math.PI) / 180));
const T0 = Date.parse('2026-07-08T13:40:00Z');

const settle = async (): Promise<void> => {
	for (let i = 0; i < 30; i++) {
		await new Promise((r) => setTimeout(r, 0));
	}
};

describe('a failing corridor tile at the preferred level', () => {
	it('asks for the coarser level the read falls back to, and reads the corridor', async () => {
		const pts: TrackPoint[] = [];
		for (let i = 0; i < 20; i++) {
			pts.push({ lat: LAT, lon: LON0 + i * DLON, altFt: 12000, timeMs: T0 + i * 1000, speedKt: 120, trackDeg: 90 });
		}
		const { importTrace, setPlayhead } = await import('$lib/state/navRecording.svelte');
		importTrace(pts, 'msl');
		const { terrainAlerts } = await import('$lib/state/terrainAlert.svelte');
		let last = null as ReturnType<typeof terrainAlerts>;
		for (let t = 5; t <= 19; t++) {
			setPlayhead(T0 + t * 1000);
			last = terrainAlerts();
			await settle();
		}
		const levels = [...new Set(asked.map((k) => Number(k.split('/')[0])))].sort((a, b) => a - b);
		expect(levels[levels.length - 1]).toBe(12);
		expect(levels.some((z) => z < 12)).toBe(true);
		expect(last?.unread).toBe(false);
	});
});
