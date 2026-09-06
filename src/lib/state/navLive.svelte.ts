/* Navigation-mode live selector: ONE evaluation per fix serving the whole
 * merged surface: the live nav log (per-waypoint ATO / estimate chain), the
 * radio-contact resolution (current / next / destination), the live schedule
 * overlay (per-row crossing stamps, contact rows, next-change countdown
 * chip) and the sheet's contact keys. Route-referenced: the pose projects
 * ONCE onto the planned route's distance axis (the shared state/navProgress
 * checkpoints) and every answer reads that distance. Heavy stages stay
 * memoised on geometry, never on the pose (the "per-tick writes never
 * re-run the heavy walks" discipline): the schedule rides the shared
 * cachedAirspaceSchedule memo, the two passage folds extend incrementally
 * per appended fix (the waypoint fold keyed on the checkpoints ref; the
 * schedule fold on the checkpoints + RAW schedule refs, because
 * resolveScheduleRadios returns a fresh array per call whenever a
 * frequency-change NOTAM is visible and must never key a fold), and each
 * evaluation costs O(legs + spans + events). The log side needs no
 * airspaces (contact / schedule ride along once the dataset loads);
 * without a pose the actuals stay blank but an explicit-ETD plan still
 * briefs and the aerodrome units still resolve. Contract: docs/nav-live.md. */

import { nav, currentPose } from './navRecording.svelte';
import { activeRoute, routes, routeSettings, type Waypoint } from './route.svelte';
import { legPinsFor, navRouteId, navSegments, segmentForRoute } from './navRoute.svelte';
import { airportByIdent, dataState, getAirspaces } from './data.svelte';
import { routeTerrainSamples } from './routeTerrain.svelte';
import { effectiveCruiseSpeedKt } from './aircraft.svelte';
import { flightPrep } from './flightPrep.svelte';
import { routeDepartureMs, routeLegGroundSpeeds } from './routeWind.svelte';
import { cachedAirspaceSchedule } from './navlogSchedule';
import { traceRouteCheckpoints } from './navProgress.svelte';
import { traceMotion } from './navMotion';
import { freqChangeIdents, resolveAirportRadios, resolveScheduleRadios } from './freqOverride.svelte';
import {
	buildContactSpans,
	closedContactSpans,
	outranksContact,
	contactEnterRowIdx,
	contactLeaveRowIdx,
	contactStateAt,
	contactTier,
	type ContactSpan,
	type ContactState,
	type RouteAirspaceEvent,
} from '$lib/route/airspaces';
import { computeNavLog, waypointLabel } from '$lib/route/navlog';
import {
	extendCrossings,
	liveNavlogAt,
	newCrossingFold,
	toNavlogDisplay,
	OFF_ROUTE_NM,
	type CrossingFold,
	type LiveNavlogState,
	type NavLiveSchedule,
	type NavlogLiveDisplay,
} from '$lib/nav/navlogLive';
import {
	progressDistNM,
	progressOffM,
	type LegPin,
	type RouteProgressPoint,
} from '$lib/nav/routeProgress';
import { contactChainAt, type NavContactUnit } from '$lib/nav/contactChain';
import { smoothedMotionAt, MIN_VECTOR_KT } from '$lib/nav/trace';
import { contactRadios, type Airport } from '$lib/data/airports';
import { crossTrackSide } from '$lib/nav/steering';
import { initialBearingDeg } from '$lib/notam/geometry';
import { decimalYearFromDate, magneticFromTrue } from '$lib/route/magnetic';
import { fmtClockUtc } from '$lib/route/format';
import { formatFreqMHz } from '$lib/format/radio';
import { NM_TO_METERS } from '$lib/notam/units';

export type { NavContactUnit };

