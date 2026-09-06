/* Combined airport + navaid search for the Route tab's "add waypoint" box.
 * Parallel to airportSearch.svelte.ts (and kept separate so the two query
 * boxes never interfere). Ranks airports and navaids on one scale and returns
 * a capped, best-first list the tab turns into anchored waypoints. */

import type { Airport } from '$lib/data/airports';
import { NAVAID_LABELS, navaidFreqLabel, type Navaid } from '$lib/data/navaids';
import { dataState, getAirports, getNavaids } from '$lib/state/data.svelte';
import type { WaypointAnchor } from '$lib/state/route.svelte';
import { equirectangularDistanceM } from '$lib/notam/geometry';
import { buildVfrAerodromeMap, type VfrAerodrome } from '$lib/data/vfrAerodrome';

// Cached VFR-reporting-point -> aerodrome map, rebuilt only when the airport or
// navaid dataset reference changes (i.e. once each lazy load resolves).
// Exported for the search palette, whose navaid group ranks with the same
// aerodrome tiers.
let aeroMemo: { airports: Airport[]; navaids: Navaid[]; map: Map<string, VfrAerodrome> } | null =
	null;
export function vfrAerodromes(
	airports: Airport[] | null,
	navaids: Navaid[] | null,
): Map<string, VfrAerodrome> | null {
	if (!airports || !navaids) {
		return null;
	}
	if (aeroMemo && aeroMemo.airports === airports && aeroMemo.navaids === navaids) {
		return aeroMemo.map;
	}
	const map = buildVfrAerodromeMap(airports, navaids);
	aeroMemo = { airports, navaids, map };
	return map;
}

/** Cap on rendered rows. This is an add-waypoint autocomplete (you pick one),
 *  not a browse list, so a tighter cap than the Airports tab. */
export const RESULT_CAP = 60;

export const waypointSearch = $state<{ query: string }>({ query: '' });

export type WaypointHit =
	| { kind: 'airport'; airport: Airport }
	| { kind: 'navaid'; navaid: Navaid };

export interface WaypointSearchResult {
	results: WaypointHit[];
	total: number;
}

/** Airport match score; lower is better, -1 = no match. Mirrors searchAirports. */
function airportScore(a: Airport, qUpper: string, qLower: string): number {
	const ident = a.ident.toUpperCase();
	const iata = a.iata.toUpperCase();
	const name = a.name.toLowerCase();
	const city = a.city.toLowerCase();
	if (ident === qUpper) return 0;
	if (iata && iata === qUpper) return 1;
	if (ident.startsWith(qUpper)) return 2;
	if (iata && iata.startsWith(qUpper)) return 3;
	if (name.startsWith(qLower)) return 4;
	if (city.startsWith(qLower)) return 5;
	if (name.includes(qLower)) return 6;
	if (city.includes(qLower)) return 7;
	if (ident.includes(qUpper)) return 8;
	return -1;
}

/** Navaid match score on the same scale; name is often empty, so guard it. A VFR
 *  reporting point also matches via its aerodrome: its ICAO ranks just under a
 *  direct ident match (so the aerodrome itself stays on top), while its NAME
 *  shares the direct name tiers, so proximity floats a nearby aerodrome's points
 *  above a far same-named airport. Best (lowest) wins. */
function navaidScore(
	n: Navaid,
	qUpper: string,
	qLower: string,
	aero?: VfrAerodrome | null,
): number {
	const ident = n.ident.toUpperCase();
	const name = n.name.toLowerCase();
	let s = -1;
	if (ident === qUpper) s = 0;
	else if (ident.startsWith(qUpper)) s = 2;
	else if (name && name.startsWith(qLower)) s = 4;
	else if (name && name.includes(qLower)) s = 6;
	else if (ident.includes(qUpper)) s = 8;
	if (aero) {
		const aIdent = aero.ident.toUpperCase();
		const aName = aero.name.toLowerCase();
		let aScore = -1;
		if (aIdent === qUpper) aScore = 3;
		else if (aIdent.startsWith(qUpper)) aScore = 5;
		else if (aName.startsWith(qLower)) aScore = 4;
		else if (aName.includes(qLower)) aScore = 6;
		if (aScore >= 0 && (s < 0 || aScore < s)) {
			s = aScore;
		}
	}
	return s;
}

