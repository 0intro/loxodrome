/* Relative terrain: the ground and the obstacles around the aircraft graded by
 * their height against the aircraft's own altitude, the convention of Garmin's
 * Terrain Proximity (GPS 175 / GNC 355 / GTN Xi pilot's guides, "Terrain
 * Elevation Depictions") that ForeFlight's Hazard Advisor also follows
 * (contract: docs/terrain-awareness.md).
 *
 *   red     the ground is at or above the aircraft, or less than 100 ft below
 *   yellow  the ground is between 100 ft and 1 000 ft below
 *   clear   the ground is more than 1 000 ft below
 *
 * The inks and thresholds are the firmware's own, read out of the GPS 175's
 * tables: terrain band 1 #FF0000 and band 2 #FFFF00 (the thresholds held as
 * 31 m and 305 m, Garmin's rounding of 100 ft and 1 000 ft), obstacles red
 * #FF0000 and a darker yellow #D2D200. The bands are a LIST, as the
 * firmware's own table is, so a five-band rotorcraft palette or a planning
 * palette would be a data change and not a code change.
 *
 * The altitude the bands are read against is the pose's height above mean sea
 * level (GPS through the geoid, Garmin's "GSL"): never the barometric altitude,
 * which this app does not have, and never a figure the pilot typed.
 *
 * Pure: no Svelte, no Leaflet, no DOM. The map layer, the obstacle layer, the
 * legend and the alert all read the rule from here, so the colour a pilot sees
 * and the tier an alert grades cannot disagree. */

/** Feet per metre, the conversion map/terrain.ts uses (metresToFeet). */
export const FT_PER_M = 3.28084;

/** A tier of the relative-terrain shading. */
export type TerrainTier = 'red' | 'yellow';

export interface TerrainBand {
	tier: TerrainTier;
	/** The band holds ground at or above (reference - belowFt). */
	belowFt: number;
	/** The ink the map paints the band in, fixed hex (map layers never read
	 *  CSS variables). */
	ink: string;
}

/** The fixed-wing bands, most severe first: the order is the precedence (the
 *  first band a height reaches is its tier). */
export const TERRAIN_BANDS: readonly TerrainBand[] = [
	{ tier: 'red', belowFt: 100, ink: '#ff0000' },
	{ tier: 'yellow', belowFt: 1000, ink: '#ffff00' },
];

/** The obstacle glyph inks per tier: the firmware's obstacle red, and its
 *  darker obstacle yellow, which holds its contrast as a thin glyph on a light
 *  chart where the terrain yellow would not. The thresholds are the terrain
 *  bands' own. Garmin's third tier, white for 1 000 to 2 000 ft below, is not
 *  drawn: a white glyph disappears on a light chart, and the obstacle keeps
 *  its chart ink there instead. */
export const OBSTACLE_TIER_INK: Readonly<Record<TerrainTier, string>> = {
	red: '#ff0000',
	yellow: '#d2d200',
};

/** The reference moves in steps of this many feet, so the map repaints on a
 *  climb rather than on every foot of GPS altitude noise. */
export const REFERENCE_QUANTUM_FT = 10;

/** How far past the next step a climb must go before the reference takes
 *  it: an altitude hovering on a step boundary would otherwise flip the
 *  step on every fix, and each flip repaints every tile in view. */
export const REFERENCE_HYSTERESIS_FT = 3;

/** The reference altitude on its quantum, rounded DOWN: a reference above
 *  the aircraft would colour less ground than the aircraft's own height
 *  does, which is the less cautious direction. */
export function quantiseReferenceFt(ft: number): number {
	return Math.floor(ft / REFERENCE_QUANTUM_FT) * REFERENCE_QUANTUM_FT;
}

/** The reference for altitude `ft`, following the one in force (`prev`, null
 *  for none): a descent below it moves it at once, since it must never stand
 *  above the aircraft, and a climb only once REFERENCE_HYSTERESIS_FT past the
 *  next step. Deterministic in the sequence of altitudes, so two layers fed
 *  the same fixes hold the same reference. */
export function nextReferenceFt(prev: number | null, ft: number): number {
	const q = quantiseReferenceFt(ft);
	if (prev == null || q < prev || ft >= prev + REFERENCE_QUANTUM_FT + REFERENCE_HYSTERESIS_FT) {
		return q;
	}
	return prev;
}

/** The tier of ground (or an obstacle top) at `elevFt` against an aircraft at
 *  `refFt`, both feet above mean sea level; null when the height is more than
 *  the deepest band below, or unknown. */
export function relativeTier(
	elevFt: number | null | undefined,
	refFt: number,
	bands: readonly TerrainBand[] = TERRAIN_BANDS,
): TerrainTier | null {
	if (elevFt == null || !Number.isFinite(elevFt) || !Number.isFinite(refFt)) {
		return null;
	}
	for (const b of bands) {
		if (elevFt >= refFt - b.belowFt) {
			return b.tier;
		}
	}
	return null;
}

/** The bands' lower edges in whole METRES, in the bands' order, for a raster
 *  of integer metres: ground `v` falls in band `i` when `v >= out[i]` (and in
 *  no earlier band). Rounded UP, because the tiles carry integer metres and
 *  `v >= ceil(x)` holds exactly when `v >= x` does, so the integer compare
 *  reproduces relativeTier's feet exactly. */
export function tierThresholdsM(
	refFt: number,
	bands: readonly TerrainBand[] = TERRAIN_BANDS,
): Int32Array {
	const out = new Int32Array(bands.length);
	for (let i = 0; i < bands.length; i++) {
		out[i] = Math.ceil((refFt - bands[i].belowFt) / FT_PER_M);
	}
	return out;
}
