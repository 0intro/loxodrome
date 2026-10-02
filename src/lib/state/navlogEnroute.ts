/* How many enroute-frequency lines each leg of a route carries, computed the
 * way NavLogSheet computes the lines themselves (the shared schedule memo,
 * the frequency-override resolution, one line per channel,
 * route/airspaces.ts enrouteFreqsByLeg). For the kneeboard's no-DOM card
 * estimator (components/navlogCards.ts), the fallback both print flows take
 * when a route's measured split is missing: a leg meeting two channels (SIV
 * SEINE 3 then SEINE 4) prints two lines, and priced at one the card
 * overran its budget. */

import { computeNavLog } from '$lib/route/navlog';
import { enrouteFreqsByLeg } from '$lib/route/airspaces';
import { effectiveCruiseSpeedKt } from './aircraft.svelte';
import { dataState, getAirspaces } from './data.svelte';
import { cachedAirspaceSchedule } from './navlogSchedule';
import { routeSettings, type Route } from './route.svelte';
import { routeTerrainSamples } from './routeTerrain.svelte';
import { resolveScheduleRadios } from './scheduleRadios.svelte';

/** The enroute lines per leg, or null while the airspaces are not loaded
 *  (the estimator then prices the column flat, as it always did). */
export function routeEnrouteLineCounts(route: Route): number[] | null {
	const airspaces = dataState.airspacesLoaded ? getAirspaces() : null;
	if (!airspaces || route.waypoints.length < 2) {
		return null;
	}
	const cruise = effectiveCruiseSpeedKt();
	const schedule = resolveScheduleRadios(
		cachedAirspaceSchedule(
			route.waypoints,
			airspaces,
			cruise,
			routeSettings.defaultAltitudeFt,
			routeTerrainSamples(route.id, route.waypoints),
		),
		airspaces,
	);
	const legCumNM = computeNavLog(route.waypoints, cruise).legs.map((l) => l.cumNM);
	return enrouteFreqsByLeg(schedule, legCumNM, !routeSettings.vfr).map((lines) => lines.length);
}
