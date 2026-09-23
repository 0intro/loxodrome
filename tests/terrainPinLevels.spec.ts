/* The offline terrain pin holds every level the terrain alert's corridor
 * reads (state/offlineTerrain.svelte.ts pinLevels): the corridor prefers z11
 * north of about 49 N (pickLevel at its 200 m bins) and falls back as far as
 * the complete level, where the sea is answered. The pin held the deepest
 * level and the MSA corridor's level only, so a plan pinned for an offline
 * flight read "terrain not read" the whole way north of 49 N, and along a
 * coast wherever a z12 tile was the open sea, although the pinned z12 tiles
 * were decoded and in hand.
 *
 * The real pinLevels over a plan out of Reims-Prunay toward Charleville, and
 * the real peekCapsuleGround over a lookup holding exactly the pinned levels
 * (every other level failed to load, offline). */

import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/state/route.svelte', () => ({
	routes: {
		list: [
			{
				waypoints: [
					{ lat: 49.209, lon: 4.157 },
					{ lat: 49.783, lon: 4.647 },
				],
			},
		],
	},
	routeSettings: { corridorRadiusNM: 5, minAltCorridorRadiusNM: 5 },
}));

import {
	binMax,
	completeLevel,
	lngLatToTile,
	peekCapsuleGround,
	pickLevel,
	terrainLevels,
	type DecodedTile,
} from '$lib/map/terrain';
import { corridorTerrainLevels } from '$lib/route/minAltitude';
import { destinationPoint } from '$lib/notam/geometry';
import { ALONG_BIN_M, FLTA_HALF_WIDTH_NM } from '$lib/nav/terrainAlert';
import { NM_TO_METERS } from '$lib/notam/units';
import { pinLevels } from '$lib/state/offlineTerrain.svelte';

function flat(z: number, x: number, y: number, h: number): DecodedTile {
	const band = new Int16Array(256 * 256).fill(h);
	return { z, tx: x, ty: y, mean: band, max: band, min: band };
}

/** The corridor the state module reads 100 kt ahead of `here`. */
function corridor(here: { lat: number; lon: number }, trackDeg: number) {
	const lenM = ((100 * NM_TO_METERS) / 3600) * 60 + ALONG_BIN_M;
	const dest = destinationPoint(here.lat, here.lon, trackDeg, lenM);
	const alongBins = Math.round(lenM / ALONG_BIN_M);
	const opts = { halfWidthM: FLTA_HALF_WIDTH_NM * NM_TO_METERS, alongBins, crossMax: 0, footprint: true };
	return { dest, alongBins, opts, binM: lenM / alongBins };
}

describe('the pinned terrain levels', () => {
	const pinned = new Set(pinLevels());

	it('hold the deepest level, every level down to the complete one, and the MSA corridor level', () => {
		const l = terrainLevels();
		for (let z = completeLevel(l); z <= l.deepest; z++) {
			expect(pinned.has(z)).toBe(true);
		}
		const route = [
			{ lat: 49.209, lon: 4.157 },
			{ lat: 49.783, lon: 4.647 },
		];
		for (const z of corridorTerrainLevels(route, { halfWidthNM: 5 })) {
			expect(pinned.has(z)).toBe(true);
		}
	});

	it('answer the alert corridor offline north of 49 N, where it reads z11', () => {
		const here = { lat: 49.5, lon: 4.4 };
		const c = corridor(here, 30);
		expect(pickLevel(c.binM, here.lat)).toBe(11);
		const lookup = (z: number, x: number, y: number): DecodedTile | undefined =>
			pinned.has(z) ? flat(z, x, y, 150) : undefined;
		const peek = peekCapsuleGround(here, c.dest, c.opts, lookup);
		expect({ resolved: peek.resolved, bin0: binMax(peek.bins, 0) }).toEqual({ resolved: true, bin0: 150 });
	});

	it('answer it along a coast, where a z12 tile is the open sea', () => {
		// Above the complete level an absent tile is "no finer tier here", so
		// the read goes down to z11 and z10.
		const here = { lat: 43.52, lon: 7.0 };
		const c = corridor(here, 180);
		expect(pickLevel(c.binM, here.lat)).toBe(12);
		const seaRow = Math.floor(lngLatToTile(43.52, 7.0, 12).y) + 1;
		const lookup = (z: number, x: number, y: number): DecodedTile | null | undefined => {
			if (z === 12) {
				return y >= seaRow ? null : flat(z, x, y, 150); // pinned: land, or the worker's 204
			}
			return pinned.has(z) ? flat(z, x, y, 150) : undefined;
		};
		const peek = peekCapsuleGround(here, c.dest, c.opts, lookup);
		expect({ resolved: peek.resolved, bin0: binMax(peek.bins, 0) }).toEqual({ resolved: true, bin0: 150 });
	});
});
