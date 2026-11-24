/* The nearest aerodromes to the position: the diversion list a pilot reads
 * when the plan stops applying (the Airports page's "Nearest" section on a
 * phone, the tab's head on desktop while a pose exists). The ONE
 * position-based list beside the overflown field (nav/overflight.ts), and
 * unlike it deliberately NOT gated on a usable frequency: a strip that
 * answers nobody is still a runway. Pure of the pose; pinned by
 * tests/nearestAerodromes.spec.ts. */

import type { Airport } from '$lib/data/airports';
import { equirectangularDistanceM, initialBearingDeg, M_PER_DEG } from '$lib/notam/geometry';
import type { LatLon } from '$lib/notam/types';
import { NM_TO_METERS } from '$lib/notam/units';

/** How far the list looks: forty minutes at a light aircraft's cruise, the
 *  reach that still leaves fuel to think with. */
export const NEAREST_RADIUS_NM = 40;
export const NEAREST_LIMIT = 10;

/** Fixed-wing aerodromes only: a heliport or a seaplane base is no diversion
 *  for an aeroplane, and a closed field is closed (the OurAirports size
 *  vocabulary the merge keeps, `closed` the AIP's own statement). */
const AERODROME_TYPES: ReadonlySet<string> = new Set(['small_airport', 'medium_airport', 'large_airport']);

/** The fields worth scanning per pose. */
export function nearestCandidates(airports: readonly Airport[]): Airport[] {
	return airports.filter((a) => AERODROME_TYPES.has(a.type));
}

/* The filter is 46k rows in and 31k out, so it is memoised on the dataset's
 * own array REF (replaced wholesale when a country lands) and HERE rather
 * than in the component: its one mount is the phone's Airports page, which
 * unmounts every time the page closes and would rebuild the whole
 * quarter-megabyte list on the next open. The overflight module's idiom. */
let memo: { airports: readonly Airport[]; candidates: Airport[] } | null = null;

export function nearestCandidatesFor(airports: readonly Airport[]): Airport[] {
	if (!memo || memo.airports !== airports) {
		memo = { airports, candidates: nearestCandidates(airports) };
	}
	return memo.candidates;
}

export interface NearestAerodrome {
	airport: Airport;
	distNM: number;
	/** Initial great-circle bearing from the position, degrees TRUE; the
	 *  caller converts to magnetic at the pose. */
	bearingTrueDeg: number;
}

/** A point near a position, as nearestPoints finds it. */
export interface NearbyPoint<T> {
	item: T;
	distNM: number;
	/** Initial great-circle bearing from the position, degrees TRUE. */
	bearingTrueDeg: number;
}

/** The closest `limit` points within `radiusNM` of (lat, lon) that `keep`
 *  passes, nearest first; ties break on `name` so the list is stable
 *  between poses. `keep` runs before the limit, so a filter finds the
 *  nearest that pass it. The scan is the overflight one: a cheap
 *  latitude-band reject, then the wrapped equirectangular distance. */
export function nearestPoints<T extends LatLon>(
	candidates: readonly T[],
	lat: number,
	lon: number,
	opts: { limit: number; radiusNM: number; keep?: ((p: T) => boolean) | undefined },
	name: (p: T) => string,
): NearbyPoint<T>[] {
	const radiusM = opts.radiusNM * NM_TO_METERS;
	const hits: { p: T; m: number }[] = [];
	for (const p of candidates) {
		if (Math.abs(p.lat - lat) * M_PER_DEG > radiusM) {
			continue;
		}
		const m = equirectangularDistanceM(lat, lon, p.lat, p.lon);
		if (m <= radiusM && (!opts.keep || opts.keep(p))) {
			hits.push({ p, m });
		}
	}
	hits.sort((x, y) => x.m - y.m || name(x.p).localeCompare(name(y.p)));
	return hits.slice(0, opts.limit).map(({ p, m }) => ({
		item: p,
		distNM: m / NM_TO_METERS,
		bearingTrueDeg: initialBearingDeg(lat, lon, p.lat, p.lon),
	}));
}

/** The closest `limit` aerodromes within `radiusNM` that `keep` passes,
 *  nearest first, ties broken on the ident (nearestPoints). */
export function nearestAerodromes(
	candidates: readonly Airport[],
	lat: number,
	lon: number,
	opts: { limit?: number; radiusNM?: number; keep?: ((a: Airport) => boolean) | undefined } = {},
): NearestAerodrome[] {
	const near = nearestPoints(
		candidates,
		lat,
		lon,
		{ limit: opts.limit ?? NEAREST_LIMIT, radiusNM: opts.radiusNM ?? NEAREST_RADIUS_NM, keep: opts.keep },
		(a) => a.ident,
	);
	return near.map((h) => ({ airport: h.item, distNM: h.distNM, bearingTrueDeg: h.bearingTrueDeg }));
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
