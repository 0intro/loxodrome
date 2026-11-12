/* Combined airport, navaid and town search for the Route tab's "add
 * waypoint" box, ranked by the one search engine (src/lib/search,
 * docs/search.md) and kept separate from the Airports tab's box so the two
 * queries never interfere. A town joins the route as a named free point. */

import type { Airport } from '$lib/data/airports';
import { navaidFreqLabel, type Navaid, type NavaidType } from '$lib/data/navaids';
import { dataState, getAirports, getNavaids } from '$lib/state/data.svelte';
import type { WaypointAnchor } from '$lib/state/route.svelte';
import { buildVfrAerodromeMap, type VfrAerodrome } from '$lib/data/vfrAerodrome';
import { vrpLandmark } from '$lib/format/remark';
import { rankAirports } from '$lib/search/airports';
import { rankNavaids } from '$lib/search/navaids';
import { rankPlaces } from '$lib/search/places';
import type { Place } from '$lib/data/places';
import { getPlaces } from '$lib/state/places.svelte';
import { prepareQuery } from '$lib/search/query';
import { mapHits, mergeRanked, type Ranked } from '$lib/search/rank';

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
	| { kind: 'navaid'; navaid: Navaid }
	| { kind: 'place'; place: Place };

/** A hit that names a feature a waypoint anchors to. */
export type FeatureHit = Exclude<WaypointHit, { kind: 'place' }>;

export interface WaypointSearchResult {
	results: WaypointHit[];
	total: number;
}

/** Reactive wrapper: read the query + loaded datasets and rank them. `ref` is the
 *  point suggestions are ordered closest to (the route's last waypoint, or the
 *  map centre on an empty route); null disables the proximity term. */
export function searchWaypoints(ref: { lat: number; lon: number } | null = null): WaypointSearchResult {
	// Non-reactive refs; gate on the loaded flags so a $derived consumer
	// recomputes once each lazy load resolves (same idiom as searchAirportsFor).
	const airports = dataState.airportsLoaded ? getAirports() : null;
	const navaids = dataState.navaidsLoaded ? getNavaids() : null;
	return rankWaypointHits(airports, navaids, waypointSearch.query, ref, vfrAerodromes(airports, navaids), getPlaces());
}

/** Airports and navaids ranked on the engine's one scale: the match's tier,
 *  then class, then distance to `ref` (nearest first), airport before navaid
 *  and ident as the final tiebreaks. A null `ref` leaves the distances out,
 *  so the order falls back to match-then-alphabetical. `aero` lets a VFR
 *  reporting point match via its aerodrome (keyed by navaid id). `places`,
 *  the towns, rank on the same scale (search/places.ts). */
export function rankWaypointHits(
	airports: Airport[] | null,
	navaids: Navaid[] | null,
	query: string,
	ref: { lat: number; lon: number } | null,
	aero: Map<string, VfrAerodrome> | null = null,
	places: readonly Place[] | null = null,
): WaypointSearchResult {
	const q = prepareQuery(query);
	const lists: Ranked<WaypointHit>[] = [];
	if (airports) {
		lists.push(
			mapHits(rankAirports(airports, q, { ref, cap: RESULT_CAP }), (airport): WaypointHit => ({ kind: 'airport', airport })),
		);
	}
	if (navaids) {
		lists.push(
			mapHits(rankNavaids(navaids, q, { ref, cap: RESULT_CAP, aero }), (navaid): WaypointHit => ({ kind: 'navaid', navaid })),
		);
	}
	if (places) {
		lists.push(mapHits(rankPlaces(places, q, { ref, cap: RESULT_CAP }), (place): WaypointHit => ({ kind: 'place', place })));
	}
	const r = mergeRanked(lists, RESULT_CAP);
	return { results: r.hits.map((h) => h.item), total: r.total };
}

/** The ICAO / navaid ident shown as a result row's title, a town's name. */
export function hitIdent(hit: WaypointHit): string {
	switch (hit.kind) {
		case 'airport':
			return hit.airport.ident;
		case 'navaid':
			return hit.navaid.ident;
		case 'place':
			return hit.place.name;
	}
}

/** A one-line subtitle: airport name and city, or navaid type and frequency,
 *  with the aerodrome appended for a VFR reporting point ("VFR reporting point,
 *  Albert Bray"). The type words come from the caller's catalog: this module
 *  stays locale-free. */
