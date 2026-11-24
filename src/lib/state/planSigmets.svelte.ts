/* The SIGMETs the planned flight meets, for the Overview's box B and the
 * print review: every route's track inside the NOTAM corridor, the window a
 * briefing for the flight covers (briefingWindow) and the highest level the
 * plan flies, against every advisory held (state/sigmets.svelte.ts),
 * whatever period or level band the map is read at. Flight app only.
 *
 * Reads reactive state, so call it inside a $derived or $effect. */

import { NM_TO_METERS } from '$lib/notam/units';
import { sigmetsOnPlan, type Sigmet } from '$lib/weather/sigmet';
import { dataState } from './data.svelte';
import { display } from './display.svelte';
import { notamState } from './notam.svelte';
import { routes, routeSettings } from './route.svelte';
import { allSigmets, sigmetRings, sigmetsKnown } from './sigmets.svelte';
import { briefingFlightStart, briefingWindow } from './timeWindow.svelte';

/** West of this longitude a plan reaches the Americas, where AWC's US feed
 *  holds the domestic advisories. */
const AMERICAS_LON = -30;

/** Off: live weather is off or there is no plan. Unknown: the last attempt
 *  failed the feed the plan needs (sigmetsKnown). Otherwise the advisories
 *  met, none included. */
export type PlanSigmets =
	| { status: 'off' }
	| { status: 'unknown' }
	| {
			status: 'ok';
			list: Sigmet[];
			/** The flight's start (briefingFlightStart): a label dates an
			 *  advisory starting on another UTC day. */
			fromMs: number;
	  };

let memo: {
	all: Sigmet[];
	sig: string;
	revision: number;
	out: PlanSigmets;
} | null = null;

export function planSigmetsNow(nowMs = Date.now()): PlanSigmets {
	void notamState.tick;
	const win = briefingWindow(nowMs);
	if (!display.liveWeather || !win) {
		return { status: 'off' };
	}
	const drawn = routes.list.filter((r) => r.waypoints.length >= 2);
	if (!sigmetsKnown(drawn.some((r) => r.waypoints.some((w) => w.lon < AMERICAS_LON)))) {
		return { status: 'unknown' };
	}
	const all = allSigmets();
	const paths = drawn.map((r) => r.waypoints.map((w) => ({ lat: w.lat, lon: w.lon })));
	// A leg flies at its first waypoint's altitude: the last one's starts no
	// leg (a waypoint deleted after it leaves it where it was).
	const ceilingFt = Math.max(0, ...drawn.flatMap((r) => r.waypoints.slice(0, -1).map((w) => w.alt)));
	const halfWidthM = routeSettings.corridorRadiusNM * NM_TO_METERS;
	// The FIR rings a FIR-wide advisory falls back to arrive with the
	// airspace dataset.
	const revision = dataState.revision.airspaces;
	const sig = `${JSON.stringify(paths)}|${halfWidthM}|${ceilingFt}|${win.from}|${win.to}`;
	if (memo && memo.all === all && memo.sig === sig && memo.revision === revision) {
		return memo.out;
	}
	const out: PlanSigmets = {
		status: 'ok',
		list: sigmetsOnPlan(all, { paths, halfWidthM, window: win, ceilingFt }, sigmetRings),
		fromMs: briefingFlightStart(nowMs) ?? win.from,
	};
	memo = { all, sig, revision, out };
	return out;
}