export interface NavContactInfo {
	current: NavContactUnit | null;
	next: NavContactUnit | null;
	/** NM from the present along-route position to the next contact change:
	 *  the airspace boundary, or the distance still to fly when the
	 *  destination field is next. Null when the change has no distance to it
	 *  (leaving the departure field happens when the pilot is clear of it,
	 *  not at a boundary) and when there is no next unit at all. */
	toBoundaryNM: number | null;
	/** Minutes to that change at the live ground speed; null when the speed
	 *  is unknown or below MIN_VECTOR_KT. */
	eteMin: number | null;
	/** The clock at that change (ms UTC): the DISPLAY instant plus the ETE,
	 *  not wall clock, so a replay reads the times the flight actually had.
	 *  Null whenever the ETE is. */
	etoMs: number | null;
}

/** The whole merged live surface at the current pose. */
export interface NavLiveInfo {
	log: {
		/** For NavLogSheet's `live` prop (contact keys injected). */
		display: NavlogLiveDisplay;
		/** The numeric state (readouts, tests). */
		state: LiveNavlogState;
		/** The waypoint currently navigated to (the current leg's end). */
		nextIdent: string | null;
		nextDistNM: number | null;
		/** Minutes to it at the revision ground speed. */
		nextEteMin: number | null;
		/** Lateral offset beyond OFF_ROUTE_NM: the plan answers a route not
		 *  being flown. */
		offRoute: boolean;
		/** The segment the pilot told the log is being flown, while that
		 *  answer still stands (null once the flight sequences past it). The
		 *  surfaces say so: a log reading a hand-set segment is not reading
		 *  what it worked out itself. */
		pinnedLegIdx: number | null;
		/** Magnetic bearing from the aircraft to the active waypoint; null
		 *  without a pose or a target. */
		bearingMagDeg: number | null;
		/** Cross-track distance (NM) and the side of course it falls on
		 *  (+1 right, -1 left, 0 on course / unknown). */
		xtkNM: number | null;
		xtkSide: -1 | 0 | 1;
	};
	/** Null until the airspace dataset loads. */
	contact: NavContactInfo | null;
	/** For NavLogSchedule's `live` prop; null until the airspaces load. */
	scheduleLive: NavLiveSchedule | null;
	/** Every route-referenced answer here is about the nearest point of a
	 *  route the aircraft is not on: it is more than OFF_ROUTE_NM off this
	 *  one, or this is a route the flight never flew. The units, the
	 *  countdown and the schedule are then the plan, not the position, and
	 *  the surfaces say so instead of answering at full confidence. False
	 *  without a position at all, when nothing is being claimed. */
	planOnly: boolean;
}

/** The three per-leg memos are KEYED by route id: a plan of consecutive legs
 *  evaluates one leg per surface and pages between them, and single entries
 *  would reset each other on every alternation. The bound is the route cap,
 *  so they never need eviction. */
interface FoldMemo {
	/** The shared checkpoints array: navProgress hands out a FRESH array
	 *  exactly when it fully recomputes (trace replace / front-splice /
	 *  moved waypoint / a moved segment start), so the reference is the reset
	 *  key; the crossing boundaries derive from the same waypoint geometry, so
	 *  a stale fold cannot survive a route edit. */
	checkpoints: RouteProgressPoint[];
	fold: CrossingFold;
}
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- fold caches read through a plain function, never rendered
const foldMemo = new Map<string, FoldMemo>();

interface SchedFoldMemo {
	checkpoints: RouteProgressPoint[];
	/** The RAW cachedAirspaceSchedule output: memo-stable, and it changes
	 *  exactly when the event atNMs can (waypoint edits incl. leg ALTITUDES,
	 *  cruise, airspaces / terrain refs), which the checkpoints ref alone
	 *  does not cover. */
	schedule: RouteAirspaceEvent[];
	atNMs: number[];
	fold: CrossingFold;
}
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- as above
const schedFoldMemo = new Map<string, SchedFoldMemo>();

