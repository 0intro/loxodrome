/* A recorded GPS track: an ordered list of TrackPoints, plus the pure helpers
 * the recorder, the map layer, the replay slider and the vertical profile all
 * share. No Svelte, no I/O, so it is unit-testable (tests/navTrace.spec.ts) and
 * usable from both the state module and the pure GPX / profile modules. */

import { destinationPoint, equirectangularDistanceM, initialBearingDeg } from '$lib/notam/geometry';

/** Metres per second in one knot (1 kt = 1852 m / 3600 s). */
export const MS_PER_KT = 1852 / 3600;

/** One recorded fix. Altitude/speed/track are the device's own values when it
 *  reports them; speed/track are otherwise derived from the previous fix. */
export interface TrackPoint {
	lat: number;
	lon: number;
	/** GPS (WGS84 ellipsoidal) altitude in feet; null when the device omits it. */
	altFt: number | null;
	/** Fix time, epoch milliseconds UTC. */
	timeMs: number;
	/** Ground speed in knots, when known. */
	speedKt?: number | null;
	/** Track over the ground in degrees true, when known. */
	trackDeg?: number | null;
	/** Reported horizontal accuracy in metres, when known. */
	accuracyM?: number | null;
}

/** An interpolated pose for the map icon / profile playhead at some instant. */
export interface Fix {
	lat: number;
	lon: number;
	altFt: number | null;
	trackDeg: number | null;
	speedKt: number | null;
}

/** A lat/lon bounding box (degrees), for fit-to-trace on import. */
export interface TraceBounds {
	south: number;
	west: number;
	north: number;
	east: number;
}

/** Speed (kt) and track (° true) inferred from the hop prev -> cur, used when
 *  the device leaves coords.speed / coords.heading null (common at low speed or
 *  on GPX imports that carry only position + time). */
export function deriveMotion(
	prev: TrackPoint,
	cur: TrackPoint,
): { speedKt: number; trackDeg: number } {
	const distM = equirectangularDistanceM(prev.lat, prev.lon, cur.lat, cur.lon);
	const dtSec = (cur.timeMs - prev.timeMs) / 1000;
	const speedKt = dtSec > 0 ? distM / dtSec / MS_PER_KT : 0;
	const trackDeg = initialBearingDeg(prev.lat, prev.lon, cur.lat, cur.lon);
	return { speedKt, trackDeg };
}

/** A TrackPoint promoted to a Fix (identity pose; used for the live tip). */
export function fixOf(p: TrackPoint): Fix {
	return {
		lat: p.lat,
		lon: p.lon,
		altFt: p.altFt,
		trackDeg: p.trackDeg ?? null,
		speedKt: p.speedKt ?? null,
	};
}

/** Linear interpolation clamped to [0, 1]. */
function lerp(a: number, b: number, f: number): number {
	return a + (b - a) * f;
}

/** The pose along the track at time tMs, for replay. Clamps to the ends; lerps
 *  position/altitude by the time fraction; the heading is the direction of
 *  travel over the bracketing segment (falling back to a reported track). Null
 *  when the track is empty. */
export function positionAt(points: TrackPoint[], tMs: number): Fix | null {
	const n = points.length;
	if (n === 0) {
		return null;
	}
	if (n === 1 || tMs <= points[0].timeMs) {
		return fixOf(points[0]);
	}
	if (tMs >= points[n - 1].timeMs) {
		return fixOf(points[n - 1]);
	}
	// Largest i with points[i].timeMs <= tMs (binary search).
	let lo = 0;
	let hi = n - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (points[mid].timeMs <= tMs) {
			lo = mid;
		} else {
			hi = mid - 1;
		}
	}
	const a = points[lo];
	const b = points[lo + 1];
	const span = b.timeMs - a.timeMs;
	const f = span > 0 ? (tMs - a.timeMs) / span : 0;
	const altFt =
		a.altFt != null && b.altFt != null
			? lerp(a.altFt, b.altFt, f)
			: (a.altFt ?? b.altFt);
	const trackDeg =
		a.lat !== b.lat || a.lon !== b.lon
			? initialBearingDeg(a.lat, a.lon, b.lat, b.lon)
			: (a.trackDeg ?? b.trackDeg ?? null);
	const speedKt =
		a.speedKt != null && b.speedKt != null
			? lerp(a.speedKt, b.speedKt, f)
			: (a.speedKt ?? b.speedKt ?? deriveMotion(a, b).speedKt);
	return { lat: lerp(a.lat, b.lat, f), lon: lerp(a.lon, b.lon, f), altFt, trackDeg, speedKt };
}

