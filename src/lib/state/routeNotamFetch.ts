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
import { customWindow } from './filter.svelte';
import { t } from './i18n.svelte';
import { activeEvalWindow } from './notam.svelte';
import { notamFetchBusy, type FetchOutcome } from './notamSource.svelte';
import { routes, routeSettings, type Route, type Waypoint } from './route.svelte';
import { briefingWindow } from './timeWindow.svelte';

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

/** "LFPL-LFPU" from a route's endpoints, for the skipped-route note and the
 *  briefing's verdict. A free or unnamed endpoint falls back to its name,
 *  else "?". */
export function routeEndpointsLabel(route: Route): string {
	const wps = route.waypoints;
	const a = endpointLabel(wps[0]);
	const b = endpointLabel(wps[wps.length - 1]);
	return a === b ? a : `${a}-${b}`;
}

function endpointLabel(w: Waypoint | undefined): string {
	return w?.ident?.trim() || w?.label?.trim() || '?';
}

/** The widest corridor half-width SOFIA accepts: it refuses 100 NM. */
const SOFIA_MAX_WIDTH_NM = 99;

/** The half-width SOFIA is asked for: the drawn corridor's, rounded up to
 *  the whole mile the request carries, plus one for the minute each
 *  coordinate token rounds its point to (up to 0.7 NM off the drawn line),
 *  so the briefing covers the corridor the map draws. Past SOFIA's limit
 *  the margin gives way, and a corridor drawn wider still is asked as
 *  drawn, for SOFIA to refuse rather than for a narrower briefing to pass
 *  as the whole. */
export function sofiaWidthNM(drawnNM: number): number {
	const asked = Math.ceil(drawnNM) + 1;
	if (asked <= SOFIA_MAX_WIDTH_NM) {
		return asked;
	}
	return Math.max(SOFIA_MAX_WIDTH_NM, drawnNM);
}

/** Brief every drawn route from SOFIA: one narrow-route PIB each, merged.
 *  The empty case is the caller's word, not the fetch's: "you have not drawn a
 *  route" is a sentence only an app with routes can say. `flight` briefs the
 *  planned flight whatever period is typed: the app's own runs and the
 *  verdict's line, which judge the flight, ask it. */
export async function fetchRouteNotamsFromSofia(
	opts: { wholeOnly?: boolean; flight?: boolean; since?: number } = {},
): Promise<FetchOutcome> {
	// Asked before the input guard so a briefing already in flight is not
	// reported as a missing route; briefFromSofia asks again, which is its own
	// contract and costs nothing (no await sits between the two).
	if (notamFetchBusy()) {
		return 'skipped';
	}
	const drawn = routes.list.filter((r) => r.waypoints.length >= 2);
	if (drawn.length === 0) {
		sofia.error = () => t.errors.needTwoWaypoints;
		return 'skipped';
	}
	// Navaids so the nav-log frequencies resolve. Not awaited with the
	// briefing's own datasets: it is the LOG's need, not the briefing's, and a
	// missing navaid set must not hold up a bulletin.
	void ensureNavaids().catch(() => {
		/* error is surfaced via dataState.navaidsError */
	});
	const custom = opts.flight ? null : customWindow();
	return briefFromSofia(
		drawn.map(
			(r): SofiaTrack => ({
				label: routeEndpointsLabel(r),
				points: r.waypoints.map(waypointPoint),
				path: r.waypoints.map((w) => ({ lat: w.lat, lon: w.lon })),
			}),
		),
		{
			widthNM: sofiaWidthNM(routeSettings.corridorRadiusNM),
			// The planned flight's window, read ONCE so every route is
			// briefed for the same one, whatever period the map is read at:
			// a flight dated in three days is briefed for that day. A typed
			// custom period is the pilot saying which one they mean, and
			// goes first from the fetch view's own button.
			window: custom ?? briefingWindow() ?? activeEvalWindow(),
			kind: 'route',
			aim: custom ? 'period' : 'flight',
			wholeOnly: opts.wholeOnly,
			since: opts.since,
		},
	);
}

/** Can SOFIA brief the plan? A route of two waypoints with an aerodrome on
 *  it to anchor the request on (narrowRouteTokens). */
export function sofiaCanBrief(): boolean {
	return routes.list.some((r) => r.waypoints.length >= 2 && sofiaBriefsRoute(r));
}

/** Does a route carry an aerodrome for SOFIA to anchor its PIB on? */
export function sofiaBriefsRoute(route: Route): boolean {
	return route.waypoints.some((w) => waypointPoint(w).aerodrome);
}

/** Can SOFIA brief every drawn route, for an answer it may replace a
 *  briefing with whole? */
export function sofiaCanBriefEvery(): boolean {
	return routes.list.every((r) => r.waypoints.length < 2 || sofiaBriefsRoute(r));
}