interface SpanMemo {
	schedule: RouteAirspaceEvent[];
	ifr: boolean;
	spans: ContactSpan[];
	/** Spans a service-closure NOTAM removed from `spans`: read back to stamp
	 *  "who WOULD have been the contact" provenance on the unit that replaced
	 *  them (the strip's closure marker). */
	closedSpans: ContactSpan[];
	/** Enter-event object -> absolute row index, for the schedule overlay. */
	evIndex: Map<RouteAirspaceEvent, number>;
}
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- as above
const spanMemo = new Map<string, SpanMemo>();

const FMT = { clock: fmtClockUtc };

/** The pilot's most recent leg assertion at or before an instant, so a
 *  scrubbed playhead reads the flight as it was corrected then. Pure. */
function latestPinAt(pins: readonly LegPin[], tMs: number): LegPin | null {
	let best: LegPin | null = null;
	for (const p of pins) {
		if (p.sinceMs <= tMs && (best == null || p.sinceMs >= best.sinceMs)) {
			best = p;
		}
	}
	return best;
}

function toContact(span: ContactSpan | null): NavContactUnit | null {
	if (!span) {
		return null;
	}
	return {
		kind: 'airspace',
		key: span.ev.key,
		label: `${span.ev.type} ${span.ev.name}`.trim(),
		radio: span.ev.radio,
		ident: null,
		freqFlagged: false,
	};
}

/** Closure provenance for a resolved unit: the closed span covering `dNM`
 *  that would have OUTRANKED the winner had its frequency not been withdrawn
 *  (a closed SIV over the FIC that answers in its place). The NOTAM id rides
 *  the resolver's row provenance, read duck-typed so the pure span type stays
 *  state-free. Null when no closure affected this resolution. */
function closedByAt(
	closedSpans: readonly ContactSpan[],
	dNM: number,
	winner: ContactSpan | null,
): NavContactUnit['closedBy'] | null {
	let best: ContactSpan | null = null;
	for (const s of closedSpans) {
		if (!(s.enterNM <= dNM && dNM < s.leaveNM)) {
			continue;
		}
		if (winner != null && !outranksContact(s, winner)) {
			continue;
		}
		if (best === null || outranksContact(s, best)) {
			best = s;
		}
	}
	if (!best) {
		return null;
	}
	const notamId =
		best.ev.radio
			.map(
				(r) =>
					(r as { closedBy?: { source?: { notam?: { id?: string } } } }).closedBy?.source
						?.notam?.id,
			)
			.find((id) => id != null) ?? '';
	return { notamId, closedLabel: `${best.ev.type} ${best.ev.name}`.trim() };
}

/** An airport as a contact unit. Radios ride the NavLogSheet parity gate, so
 *  a frequency-change NOTAM shows its effective value. A field with no usable
 *  published frequency is not a contact at all (a private strip, an unattended
 *  field): it yields no unit, the same acceptance buildContactSpans applies to
 *  an airspace. Reads reactive state (call inside $derived / $effect). Shared
 *  with the overflown-aerodrome selector (state/navOverflight.svelte). */
export function airportContactUnit(a: Airport): NavContactUnit | null {
	// A closed field is no contact whatever it publishes, and no frequency
	// change makes it one, so the gate runs before the resolution.
	if (contactRadios(a).length === 0) {
		return null;
	}
	// The resolution's FLAGS ride along too: a frequency change that could not
	// be tied to a published row is a change the list does not show, and in
	// flight there is nowhere else the pilot would see it.
	const resolved = freqChangeIdents().has(a.ident.toUpperCase()) ? resolveAirportRadios(a) : null;
	const radios = resolved ? resolved.radios : a.radios;
	if (!radios.some((r) => formatFreqMHz(r.freq) !== '')) {
		return null;
	}
	return {
		kind: 'aerodrome',
		key: null,
		label: `${a.ident} ${a.name}`.trim(),
		radio: radios,
		ident: a.ident,
		freqFlagged: (resolved?.flags.length ?? 0) > 0,
	};
}

