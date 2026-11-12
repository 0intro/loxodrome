/* Loxodrome's own answers to the questions state/planScope.svelte.ts asks.
 *
 * This is the one place the route workspace is handed to the NOTAM half and to
 * the airspace panel. Called once from src/main.ts, inside boot(), alongside
 * the dynamic App import: the state modules read their storage at module
 * evaluation, so anything static in main.ts would evaluate ahead of the
 * shared-mode boot sweep (docs/accounts-sync.md, Device modes).
 *
 * Registration is a single write per slot. planScope is `$state`, so a memo
 * that already read a null slot is invalidated rather than left stale.
 */

import { planScope } from './planScope.svelte';
import { areaOfPoints, type CoverageArea } from './coverage.svelte';
import { airportByIdent } from './data.svelte';
import { flightPrep, hasStatedEtd } from './flightPrep.svelte';
import { routeCorridorNotamIds } from './notamCorridor.svelte';
import { currentPose } from './navRecording.svelte';
import { routes, routeSettings } from './route.svelte';
import { hasFlyableRoute, plannedFlightTimed, plannedFlightWindow } from './timeWindow.svelte';

/** Map each route-aerodrome ICAO ident to its position along the routes: every
 *  route's airport-anchored waypoints, in order, all routes concatenated in tab
 *  order, the first occurrence winning. This is the aerodrome-block order SOFIA
 *  gives a bulletin (departure, overflown / alternates, destination), extended
 *  across all drawn routes. Reactive: reads routes.list and each waypoint. */
function routeAerodromeRank(): Map<string, number> {
	// A plain index handed to the pure sorter, not reactive state.
	const rank = new Map<string, number>();
	let n = 0;
	for (const route of routes.list) {
		for (const wp of route.waypoints) {
			if (wp.kind === 'airport' && wp.ident) {
				const ident = wp.ident.toUpperCase();
				if (!rank.has(ident)) {
					rank.set(ident, n++);
				}
			}
		}
	}
	return rank;
}

/** The grid the aircraft's position is snapped to (degrees): its area
 *  changes, and the coverage passes, every half degree flown rather than
 *  on every fix; the gate's own margin (1.5 degrees) still reaches well
 *  past the aircraft. */
const POSE_GRID_DEG = 0.5;

const snap = (x: number): number => Math.round(x / POSE_GRID_DEG) * POSE_GRID_DEG;

/** The areas the plan needs reference data for, wherever the map is: each
 *  route's extent, one rectangle apiece, and each aerodrome the performance
 *  page adds by hand, at the position the loaded airports place it (the
 *  worldwide baseline has it before its country's own AIP does, which is
 *  what brings that AIP in); and, wherever a pose exists (the live fix, or
 *  any loaded trace's playhead), the aircraft itself: the alerts read the ground and the airspace where
 *  it is, and a diversion flown out of the plan with the map panned away
 *  left them without that country. Separate rectangles, never one envelope:
 *  the coverage gate tests each (state/coverage.svelte.ts). Reactive: reads
 *  the routes, their waypoints, the manual list, the airports revision and
 *  the pose. */
function planExtent(): CoverageArea[] {
	const out: CoverageArea[] = [];
	const pose = currentPose();
	if (pose && Number.isFinite(pose.lat) && Number.isFinite(pose.lon)) {
		const lat = snap(pose.lat);
		const lon = snap(pose.lon);
		out.push({ minLat: lat, minLon: lon, maxLat: lat, maxLon: lon });
	}
	for (const route of routes.list) {
		const area = areaOfPoints(route.waypoints);
		if (area) {
			out.push(area);
		}
	}
	for (const icao of flightPrep.perf.manualIcaos) {
		const a = airportByIdent(icao);
		if (a) {
			out.push({ minLat: a.lat, minLon: a.lon, maxLat: a.lat, maxLon: a.lon });
		}
	}
	return out;
}

/** Hand the route workspace to every surface that reads a plan without
 *  importing one. Idempotent; call once at boot. */
export function installFlightScope(): void {
	planScope.flight = {
		window: plannedFlightWindow,
		flyable: hasFlyableRoute,
		etdStated: hasStatedEtd,
		timed: plannedFlightTimed,
	};
	planScope.corridor = routeCorridorNotamIds;
	planScope.aerodromeRank = routeAerodromeRank;
	planScope.flightRules = () => (routeSettings.vfr ? 'vfr' : 'ifr');
	planScope.extent = planExtent;
}
