/* Resolution of the two SOURCED evaluation windows: the typed custom range and
 * the planned flight's own span. The default (now plus the look-ahead) and the
 * public activeEvalWindow() stay in notam.svelte.ts, where the minute
 * heartbeat lives, so this module can reach route and flight-prep state
 * without closing an import cycle.
 *
 * Reads reactive state, so call these inside a $derived or $effect. */

import { orderedTrips } from '$lib/aircraft/trips';
import { computeNavLog } from '$lib/route/navlog';
import { chainDepartures } from '$lib/route/legWind';
import { effectiveCruiseSpeedKt } from './aircraft.svelte';
import { filter, parseUtcDateTime } from './filter.svelte';
import { dossierStopEffectiveMin } from './flightPrep.svelte';
import { memoised } from './memoSelector';
import { routes } from './route.svelte';
import { firstDepartureMs } from './routeWind.svelte';

/** Pad before the first ETD: the hour the briefing is actually read, on the
 *  ramp, and the start delay that follows it. EasyVFR 4 uses the same hour. */
const PAD_BEFORE_MS = 60 * 60_000;
/** Pad after the last arrival: a hold plus the approach. EasyVFR uses two
 *  hours here, Garmin Pilot three; two keeps a day VFR flight's overlays
 *  tight without clipping a diversion. */
const PAD_AFTER_MS = 2 * 60 * 60_000;

/** The typed UTC range as epoch ms, or null when the window is not in custom
 *  mode or the inputs are not a valid from <= to pair. */
export function customWindow(): { from: number; to: number } | null {
	if (filter.window.mode !== 'custom') {
		return null;
	}
	const from = parseUtcDateTime(filter.window.fromDate, filter.window.fromTime);
	const to = parseUtcDateTime(filter.window.toDate, filter.window.toTime);
	if (Number.isNaN(from) || Number.isNaN(to) || from > to) {
		return null;
	}
	return { from, to };
}

/** Is there a route the flight window could be derived from? Drives the
 *  Flight option's enabled state, which must not depend on the mode already
 *  being 'flight'. */
export function hasFlyableRoute(): boolean {
	return routes.list.some((r) => r.waypoints.length >= 2);
}

const flightSpan = memoised(
	// Every reactive input, unconditionally (the memoSelector contract): the
	// departure anchor, the cruise speed, the ground stops, and every waypoint
	// of every trip and alternate.
	() => {
		const trips = orderedTrips(routes.list);
		return (
			`${firstDepartureMs()}|${effectiveCruiseSpeedKt() ?? '-'}|` +
			trips
				.map(
					(tr, i) =>
						`${dossierStopEffectiveMin(i)}:` +
						[tr.route, tr.alternate]
							.map((r) =>
								r ? r.waypoints.map((w) => `${w.lat},${w.lon}`).join(';') : '',
							)
							.join('/'),
				)
				.join('#')
		);
	},
	() => computeFlightSpan(),
);

/** The planned flight's window: the first ETD less the ramp hour, to the last
 *  arrival plus the slack, an alternate's arrival counted as an arrival (a
 *  diversion is still the flight). Null when no trip has two waypoints or no
 *  cruise speed resolves, so the caller falls back to the unbounded default
 *  rather than to a window that would hide everything. */
export function plannedFlightWindow(): { from: number; to: number } | null {
	return flightSpan();
}

function computeFlightSpan(): { from: number; to: number } | null {
	const trips = orderedTrips(routes.list).filter((tr) => tr.route.waypoints.length >= 2);
	if (trips.length === 0) {
		return null;
	}
	const cruise = effectiveCruiseSpeedKt();
	const stillAir = trips.map((tr) => computeNavLog(tr.route.waypoints, cruise).totalEteMin);
	if (stillAir.some((m) => m == null)) {
		return null;
	}
	const chain = chainDepartures(
		stillAir,
		trips.map((_, i) => dossierStopEffectiveMin(i)),
		firstDepartureMs(),
	);
	let last = chain[chain.length - 1].arrivalMs;
	trips.forEach((tr, i) => {
		const alt = tr.alternate;
		if (!alt || alt.waypoints.length < 2) {
			return;
		}
		const min = computeNavLog(alt.waypoints, cruise).totalEteMin;
		if (min != null) {
			last = Math.max(last, chain[i].arrivalMs + min * 60_000);
		}
	});
	return { from: chain[0].departureMs - PAD_BEFORE_MS, to: last + PAD_AFTER_MS };
}
