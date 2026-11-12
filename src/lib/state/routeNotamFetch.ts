/* The route workspace's own NOTAM fetches.
 *
 * Both sources brief a TRACK, and a drawn route is one; this module is the
 * only place that knows that. It turns routes into what each source asks for
 * and calls the shared orchestration, so sofia/fetch.ts and autorouter/fetch.ts
 * stay readable by an app that has no route workspace at all.
 */

import { briefFromSofia, type SofiaTrack } from '$lib/sofia/fetch';
import { latLonToSofiaToken, type NarrowRoutePoint } from '$lib/sofia/client';
import { sofia } from '$lib/sofia/state.svelte';
import { ensureNavaids } from './data.svelte';
import { t } from './i18n.svelte';
import { activeEvalWindow } from './notam.svelte';
import { notamFetchBusy } from './notamSource.svelte';
import { routes, routeSettings, type Route, type Waypoint } from './route.svelte';

/** A route waypoint as a SOFIA `route[]` token. Only aerodromes go in by ICAO
 *  ident (the ident anchors SOFIA's aerodrome NOTAM scan, and is the only thing
 *  it accepts at either end of a route); navaids and free points go in by
 *  coordinate. SOFIA rejects some navaid idents outright (e.g. PMN -> a generic
 *  "Votre requête n'a pas abouti"), but reliably accepts a coordinate token for
 *  any intermediate point, and every waypoint carries resolved coordinates.
 *  buildNarrowRouteBody upper-cases the ident (SOFIA is case-sensitive).
 *
 *  Which points are aerodromes rides along, since that is what decides where
 *  `narrowRouteTokens` can anchor the ends. */
function waypointPoint(w: Waypoint): NarrowRoutePoint {
	const ident = w.ident?.trim();
	return w.kind === 'airport' && ident
		? { token: ident, aerodrome: true }
		: { token: latLonToSofiaToken(w.lat, w.lon), aerodrome: false };
}

/** "LFPL-LFPU" from a route's endpoints, for the skipped-route note; a free or
 *  unnamed endpoint falls back to its name, else "?". */
function routeEndpointsLabel(route: Route): string {
	const wps = route.waypoints;
	const a = endpointLabel(wps[0]);
	const b = endpointLabel(wps[wps.length - 1]);
	return a === b ? a : `${a}-${b}`;
}

function endpointLabel(w: Waypoint | undefined): string {
	return w?.ident?.trim() || w?.label?.trim() || '?';
}

/** Fetch one anonymous JSESSIONID from the proxy's /sofia/session route so the
 *  per-route POSTs can reuse it (?session=), halving the SOFIA hits of a
 *  multi-route briefing. Best-effort: null falls back to a per-route handshake
 *  in the worker, so an older worker without /sofia/session (404) still works. */

/** Brief every drawn route from SOFIA: one narrow-route PIB each, merged.
 *  The empty case is the caller's word, not the fetch's: "you have not drawn a
 *  route" is a sentence only an app with routes can say. */
export async function fetchRouteNotamsFromSofia(): Promise<void> {
	// Asked before the input guard so a briefing already in flight is not
	// reported as a missing route; briefFromSofia asks again, which is its own
	// contract and costs nothing (no await sits between the two).
	if (notamFetchBusy()) {
		return;
	}
	const drawn = routes.list.filter((r) => r.waypoints.length >= 2);
	if (drawn.length === 0) {
		sofia.error = () => t.errors.needTwoWaypoints;
		return;
	}
	// Navaids so the nav-log frequencies resolve. Not awaited with the
	// briefing's own datasets: it is the LOG's need, not the briefing's, and a
	// missing navaid set must not hold up a bulletin.
	void ensureNavaids().catch(() => {
		/* error is surfaced via dataState.navaidsError */
	});
	await briefFromSofia(
		drawn.map(
			(r): SofiaTrack => ({
				label: routeEndpointsLabel(r),
				points: r.waypoints.map(waypointPoint),
			}),
		),
		{
			widthNM: routeSettings.corridorRadiusNM,
			// The period the pilot is looking at, read ONCE so every route is
			// briefed for the same window: the flight's own start in Flight
			// mode, the typed start in Custom, else now.
			window: activeEvalWindow(),
			kind: 'route',
		},
	);
}