/** First / last fix time, the replay slider bounds (null when empty). */
export function traceStartMs(points: TrackPoint[]): number | null {
	return points.length ? points[0].timeMs : null;
}

export function traceEndMs(points: TrackPoint[]): number | null {
	return points.length ? points[points.length - 1].timeMs : null;
}

/** 2000-01-01T00:00Z: timestamps past it are real wall clock. */
const ABSOLUTE_TIME_MIN_MS = 946684800000;

/** Whether the trace carries absolute wall-clock time (a live recording, a
 *  GPX with <time>) as opposed to a synthesised 1 Hz clock from epoch 0 on
 *  a time-less GPX; gates every "time of day" display. */
export function hasAbsoluteTime(points: readonly TrackPoint[]): boolean {
	return points.length > 0 && points[0].timeMs > ABSOLUTE_TIME_MIN_MS;
}

/** Stride-decimate to at most `max` points, always keeping the last, for the
 *  persisted crash-recovery copy (the full track stays in memory). */
export function downsample(points: TrackPoint[], max: number): TrackPoint[] {
	if (max <= 0 || points.length <= max) {
		return points.slice();
	}
	const stride = Math.ceil(points.length / max);
	const out: TrackPoint[] = [];
	for (let i = 0; i < points.length; i += stride) {
		out.push(points[i]);
	}
	const last = points[points.length - 1];
	if (out[out.length - 1] !== last) {
		out.push(last);
	}
	return out;
}

/** Lat/lon bounding box of the track (null when empty). */
export function traceBounds(points: TrackPoint[]): TraceBounds | null {
	if (points.length === 0) {
		return null;
	}
	let south = Infinity;
	let west = Infinity;
	let north = -Infinity;
	let east = -Infinity;
	for (const p of points) {
		if (p.lat < south) south = p.lat;
		if (p.lat > north) north = p.lat;
		if (p.lon < west) west = p.lon;
		if (p.lon > east) east = p.lon;
	}
	return { south, west, north, east };
}

/** The projected-position lead times (minutes) of the live trajectory vector. */
export const VECTOR_MINUTES = [2, 3, 5, 10];

/** Ground speed (kt) below which the aircraft is treated as stationary, so no
 *  trajectory vector is drawn. */
export const MIN_VECTOR_KT = 5;

export interface ProjectedPosition {
	min: number;
	lat: number;
	lon: number;
}

/** Dead-reckoned positions `minutes` ahead at a constant ground speed + track
 *  (the direct geodesic). Empty when not moving. */
export function projectedPositions(
	lat: number,
	lon: number,
	trackDeg: number,
	speedKt: number,
	minutes: number[],
): ProjectedPosition[] {
	if (speedKt <= 0) {
		return [];
	}
	const speedMs = speedKt * MS_PER_KT;
	return minutes.map((min) => {
		const p = destinationPoint(lat, lon, trackDeg, speedMs * min * 60);
		return { min, lat: p.lat, lon: p.lon };
	});
}

// --- Trajectory-vector motion filter ---------------------------------------
//
// The live vector's direction/length come from a time-weighted mean of the
// recent velocity, evaluated at an instant (the live tip or the replay
// playhead). Time weighting (an exponential decay, not a fixed fix count) makes
// the smoothing span independent of the GPS fix cadence, so a new fix nudges the
// vector instead of stepping it. See docs note in navRecording.svelte.ts.

/** Base EMA decay constant (s): the smoothing time in steady flight. */
const MOTION_TAU_SEC = 8;
/** Decay-constant floor (s) in a hard turn, so the vector tracks the turn
 *  instead of lagging a fixed span behind it. */
