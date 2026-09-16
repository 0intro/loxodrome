/* The nearest aerodromes to the position: the diversion list a pilot reads
 * when the plan stops applying (the Airports page's "Nearest" section on a
 * phone, the tab's head on desktop while a pose exists). The ONE
 * position-based list beside the overflown field (nav/overflight.ts), and
 * unlike it deliberately NOT gated on a usable frequency: a strip that
 * answers nobody is still a runway. Pure of the pose; pinned by
 * tests/nearestAerodromes.spec.ts. */

import type { Airport } from '$lib/data/airports';
import { equirectangularDistanceM, initialBearingDeg, M_PER_DEG } from '$lib/notam/geometry';
import { NM_TO_METERS } from '$lib/notam/units';

/** How far the list looks: forty minutes at a light aircraft's cruise, the
 *  reach that still leaves fuel to think with. */
export const NEAREST_RADIUS_NM = 40;
export const NEAREST_LIMIT = 10;

/** Fixed-wing aerodromes only: a heliport or a seaplane base is no diversion
 *  for an aeroplane, and a closed field is closed (the OurAirports size
 *  vocabulary the merge keeps, `closed` the AIP's own statement). */
const AERODROME_TYPES: ReadonlySet<string> = new Set(['small_airport', 'medium_airport', 'large_airport']);

/** The fields worth scanning per pose; the caller memoises on the dataset
 *  ref, the overflight idiom. */
export function nearestCandidates(airports: readonly Airport[]): Airport[] {
	return airports.filter((a) => AERODROME_TYPES.has(a.type));
}

export interface NearestAerodrome {
	airport: Airport;
	distNM: number;
	/** Initial great-circle bearing from the position, degrees TRUE; the
	 *  caller converts to magnetic at the pose. */
	bearingTrueDeg: number;
}

/** The closest `limit` candidates within `radiusNM`, nearest first; ties
 *  break on the ident so the list is stable between poses. The scan is the
 *  overflight one: a cheap latitude-band reject, then the wrapped
 *  equirectangular distance. */
export function nearestAerodromes(
	candidates: readonly Airport[],
	lat: number,
	lon: number,
	opts: { limit?: number; radiusNM?: number } = {},
): NearestAerodrome[] {
	const limit = opts.limit ?? NEAREST_LIMIT;
	const radiusM = (opts.radiusNM ?? NEAREST_RADIUS_NM) * NM_TO_METERS;
	const hits: { a: Airport; m: number }[] = [];
	for (const a of candidates) {
		if (Math.abs(a.lat - lat) * M_PER_DEG > radiusM) {
			continue;
		}
		const m = equirectangularDistanceM(lat, lon, a.lat, a.lon);
		if (m <= radiusM) {
			hits.push({ a, m });
		}
	}
	hits.sort((x, y) => x.m - y.m || x.a.ident.localeCompare(y.a.ident));
	return hits.slice(0, limit).map(({ a, m }) => ({
		airport: a,
		distNM: m / NM_TO_METERS,
		bearingTrueDeg: initialBearingDeg(lat, lon, a.lat, a.lon),
	}));
}

/** The longest published runway (ft), null when no runway states a length. */
export function longestRunwayFt(a: Airport): number | null {
	let best: number | null = null;
	for (const r of a.runways) {
		if (r.lengthFt != null && (best == null || r.lengthFt > best)) {
			best = r.lengthFt;
		}
	}
	return best;
}
