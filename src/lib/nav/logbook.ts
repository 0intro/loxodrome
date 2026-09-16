/* EASA pilot-logbook export: one CSV row per FLIGHT of the loaded trace, in
 * the AMC1 FCL.050 column shape (Easy Access Rules for Aircrew, Dec 2024
 * revision, as amended through ED 2025/002/R): date; departure place and
 * time; arrival place and time; aircraft make, model and registration;
 * single-pilot SE/ME and multi-pilot time; total time of flight; name of
 * PIC; landings day/night; operational condition time night/IFR; pilot
 * function times; FSTD session; remarks. Conventions from the AMC's own
 * instructions for use: all times UTC (note (i)(2)), durations in hours and
 * minutes (note (i)(4) allows hh:mm or decimal), 'SELF' as the PIC name
 * where appropriate (note (i)(5), applied by the caller). The headers are
 * file-format content, locale-invariant English like the YAML keys
 * (docs/i18n.md). Columns the app cannot attest stay EMPTY for the pilot to
 * fill: crew/engine class, the function times ((a)(4) names legal roles),
 * IFR time (flight rules are not observable from a track), FSTD. One row
 * per flight, never the (b)(1)(vi) same-place series merge, which is the
 * pilot's option; the stricter form is always compliant. Contract and the
 * full citation table: docs/logbook.md. Pure (no Svelte, no I/O). */

import { equirectangularDistanceM } from '$lib/notam/geometry';
import { NM_TO_METERS } from '$lib/notam/units';
import { fmtClockUtc } from '$lib/route/format';
import { isAeroNightUtc } from '$lib/route/sun';
import { MOVE_KT, type MotionFold } from './navlogLive';
import { deriveMotion, positionAt, type TrackPoint } from './trace';

/** One flight of the outing: the block pair around a committed takeoff /
 *  landing pair. An open flight (takeoff without a committed landing yet)
 *  carries null landing / block-on. */
export interface FlightSlice {
	blockOffMs: number;
	takeoffMs: number;
	landingMs: number | null;
	blockOnMs: number | null;
	/** Along-track distance of the block span, NM. */
	distanceNM: number;
}

/** One resolved logbook row: the slice plus everything the caller attests
 *  (places, aircraft, pilot, night). Unattestable fields are absent here on
 *  purpose; they print as empty cells. */
export interface LogbookRow {
	slice: FlightSlice;
	departurePlace: string;
	arrivalPlace: string;
	aircraftMake: string;
	aircraftModel: string;
	registration: string;
	picName: string;
	/** Landings by day / night: the committed landing plus the detected
	 *  touch-and-goes of this flight, each judged at its own instant. Null
	 *  pair = nothing to report yet (an open flight with no touch either);
	 *  prints as empty cells. */
	landingsDay: number | null;
	landingsNight: number | null;
	/** Night minutes of the block span; null while the block is open. */
	nightMin: number | null;
	remarks: string;
	/** The pilot-DECLARED cells this app never derives, when they came
	 *  from an imported logbook CSV: crew and engine configuration, the
	 *  function times, IFR, the FSTD session. Keyed by the column name.
	 *  Absent on a trace-derived row, where they stay empty by principle
	 *  (docs/logbook.md); present on an imported one, where blanking them
	 *  on the way out would quietly destroy what the pilot declared. */
	declared?: Readonly<Record<string, string>> | undefined;
}

/** The AMC columns this application never attests: it cannot see crew or
 *  engine configuration, a legal role, flight rules or an FSTD session in
 *  a GPS trace. A trace row leaves them empty; an imported row carries
 *  back exactly what its source said, which is why they are read and
 *  re-emitted verbatim rather than derived. `pic_name` is here too: on an
 *  imported row it names whoever commanded THAT flight, and the current
 *  dossier pilot is not an answer to that question. */
export const DECLARED_COLUMNS = [
	'sp_se',
	'sp_me',
	'mp_time',
	'pic_name',
	'ifr_time',
	'pic_time',
	'copilot_time',
	'dual_time',
	'instructor_time',
	'fstd_date',
	'fstd_type',
	'fstd_time',
] as const;

/** The fold's hop-backfilled speed at one point (the extendMotion rule): a
 *  GPX without <speed> still splits on movement. */
