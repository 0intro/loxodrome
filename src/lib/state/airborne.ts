/* The airborne watermark both position-referenced alert engines read (the
 * airspace alerts, state/airspaceAlert.svelte.ts, and the terrain alerts,
 * state/terrainAlert.svelte.ts): the route-free stand-in for the motion
 * fold's takeoff commit, so the two gate on the SAME instant. Lifted out of
 * the airspace module unchanged in its rule, plus the one extra fact the
 * terrain engine needs: when the departure phase ends (TSO-C151c 10.4,
 * 1 500 ft above the departure runway).
 *
 * The gate RE-ARMS per flight (airborneGate, user-decided 2026-10-01): a
 * trace a landing was added to holds several flights, and a gate open since
 * the first takeoff kept the second departure's ground roll armed and its
 * departure phase long over. It closes only on a landing with GROUND
 * EVIDENCE, the motion fold's committed landing whose last known altitude
 * lies within TOUCH_AGL_FT of a known aerodrome's elevation (the logbook's
 * own touch test), from the instant that landing is confirmed, and never
 * for the helicopter or the glider symbol, whose slow flight a landing rule
 * cannot tell from a hover or a thermal; it reopens at the next fix at
 * takeoff speed. Anything short of that evidence (an off-field landing, a
 * strip the dataset lacks, ridge soaring, a hover) keeps the alerts armed,
 * the gate's behaviour before. firstAirborneMs and departureWatermark keep
 * answering the FIRST flight.
 *
 * Watermarked per trace ARRAY (a live recording appends in place, an
 * imported trace is a fresh array), scanned incrementally, and answered as
 * trace instants so a scrubbed replay reads them against its own playhead.
 * Plain .ts: module memo, no runes (the navMotion.ts shape). */

import type { Airport } from '$lib/data/airports';
import { TOUCH_AGL_FT } from '$lib/nav/logbook';
import { LANDING_SUSTAIN_MS, TAKEOFF_KT } from '$lib/nav/navlogLive';
import { deriveMotion, type TrackPoint } from '$lib/nav/trace';
import { equirectangularDistanceM } from '$lib/notam/geometry';
import { NM_TO_METERS } from '$lib/notam/units';
import { getAirports } from './data.svelte';
import { traceMotion } from './navMotion';
import { nav, poseAltMslFt } from './navRecording.svelte';

let airWm: {
	points: readonly TrackPoint[] | null;
	scanned: number;
	firstIdx: number | null;
	slowSeen: boolean;
} = {
	points: null,
	scanned: 0,
	firstIdx: null,
	slowSeen: false,
};

/** Index of the first trace fix at or above the takeoff speed. A point
 *  without a device speed (a bare GPX import) gets one derived from its
 *  predecessor, so a replayed debrief still passes the airborne gate. */
export function firstAirborneIndex(points: readonly TrackPoint[]): number | null {
	if (airWm.points !== points) {
		airWm = { points, scanned: 0, firstIdx: null, slowSeen: false };
	}
	if (airWm.firstIdx == null) {
		for (let i = airWm.scanned; i < points.length; i++) {
			let kt = points[i].speedKt;
			if (kt == null && i > 0) {
				kt = deriveMotion(points[i - 1], points[i]).speedKt;
			}
			if ((kt ?? 0) >= TAKEOFF_KT) {
				airWm.firstIdx = i;
				break;
			}
			if (kt != null) {
				airWm.slowSeen = true;
			}
		}
		airWm.scanned = points.length;
	}
	return airWm.firstIdx;
}

/** Whether the trace saw its own takeoff: a fix below the takeoff speed
 *  before the first one at or above it. False for a trace that opens already
 *  fast (a recording started in flight, a file cut after the climb), whose
 *  airborne instant is inherited rather than observed, navlogLive's own
 *  `takeoffObserved`; null while the trace has not been airborne. */
export function takeoffObserved(points: readonly TrackPoint[]): boolean | null {
	return firstAirborneIndex(points) == null ? null : airWm.slowSeen;
}

/** First trace instant at or above the takeoff speed; the alert gate's
 *  route-free stand-in for the motion fold's takeoff commit. */
export function firstAirborneMs(points: readonly TrackPoint[]): number | null {
	const i = firstAirborneIndex(points);
	return i == null ? null : points[i].timeMs;
}

/** Height above the departure the departure phase ends at (TSO-C151c 10.4). */
export const DEPARTURE_END_FT = 1500;

let depWm: {
	points: readonly TrackPoint[] | null;
	scanned: number;
	baseFt: number | null;
	endMs: number | null;
} = { points: null, scanned: 0, baseFt: null, endMs: null };

/** The trace's own altitude at the airborne instant (the device's feet, on
 *  the trace's own datum: the first fix at or after it that carries one,
 *  since a recorder may interleave fixes without), and the first instant
 *  after it at which the trace stood DEPARTURE_END_FT above that: the end of
 *  the departure phase. The difference is taken between two readings on one
 *  datum, so the geoid offset cancels. Both null while the trace has given no
 *  altitude since takeoff; `endMs` null while the climb has not got there.
 *
 *  A trace that did not see its takeoff (takeoffObserved false) has no
 *  departure to measure from: the altitude it was joined at is a cruise
 *  level as often as not, and 1 500 ft above THAT would hold the departure's
 *  100 ft clearance over a whole IFR cruise. Its departure phase ends at the
 *  airborne instant. Once found, the end is final: a live recording
 *  appending fixes must not move it, or the replay of the same array would
 *  read another phase than the flight did. */
