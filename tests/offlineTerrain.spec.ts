// Route-corridor terrain pins (docs/offline-maps.md): the pure enumeration
// and reconciliation of offline/terrainPin.ts.

import { describe, expect, it } from 'vitest';
import {
	computePinOps,
	corridorTerrainTiles,
	estimateBytes,
	isoDay,
} from '../src/lib/offline/terrainPin';

const paris = { lat: 48.85, lon: 2.35 };
const alps = { lat: 45.05, lon: 7.05 };

describe('corridorTerrainTiles', () => {
	it('pins a contiguous swath along a leg, deduped and in-grid', () => {
		const tiles = corridorTerrainTiles([[paris, alps]], 10, [12]);
		expect(tiles.length).toBeGreaterThan(100);
		const keys = new Set(tiles.map((t) => `${t.x}/${t.y}`));
		expect(keys.size).toBe(tiles.length);
		for (const t of tiles) {
			expect(t.z).toBe(12);
			expect(t.x).toBeGreaterThanOrEqual(0);
			expect(t.x).toBeLessThan(1 << 12);
			expect(t.y).toBeGreaterThanOrEqual(0);
			expect(t.y).toBeLessThan(1 << 12);
		}
	});

	it('contains the endpoints own tiles', () => {
		const tiles = corridorTerrainTiles([[paris, alps]], 10, [12]);
		const keys = new Set(tiles.map((t) => `${t.x}/${t.y}`));
		// z12 tile of Paris 48.85N 2.35E: x = (2.35+180)/360*4096 = 2074,
		// y from the Mercator formula = 1409.
		expect(keys.has('2074/1409')).toBe(true);
	});

	it('grows with the radius and dedupes overlapping routes', () => {
		const narrow = corridorTerrainTiles([[paris, alps]], 5, [12]).length;
		const wide = corridorTerrainTiles([[paris, alps]], 15, [12]).length;
		expect(wide).toBeGreaterThan(narrow * 2);
		const twice = corridorTerrainTiles(
			[
				[paris, alps],
				[paris, alps],
			],
			5,
			[12],
		).length;
		expect(twice).toBe(narrow);
	});

	it('ignores routes with fewer than two waypoints', () => {
		expect(corridorTerrainTiles([[paris]], 10, [12])).toEqual([]);
		expect(corridorTerrainTiles([], 10, [12])).toEqual([]);
	});

	it('clamps to the Mercator grid near the poles', () => {
		const tiles = corridorTerrainTiles(
			[
				[
					{ lat: 85.0, lon: 0 },
					{ lat: 85.0, lon: 1 },
				],
			],
			30,
			[12],
		);
		for (const t of tiles) {
			expect(t.y).toBeGreaterThanOrEqual(0);
			expect(t.y).toBeLessThan(1 << 12);
		}
	});
});

describe('computePinOps', () => {
	it('fetches the missing, drops the stale, keeps the overlap', () => {
		const ops = computePinOps(new Set(['a', 'b']), ['b', 'c']);
		expect(ops.toFetch).toEqual(['c']);
		expect(ops.toDrop).toEqual(['a']);
	});
	it('is a no-op on identical sets and a full replace on disjoint ones', () => {
		expect(computePinOps(new Set(['a']), ['a'])).toEqual({ toFetch: [], toDrop: [] });
		expect(computePinOps(new Set(['a']), ['b'])).toEqual({ toFetch: ['b'], toDrop: ['a'] });
	});
});

describe('labels', () => {
	it('estimates a conservative 50 KB per tile', () => {
		expect(estimateBytes(300)).toBe(15_000_000);
	});
	it('formats the pin day as a UTC date', () => {
		expect(isoDay(Date.UTC(2026, 7, 4, 12))).toBe('2026-08-04');
	});
});