/** An aerodrome waypoint as a contact unit: the route's first or last
 *  waypoint when it is an airport known to the dataset (an unknown ident
 *  yields no unit, the resolution-as-gate rule). */
function aerodromeUnit(wp: Waypoint | undefined): NavContactUnit | null {
	if (!wp || wp.kind !== 'airport' || !wp.ident || !dataState.airportsLoaded) {
		return null;
	}
	const a = airportByIdent(wp.ident);
	return a ? airportContactUnit(a) : null;
}

/** The merged live state at the current pose, or null while no route has two
 *  waypoints. There is no master toggle: a planned route always has a live
 *  layer, and without a trace it simply has nothing to stamp (the estimate
 *  chain still briefs off an explicit ETD). Reads reactive state (call inside
 *  $derived / $effect); the gate runs first so everything stays untracked
 *  without a route. */
export function navLiveNow(): NavLiveInfo | null {
	return navLiveFor(navRouteId());
}

/** The merged live state for ONE leg of the plan, at the current pose. The
 *  leg's own slice of the trace is the segment nav/routeAssign gave it, so a
 *  leg flown after a junction stamps from the junction and not from the
 *  outing's takeoff. An unknown id falls back to the active route. */
/** The pose-free "log side" prefix shared by navLiveFor and replayEvents:
 *  resolve the leg (route + trace slice), the outing's motion facts and the
 *  waypoint crossing fold, extended to the trace end. Null while the route
 *  has fewer than two waypoints. Reads reactive state. */
function legCrossingFolds(routeId: string) {
	const route = routes.list.find((r) => r.id === routeId) ?? activeRoute();
	if (route.waypoints.length < 2) {
		return null;
	}
	// The leg's slice: where it began, and whether the preceding leg's arrival
	// proved its identity (which retires the crossing fold's seed guard).
	const segment = segmentForRoute(route.id);
	const fromIdx = segment?.fromIdx ?? 0;
	const chained = segment?.chained === true;
	const cruiseKt = effectiveCruiseSpeedKt();
	const legs = computeNavLog(route.waypoints, cruiseKt).legs;
	const checkpoints = traceRouteCheckpoints(route.waypoints, fromIdx, route.id);
	// The outing's motion facts, folded once over the trace (the shared
	// state/navMotion memo): the crossing folds gate on the takeoff it
	// commits. Each fold carries its own cursor, so extending is O(new data)
	// and a caught-up fold is a no-op.
	const motion = traceMotion(nav.points);
	// A chained leg is gated by its own departure from the junction, not by
	// the outing's takeoff, which happened legs ago.
	const departureMs = chained && segment ? segment.fromMs : motion.takeoffMs;
	const boundaries = legs.map((l) => l.cumNM);
	let leg = foldMemo.get(route.id);
	if (!leg || leg.checkpoints !== checkpoints) {
		leg = { checkpoints, fold: newCrossingFold(boundaries) };
		foldMemo.set(route.id, leg);
	}
	extendCrossings(leg.fold, checkpoints, boundaries, departureMs, chained);
	return { route, segment, chained, cruiseKt, legs, checkpoints, motion, departureMs, fold: leg.fold };
}

/** The schedule-side twin over the RAW cachedAirspaceSchedule (never the
 *  resolved copy: resolveScheduleRadios returns a fresh array per call
 *  while a frequency-change NOTAM is visible, and a fresh reference must
 *  never key or drive a fold), extended to the trace end. */
