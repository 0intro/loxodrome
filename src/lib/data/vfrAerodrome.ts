/* Associate each VFR reporting point with its aerodrome so the route search can
 * find it by the aerodrome's name or ICAO.
 *
 * The French SIA encodes the aerodrome's ICAO last two characters as the
 * reporting point's ident prefix: "AQN" / "AQS" belong to LF**AQ** (Albert),
 * "ATN" to LF**AT** (Le Touquet); overseas, "AAEA" belongs to NT**AA** (Tahiti
 * Faa'a). So the aerodrome is the nearest airport whose ICAO ends with the
 * point's first two ident characters. Pure; no Svelte. */

import type { Airport } from './airports';
import type { Navaid } from './navaids';
import { equirectangularDistanceM } from '$lib/notam/geometry';
import { NM_TO_METERS } from '$lib/notam/units';

/** A reporting point further than this from the nearest ICAO-suffix match is
 *  treated as unassociated (its real aerodrome is likely absent from the airport
 *  dataset, so a far suffix match would be a coincidence). */
const MAX_M = 40 * NM_TO_METERS;

export interface VfrAerodrome {
	ident: string;
	name: string;
}

/** Map (keyed by navaid id) from each VFR reporting point to its aerodrome.
 *  Built from the loaded airports + navaids; recompute only when those change. */
export function buildVfrAerodromeMap(
	airports: Airport[],
	navaids: Navaid[],
): Map<string, VfrAerodrome> {
	// Index airports by their ICAO's last two characters.
	const byEnd = new Map<string, Airport[]>();
	for (const a of airports) {
		if (a.ident.length < 3) {
			continue;
		}
		const k = a.ident.slice(-2).toUpperCase();
		let g = byEnd.get(k);
		if (!g) {
			g = [];
			byEnd.set(k, g);
		}
		g.push(a);
	}
	const out = new Map<string, VfrAerodrome>();
	for (const n of navaids) {
		if (n.type !== 'VFR_REPORTING_POINT' || n.ident.length < 2) {
			continue;
		}
		const cands = byEnd.get(n.ident.slice(0, 2).toUpperCase());
		if (!cands) {
			continue;
		}
		let best: Airport | null = null;
		let bestM = Infinity;
		for (const a of cands) {
			const d = equirectangularDistanceM(n.lat, n.lon, a.lat, a.lon);
			if (d < bestM) {
				bestM = d;
				best = a;
			}
		}
		if (best && bestM <= MAX_M) {
			out.set(n.id, { ident: best.ident, name: best.name });
		}
	}
	return out;
}