/** Reactive wrapper: read the query + loaded datasets and rank them. `ref` is the
 *  point suggestions are ordered closest to (the route's last waypoint, or the
 *  map centre on an empty route); null disables the proximity term. */
export function searchWaypoints(ref: { lat: number; lon: number } | null = null): WaypointSearchResult {
	// Non-reactive refs; gate on the loaded flags so a $derived consumer
	// recomputes once each lazy load resolves (same idiom as searchAirports).
	const airports = dataState.airportsLoaded ? getAirports() : null;
	const navaids = dataState.navaidsLoaded ? getNavaids() : null;
	return rankWaypointHits(airports, navaids, waypointSearch.query, ref, vfrAerodromes(airports, navaids));
}

/** Pure ranking: score each candidate, then order by match-quality tier, then by
 *  distance to `ref` (nearest first), with airport-before-navaid and ident as
 *  deterministic final tiebreaks. A null `ref` leaves every distance 0, so the
 *  order falls back to match-then-alphabetical. `aero` lets a VFR reporting
 *  point match via its aerodrome (keyed by navaid id). */
export function rankWaypointHits(
	airports: Airport[] | null,
	navaids: Navaid[] | null,
	query: string,
	ref: { lat: number; lon: number } | null,
	aero: Map<string, VfrAerodrome> | null = null,
): WaypointSearchResult {
	const q = query.trim();
	if (!q || (!airports && !navaids)) {
		return { results: [], total: 0 };
	}
	const qUpper = q.toUpperCase();
	const qLower = q.toLowerCase();
	const distTo = (lat: number, lon: number): number =>
		ref ? equirectangularDistanceM(ref.lat, ref.lon, lat, lon) : 0;
	const scored: { hit: WaypointHit; s: number; rank: number; ident: string; dist: number }[] = [];
	if (airports) {
		for (const a of airports) {
			const s = airportScore(a, qUpper, qLower);
			if (s >= 0) {
				scored.push({
					hit: { kind: 'airport', airport: a },
					s,
					rank: 0,
					ident: a.ident,
					dist: distTo(a.lat, a.lon),
				});
			}
		}
	}
	if (navaids) {
		for (const n of navaids) {
			const s = navaidScore(n, qUpper, qLower, aero?.get(n.id) ?? null);
			if (s >= 0) {
				scored.push({
					hit: { kind: 'navaid', navaid: n },
					s,
					rank: 1,
					ident: n.ident,
					dist: distTo(n.lat, n.lon),
				});
			}
		}
	}
	// Match-quality tier, then nearest first within the tier, then airport before
	// navaid and ident for a stable order.
	scored.sort(
		(x, y) =>
			x.s - y.s || x.dist - y.dist || x.rank - y.rank || x.ident.localeCompare(y.ident),
	);
	return {
		results: scored.slice(0, RESULT_CAP).map((e) => e.hit),
		total: scored.length,
	};
}

/** The ICAO / navaid ident shown as a result row's title. */
export function hitIdent(hit: WaypointHit): string {
	return hit.kind === 'airport' ? hit.airport.ident : hit.navaid.ident;
}

/** A one-line subtitle: airport name + city, or navaid type + frequency, with
 *  the aerodrome appended for a VFR reporting point ("VFR reporting point ·
 *  Albert Bray"). */