export function departureWatermark(points: readonly TrackPoint[]): { baseFt: number | null; endMs: number | null } {
	const first = firstAirborneIndex(points);
	if (depWm.points !== points) {
		depWm = { points, scanned: 0, baseFt: null, endMs: null };
	}
	if (first == null) {
		return { baseFt: null, endMs: null };
	}
	if (depWm.endMs != null) {
		return { baseFt: depWm.baseFt, endMs: depWm.endMs };
	}
	if (!airWm.slowSeen) {
		depWm.endMs = points[first].timeMs;
		depWm.scanned = points.length;
		return { baseFt: null, endMs: depWm.endMs };
	}
	if (depWm.scanned < first) {
		depWm.scanned = first;
	}
	for (let i = depWm.scanned; i < points.length; i++) {
		const a = points[i].altFt;
		depWm.scanned = i + 1;
		if (a == null) {
			continue;
		}
		if (depWm.baseFt == null) {
			depWm.baseFt = a;
		} else if (a >= depWm.baseFt + DEPARTURE_END_FT) {
			depWm.endMs = points[i].timeMs;
			break;
		}
	}
	if (depWm.endMs != null) {
		depWm.scanned = points.length;
	}
	return { baseFt: depWm.baseFt, endMs: depWm.endMs };
}

// ---- per flight ----------------------------------------------------------

/** What a landing needs to close the gate: the trace's altitudes on mean sea
 *  level, and the elevation of a known aerodrome near a position, null when
 *  none is and undefined while the aerodromes are not loaded (the landing is
 *  then asked about again rather than decided open). */
export interface GroundEvidence {
	altMslFt: (p: TrackPoint) => number | null;
	fieldElevFt: (lat: number, lon: number) => number | null | undefined;
}

/** The gate at one instant. */
export interface AirborneGate {
	airborne: boolean;
	/** When the instant's flight opened (its first fix at takeoff speed);
	 *  null before the first. */
	openMs: number | null;
	/** How many times the gate has REOPENED after a closing landing by the
	 *  instant: the pilot's terrain inhibit is scoped to it, the stop being
	 *  the power cycle Garmin lifts its own at. */
	epoch: number;
	/** The end of that flight's departure phase, null while its climb has not
	 *  got there (departureWatermark's rule, per flight). */
	departureEndMs: number | null;
}

interface Flight {
	openIdx: number;
	openMs: number;
	/** The confirmed closing landing, null while the flight stands open. */
	closeMs: number | null;
	baseFt: number | null;
	departureEndMs: number | null;
	scanned: number;
}

let gateWm: {
	points: readonly TrackPoint[] | null;
	closes: boolean;
	flights: Flight[];
	/** The motion fold's committed landings decided so far. */
	landings: number;
	/** Fixes searched for the reopening after the last closure. */
	reopenScanned: number;
} = { points: null, closes: true, flights: [], landings: 0, reopenScanned: 0 };

/** The last fix at or before `ms`, -1 when none. */
function idxAtOrBefore(points: readonly TrackPoint[], ms: number): number {
	let lo = 0;
	let hi = points.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (points[mid].timeMs <= ms) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	return lo - 1;
}

/** Whether the landing whose slow streak opened at `landingMs` was made on a
 *  known aerodrome: the streak's last known altitude up to its confirmation
 *  within TOUCH_AGL_FT of the field's elevation. Undefined while the
 *  aerodromes cannot tell. */
function landedOnField(points: readonly TrackPoint[], landingMs: number, ev: GroundEvidence): boolean | undefined {
	const i = idxAtOrBefore(points, landingMs + LANDING_SUSTAIN_MS);
	if (i < 0) {
		return false;
	}
	let alt: number | null = null;
	for (let j = i; j >= 0 && points[j].timeMs >= landingMs; j--) {
		alt = ev.altMslFt(points[j]);
		if (alt != null) {
			break;
		}
	}
	const elev = ev.fieldElevFt(points[i].lat, points[i].lon);
	if (elev === undefined) {
		return undefined;
	}
	return alt != null && elev != null && Math.abs(alt - elev) <= TOUCH_AGL_FT;
}

/** The first fix at takeoff speed from index `from` on, the opening rule
 *  (firstAirborneIndex's, speed derived where a fix carries none). */
function fastFrom(points: readonly TrackPoint[], from: number): number | null {
	for (let i = from; i < points.length; i++) {
		let kt = points[i].speedKt;
		if (kt == null && i > 0) {
			kt = deriveMotion(points[i - 1], points[i]).speedKt;
		}
		if ((kt ?? 0) >= TAKEOFF_KT) {
			return i;
		}
	}
	return null;
}

