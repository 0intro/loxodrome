/* The overflown aerodrome: which field the aircraft is passing over, and so
 * which frequency to monitor or announce on while transiting. This is the ONE
 * position-based answer in navigation mode (everything else is
 * route-referenced; contract: docs/nav-live.md): the nearest open aerodrome
 * with a usable published frequency within OVERFLIGHT_RADIUS_NM of the pose,
 * whatever the plan says and with no route at all. Stateless per evaluation
 * (pure of the pose), so replay and scrubbing answer identically. Pure; no
 * Svelte, no I/O; pinned by tests/navOverflight.spec.ts. */

import { contactRadios, type Airport } from '$lib/data/airports';
import { formatFreqMHz } from '$lib/format/radio';
import { equirectangularDistanceM, M_PER_DEG } from '$lib/notam/geometry';
import { NM_TO_METERS } from '$lib/notam/units';

/** Lateral radius (NM) within which an aerodrome counts as flown over: about
 *  three minutes of warning at 100 kt, ATZ-scale plus the margin to tune and
 *  announce before overhead. */
export const OVERFLIGHT_RADIUS_NM = 5;

/** The fields worth scanning per pose: those a flight may be offered at all
 *  (contactRadios, which is empty for a closed aerodrome) and publishing at
 *  least one usable frequency, the same acceptance buildContactSpans applies
 *  to an airspace. Shrinks the 41k-row merged dataset to the few thousand
 *  fields a pilot could actually call; the caller memoises the result on the
 *  dataset ref. */
export function overflightCandidates(airports: readonly Airport[]): Airport[] {
	return airports.filter((a) => contactRadios(a).some((r) => formatFreqMHz(r.freq) !== ''));
}

/** The nearest candidate within `radiusNM` of the position, with its distance,
 *  skipping `excludeIdents` (upper-cased ICAO idents: the flown route's own
 *  departure and destination, which the contact chain already brackets). The
 *  scan is linear with a cheap latitude-band reject (the nearestMetar idiom);
 *  latitude never wraps, so the band test is exact everywhere, and the full
 *  distance is the antimeridian-wrapped equirectangular one. */
export function nearestOverflown(
	candidates: readonly Airport[],
	lat: number,
	lon: number,
	radiusNM: number,
	excludeIdents: ReadonlySet<string>,
): { airport: Airport; distNM: number } | null {
	const radiusM = radiusNM * NM_TO_METERS;
	let best: Airport | null = null;
	let bestM = Infinity;
	for (const a of candidates) {
		if (Math.abs(a.lat - lat) * M_PER_DEG > radiusM) {
			continue;
		}
		if (excludeIdents.has(a.ident.toUpperCase())) {
			continue;
		}
		const d = equirectangularDistanceM(lat, lon, a.lat, a.lon);
		if (d <= radiusM && d < bestM) {
			bestM = d;
			best = a;
		}
	}
	return best ? { airport: best, distNM: bestM / NM_TO_METERS } : null;
}