const MOTION_TAU_TURN_SEC = 2.5;
/** Hard truncation of the averaging window (s), ~4 base tau (older fixes carry
 *  under ~2% weight). */
const MOTION_WINDOW_SEC = 30;
/** Turn rate (deg/s) at which the decay constant reaches its floor; tau ramps
 *  continuously from base at 0 to the floor here (no mode-flip stutter). */
const TURN_TAU_OMEGA_REF = 1.0;
/** Directional-coherence floor: |mean velocity| / mean speed. Below this the
 *  recent fixes disagree on direction (a reversal or pure noise), so no vector
 *  is drawn. Also guards atan2(0, 0), which returns 0 (a false due-north), not
 *  NaN. */
const MOTION_COHERENCE_MIN = 0.3;

function clamp(x: number, lo: number, hi: number): number {
	return x < lo ? lo : x > hi ? hi : x;
}

/** Signed shortest angular difference b - a, in (-180, 180]. */
function angleDeltaDeg(a: number, b: number): number {
	return ((b - a + 540) % 360) - 180;
}

/** One usable window fix: position, time, and resolved (backfilled) motion. */
interface MotionSample {
	timeMs: number;
	lat: number;
	lon: number;
	speedKt: number;
	trackDeg: number;
	altFt: number | null;
}

/** The usable fixes at or before `tMs` and within MOTION_WINDOW_SEC of it, in
 *  ascending time. Motion missing from the device is backfilled from the hop off
 *  the immediately preceding fix (as the live ingest does); the very first fix,
 *  having no predecessor, is dropped when it carries no motion. */
function motionWindow(points: TrackPoint[], tMs: number): MotionSample[] {
	const minMs = tMs - MOTION_WINDOW_SEC * 1000;
	const win: MotionSample[] = [];
	for (let i = points.length - 1; i >= 0; i--) {
		const p = points[i];
		if (p.timeMs > tMs) {
			continue; // a future fix (replay before the tip): causal filter skips it
		}
		if (p.timeMs < minMs) {
			break; // sorted ascending, so everything earlier is out of the window
		}
		let speedKt = p.speedKt;
		let trackDeg = p.trackDeg;
		if (
			speedKt == null ||
			!Number.isFinite(speedKt) ||
			trackDeg == null ||
			!Number.isFinite(trackDeg)
		) {
			const prev = i > 0 ? points[i - 1] : undefined;
			if (!prev) {
				continue;
			}
			const m = deriveMotion(prev, p);
			if (speedKt == null || !Number.isFinite(speedKt)) speedKt = m.speedKt;
			if (trackDeg == null || !Number.isFinite(trackDeg)) trackDeg = m.trackDeg;
		}
		win.push({
			timeMs: p.timeMs,
			lat: p.lat,
			lon: p.lon,
			speedKt,
			trackDeg,
			altFt: p.altFt ?? null,
		});
	}
	win.reverse();
	return win;
}

/** Weighted vertical speed (ft/min) over the window: the age-weighted mean of
 *  the altitude change per unit time across consecutive alt-carrying fixes
 *  (the windowTurnRate hop idiom). A RATE cancels the trace's constant datum
 *  offset, so it is datum-safe by construction. Null under two alt-carrying
 *  fixes (no difference to take). */
function windowVerticalSpeed(win: MotionSample[], tMs: number, tauSec: number): number | null {
	let num = 0;
	let den = 0;
	let prev: { timeMs: number; altFt: number } | null = null;
	for (const f of win) {
		if (f.altFt == null) {
			continue;
		}
		if (prev && f.timeMs > prev.timeMs) {
			const midMs = (prev.timeMs + f.timeMs) / 2;
			const w = Math.exp(-(tMs - midMs) / 1000 / tauSec);
			num += w * (f.altFt - prev.altFt);
			den += w * ((f.timeMs - prev.timeMs) / 60_000);
		}
		prev = { timeMs: f.timeMs, altFt: f.altFt };
	}
	return den > 0 ? num / den : null;
}

/** Weighted turn rate (deg/s, right-hand positive) over the window: the
 *  age-weighted mean of the change in the position-derived hop bearing per unit
 *  time. Position bearings are used, not the stored track, to avoid mixing
 *  device heading with derived. Zero when under three moving fixes (no reliable
 *  second difference). Weights use the base tau (the turn rate then picks the
 *  effective tau). */
