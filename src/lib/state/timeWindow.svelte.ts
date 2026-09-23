/* Resolution of the PLANNED FLIGHT's own evaluation window: its span, and
 * whether there is a flight to derive one from. The default (now plus the
 * look-ahead) and the public activeEvalWindow() stay in notam.svelte.ts, where
 * the minute heartbeat lives, so this module can reach route and flight-prep
 * state without closing an import cycle; the typed custom range lives in
 * filter.svelte.ts beside the fields it reads and the error it mirrors.
 *
 * Everything here needs a route workspace. That is the whole of what this
 * module is, and it is why the graph below (trips, nav log, leg wind, the
 * cruise speed, the forecast) hangs off it: a NOTAM period sourced from a
 * flight has to know how long the flight takes.
 *
 * Reads reactive state, so call these inside a $derived or $effect. */

import { orderedTrips } from '$lib/aircraft/trips';
import { computeNavLog } from '$lib/route/navlog';
import { chainDepartures } from '$lib/route/legWind';
import { effectiveCruiseSpeedKt } from './aircraft.svelte';
import { customWindow, filter } from './filter.svelte';
import {
	dossierFlightDate,
	dossierStopEffectiveMin,
	flightPrep,
	hasStatedEtd,
} from './flightPrep.svelte';
import { memoised } from './memoSelector';
import { drawnStateAt } from './notam.svelte';
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

/** The flight's day as a closed range, [00:00, 24:00) held as its last
 *  millisecond: every gate over it compares both ends INCLUSIVELY (validIn,
 *  the D) walk), so a day ending AT the next midnight charged a Tuesday
 *  flight with a closure starting Wednesday 0000Z, a runway shut "WED H24"
 *  and a channel changing at Wednesday's first minute. */
function dayRange(dayMs: number): { from: number; to: number } {
	return { from: dayMs, to: dayMs + DAY_MS - 1 };
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

/** The range a PLANNED FLIGHT's own operational state is judged over: the
 *  frequency the nav log says to set, the sector hours it withdraws a radio
 *  on, the runway and the declared distances the performance page computes
 *  with, the fuel a stop can still serve.
 *
 *  Deliberately not activeEvalWindow(): that is a briefing filter whose
 *  look-ahead is unbounded by default, and "in force at some point between now
 *  and forever" is true of every schedule and every future-dated NOTAM ever
 *  published. An 8.33 kHz conversion effective next month then moved today's
 *  frequency, a works closure next week struck today's runway. Which
 *  frequency to set and which runway to compute on are questions about the
 *  flight, so this is the flight's own span (its ETD less the ramp hour to its
 *  last arrival plus the slack, or the whole day of the flight date when no
 *  ETD is stated).
 *
 *  When the span does not resolve, which a plan reaches by stating a
 *  departure time with no cruise speed to fly it at, the flight is still
 *  somewhere in its own DAY, which is exactly what computeFlightSpan falls
 *  back to when no ETD is stated: judging a Saturday plan by today's Monday
 *  would withdraw a frequency the flight will need. Only a malformed stored
 *  date reaches the drawn instant. */
export function plannedFlightAt(): { fromMs: number; toMs: number } {
	const w = plannedFlightWindow();
	if (w) {
		return { fromMs: w.from, toMs: w.to };
	}
	const dayMs = Date.parse(`${dossierFlightDate()}T00:00:00Z`);
	if (Number.isFinite(dayMs)) {
		const day = dayRange(dayMs);
		return { fromMs: day.from, toMs: day.to };
	}
	return drawnStateAt();
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
		return Number.isFinite(dayMs) ? dayRange(dayMs) : null;
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
