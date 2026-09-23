/* The rise gate over REAL relief: the committed Mont Blanc tile (z12
 * 2126/1459), the state module's own corridor recipe (60 s and one bin, 200 m
 * bins, 0.25 NM half-width in three lanes, by footprint; capsuleTrackMaxFt)
 * and the real pure fold.
 *
 * Sweep: start points on a grid inside the tile, 36 headings, 100 kt level,
 * the aircraft 300, 500 or 1 000 ft above the ground directly under it. Every
 * case where the straight path meets ground above the aircraft within 30 s
 * (flying into terrain) must alert. Gated alone against the corridor's
 * highest ground under the aircraft, the fold let 82 of 1 375 such paths go
 * silent at 300 ft, 34 at 500 ft and 10 at 1 000 ft: the valley wall beside
 * the aircraft disarmed the spur on its track. Ground on the track above the
 * aircraft now overrides the gate. */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodeTerrainTile } from '$lib/map/terrainTile';
import {
	binMax,
	capsuleTrackMaxFt,
	metresToFeet,
	reduceCapsuleFromTiles,
	tileColLon,
	tilePixel,
	tileRowLat,
	type DecodedTile,
} from '$lib/map/terrain';
import { destinationPoint } from '$lib/notam/geometry';
import { emptyTerrainPrev, evaluateTerrain, FLTA_HALF_WIDTH_NM, TRACK_STRIP_M } from '$lib/nav/terrainAlert';
import { NM_TO_METERS } from '$lib/notam/units';

const KT = 100;
const MPS = (KT * 1852) / 3600;

describe('the rise gate over the Mont Blanc tile', () => {
	for (const agl of [300, 500, 1000]) {
		it(`alerts on every straight path into ground above the aircraft within 30 s, ${agl} ft up`, async () => {
			const d = await decodeTerrainTile(readFileSync('tests/fixtures/terrain-alps-12-2126-1459.tile'));
			const tile: DecodedTile = { z: d!.z, tx: d!.x, ty: d!.y, mean: d!.mean, max: d!.max!, min: d!.min! };
			const lookup = (z: number, x: number, y: number): DecodedTile | undefined =>
				z === tile.z && x === tile.tx && y === tile.ty ? tile : undefined;
			const halfWidthM = FLTA_HALF_WIDTH_NM * NM_TO_METERS;
			let into = 0;
			let missed = 0;
			for (let row = 40; row <= 216; row += 16) {
				for (let col = 40; col <= 216; col += 16) {
					const lat = tileRowLat(tile.z, tile.ty, row);
					const lon = tileColLon(tile.z, tile.tx, col);
					const p = tilePixel(lat, lon, tile.z);
					const mslFt = metresToFeet(tile.mean[p.py * 256 + p.px]) + agl;
					for (let hdg = 0; hdg < 360; hdg += 10) {
						const lenM = MPS * 60 + 200;
						const dest = destinationPoint(lat, lon, hdg, lenM);
						const alongBins = Math.round(lenM / 200);
						const peek = reduceCapsuleFromTiles(
							{ lat, lon },
							dest,
							{ halfWidthM, alongBins, crossMax: 1, crossBinM: 2 * TRACK_STRIP_M, z: 12, footprint: true },
							lookup,
						);
						if (peek.missing.length > 0) {
							continue; // the corridor leaves the one tile held
						}
						// Ground above the aircraft ON ITS STRAIGHT PATH (a 30 m strip
						// about the track) within 30 s: flying into the ground.
						const strip = reduceCapsuleFromTiles({ lat, lon }, dest, { halfWidthM: 30, alongBins, crossMax: 0, z: 12 }, lookup);
						let hits = false;
						for (let i = 1; i <= alongBins; i++) {
							const m = binMax(strip.bins, i);
							if ((i * strip.frame.alongBinM) / MPS <= 30 && m != null && metresToFeet(m) > mslFt) {
								hits = true;
							}
						}
						if (!hits) {
							continue;
						}
						into++;
						const { maxFt, trackFt } = capsuleTrackMaxFt(peek.bins, alongBins);
						const r = evaluateTerrain(
							{
								nowMs: 0,
								pose: { lat, lon, mslFt, altTrusted: true, trackDeg: hdg, speedKt: KT, vsFpm: 0 },
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
						if (r.alerts.length === 0) {
							missed++;
						}
					}
				}
			}
			expect(into).toBeGreaterThan(100);
			expect(missed).toBe(0);
		});
	}
});