export function hitSubtitle(hit: FeatureHit, navaidTypes: Readonly<Record<NavaidType, string>>): string {
	if (hit.kind === 'airport') {
		const a = hit.airport;
		return [a.name, a.city].filter(Boolean).join(', ') || a.type;
	}
	const n = hit.navaid;
	const parts = [navaidTypes[n.type], navaidFreqLabel(n)];
	if (n.type === 'VFR_REPORTING_POINT') {
		parts.push(vrpLandmark(n.rmk));
		const aero = vfrAerodromes(getAirports(), getNavaids())?.get(n.id);
		if (aero) {
			parts.push(aero.name || aero.ident);
		}
	}
	return parts.filter(Boolean).join(', ');
}

/** Resolve a single route token (an ICAO or navaid ident) to an anchor by
 *  EXACT ident match, airports first. Returns null when the token matches no
 *  loaded airport or navaid.
 *
 *  This is the answer for a token ALONE, which cannot be told where it is: an
 *  identifier can name several features continents apart (BOV, KCIR; see
 *  route/anchorChoice.ts). A route resolves its tokens together through
 *  `resolveWaypointToken.candidates` (waypointCandidates, attached below),
 *  every caller that builds one passing this resolver whole; the bare call is
 *  for the existence checks and the lone-token uses. */
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
 *  `resolveWaypointToken` answers with the FIRST hit, which is all a lone
 *  token can be told and wrong wherever its identifier names several
 *  features: the OurAirports baseline is loaded whole and shadows about 120
 *  same-ident navaids more than 50 NM away, so a plan stating BOV (the
 *  Beauvais-Tille VOR-DME, on the standard northbound routing) is handed
 *  Boang Airport in Papua New Guinea. A file whose points carry their own
 *  positions is confirmed against this index (state/routeLoad.svelte.ts), and
 *  a route's identifiers are chosen together over the ambiguous part of it
 *  (`waypointCandidates`, route/anchorChoice.ts).
 *
 *  Built in one pass and handed to the caller rather than retained whole: the
 *  alternative is a 50 000-entry index held for the session. It also ends the
 *  linear scan the resolver makes per token, which at three candidates a
 *  point over three hundred points was seconds of a phone's main thread. */
export function waypointHitIndex(): Map<string, FeatureHit[]> {
	// A throwaway index handed back to one caller, not reactive state.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const out = new Map<string, FeatureHit[]>();
	const add = (ident: string, hit: FeatureHit): void => {
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

// The identifiers that name more than one feature in the loaded data, each
// with every feature in resolution order (airports first, then navaids in
// publisher order): about nine hundred keys, so retained, unlike the whole
// index they are filtered from. Rebuilt when a merge publishes new arrays;
// the getters are read on every call so a reactive caller still tracks the
// revision.
let ambiguousMemo: {
	airports: Airport[] | null;
	navaids: Navaid[] | null;
	map: Map<string, FeatureHit[]>;
} | null = null;

function ambiguousHits(): Map<string, FeatureHit[]> {
	const airports = getAirports();
	const navaids = getNavaids();
	if (ambiguousMemo && ambiguousMemo.airports === airports && ambiguousMemo.navaids === navaids) {
		return ambiguousMemo.map;
	}
	// A memo rebuilt per merge, not reactive state.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const map = new Map<string, FeatureHit[]>();
	for (const [key, hits] of waypointHitIndex()) {
		if (hits.length > 1) {
			map.set(key, hits);
		}
	}
	ambiguousMemo = { airports, navaids, map };
	return map;
}

/** Every loaded feature filed under `token`, in the resolver's own order
 *  (airports first, then navaids in publisher order): what a route chooses
 *  among (route/anchorChoice.ts). The first is always the bare resolver's
 *  answer. Asked by the route builders only, so the existence checks that
 *  call the resolver bare never build the memo. */
export function waypointCandidates(token: string): WaypointAnchor[] {
	const up = token.trim().toUpperCase();
	if (!up) {
		return [];
	}
	const many = ambiguousHits().get(up);
	if (many) {
		return many.map(hitToAnchor);
	}
	const one = resolveWaypointToken(token);
	return one ? [one] : [];
}

resolveWaypointToken.candidates = waypointCandidates;

/** Where a hit stands, whichever kind it is. */
export function hitPosition(hit: WaypointHit): { lat: number; lon: number } {
	switch (hit.kind) {
		case 'airport':
			return hit.airport;
		case 'navaid':
			return hit.navaid;
		case 'place':
			return hit.place;
	}
}

/** Convert a search hit to the anchor a Route waypoint stores. */
export function hitToAnchor(hit: FeatureHit): WaypointAnchor {
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
