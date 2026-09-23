/* The figures docs/terrain-awareness.md publishes, pinned by VALUE. The
 * behaviour specs use the constants by name, so a changed figure keeps them
 * green: widening the rise gate or the aerodrome's surroundings would
 * silence alerts and pass. A change here is a change to the contract, and
 * the doc (its "Defaults" table and the corpus figures measured against
 * them) changes with it. */

import { describe, expect, it } from 'vitest';
import {
	AERODROME_SURROUND_FT,
	AERODROME_ZONE_NM,
	ALONG_BIN_M,
	CAUTION_S,
	DEMOTE_HOLD_MS,
	DESCENT_FPM,
	FLTA_HALF_WIDTH_NM,
	GROUND_SAME_M,
	RISE_FT,
	RUNWAY_INHIBIT_FT,
	RUNWAY_INHIBIT_NM,
	SOUND_REARM_MS,
	TRACK_STRIP_M,
	VFR_CLEARANCE_FT,
	VS_CREDIT_S,
	WARNING_S,
} from '$lib/nav/terrainAlert';
import { OBSTACLE_TIER_INK, REFERENCE_QUANTUM_FT, TERRAIN_BANDS } from '$lib/nav/terrainAwareness';
import { TERRAIN_NODATA_ALPHA, TERRAIN_NODATA_INK, TERRAIN_SHADE_ALPHA } from '$lib/map/terrainShade';
import { TILE_RETRY_MS } from '$lib/map/terrain';

describe('the published terrain figures', () => {
	it('grade the alert as the contract states', () => {
		expect({ CAUTION_S, WARNING_S, VS_CREDIT_S, DESCENT_FPM }).toEqual({
			CAUTION_S: 60,
			WARNING_S: 30,
			VS_CREDIT_S: 30,
			DESCENT_FPM: -300,
		});
		expect({ FLTA_HALF_WIDTH_NM, ALONG_BIN_M, RISE_FT, VFR_CLEARANCE_FT }).toEqual({
			FLTA_HALF_WIDTH_NM: 0.25,
			ALONG_BIN_M: 200,
			RISE_FT: 100,
			VFR_CLEARANCE_FT: 100,
		});
		// The strip about the track whose ground above the aircraft overrides
		// the rise gate: a quarter of the corridor's half-width.
		expect(TRACK_STRIP_M).toBeCloseTo(115.75, 2);
		expect({ AERODROME_ZONE_NM, AERODROME_SURROUND_FT, RUNWAY_INHIBIT_NM, RUNWAY_INHIBIT_FT }).toEqual({
			AERODROME_ZONE_NM: 2,
			AERODROME_SURROUND_FT: 500,
			RUNWAY_INHIBIT_NM: 1,
			RUNWAY_INHIBIT_FT: 200,
		});
	});

	it('hold the presentation memory as the contract states', () => {
		expect({ DEMOTE_HOLD_MS, SOUND_REARM_MS, GROUND_SAME_M }).toEqual({
			DEMOTE_HOLD_MS: 10_000,
			SOUND_REARM_MS: 300_000,
			GROUND_SAME_M: 100,
		});
	});

	it('shade the map as the contract states', () => {
		expect(TERRAIN_BANDS.map((b) => [b.belowFt, b.ink])).toEqual([
			[100, '#ff0000'],
			[1000, '#ffff00'],
		]);
		expect(OBSTACLE_TIER_INK).toMatchObject({ red: '#ff0000', yellow: '#d2d200' });
		expect({ TERRAIN_SHADE_ALPHA, TERRAIN_NODATA_ALPHA, TERRAIN_NODATA_INK, REFERENCE_QUANTUM_FT }).toEqual({
			TERRAIN_SHADE_ALPHA: 0.5,
			TERRAIN_NODATA_ALPHA: 0.7,
			TERRAIN_NODATA_INK: '#78909c',
			REFERENCE_QUANTUM_FT: 10,
		});
		expect(TILE_RETRY_MS).toBe(60_000);
	});
});