export function hitSubtitle(hit: WaypointHit): string {
	if (hit.kind === 'airport') {
		const a = hit.airport;
		return [a.name, a.city].filter(Boolean).join(' · ') || a.type;
	}
	const n = hit.navaid;
	const parts = [NAVAID_LABELS[n.type], navaidFreqLabel(n)];
	if (n.type === 'VFR_REPORTING_POINT') {
		const aero = vfrAerodromes(getAirports(), getNavaids())?.get(n.id);
		if (aero) {
			parts.push(aero.name || aero.ident);
		}
	}
	return parts.filter(Boolean).join(' · ');
}

/** Resolve a single route token (an ICAO or navaid ident) to an anchor by
 *  EXACT ident match, airports first. Used to build a route from a
 *  space-separated string like "LFPL LFAI LFPK LFPL". Returns null when the
 *  token matches no loaded airport or navaid. */
export function resolveWaypointToken(token: string): WaypointAnchor | null {
	const up = token.trim().toUpperCase();
	if (!up) {
		return null;
	}
	const airports = getAirports();
	if (airports) {
		const a = airports.find((ap) => ap.ident.toUpperCase() === up);
		if (a) {
			return hitToAnchor({ kind: 'airport', airport: a });
		}
	}
	const navaids = getNavaids();
	if (navaids) {
		const n = navaids.find((nv) => nv.ident.toUpperCase() === up);
		if (n) {
			return hitToAnchor({ kind: 'navaid', navaid: n });
		}
	}
	return null;
}

/** Every feature the datasets file under each identifier, airports first.
 *
 *  `resolveWaypointToken` answers with the FIRST hit, which is right for a
 *  token the user typed and wrong for a file whose points carry their own
 *  positions. The OurAirports baseline is loaded whole and shadows some
 *  eighty-eight same-ident navaids, so a plan stating BOV (the Beauvais-Tille
 *  VOR-DME, on the standard northbound routing) is handed Boang Airport in
 *  Papua New Guinea; the importer's position confirmation can then only
 *  REJECT it, and the beacon becomes a nameless free point. Handed every
 *  candidate, it picks the one that is where the file says it is
 *  (state/routeLoad.svelte.ts).
 *
 *  Built in one pass and handed to the caller rather than memoised: an import
 *  is rare, and the alternative is a 45 000-entry index retained for the
 *  session. It also ends the linear scan the resolver makes per token, which
 *  at three candidates a point over three hundred points was seconds of a
 *  phone's main thread. */
export function waypointHitIndex(): Map<string, WaypointHit[]> {
	// A throwaway index handed back to one caller, not reactive state.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const out = new Map<string, WaypointHit[]>();
	const add = (ident: string, hit: WaypointHit): void => {
		const key = ident.trim().toUpperCase();
		if (key === '') {
			return;
		}
		const at = out.get(key);
		if (at) {
			at.push(hit);
		} else {
			out.set(key, [hit]);
		}
	};
	for (const airport of getAirports() ?? []) {
		add(airport.ident, { kind: 'airport', airport });
	}
	for (const navaid of getNavaids() ?? []) {
		add(navaid.ident, { kind: 'navaid', navaid });
	}
	return out;
}

/** Where a hit stands, whichever kind it is. */
export function hitPosition(hit: WaypointHit): { lat: number; lon: number } {
	return hit.kind === 'airport' ? hit.airport : hit.navaid;
}

/** Convert a search hit to the anchor a Route waypoint stores. */
export function hitToAnchor(hit: WaypointHit): WaypointAnchor {
	if (hit.kind === 'airport') {
		const a = hit.airport;
		return {
			lat: a.lat,
			lon: a.lon,
			kind: 'airport',
			refId: a.ident.toUpperCase(),
			ident: a.ident,
			label: a.name || undefined,
		};
	}
	const n = hit.navaid;
	const freq = navaidFreqLabel(n);
	return {
		lat: n.lat,
		lon: n.lon,
		kind: 'navaid',
		refId: n.id,
		ident: n.ident,
		label: n.name || undefined,
		freq: freq || undefined,
	};
}