/** Fold the closures and reopenings the trace holds so far. */
function advanceFlights(points: readonly TrackPoint[], ev: GroundEvidence): void {
	const landings = traceMotion(points).landingsMs;
	for (;;) {
		const last = gateWm.flights[gateWm.flights.length - 1];
		if (last.closeMs != null) {
			const closeMs = last.closeMs;
			const from = Math.max(gateWm.reopenScanned, idxAtOrBefore(points, closeMs) + 1);
			const idx = fastFrom(points, from);
			if (idx == null) {
				gateWm.reopenScanned = points.length;
				return;
			}
			gateWm.flights.push({
				openIdx: idx,
				openMs: points[idx].timeMs,
				closeMs: null,
				baseFt: null,
				departureEndMs: null,
				scanned: idx,
			});
			gateWm.reopenScanned = 0;
			continue;
		}
		if (gateWm.landings >= landings.length) {
			return;
		}
		const landingMs = landings[gateWm.landings];
		if (landingMs > last.openMs) {
			const onField = landedOnField(points, landingMs, ev);
			if (onField === undefined) {
				return;
			}
			if (onField) {
				last.closeMs = landingMs + LANDING_SUSTAIN_MS;
			}
		}
		gateWm.landings++;
	}
}

/** The departure phase of flight `k`: the first flight's is
 *  departureWatermark's own; a later one's ends DEPARTURE_END_FT above the
 *  first altitude at or after its opening, and is final once found. */
function flightDepartureEndMs(points: readonly TrackPoint[], k: number): number | null {
	if (k === 0) {
		return departureWatermark(points).endMs;
	}
	const f = gateWm.flights[k];
	if (f.departureEndMs != null) {
		return f.departureEndMs;
	}
	for (let i = f.scanned; i < points.length; i++) {
		const a = points[i].altFt;
		f.scanned = i + 1;
		if (a == null) {
			continue;
		}
		if (f.baseFt == null) {
			f.baseFt = a;
		} else if (a >= f.baseFt + DEPARTURE_END_FT) {
			f.departureEndMs = points[i].timeMs;
			break;
		}
	}
	return f.departureEndMs;
}

/** The alert gate at instant `t`: airborne from the first fix at takeoff
 *  speed, closed from the confirmation of a landing made on a known
 *  aerodrome (`ev`; null leaves every landing undecided) until the next fix
 *  at takeoff speed. `closes` false (a helicopter, a glider) keeps the gate
 *  open from the first takeoff on, as it always was. */
export function airborneGate(
	points: readonly TrackPoint[],
	t: number,
	ev: GroundEvidence | null,
	closes: boolean,
): AirborneGate {
	const first = firstAirborneIndex(points);
	if (gateWm.points !== points || gateWm.closes !== closes) {
		gateWm = { points, closes, flights: [], landings: 0, reopenScanned: 0 };
	}
	if (first == null) {
		return { airborne: false, openMs: null, epoch: 0, departureEndMs: null };
	}
	if (gateWm.flights.length === 0) {
		gateWm.flights.push({
			openIdx: first,
			openMs: points[first].timeMs,
			closeMs: null,
			baseFt: null,
			departureEndMs: null,
			scanned: first,
		});
	}
	if (closes && ev != null) {
		advanceFlights(points, ev);
	}
	let k = gateWm.flights.length - 1;
	while (k >= 0 && gateWm.flights[k].openMs > t) {
		k--;
	}
	if (k < 0) {
		return { airborne: false, openMs: null, epoch: 0, departureEndMs: null };
	}
	const f = gateWm.flights[k];
	return {
		airborne: f.closeMs == null || t < f.closeMs,
		openMs: f.openMs,
		epoch: k,
		departureEndMs: flightDepartureEndMs(points, k),
	};
}

/** A known aerodrome within this of a landing's position is the one it was
 *  made on (the logbook's place radius, state/flightLibrary.svelte.ts). */
const FIELD_RADIUS_NM = 3;

/** The elevation of the nearest loaded aerodrome within FIELD_RADIUS_NM. */
function nearestFieldElevFt(airports: readonly Airport[], lat: number, lon: number): number | null {
	const latBand = FIELD_RADIUS_NM / 60;
	let bestM = FIELD_RADIUS_NM * NM_TO_METERS;
	let elev: number | null = null;
	for (const a of airports) {
		if (Math.abs(a.lat - lat) > latBand || a.elevFt == null) {
			continue;
		}
		const d = equirectangularDistanceM(lat, lon, a.lat, a.lon);
		if (d <= bestM) {
			bestM = d;
			elev = a.elevFt;
		}
	}
	return elev;
}

/** The live trace's gate at `t`, over its own datum, the loaded aerodromes
 *  and the aircraft symbol: what both alert engines and the terrain
 *  inhibit's scope read. */
export function liveAirborneGate(t: number): AirborneGate {
	return airborneGate(
		nav.points,
		t,
		{
			altMslFt: poseAltMslFt,
			fieldElevFt: (lat, lon) => {
				const airports = getAirports();
				return airports == null ? undefined : nearestFieldElevFt(airports, lat, lon);
			},
		},
		nav.iconKind === 'plane',
	);
}