function scheduleFoldFor(
	f: NonNullable<ReturnType<typeof legCrossingFolds>>,
	airspaces: NonNullable<ReturnType<typeof getAirspaces>>,
): SchedFoldMemo {
	const schedule = cachedAirspaceSchedule(
		f.route.waypoints,
		airspaces,
		f.cruiseKt,
		routeSettings.defaultAltitudeFt,
		routeTerrainSamples(f.route.id, f.route.waypoints),
	);
	let sched = schedFoldMemo.get(f.route.id);
	if (!sched || sched.checkpoints !== f.checkpoints || sched.schedule !== schedule) {
		const atNMs = schedule.map((ev) => ev.atNM);
		sched = { checkpoints: f.checkpoints, schedule, atNMs, fold: newCrossingFold(atNMs) };
		schedFoldMemo.set(f.route.id, sched);
	}
	extendCrossings(sched.fold, f.checkpoints, sched.atNMs, f.departureMs, f.chained);
	return sched;
}

export function navLiveFor(routeId: string): NavLiveInfo | null {
	const f = legCrossingFolds(routeId);
	if (!f) {
		return null;
	}
	const { route, segment, cruiseKt, legs, checkpoints, motion, departureMs } = f;

	// ---- shared, computed once per evaluation ----
	const points = nav.points;
	const tMs = nav.playheadMs;
	const pose = currentPose();
	const distNM = progressDistNM(checkpoints, tMs);
	const offM = progressOffM(checkpoints, tMs);
	// Live ground speed: the causal smoothed motion at the playhead (the
	// trajectory vector's filter, already gated at MIN_VECTOR_KT), else the
	// instant pose speed under the same gate. Feeds the estimate chain, the
	// contact boundary ETE and the destination ETE alike.
	const smoothed = smoothedMotionAt(points, tMs);
	const gsLiveKt =
		smoothed != null
			? smoothed.speedKt
			: pose?.speedKt != null && pose.speedKt >= MIN_VECTOR_KT
				? pose.speedKt
				: null;
	// The explicit ETD only: firstDepartureMs's next-hour fallback must never
	// fabricate an ETO column.
	const etdMs = flightPrep.dossier.departureTime != null ? routeDepartureMs(route.id) : null;
	// The pilot's own answer about which segment is being flown: the latest
	// assertion at or before the displayed instant, SPENT once the flight has
	// sequenced past that segment's end (from there on the fold's answer is
	// its own again). The projection already carries every pin, since they are
	// inputs to it (state/navProgress); this is what the DISPLAY does with the
	// standing one.
	const asserted = latestPinAt(legPinsFor(route.id), tMs);
	const pinnedLegIdx =
		asserted != null &&
		asserted.legIdx >= 0 &&
		asserted.legIdx < legs.length &&
		distNM != null &&
		distNM < legs[asserted.legIdx].cumNM
			? asserted.legIdx
			: null;
	const state = liveNavlogAt({
		legs,
		checkpoints,
		motion,
		crossings: f.fold,
		departureMs,
		tMs,
		gsLiveKt,
		cruiseKt,
		legGsKt: routeLegGroundSpeeds(route),
		etdMs,
		distNM,
		offM,
		pinnedLegIdx,
	});
	const display = toNavlogDisplay(state, FMT);
	const targetIdx = state.currentLegIdx != null ? state.currentLegIdx + 1 : null;
	const nextWp = targetIdx != null ? route.waypoints[targetIdx] : null;
	const nextDistNM =
		targetIdx != null && state.distNM != null
			? Math.max(0, legs[targetIdx - 1].cumNM - state.distNM)
			: null;
	const nextEteMin =
		nextDistNM != null && state.gsUsedKt != null ? (nextDistNM / state.gsUsedKt) * 60 : null;
	// Steering to the active waypoint: the magnetic bearing from where the
	// aircraft IS (not the leg's planned course, which it may be well off) and
	// the cross-track with the side it falls on. The fold already measured the
	// lateral distance; only the side is new.
	const legIdx = state.currentLegIdx;
	const legFrom = legIdx != null ? route.waypoints[legIdx] : null;
	const bearingMagDeg =
		pose && nextWp
			? magneticFromTrue(
					initialBearingDeg(pose.lat, pose.lon, nextWp.lat, nextWp.lon),
					pose.lat,
					pose.lon,
					// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a throwaway Date for the magnetic model's decimal year, never stored
					decimalYearFromDate(new Date(tMs)),
				)
			: null;
	const xtkSide =
		pose && legFrom && nextWp
			? crossTrackSide(pose.lat, pose.lon, legFrom.lat, legFrom.lon, nextWp.lat, nextWp.lon)
			: 0;

	// Off this route, or on a route this flight never flew: the answers below
	// are the plan at the nearest route point, not where the aircraft is.
	const offRoute = state.offM != null && state.offM > OFF_ROUTE_NM * NM_TO_METERS;
	const planOnly = distNM != null && (offRoute || segment == null);

	const log = {
		display,
		state,
		nextIdent: nextWp ? waypointLabel(nextWp) : null,
		nextDistNM,
		nextEteMin,
		offRoute,
		pinnedLegIdx,
		bearingMagDeg,
		xtkNM: state.offM != null ? state.offM / NM_TO_METERS : null,
		xtkSide,
	};

	// ---- the contact + schedule side (airspace-gated; the log rides on) ----
	let contact: NavContactInfo | null = null;
	let scheduleLive: NavLiveSchedule | null = null;
	const airspaces = dataState.airspacesLoaded ? getAirspaces() : null;
	if (airspaces) {
		// The briefed sequence: the exact NavLogSchedule recipe (same shared
		// memo entry), override-resolved so a frequency-change NOTAM shows
		// its effective value here too. scheduleFoldFor also extends the
		// passage fold read further down.
		const sched = scheduleFoldFor(f, airspaces);
		const schedule = sched.schedule;
		// Resolved at the DISPLAY INSTANT, not the planning window: a replay
		// must read the closure state the flight had (a day-scheduled FIS
		// closure, docs/notam-relationships.md), and tMs is that instant for
		// live and replay alike.
		const resolved = resolveScheduleRadios(schedule, airspaces, { fromMs: tMs, toMs: tMs });
		const ifr = !routeSettings.vfr;
		let spanEntry = spanMemo.get(route.id);
		if (!spanEntry || spanEntry.schedule !== resolved || spanEntry.ifr !== ifr) {
			// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a memo index rebuilt with the span memo, never mutated reactively
			const evIndex = new Map<RouteAirspaceEvent, number>();
			resolved.forEach((ev, i) => evIndex.set(ev, i));
			spanEntry = {
				schedule: resolved,
				ifr,
				spans: buildContactSpans(resolved, ifr),
				closedSpans: closedContactSpans(resolved, ifr),
				evIndex,
			};
			spanMemo.set(route.id, spanEntry);
		}
		const spans = spanEntry.spans;
		const cState: ContactState =
			distNM != null && pose
				? contactStateAt(spans, distNM)
				: { current: null, next: null, boundaryNM: null, handover: null };
		// The chain, aerodrome to aerodrome. The departure field holds the
		// contact on the ground and until DEPARTURE_HANDOVER_NM, unless a unit
		// above the FIS watch applies (a CTR is itself the first airspace
		// contact); the destination field takes the next slot once no airspace
		// contact remains ahead, and the current one on arrival. Leaving the
		// departure field is the pilot's call, not a boundary, so that step
		// carries no countdown.
		const airCur = toContact(cState.current);
		const airNext = toContact(cState.next);
		// The closure marker: when a withdrawn sector would have been the
		// answer here (or at the coming handover), the unit that replaced it
		// says so. Evaluated on the airspace units only, before the chain
		// brackets them with the aerodromes.
		if (airCur && distNM != null) {
			const c = closedByAt(spanEntry.closedSpans, distNM, cState.current);
			if (c) {
				airCur.closedBy = c;
			}
		}
		if (airNext && cState.boundaryNM != null) {
			const c = closedByAt(spanEntry.closedSpans, cState.boundaryNM + 1e-6, cState.next);
			if (c) {
				airNext.closedBy = c;
			}
		}
		const chain = contactChainAt({
			airCurrent: airCur,
			airNext,
			currentTier: cState.current ? contactTier(cState.current.ev) : -1,
			departure: aerodromeUnit(route.waypoints[0]),
			destination: aerodromeUnit(route.waypoints[route.waypoints.length - 1]),
			distNM,
			boundaryNM:
				cState.boundaryNM != null && distNM != null
					? Math.max(0, cState.boundaryNM - distNM)
					: null,
			remainingNM: distNM != null ? Math.max(0, legs[legs.length - 1].cumNM - distNM) : null,
			arrived: state.arrived,
		});
		const { current, next, toBoundaryNM } = chain;
		const boundaryEteMin =
			toBoundaryNM != null && gsLiveKt != null && gsLiveKt >= MIN_VECTOR_KT
				? (toBoundaryNM / gsLiveKt) * 60
				: null;
		contact = {
			current,
			next,
			toBoundaryNM,
			eteMin: boundaryEteMin,
			etoMs: boundaryEteMin != null ? tMs + boundaryEteMin * 60_000 : null,
		};
		// The banner ink follows the AIRSPACE units only: an aerodrome has no
		// enroute frequency line to bold.
		display.contactKey = current?.kind === 'airspace' ? current.key : null;
		display.nextContactKey = next?.kind === 'airspace' ? next.key : null;

		// The schedule passage fold: actual crossing times per event row
		// (extended by scheduleFoldFor above).
		const sFold = sched.fold;
		const airborne = motion.takeoffMs != null && motion.takeoffMs <= tMs;
		// The waypoint rows' ink rule (nav/navlogLive): rows ascend in atNM, so
		// everything up to the last stamped crossing stays behind the aircraft
		// even while a circuit at a waypoint dips the position back over it.
		let lastStamped = -1;
		for (let i = 0; i < schedule.length; i++) {
			const stamp = sFold.crossMs[i];
			if (stamp != null && stamp <= tMs) {
				lastStamped = i;
			}
		}
		const rows = schedule.map((ev, i) => {
			const stamp = sFold.crossMs[i];
			const atoMs = stamp != null && stamp <= tMs ? stamp : null;
			return {
				atoMs,
				passed:
					atoMs != null ||
					i <= lastStamped ||
					(airborne && distNM != null && ev.atNM <= distNM),
			};
		});
		// The row a contact takes over at (contactStateAt's handover): its own
		// enter, or the LEAVE that hands it back, so the highlight walks down the
		// table with the flight instead of jumping back to a FIS entered at 0 NM
		// the moment a TMA above it ends. The NEXT contact's row is the same
		// question asked at the boundary, which is also where the countdown pill
		// belongs.
		const handRow = (hand: ContactState['handover']): number | null =>
			hand
				? hand.kind === 'leave'
					? contactLeaveRowIdx(resolved, hand.span)
					: (spanEntry.evIndex.get(hand.span.ev) ?? contactEnterRowIdx(resolved, hand.span))
				: null;
		const currentRowIdx = handRow(cState.handover);
		const nextRowIdx =
			cState.next && cState.boundaryNM != null
				? handRow(contactStateAt(spans, cState.boundaryNM).handover)
				: null;
		let chip: NavLiveSchedule['chip'] = null;
		if (toBoundaryNM != null) {
			const rowIdx =
				nextRowIdx ?? (cState.current ? contactLeaveRowIdx(resolved, cState.current) : null);
			if (rowIdx != null) {
				chip = { rowIdx, toNM: toBoundaryNM, eteMin: boundaryEteMin };
			}
		}
		scheduleLive = { rows, currentRowIdx, nextRowIdx, chip, planOnly };
	}

	return { log, contact, scheduleLive, planOnly };
}

