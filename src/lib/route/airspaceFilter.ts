/* Which airspace bands a vertical profile draws: the pilot's filter rows
 * and the toolbar's level band, applied to the bands the route / trace walk
 * already produced. Pure, locale-free and state-free; the reactive wrapper
 * is components/profileOverlays.svelte.ts and the contract is
 * docs/route-profile.md "Airspace filter".
 *
 * It runs DOWNSTREAM of computeAirspaceCorridorSpans on purpose, for three
 * reasons that all point the same way: the forbidden-crossing rescue below
 * needs a penetration verdict, which only exists once the bands are placed
 * against the drawn line; a checkbox tick must not re-run the up-to-1000
 * sample lateral walk (docs/route-profile.md's tick-free doc invariant);
 * and the flight dossier's print doc calls the same builder and must stay
 * unconditional, which it does for free when the builder never learns
 * about the filter. */

import {
	AIRSPACE_FILTER_GROUPS,
	airspaceGroupShown,
	type AirspaceFilterGroup,
} from '$lib/data/airspaces';
import { bandIntersects, type FtBand } from '$lib/vertical/limits';
import type { AirspaceCorridorBand } from './airspaces';
import {
	bandPenetrations,
	isForbiddenCrossing,
	type AltitudeVertex,
	type PlacedBand,
} from './routeProfile';

/** What the gate needs of one band: its identity, what it IS, and the
 *  vertical limits the level band is tested against (PlacedBand drops
 *  vLower / vUpper, so the corridor row is the side to test). */
export type AirspaceBandRow = Pick<
	AirspaceCorridorBand,
	'key' | 'type' | 'airClass' | 'category' | 'vLower' | 'vUpper'
>;

export interface AirspaceGateOpts {
	/** The pilot's eight filter rows. */
	groups: Readonly<Record<AirspaceFilterGroup, boolean>>;
	/** The toolbar's persisted level band, or null when it is switched off. */
	band: FtBand | null;
}

/** What the cheap gate decided, split so the caller can spend the expensive
 *  half on the HIDDEN side alone. */
export interface AirspaceGateResult {
	/** The keys that pass the rows and the level band. */
	shown: Set<string>;
	/** The keys they drop: the only bands a rescue can ever concern. */
	hidden: Set<string>;
}

/** True while either gate could hide something, i.e. while there is any
 *  work to do. Not exported: `gatedAirspaceBandKeys`' null IS the
 *  observable, and the callers read that. */
function airspaceGateActive(
	groups: Readonly<Record<AirspaceFilterGroup, boolean>>,
	band: FtBand | null,
): boolean {
	// Over the declared row list rather than Object.values: exhaustive by
	// construction, and it reads each row as its own dependency when the
	// record handed in is reactive state.
	return band != null || AIRSPACE_FILTER_GROUPS.some((g) => !groups[g]);
}

/** The cheap half: the pilot's rows and the level band over the corridor
 *  rows, with no knowledge of the drawn line. NULL when neither gate hides
 *  anything (the identity gate: the caller keeps its arrays untouched
 *  rather than rebuilding two of them, and never pays for the rescue).
 *
 *  A band whose publisher left a vertical side unstated reads UNBOUNDED on
 *  that side, so the level band cannot drop it (bandIntersects' rule, and
 *  docs/vertical-limits.md's fail-open contract). That is deliberate: the
 *  bands you most need are the ones nobody fully stated. A prohibited area
 *  passes the rows (it answers to none of them) but not, by itself, the
 *  level band; `rescuedBandKeys` is what carries a P the flight would
 *  actually enter back over both. */
export function gatedAirspaceBandKeys(
	bands: readonly AirspaceBandRow[],
	opts: AirspaceGateOpts,
): AirspaceGateResult | null {
	if (!airspaceGateActive(opts.groups, opts.band)) {
		return null;
	}
	const shown = new Set<string>();
	const hidden = new Set<string>();
	for (const b of bands) {
		const pass =
			airspaceGroupShown(b, opts.groups) &&
			(!opts.band || bandIntersects(b.vLower, b.vUpper, opts.band));
		(pass ? shown : hidden).add(b.key);
	}
	return { shown, hidden };
}

/** The expensive half, and the reason it is asked only of the bands the
 *  cheap gate DROPPED: of those, the ones the drawn line penetrates whose
 *  crossing grades forbidden. Garmin's prohibited rule generalised through
 *  this app's own verified NO-GO tier: a volume the flight actually enters
 *  illegally is not a reading preference, so it is drawn whichever gate
 *  would have dropped it, the level band included.
 *
 *  `isForbiddenCrossing` is O(1) and runs FIRST, so the penetration walk
 *  (whose grid scales with the path, 600 vertices on a thinned trace) runs
 *  only for the handful of hidden bands that could ever reach the tier.
 *  Pass the bands already narrowed to `hidden`; NOTAM bands must not be
 *  among them, their keys naming nothing the gate can hide. */
export function rescuedBandKeys(
	hiddenBands: readonly PlacedBand[],
	pathVertices: AltitudeVertex[],
	opts: { vfr: boolean; activeKeys: ReadonlySet<string> },
): Set<string> {
	const out = new Set<string>();
	if (pathVertices.length < 2) {
		return out;
	}
	for (const b of hiddenBands) {
		if (!isForbiddenCrossing(b, { vfr: opts.vfr, active: opts.activeKeys.has(b.key) })) {
			continue;
		}
		if (bandPenetrations(b, pathVertices, { vfr: opts.vfr }).length > 0) {
			out.add(b.key);
		}
	}
	return out;
}
