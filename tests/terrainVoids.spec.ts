/* A no-data pixel in a PRESENT tile above the complete level is ground no
 * finer tier covers, not the sea. At the edge of a 30 m box the pyramid
 * pools a z11 parent from the z12 children that exist and carries a missing
 * child as NO_DATA (internal/terrain TestPool4CarriesAMissingChildAsNoData),
 * which nothing refills, z11 having no native tile of its own. The native
 * data writes the sea as 0 m. Read as the sea, such a quadrant took a massif
 * for open water: the alert's corridor resolved at z11 and graded the ground
 * 0 ft, and the shading painted it clear.
 *
 * World: a 2 000 m massif everywhere (z10 holds it natively), the z12 tiles
 * absent (outside the box), the z11 tile present with ground in its
 * north-west quadrant only. The aircraft flies at 6 000 ft over the
 * south-east quadrant, inside the massif. */

import { describe, expect, it } from 'vitest';
import {
	NO_DATA,
	capsuleTrackMaxFt,
	lngLatToTile,
	metresToFeet,
	peekCapsuleGround,
	terrainLevels,
	tileColLon,
	tileRowLat,
	type DecodedTile,
} from '$lib/map/terrain';
import { tileVoided } from '$lib/map/terrainShade';
import { destinationPoint } from '$lib/notam/geometry';
import { emptyTerrainPrev, evaluateTerrain } from '$lib/nav/terrainAlert';

const MASSIF_M = 2000;

function edgeTile(z: number, x: number, y: number): DecodedTile {
	const band = new Int16Array(256 * 256);
	for (let row = 0; row < 256; row++) {
		for (let col = 0; col < 256; col++) {
			band[row * 256 + col] = row < 128 && col < 128 ? MASSIF_M : NO_DATA;
		}
	}
	return { z, tx: x, ty: y, mean: band, max: band, min: band };
}

function flat(z: number, x: number, y: number, h: number): DecodedTile {
	const band = new Int16Array(256 * 256).fill(h);
	return { z, tx: x, ty: y, mean: band, max: band, min: band };
}

describe('a present z11 tile with a no-data quadrant at a 30 m box edge', () => {
	// The Europe box's east edge (45 E), 40 N.
	const t11 = lngLatToTile(40, 45.1, 11);
	const tx = Math.floor(t11.x);
	const ty = Math.floor(t11.y);
	const here = { lat: tileRowLat(11, ty, 192), lon: tileColLon(11, tx, 150) };
	const lookup = (z: number, x: number, y: number): DecodedTile | null | undefined => {
		if (z === 12) {
			return null; // outside the box: the worker's 204
		}
		if (z === 11) {
			return x === tx && y === ty ? edgeTile(z, x, y) : null;
		}
		return flat(z, x, y, MASSIF_M);
	};

	it('sends the corridor down to the complete level, where the massif is', () => {
		const dest = destinationPoint(here.lat, here.lon, 90, 1500); // stays in the quadrant
		const alongBins = Math.round(1500 / 200);
		const peek = peekCapsuleGround(here, dest, { halfWidthM: 463, alongBins, crossMax: 0, footprint: true }, lookup);
		expect({ z: peek.z, resolved: peek.resolved }).toEqual({ z: 10, resolved: true });
		const { maxFt, trackFt } = capsuleTrackMaxFt(peek.bins, alongBins);
		expect(maxFt[0]).toBeCloseTo(metresToFeet(MASSIF_M), 0);
		const r = evaluateTerrain(
			{
				nowMs: 0,
				pose: { lat: here.lat, lon: here.lon, mslFt: 6000, altTrusted: true, trackDeg: 90, speedKt: 120, vsFpm: 0 },
				vfr: true,
				airborne: true,
				departureEnded: true,
				field: null,
				ground: { binM: peek.frame.alongBinM, maxFt, trackFt, missing: 0, nearField: null },
				obstacles: [],
				acks: new Map(),
				tiers: { terrain: true, obstacle: true },
				inhibited: false,
			},
			emptyTerrainPrev(),
		);
		expect(r.alerts.map((a) => `${a.kind}:${a.level}`)).toEqual(['terrain:warning']);
	});

	it('has the shading stand an ancestor in for it, never paint it clear', () => {
		const levels = terrainLevels();
		expect(tileVoided(edgeTile(11, tx, ty), levels)).toBe(true);
		// A complete tile above the complete level is drawn as it stands.
		expect(tileVoided(flat(11, tx, ty, MASSIF_M), levels)).toBe(false);
		// At the complete level a no-data pixel is the sea.
		expect(tileVoided(edgeTile(10, tx >> 1, ty >> 1), levels)).toBe(false);
	});
});
