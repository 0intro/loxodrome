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
import {
	dossierFlightDate,
	dossierStopEffectiveMin,
	flightPrep,
	hasStatedEtd,
} from './flightPrep.svelte';
import { memoised } from './memoSelector';
import { routes } from './route.svelte';
import { firstDepartureMs } from './routeWind.svelte';
import { floorHourMs } from './windAloft.svelte';

/** Pad before the first ETD: the hour the briefing is actually read, on the
 *  ramp, and the start delay that follows it. EasyVFR 4 uses the same hour. */
const PAD_BEFORE_MS = 60 * 60_000;
/** Pad after the last arrival: a hold plus the approach. EasyVFR uses two
 *  hours here, Garmin Pilot three; two keeps a day VFR flight's overlays
 *  tight without clipping a diversion. */
const PAD_AFTER_MS = 2 * 60 * 60_000;
/** The window a flight with no stated departure time gets: its whole day. */
const DAY_MS = 24 * 60 * 60_000;

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
	// departure anchor, whether an ETD was STATED at all and on what date (the
	// two the no-ETD branch reads, which the anchor alone would not move if a
	// typed ETD happened to equal the fallback), the cruise speed, the ground
	// stops, and every waypoint of every trip and alternate.
	() => {
		const trips = orderedTrips(routes.list);
		return (
			`${firstDepartureMs()}|${flightPrep.dossier.departureTime ?? '-'}|` +
			`${dossierFlightDate()}|${effectiveCruiseSpeedKt() ?? '-'}|` +
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
 *  diversion is still the flight). With no ETD stated it is the whole day of
 *  the dossier flight date instead (see computeFlightSpan). Null when no trip
 *  has two waypoints or no cruise speed resolves, so the caller falls back to
 *  the unbounded default rather than to a window that would hide everything. */
export function plannedFlightWindow(): { from: number; to: number } | null {
	return flightSpan();
}

function computeFlightSpan(): { from: number; to: number } | null {
	const trips = orderedTrips(routes.list).filter((tr) => tr.route.waypoints.length >= 2);
	if (trips.length === 0) {
		return null;
	}
	// No ETD stated: the flight is somewhere in its DAY, so the day IS the
	// window. The alternative is what this did before, invent an hour
	// (firstDepartureMs's fallback) and present the span around it as the
	// flight's own; navLive.svelte.ts already refuses that for the ETO column,
	// on the rule that a fallback must never become a clock time the pilot can
	// read as stated. It also answered the wrong DAY for a flight dated later,
	// and its start, an hour before an ETD at most an hour away, was ALWAYS in
	// the past, which is an instant SOFIA will not brief FROM
	// (docs/sofia-briefing.md, "The departure instant SOFIA accepts").
	//
	// Ahead of the cruise-speed work on purpose: which day a flight is on does
	// not depend on how fast it is flown.
	if (!hasStatedEtd()) {
		const dayMs = Date.parse(`${dossierFlightDate()}T00:00:00Z`);
		return Number.isFinite(dayMs) ? { from: dayMs, to: dayMs + DAY_MS } : null;
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

/** Where the period's instant comes from. 'flight' is a departure the pilot
 *  STATED; 'flight-day' the same flight with no departure time, whose instant
 *  is a fallback and must never be worded as a stated one (hasStatedEtd is the
 *  test every such surface shares). */
export type PeriodAnchorSource = 'now' | 'flight' | 'flight-day' | 'custom';

/** The single INSTANT the viewing period anchors on, and where it came from:
 *  the current hour under 'now', the flight's own departure under 'flight'
 *  (firstDepartureMs, exactly what the nav log's first leg flies, so the map
 *  and the plan cannot brief different hours), the typed range's start under
 *  'custom'. Every fall-through lands on the current hour, mirroring
 *  activeEvalWindow's own safety rule: a period that states no instant must
 *  leave the map on the hour in force rather than on one nobody asked for.
 *
 *  The current hour, not the next one: this is the instant something is READ
 *  at, where firstDepartureMs answers when a flight can DEPART. Reads reactive
 *  state, so call it inside a $derived or $effect; the caller reads the minute
 *  heartbeat for the two clock-relative sources (state/wxTime.svelte.ts). */
export function periodAnchor(nowMs = Date.now()): { ms: number; source: PeriodAnchorSource } {
	// Both sourced branches are consulted the way activeEvalWindow consults
	// them, so the mode is tracked whichever one answers.
	const custom = customWindow();
	if (custom) {
		return { ms: custom.from, source: 'custom' };
	}
	const flight = filter.window.mode === 'flight' ? plannedFlightWindow() : null;
	if (flight) {
		return { ms: firstDepartureMs(), source: hasStatedEtd() ? 'flight' : 'flight-day' };
	}
	return { ms: floorHourMs(nowMs), source: 'now' };
}