function speedAt(points: readonly TrackPoint[], i: number): number | null {
	const s = points[i].speedKt;
	if (s != null && Number.isFinite(s)) {
		return s;
	}
	return i > 0 ? deriveMotion(points[i - 1], points[i]).speedKt : null;
}

/** Lower bound: the first index whose fix is at or after `ms`. */
function idxAtOrAfter(points: readonly TrackPoint[], ms: number): number {
	let lo = 0;
	let hi = points.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (points[mid].timeMs < ms) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	return lo;
}

/** The block cut between a landing and the NEXT takeoff: the LONGEST run of
 *  below-MOVE_KT fixes in the interval decides (the parking between taxi-in
 *  and taxi-out); the moving fixes bounding it are the previous flight's
 *  block-on and the next one's block-off. Landing-bounded on purpose: a
 *  holding-point wait lives between block-off and takeoff INSIDE a flight,
 *  so it can never split one. A stop-and-go with no detectable stop cuts at
 *  the landing instant, keeping the two blocks contiguous. */
function interFlightCut(
	points: readonly TrackPoint[],
	landingMs: number,
	nextTakeoffMs: number,
): { onMs: number; offMs: number } {
	const lo = idxAtOrAfter(points, landingMs);
	const hi = idxAtOrAfter(points, nextTakeoffMs);
	let best: { start: number; endIdx: number; durMs: number } | null = null;
	let cur = -1;
	const flush = (endIdx: number): void => {
		if (cur < 0) {
			return;
		}
		const endMs = endIdx < hi ? points[endIdx].timeMs : nextTakeoffMs;
		const durMs = endMs - points[cur].timeMs;
		if (!best || durMs > best.durMs) {
			best = { start: cur, endIdx, durMs };
		}
		cur = -1;
	};
	for (let i = lo; i < hi; i++) {
		const s = speedAt(points, i);
		if (s != null && s >= MOVE_KT) {
			flush(i);
		} else if (cur < 0) {
			cur = i;
		}
	}
	flush(hi);
	if (!best) {
		return { onMs: landingMs, offMs: landingMs };
	}
	const b: { start: number; endIdx: number } = best;
	return {
		onMs: b.start > lo ? points[b.start - 1].timeMs : landingMs,
		offMs: b.endIdx < hi ? points[b.endIdx].timeMs : nextTakeoffMs,
	};
}