// --- Replay events ---------------------------------------------------------

export type ReplayEventKind = 'takeoff' | 'landing' | 'waypoint' | 'airspace';

export interface ReplayEvent {
	ms: number;
	kind: ReplayEventKind;
	/** Waypoint / airspace display label; empty for the motion events, whose
	 *  kind is the identity (a state module bakes no rendered words). */
	label: string;
}

/** Two stamps closer than this are one event (a chained plan's junction
 *  stamps an arrival and the next leg's crossing within a second), and a
 *  jump must land strictly beyond it so a repeated press never re-lands on
 *  the event just jumped to. */
const EVENT_EPS_MS = 1000;

/** Every stamped instant of the loaded trace, sorted: the motion fold's
 *  takeoff and landing, and, per route the flight actually flew
 *  (navSegments), the waypoint ATO stamps and the airspace schedule's
 *  actual boundary crossings. RAW stamps on purpose: never filtered by the
 *  playhead and never reading it, so a $derived over this is stable across
 *  playback ticks. Reads reactive state; call inside $derived / $effect. */
export function replayEvents(): ReplayEvent[] {
	const events: ReplayEvent[] = [];
	// EVERY committed instant, off the fold's arrays rather than the
	// scalars: a stop-and-go's first landing and the re-arm's takeoff are
	// debrief events too, though the scalar pair forgets them.
	const motion = traceMotion(nav.points);
	for (const ms of motion.takeoffsMs) {
		events.push({ ms, kind: 'takeoff', label: '' });
	}
	for (const ms of motion.landingsMs) {
		events.push({ ms, kind: 'landing', label: '' });
	}
	const airspaces = dataState.airspacesLoaded ? getAirspaces() : null;
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a per-call dedup scratch, never rendered
	const seen = new Set<string>();
	for (const seg of navSegments()) {
		if (seen.has(seg.routeId)) {
			continue; // a route flown twice shares one fold
		}
		seen.add(seg.routeId);
		const f = legCrossingFolds(seg.routeId);
		if (!f) {
			continue;
		}
		f.fold.crossMs.forEach((ms, k) => {
			if (ms != null) {
				events.push({ ms, kind: 'waypoint', label: waypointLabel(f.route.waypoints[k + 1]) });
			}
		});
		if (airspaces) {
			const sched = scheduleFoldFor(f, airspaces);
			sched.fold.crossMs.forEach((ms, i) => {
				if (ms != null) {
					const ev = sched.schedule[i];
					events.push({ ms, kind: 'airspace', label: `${ev.type} ${ev.name}`.trim() });
				}
			});
		}
	}
	events.sort((a, b) => a.ms - b.ms);
	// Collapse near-duplicates; a motion kind wins the tie (the takeoff IS
	// the departure crossing).
	const out: ReplayEvent[] = [];
	for (const e of events) {
		const last = out[out.length - 1];
		if (last && e.ms - last.ms < EVENT_EPS_MS) {
			if (
				(e.kind === 'takeoff' || e.kind === 'landing') &&
				last.kind !== 'takeoff' &&
				last.kind !== 'landing'
			) {
				out[out.length - 1] = e;
			}
			continue;
		}
		out.push(e);
	}
	return out;
}

/** The event strictly beyond EVENT_EPS_MS of `tMs` in `dir`, or null: the
 *  transports' prev / next jump target (pure over its inputs). */
export function adjacentReplayEvent(
	events: readonly ReplayEvent[],
	tMs: number,
	dir: -1 | 1,
): ReplayEvent | null {
	if (dir < 0) {
		for (let i = events.length - 1; i >= 0; i--) {
			if (events[i].ms < tMs - EVENT_EPS_MS) {
				return events[i];
			}
		}
		return null;
	}
	for (const e of events) {
		if (e.ms > tMs + EVENT_EPS_MS) {
			return e;
		}
	}
	return null;
}