function windowTurnRate(win: MotionSample[], tMs: number): number {
	// Hop bearings between consecutive fixes that are actually moving.
	const hops: { bearing: number; midMs: number }[] = [];
	for (let k = 0; k + 1 < win.length; k++) {
		const a = win[k];
		const b = win[k + 1];
		if (b.timeMs <= a.timeMs || a.speedKt < MIN_VECTOR_KT || b.speedKt < MIN_VECTOR_KT) {
			continue;
		}
		hops.push({
			bearing: initialBearingDeg(a.lat, a.lon, b.lat, b.lon),
			midMs: (a.timeMs + b.timeMs) / 2,
		});
	}
	let num = 0;
	let den = 0;
	for (let k = 0; k + 1 < hops.length; k++) {
		const h0 = hops[k];
		const h1 = hops[k + 1];
		const dtSec = (h1.midMs - h0.midMs) / 1000;
		if (dtSec <= 0) {
			continue;
		}
		const w = Math.exp(-(tMs - h1.midMs) / 1000 / MOTION_TAU_SEC);
		num += w * angleDeltaDeg(h0.bearing, h1.bearing);
		den += w * dtSec;
	}
	return den > 0 ? num / den : 0;
}

/** Time-weighted ground speed (kt), track (deg true) and turn rate (deg/s) at
 *  the instant `tMs`, from the recent GPS fixes; the direction/length/curvature
 *  of the live trajectory vector. Causal (only fixes at or before `tMs`), so the
 *  live tip and a replay playhead read the same way. Averages in velocity
 *  components (wrap-safe), speed-weighted so a near-stationary fix's garbage
 *  heading barely tugs the result, and shortens its own memory in a turn.
 *
 *  Null when no usable fix falls in the window, the mean speed is below
 *  MIN_VECTOR_KT (stationary), or the recent directions are incoherent
 *  (MOTION_COHERENCE_MIN). `tauSec` overrides the steady-flight decay constant
 *  (tests contrast responsiveness); the turn-driven shortening still applies. */
export function smoothedMotionAt(
	points: TrackPoint[],
	tMs: number,
	tauSec = MOTION_TAU_SEC,
): { speedKt: number; trackDeg: number; turnRateDegS: number; vsFpm: number | null } | null {
	const win = motionWindow(points, tMs);
	if (win.length === 0) {
		return null;
	}
	const turnRateDegS = windowTurnRate(win, tMs);
	// Shorten the memory continuously with turn rate: base tau when straight,
	// down to the floor at TURN_TAU_OMEGA_REF and beyond.
	const tauEff = clamp(
		tauSec - (tauSec - MOTION_TAU_TURN_SEC) * (Math.abs(turnRateDegS) / TURN_TAU_OMEGA_REF),
		MOTION_TAU_TURN_SEC,
		tauSec,
	);
	let sumW = 0;
	let sumWV = 0;
	let sumU = 0;
	let sumN = 0;
	for (const f of win) {
		const w = Math.exp(-(tMs - f.timeMs) / 1000 / tauEff);
		const rad = (f.trackDeg * Math.PI) / 180;
		sumW += w;
		sumWV += w * f.speedKt;
		sumU += w * f.speedKt * Math.sin(rad);
		sumN += w * f.speedKt * Math.cos(rad);
	}
	if (sumW <= 0) {
		return null;
	}
	const speedKt = sumWV / sumW;
	if (speedKt < MIN_VECTOR_KT) {
		return null;
	}
	// Coherence: how aligned the recent velocity vectors are, in [0, 1].
	const coherence = sumWV > 0 ? Math.hypot(sumU, sumN) / sumWV : 0;
	if (coherence < MOTION_COHERENCE_MIN) {
		return null;
	}
	const trackDeg = ((Math.atan2(sumU, sumN) * 180) / Math.PI + 360) % 360;
	return { speedKt, trackDeg, turnRateDegS, vsFpm: windowVerticalSpeed(win, tMs, tauEff) };
}