/** Along-track distance (NM) of the fixes within [fromMs, toMs]. */
function sliceDistanceNM(points: readonly TrackPoint[], fromMs: number, toMs: number): number {
	let m = 0;
	const lo = idxAtOrAfter(points, fromMs);
	for (let i = lo + 1; i < points.length && points[i].timeMs <= toMs; i++) {
		m += equirectangularDistanceM(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
	}
	return m / NM_TO_METERS;
}

/** Cut the outing into flights: pair the motion fold's committed instant
 *  arrays (takeoffsMs[i] with landingsMs[i]; the interleaving is the fold's
 *  invariant), place the block cuts at the parking between consecutive
 *  flights (interFlightCut), and bracket the outing with its own
 *  firstMove / lastMove pair. A trailing takeoff with no committed landing
 *  yields an open flight. Empty without a committed takeoff. */
export function splitFlights(points: readonly TrackPoint[], motion: MotionFold): FlightSlice[] {
	const T = motion.takeoffsMs;
	const L = motion.landingsMs;
	if (T.length === 0 || points.length === 0) {
		return [];
	}
	const offs: number[] = [motion.firstMoveMs ?? T[0]];
	const ons: (number | null)[] = [];
	for (let i = 0; i + 1 < T.length; i++) {
		const cut = interFlightCut(points, L[i], T[i + 1]);
		ons.push(cut.onMs);
		offs.push(cut.offMs);
	}
	// The last flight landed exactly when the arrays pair up (a re-arm would
	// have pushed another takeoff); its block-on is the outing's last
	// movement, the liveNavlogAt blockIn rule.
	ons.push(L.length === T.length ? motion.lastMoveMs : null);
	const flights: FlightSlice[] = [];
	for (let i = 0; i < T.length; i++) {
		const blockOffMs = offs[i];
		const blockOnMs = ons[i];
		flights.push({
			blockOffMs,
			takeoffMs: T[i],
			landingMs: i < L.length ? L[i] : null,
			blockOnMs,
			distanceNM: sliceDistanceNM(
				points,
				blockOffMs,
				blockOnMs ?? points[points.length - 1].timeMs,
			),
		});
	}
	return flights;
}

/** Below this ground speed a fix can be a landing roll: the fleet touches
 *  down at 45-60 kt IAS, so the below-45 stretch of a touch-and-go is the
 *  ground roll, while a go-around flown at approach speed stays above. */
const TOUCH_SPEED_KT = 45;
/** A dip must persist this long: a single steep-turn ground-speed dip or a
 *  bad fix must not read as wheels on the runway. */
const TOUCH_MIN_MS = 4000;
/** Height gate over the aerodrome elevation: within GNSS vertical error of
 *  a runway, and well clear of any pattern altitude. */
const TOUCH_AGL_FT = 150;
/** The LOW SLOW PASS thresholds (the detector's second signal): per-hop
 *  derived speed is unreliable in both directions - a 9-second aerogest
 *  hop AVERAGES a ground roll with the climb-out (the logged LFEM /
 *  LFLA touches read 47-57 kt), and 1 Hz GPS noise JITTERS +-20 kt so
 *  sub-45 fixes never sustain (the logged LFOX touch read 41-94 kt over
 *  a 93 ft pass). Median-smoothed speed under TOUCH_SLOW_KT sustained
 *  TOUCH_SLOW_MIN_MS, bottoming within TOUCH_AGL_FT of an aerodrome,
 *  is a touch-and-go at any sampling rate; a normal landing's final
 *  touches the bracket end and stays excluded. */
const TOUCH_SLOW_KT = 65;
const TOUCH_SLOW_MIN_MS = 15_000;
const SPEED_MEDIAN_HALF_MS = 5000;
/** A wheels-down cannot repeat within this: even the tightest pattern
 *  circuit takes about three minutes (the aerogest sweep's closest real
 *  pair sits 191 s apart), while FRAGMENTS of one approach - the median
 *  oscillating around TOUCH_SLOW_KT on final splits it into several
 *  interior runs - arrive within seconds. Detected touches closer than
 *  this collapse to the first, and one this close AHEAD of the committed
 *  landing is that landing's own approach, not a touch. */
const TOUCH_CYCLE_MS = 120_000;

/** Median of the derived speeds within +-SPEED_MEDIAN_HALF_MS of fix i:
 *  the smoothing that survives both 1 Hz jitter (many samples) and
 *  sparse hops (few, already-averaged samples). */
function medianSpeedAt(points: readonly TrackPoint[], i: number): number | null {
	const t = points[i].timeMs;
	const speeds: number[] = [];
	for (let j = i; j >= 0 && t - points[j].timeMs <= SPEED_MEDIAN_HALF_MS; j--) {
		const v = speedAt(points, j);
		if (v != null) {
			speeds.push(v);
		}
	}
	for (let j = i + 1; j < points.length && points[j].timeMs - t <= SPEED_MEDIAN_HALF_MS; j++) {
		const v = speedAt(points, j);
		if (v != null) {
			speeds.push(v);
		}
	}
	if (speeds.length === 0) {
		return null;
	}
	speeds.sort((a, b) => a - b);
	return speeds[Math.floor(speeds.length / 2)];
}

/** A detected touch-and-go: wheels on a runway between a committed takeoff
 *  and the flight's committed landing. */
export interface TouchAndGo {
	ms: number;
	lat: number;
	lon: number;
}

/** Detect touch-and-goes: inside each flight's airborne bracket (committed
 *  takeoff to committed landing, exclusive), a maximal slow run that is
 *  strictly INTERIOR to the bracket (a run touching either end is the
 *  takeoff roll's tail or the final rollout, already accounted) and whose
 *  lowest fix sits within TOUCH_AGL_FT of a known aerodrome's elevation.
 *  Two speed signals feed it: the crisp below-TOUCH_SPEED_KT ground roll
 *  (TOUCH_MIN_MS) and the LOW SLOW PASS (median under TOUCH_SLOW_KT for
 *  TOUCH_SLOW_MIN_MS, the signal that survives sparse and jittery traces
 *  alike); TOUCH_CYCLE_MS then collapses fragments of one approach and
 *  drops a touch riding the committed landing's own approach.
 *  The vertical judgement rides two injected lookups so the module stays
 *  pure: `altMslFt` (the poseAltMslFt datum chokepoint) and `fieldElevFt`
 *  (the nearest aerodrome's elevation near a position, null when none is
 *  close or published). No altitude or no field = not counted, the
 *  conservative side. ADVISORY by construction: a balked landing that
 *  slowed below the gate on the runway is indistinguishable from a touch,
 *  and a field the dataset lacks hides a real one; the logbook tips say
 *  to verify the count. */
export function detectTouchAndGoes(
	points: TrackPoint[],
	motion: MotionFold,
	altMslFt: (p: TrackPoint) => number | null,
	fieldElevFt: (lat: number, lon: number) => number | null,
): TouchAndGo[] {
	const out: TouchAndGo[] = [];
	const T = motion.takeoffsMs;
	const L = motion.landingsMs;
	for (let f = 0; f < T.length; f++) {
		// Strictly inside the airborne bracket; an open flight runs to the
		// trace end (a run touching it is discarded below anyway).
		const lo = idxAtOrAfter(points, T[f] + 1);
		const hi = f < L.length ? idxAtOrAfter(points, L[f]) : points.length;
		const found: TouchAndGo[] = [];
		const scan = (fast: (i: number) => boolean, minMs: number): void => {
			let cur = -1;
			const flush = (endIdx: number): void => {
				if (cur < 0) {
					return;
				}
				const start = cur;
				cur = -1;
				// Interior runs only: one touching an end is the takeoff
				// roll's tail, the final rollout or the trace edge.
				if (start === lo || endIdx === hi) {
					return;
				}
				// The below-threshold window is estimated from the MIDPOINTS
				// of the crossings (half a sampling interval each side), not
				// from the run's own span: a real touch on a 9-second trace
				// leaves one or two slow fixes whose internal span is near
				// zero, while at 1 Hz a lone noisy fix still estimates ~1 s.
				const enterMs = (points[start].timeMs + points[start - 1].timeMs) / 2;
				const exitMs = (points[endIdx].timeMs + points[endIdx - 1].timeMs) / 2;
				if (exitMs - enterMs < minMs) {
					return;
				}
				// The touch is the run's lowest fix (closest to the runway).
				let low: TrackPoint | null = null;
				let lowFt = Infinity;
				for (let i = start; i < endIdx; i++) {
					const ft = altMslFt(points[i]);
					if (ft != null && ft < lowFt) {
						lowFt = ft;
						low = points[i];
					}
				}
				if (!low) {
					return;
				}
				const elev = fieldElevFt(low.lat, low.lon);
				if (elev == null || lowFt - elev > TOUCH_AGL_FT) {
					return;
				}
				// One touch per window: the crisp pass already claimed it.
				if (found.some((tg) => tg.ms >= enterMs && tg.ms <= exitMs)) {
					return;
				}
				found.push({ ms: low.timeMs, lat: low.lat, lon: low.lon });
			};
			for (let i = lo; i < hi; i++) {
				if (fast(i)) {
					flush(i);
				} else if (cur < 0) {
					cur = i;
				}
			}
			flush(hi);
		};
		// Pass 1: the crisp ground roll, raw speed under TOUCH_SPEED_KT.
		scan((i) => {
			const v = speedAt(points, i);
			return v != null && v >= TOUCH_SPEED_KT;
		}, TOUCH_MIN_MS);
		// Pass 2: the LOW SLOW PASS, median-smoothed speed under
		// TOUCH_SLOW_KT (see the constants above for why raw speed cannot
		// carry this at either sampling extreme).
		scan((i) => {
			const v = medianSpeedAt(points, i);
			return v != null && v >= TOUCH_SLOW_KT;
		}, TOUCH_SLOW_MIN_MS);
		// The TOUCH_CYCLE_MS physics: collapse fragments of one approach to
		// its first touch, and drop a touch riding the committed landing's
		// own approach.
		found.sort((a, b) => a.ms - b.ms);
		let lastMs = -Infinity;
		for (const tg of found) {
			if (tg.ms - lastMs < TOUCH_CYCLE_MS) {
				continue;
			}
			lastMs = tg.ms;
			if (f < L.length && L[f] - tg.ms < TOUCH_CYCLE_MS) {
				continue;
			}
			out.push(tg);
		}
	}
	out.sort((a, b) => a.ms - b.ms);
	return out;
}

/** Night minutes of [fromMs, toMs], integrated per minute over the trace at
 *  the aeronautical-night rule (route/sun.ts isAeroNightUtc): the logbook's
 *  operational-condition night time, and the summary card's night row. */
export function nightMinutes(points: TrackPoint[], fromMs: number, toMs: number): number {
	let mins = 0;
	// One sample per minute INTERVAL, judged at its start, so the figure is
	// a duration (a 10 min span yields at most 10).
	for (let ms = fromMs; ms < toMs; ms += 60_000) {
		const p = positionAt(points, ms);
		if (p && isAeroNightUtc(p.lat, p.lon, ms)) {
			mins++;
		}
	}
	return mins;
}

/** One flight's derived logbook figures: the block/instant slice plus the
 *  place, landings and night resolution; everything a library row or a CSV
 *  row is built from. Every field present, nulls explicit (the
 *  exactOptionalPropertyTypes posture), so the shape stores and reloads
 *  byte-stably. */
export interface FlightSummary {
	blockOffMs: number;
	takeoffMs: number;
	landingMs: number | null;
	blockOnMs: number | null;
	distanceNM: number;
	depPlace: string;
	arrPlace: string;
	landingsDay: number | null;
	landingsNight: number | null;
	nightMin: number | null;
	/** The aerodromes this flight's wheels actually touched, in
	 *  CHRONOLOGICAL order: each detected touch-and-go's place, then the
	 *  committed landing's last. Repeats kept (two circuits at LFPK are two
	 *  entries; the flown-chain display collapses consecutive ones),
	 *  unknown places dropped. Absent on rows stored before the field
	 *  existed; the lazy re-derivation fills it in. */
	touchPlaces?: string[] | undefined;
}

/** The injected lookups the summary rides (the detectTouchAndGoes idiom):
 *  the datum chokepoint and the airport dataset, kept out of the pure
 *  module so an archived outing re-derives identically at any later time. */
export interface SummaryDeps {
	altMslFt: (p: TrackPoint) => number | null;
	fieldElevFt: (lat: number, lon: number) => number | null;
	/** The AMC note (i)(2) place designator near a position; '' when none. */
	placeIdentAt: (lat: number, lon: number) => string;
}

/** Close the outing's trailing open flight when the trace ENDS inside a
 *  still-open below-LANDING_KT streak on a known aerodrome. The landing
 *  sustain needs a minute of slow evidence, and a recording commonly ends
 *  before it delivers one: the engine-driven recorder dies with the master
 *  switch, and a pilot stops a phone recording right after vacating (ten
 *  of the 543 corpus outings landed, taxied a couple of minutes, and still
 *  filed an OPEN flight because the final slow stretch was cut short).
 *  Here the end of the trace is a fact, not a live instant: every caller
 *  of this fold reads a finished document (the library derivations, the
 *  archive, the export snapshot), while the LIVE surfaces read the motion
 *  fold itself and keep the open flight, so a slow taxi never commits
 *  anything on screen. The streak start is the landing, the fold's own
 *  commit convention; the elevation gate is the touch-and-go one, and a
 *  trace whose last fix carries no altitude, or sits away from any known
 *  field (a recording that died in the air), stays open. */
function closeTrailingFlight(
	flights: FlightSlice[],
	points: readonly TrackPoint[],
	motion: MotionFold,
	deps: SummaryDeps,
): number | null {
	const last = flights[flights.length - 1];
	if (!last || last.landingMs != null || motion.belowSinceMs == null) {
		return null;
	}
	if (motion.belowSinceMs <= last.takeoffMs) {
		return null;
	}
	// The streak's LAST KNOWN altitude: elevations drop out per fix (a tenth
	// of the corpus's points), and a landing whose final fix is one of the
	// holes must not stay open for it.
	const end = points[points.length - 1];
	let alt: number | null = null;
	for (let i = points.length - 1; i >= 0 && points[i].timeMs >= motion.belowSinceMs; i--) {
		alt = deps.altMslFt(points[i]);
		if (alt != null) {
			break;
		}
	}
	const elev = deps.fieldElevFt(end.lat, end.lon);
	if (alt == null || elev == null || Math.abs(alt - elev) > TOUCH_AGL_FT) {
		return null;
	}
	last.landingMs = motion.belowSinceMs;
	last.blockOnMs = motion.lastMoveMs;
	last.distanceNM = sliceDistanceNM(points, last.blockOffMs, last.blockOnMs ?? end.timeMs);
	return last.landingMs;
}

/** The whole per-flight derivation over one outing: splitFlights +
 *  detectTouchAndGoes + the day / night landing classification (each
 *  landing judged at its own instant and position by the
 *  aeronautical-night rule) + nightMinutes + place resolution. Pure over
 *  its inputs. Callers pass a motion fold THEY folded (a snapshot or
 *  stored points must never go through the single-slot traceMotion memo,
 *  which would evict the live trace's fold). */
export function summarizeFlights(
	points: TrackPoint[],
	motion: MotionFold,
	deps: SummaryDeps,
): FlightSummary[] {
	const flights = splitFlights(points, motion);
	const closed = closeTrailingFlight(flights, points, motion, deps);
	// The touch detector must see the closed landing as a landing: with the
	// fold's own open bracket it would run to the trace end, where the
	// rollout's own jittered sub-45 fragment (a bad fix at 46 kt splitting
	// it) is an interior run on the runway, and none of the landing-side
	// guards (the bracket end, the TOUCH_CYCLE_MS approach collapse) would
	// apply: one landing, counted twice.
	const tgMotion =
		closed == null ? motion : { ...motion, landingsMs: [...motion.landingsMs, closed] };
	const tgs = detectTouchAndGoes(points, tgMotion, deps.altMslFt, deps.fieldElevFt);
	return flights.map((slice) => {
		const depPos = positionAt(points, slice.blockOffMs);
		const arrPos = slice.blockOnMs != null ? positionAt(points, slice.blockOnMs) : null;
		let dayCount = 0;
		let nightCount = 0;
		const touchPlaces: string[] = [];
		const touch = (lat: number, lon: number): void => {
			const id = deps.placeIdentAt(lat, lon);
			if (id !== '') {
				touchPlaces.push(id);
			}
		};
		for (const tg of tgs) {
			if (tg.ms > slice.takeoffMs && (slice.landingMs == null || tg.ms < slice.landingMs)) {
				if (isAeroNightUtc(tg.lat, tg.lon, tg.ms)) {
					nightCount++;
				} else {
					dayCount++;
				}
				touch(tg.lat, tg.lon);
			}
		}
		if (slice.landingMs != null) {
			const p = positionAt(points, slice.landingMs);
			if (p && isAeroNightUtc(p.lat, p.lon, slice.landingMs)) {
				nightCount++;
			} else {
				dayCount++;
			}
			if (p) {
				touch(p.lat, p.lon);
			}
		}
		return {
			blockOffMs: slice.blockOffMs,
			takeoffMs: slice.takeoffMs,
			landingMs: slice.landingMs,
			blockOnMs: slice.blockOnMs,
			distanceNM: slice.distanceNM,
			depPlace: depPos ? deps.placeIdentAt(depPos.lat, depPos.lon) : '',
			arrPlace: arrPos ? deps.placeIdentAt(arrPos.lat, arrPos.lon) : '',
			landingsDay: dayCount + nightCount === 0 ? null : dayCount,
			landingsNight: dayCount + nightCount === 0 ? null : nightCount,
			nightMin:
				slice.blockOnMs != null
					? nightMinutes(points, slice.blockOffMs, slice.blockOnMs)
					: null,
			touchPlaces,
		};
	});
}

/** Duration as h:mm for the logbook's time cells; '' when unknown. */
export function hm(min: number | null): string {
	if (min == null) {
		return '';
	}
	const total = Math.round(min);
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** The AMC (i)(1) date of the flight, as the unambiguous ISO interchange
 *  form of the UTC day the block opens on. */
export function isoDateUtc(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

/** RFC 4180 field: quoted when it holds a comma, quote, CR or LF. */
function csvField(v: string): string {
	return /[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
}

/** The AMC1 FCL.050 columns in AMC order, then the non-AMC extras last
 *  (takeoff / landing / airborne / distance are trace facts a debrief
 *  wants; they are not logbook items). */
const LOGBOOK_HEADER = [
	'date',
	'departure_place',
	'departure_time',
	'arrival_place',
	'arrival_time',
	'aircraft_make',
	'aircraft_model',
	'aircraft_registration',
	'sp_se',
	'sp_me',
	'mp_time',
	'total_time',
	'pic_name',
	'landings_day',
	'landings_night',
	'night_time',
	'ifr_time',
	'pic_time',
	'copilot_time',
	'dual_time',
	'instructor_time',
	'fstd_date',
	'fstd_type',
	'fstd_time',
	'remarks',
	'takeoff_time',
	'landing_time',
	'airborne_time',
	'distance_nm',
];

/** Build the CSV (CRLF records, RFC 4180 quoting): the header, then one
 *  record per resolved row. Times HH:MM UTC, durations h:mm, empty cells
 *  for what the flight cannot attest (an open flight's arrival half, and
 *  every pilot-declared column). */
export function buildLogbookCsv(rows: readonly LogbookRow[]): string {
	const lines = [LOGBOOK_HEADER.join(',')];
	for (const r of rows) {
		const s = r.slice;
		// A declared cell the row carries wins over the empty one this
		// application would write, and over the resolved PIC name: an
		// imported row states what its own source stated.
		const decl = (name: string, fallback = ''): string => r.declared?.[name] ?? fallback;
		lines.push(
			[
				isoDateUtc(s.blockOffMs),
				r.departurePlace,
				fmtClockUtc(s.blockOffMs),
				r.arrivalPlace,
				s.blockOnMs != null ? fmtClockUtc(s.blockOnMs) : '',
				r.aircraftMake,
				r.aircraftModel,
				r.registration,
				decl('sp_se'),
				decl('sp_me'),
				decl('mp_time'),
				hm(s.blockOnMs != null ? (s.blockOnMs - s.blockOffMs) / 60_000 : null),
				decl('pic_name', r.picName),
				r.landingsDay == null ? '' : String(r.landingsDay),
				r.landingsNight == null ? '' : String(r.landingsNight),
				hm(r.nightMin),
				decl('ifr_time'),
				decl('pic_time'),
				decl('copilot_time'),
				decl('dual_time'),
				decl('instructor_time'),
				decl('fstd_date'),
				decl('fstd_type'),
				decl('fstd_time'),
				r.remarks,
				fmtClockUtc(s.takeoffMs),
				s.landingMs != null ? fmtClockUtc(s.landingMs) : '',
				hm(s.landingMs != null ? (s.landingMs - s.takeoffMs) / 60_000 : null),
				s.distanceNM.toFixed(1),
			].map(csvField).join(','),
		);
	}
	return lines.join('\r\n') + '\r\n';
}

/* ---- Logbook CSV import (the export's mirror) ------------------------- */

/** One imported logbook flight: the summary the row states, plus the
 *  row's own context (the registration is the fleet key on this side,
 *  remarks carry whatever the exporter put there, typically the route). */
export interface LogbookCsvRow {
	flight: FlightSummary;
	registration: string | null;
	remarks: string;
	/** The DECLARED_COLUMNS cells this row carried, non-empty ones only.
	 *  Read back verbatim and never interpreted: they are the pilot's own
	 *  statement about crew, function times, IFR and FSTD, which no trace
	 *  can attest and no export may quietly drop. */
	declared: Record<string, string>;
}

export interface LogbookCsvParse {
	rows: LogbookCsvRow[];
	/** Data lines that did not yield a flight (bad date / time / shape). */
	skipped: number;
}

/** RFC 4180 records: quoted fields, doubled quotes, quoted newlines,
 *  CRLF. The mirror of csvField above; empty lines are not records. */
function parseCsv(text: string): string[][] {
	const records: string[][] = [];
	let field = '';
	let row: string[] = [];
	let quoted = false;
	const push = (): void => {
		row.push(field);
		field = '';
	};
	const endRow = (): void => {
		push();
		records.push(row);
		row = [];
	};
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quoted) {
			if (c === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i++;
				} else {
					quoted = false;
				}
			} else {
				field += c;
			}
		} else if (c === '"') {
			quoted = true;
		} else if (c === ',') {
			push();
		} else if (c === '\n') {
			endRow();
		} else if (c !== '\r') {
			field += c;
		}
	}
	if (field !== '' || row.length > 1) {
		endRow();
	}
	return records.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

const CLOCK_RE = /^(\d{1,2}):(\d{2})$/;

function clockMin(s: string): number | null {
	const m = CLOCK_RE.exec(s);
	if (!m) {
		return null;
	}
	const h = Number(m[1]);
	const min = Number(m[2]);
	return h > 23 || min > 59 ? null : h * 60 + min;
}

/** The inverse of hm(): 'H:MM' to minutes; null on anything else. */
function hmToMin(s: string): number | null {
	const m = /^(\d+):(\d{2})$/.exec(s);
	return m && Number(m[2]) < 60 ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Parse an AMC-shaped logbook CSV (the buildLogbookCsv columns,
 *  addressed BY NAME so extra or reordered columns are tolerated; the
 *  non-AMC takeoff / landing / distance extras are read back when
 *  present, else the block times stand in). Times are UTC clocks on the
 *  row's date; a clock earlier than block-off rolls past midnight.
 *  Throws when the text is not a logbook CSV at all; malformed data
 *  lines are skipped and counted. */
export function parseLogbookCsv(text: string): LogbookCsvParse {
	const records = parseCsv(text.replace(/^\uFEFF/, ''));
	if (records.length === 0) {
		// i18n-ignore: file-format parse diagnostic, stays EN (docs/i18n.md rule 7)
		throw new Error('Invalid logbook CSV: empty file');
	}
	const header = records[0].map((h) => h.trim());
	const col = (name: string): number => header.indexOf(name);
	const iDate = col('date');
	const iDepP = col('departure_place');
	const iDepT = col('departure_time');
	const iArrP = col('arrival_place');
	const iArrT = col('arrival_time');
	const iReg = col('aircraft_registration');
	const iLdgD = col('landings_day');
	const iLdgN = col('landings_night');
	const iNight = col('night_time');
	const iRemarks = col('remarks');
	const iTo = col('takeoff_time');
	const iLdg = col('landing_time');
	const iDist = col('distance_nm');
	if (iDate < 0 || iDepT < 0) {
		// i18n-ignore: file-format parse diagnostic, stays EN (docs/i18n.md rule 7)
		throw new Error('Invalid logbook CSV: no date / departure_time columns');
	}
	const cell = (r: string[], i: number): string => (i >= 0 && i < r.length ? r[i].trim() : '');
	// The declared columns by NAME, like every other one, so a foreign
	// AMC-shaped file with its own column order round-trips too.
	const declaredIdx = DECLARED_COLUMNS.map((name) => [name, col(name)] as const);
	const rows: LogbookCsvRow[] = [];
	let skipped = 0;
	for (const r of records.slice(1)) {
		const date = cell(r, iDate);
		const dayMs = /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00Z`) : NaN;
		const dep = clockMin(cell(r, iDepT));
		if (!Number.isFinite(dayMs) || dep == null) {
			skipped++;
			continue;
		}
		const blockOffMs = dayMs + dep * 60_000;
		const after = (s: string): number | null => {
			const min = clockMin(s);
			if (min == null) {
				return null;
			}
			const ms = dayMs + min * 60_000;
			return ms < blockOffMs ? ms + 86_400_000 : ms;
		};
		const int = (s: string): number | null => (/^\d+$/.test(s) ? Number(s) : null);
		const dist = Number.parseFloat(cell(r, iDist));
		rows.push({
			flight: {
				blockOffMs,
				takeoffMs: after(cell(r, iTo)) ?? blockOffMs,
				landingMs: after(cell(r, iLdg)),
				blockOnMs: after(cell(r, iArrT)),
				distanceNM: Number.isFinite(dist) ? dist : 0,
				depPlace: cell(r, iDepP),
				arrPlace: cell(r, iArrP),
				landingsDay: int(cell(r, iLdgD)),
				landingsNight: int(cell(r, iLdgN)),
				nightMin: hmToMin(cell(r, iNight)),
			},
			registration: cell(r, iReg) || null,
			remarks: cell(r, iRemarks),
			declared: Object.fromEntries(
				declaredIdx
					.map(([name, i]) => [name, cell(r, i)] as const)
					.filter(([, v]) => v !== ''),
			),
		});
	}
	return { rows, skipped };
}
