/* The position-referenced airspace evaluator: grades every candidate volume
 * around the aircraft by proximity and required action, from the pose and a
 * dead-reckoned lookahead segment, never from the planned route. This is
 * the deliberate exception beside the route-referenced live surfaces (the
 * plog, the contact chain, the schedule): those answer "where am I on the
 * plan", this answers "what is around the aircraft", and the two must never
 * be merged (docs/nav-alerts.md, docs/nav-live.md).
 *
 * Pure and deterministic: every input arrives as data (volumes, injected
 * NOTAM windows, terrain, acknowledgements, the clock), so a replay scrub
 * reconstructs identical states. The `prev` state carries only presentation
 * memory (demotion hold, sound re-arm); a backward playhead jump resets it.
 *
 * Activation is evaluated over the PROJECTED TRAVERSAL INTERVAL, not "now":
 * a cold RTBA segment whose window opens while the aircraft would still be
 * inside it alerts on approach, and one whose window closes before arrival
 * stays silent. */

import { volumeLinksActivations, type AlertVolume, type VolumeCut } from './alertVolumes';
import {
	resolveActivity,
	type ActivePeriod,
	type ActivityState,
	type ConfirmedPeriod,
	type NotedState,
} from '$lib/data/activity';
import {
	ACTION_RANK,
	classifyVolume,
	tierPref,
	type AlertAction,
	type AlertProfile,
	type AlertTierPref,
} from './alertRules';
import { pointInRing } from '$lib/data/airspaces';
import {
	destinationPoint,
	equirectangularDistanceM,
	pointToPolylineDistanceM,
	segmentCircleCrossings,
	segmentRingCrossings,
} from '$lib/notam/geometry';
import { NM_TO_METERS } from '$lib/notam/units';
import {
	ceilingMaxFt,
	floorMinFt,
	groundBandAtPoint,
	type GroundBand,
	type VLimit,
} from '$lib/vertical/limits';

export type AlertSeverity = 'inside' | 'imminent' | 'approaching' | 'proximity' | 'clear';

export const SEVERITY_RANK: Record<AlertSeverity, number> = {
	inside: 4,
	imminent: 3,
	approaching: 2,
	proximity: 1,
	clear: 0,
};

/** A demoting severity must hold this long before the shown state follows;
 *  promotion is instant. Keeps the banner from flapping on a boundary. */
export const DEMOTE_HOLD_MS = 10_000;
/** A volume must stay below its sound threshold this long before the same
 *  severity can fire audio again (the cry-wolf guard). */
export const SOUND_REARM_MS = 300_000;
/** Below this ground speed the dead-reckoning segment is meaningless (the
 *  navLayer vector's MIN_VECTOR_KT); inside / proximity still evaluate. */
export const MIN_LOOKAHEAD_KT = 5;
/** The parked airframe stands this far above the surface. The nudge keeps
 *  the strict-floor convention (a STACKED-airspace data rule) from grading
 *  a parked aircraft as merely at the floor of a volume based at the ground
 *  it stands on, an AMSL 0 floor at a sea-level field (ground substitution
 *  below). verticalState reads a SFC floor as unbounded below. The nudge is
 *  well under the smallest vertical buffer, so nothing else moves. */
export const PARKED_AGL_FT = 10;

export interface AlertPose {
	lat: number;
	lon: number;
	/** Geoid-referenced MSL altitude (poseAltMslFt), null when the device
	 *  reports none: the vertical test degrades to lateral-only. */
	mslFt: number | null;
	/** False while the datum is a platform guess or the position quality is
	 *  degraded: same lateral-only degradation, phrased as such. */
	altTrusted: boolean;
	/** Smoothed track, null when motion is incoherent (no lookahead). */
	trackDeg: number | null;
	/** Smoothed ground speed, kt. */
	speedKt: number;
	/** Smoothed vertical speed, ft/min, null when underivable: the vertical
	 *  gap then reads as level (the quiet form), and the hard inside test
	 *  still guards actual entry. */
	vsFpm: number | null;
}

export interface AlertParams {
	/** Approaching horizon, minutes. */
	lookaheadMin: number;
	/** Imminent threshold, minutes. */
	imminentMin: number;
	/** Lateral proximity radius, NM. */
	proximityNM: number;
	/** Vertical buffer, ft. */
	verticalBufferFt: number;
}

export interface AlertInput {
	nowMs: number;
	pose: AlertPose;
	/** Spatially prefiltered candidates (the caller's RBush query). */
	volumes: AlertVolume[];
	/** NOTAM activation periods joined by volume `id` (RTBA per-zone windows,
	 *  activation NOTAMs, SUP-zone activations by NOTAM). */
	notamWindows: ReadonlyMap<string, ConfirmedPeriod[]>;
	/** The periods a loaded NOTAM changes each zone over, by volume `id` (a
	 *  restricted area "changed", QR?CH, citing it): over them its published
	 *  periods are in doubt. */
	amendedWindows?: ReadonlyMap<string, readonly ActivePeriod[]> | undefined;
	/** The pilot's notes of what a unit said of a zone, by volume `id`
	 *  (state/zoneNotes.svelte.ts): each settles its zone over the
	 *  traversals it covers while the zone may be active. */
	notes?: ReadonlyMap<string, NotedState> | undefined;
	/** Does the loaded briefing cover the pose and the lookahead's end
	 *  (notam/briefingVerdict.ts briefedAt)? A zone activated BY NOTAM can
	 *  only be called cold on the authority of a briefing that covers where
	 *  and when it is crossed, and does not list it. `notam` answers for
	 *  every such zone, `rtba` for an RTBA zone, whose day's activity the
	 *  briefing must also hold. Without that authority the honest verdict is
	 *  `activable` (the caution tier) rather than silence. `at` is when the
	 *  briefing was made, which a zone's notice bounds its silence from. */
	briefed: { notam: boolean; rtba: boolean; at?: number | undefined };
	/** Airspace keys of the flown route's schedule: a clearance-tier volume
	 *  the plan traverses softens to a briefed advisory. */
	plannedKeys: ReadonlySet<string>;
	/** Acknowledged severity rank per volume key; escalation past it re-alerts. */
	acks: ReadonlyMap<string, number>;
	profile: AlertProfile;
	params: AlertParams;
	/** Takeoff committed (the motion fold): before it, only the avoid tier
	 *  alerts, so the home field's own CTR stays quiet on the ground. */
	airborne: boolean;
	/** Terrain elevation at the pose. `groundKnown` false = lookup pending:
	 *  volumes needing terrain hold their verdict for a tick rather than
	 *  cry wolf; true with null = lookup failed, conservative endpoints. */
	groundFt: number | null;
	groundKnown: boolean;
	/** The Navigation-tab tier toggles. */
	tiers: Record<AlertTierPref, boolean>;
}

export interface VolumeAlert {
	/** The alert stack's discriminant: a volume, beside the terrain rows
	 *  (nav/terrainAlert.ts) the presentation fold ranks on the same scale. */
	subject: 'volume';
	key: string;
	volume: AlertVolume;
	action: Exclude<AlertAction, 'none'>;
	severity: Exclude<AlertSeverity, 'clear'>;
	/** Seconds to the projected boundary; null when inside or proximate. */
	etaSec: number | null;
	/** Along-track NM to the entry, or the lateral offset for proximity. */
	distNM: number | null;
	activityState: ActivityState;
	/** The period behind its state, for the phrasing ("active until
	 *  12:30Z", "may be active until 15:16Z"), null for an inactive one. */
	window: ActivePeriod | null;
	/** Label of an active avoid-graded volume containing the projected entry
	 *  (the pose, when inside): the cumulative-conditions rule (ICAO Annex 2
	 *  3.1.10 / SERA.3145: overlapping volumes' conditions each bind
	 *  independently, so the required action is the most restrictive). The
	 *  surface states that volume's prohibition in place of this alert's own
	 *  contact line; collected before the ack / tier gates, so the
	 *  composition survives either way of suppressing the covering volume's
	 *  own alert (docs/nav-alerts.md). */
	coveredBy: string | null;
	/** The graded traversal overlaps the volume only within the vertical
	 *  buffer: laterally inside now, or at the projected entry altitude. */
	verticalGap: boolean;
	gapSide: 'below' | 'above' | null;
	/** The gap is CLOSING: the smoothed vertical speed projects band entry
	 *  within the imminent horizon. Level shelf-riding stays a quiet
	 *  proximity; this is what escalates it. */
	gapClosing: boolean;
	/** Softened briefed traversal (clearance tier on the flown route). */
	planned: boolean;
	/** The pose carries no trustworthy altitude: lateral-only judgement. */
	altUnknown: boolean;
	/** The volume's vertical extent is not fully published, so the
	 *  judgement rests on a limit the AIP did not state. A floor with no
	 *  ceiling counts: the evaluator reads that ceiling as unlimited. */
	extentUnknown: boolean;
	acked: boolean;
}

/** Presentation memory between calls; reset on a backward playhead jump. */
export interface AlertPrevState {
	shown: Map<string, { severity: AlertSeverity; downSinceMs: number | null }>;
	sounded: Map<string, { rank: number; clearSinceMs: number | null }>;
}

export function emptyAlertPrev(): AlertPrevState {
	return { shown: new Map(), sounded: new Map() };
}

export interface AlertFire {
	key: string;
	action: AlertAction;
	severity: AlertSeverity;
}

export interface AlertEvalResult {
	/** Shown alerts, dominant first. */
	alerts: VolumeAlert[];
	dominant: VolumeAlert | null;
	prev: AlertPrevState;
	/** Sound edges this call (already ack- and planned-filtered). */
	fired: AlertFire[];
}

/** Severity rank at which each action becomes sound-worthy: a forbidden
 *  volume warns on approach, a clearance / equipment boundary when entry is
 *  imminent, a hazard only on entry. */
function soundThresholdRank(action: AlertAction): number {
	switch (action) {
		case 'avoid':
			return SEVERITY_RANK.approaching;
		case 'caution':
			return SEVERITY_RANK.inside;
		default:
			return SEVERITY_RANK.imminent;
	}
}

type Shape = Pick<VolumeCut, 'rings' | 'circles'>;

function inShape(v: Shape, lat: number, lon: number): boolean {
	for (const ring of v.rings) {
		if (pointInRing(lat, lon, ring)) {
			return true;
		}
	}
	for (const c of v.circles) {
		if (equirectangularDistanceM(lat, lon, c.lat, c.lon) <= c.radiusM) {
			return true;
		}
	}
	return false;
}

function cutHolds(c: VolumeCut, atMs: number): boolean {
	return c.windows === null || c.windows.some((w) => w.startMs <= atMs && atMs < w.endMs);
}

/** Is the point in the volume at `atMs`: in its footprint, in the sector a
 *  piece is confined to while that holds, and out of every sector taken out
 *  of it that holds then. */
function containsPoint(v: AlertVolume, lat: number, lon: number, atMs: number): boolean {
	if (!inShape(v, lat, lon)) {
		return false;
	}
	if (v.within && !(cutHolds(v.within, atMs) && inShape(v.within, lat, lon))) {
		return false;
	}
	return !v.holes?.some((h) => cutHolds(h, atMs) && inShape(h, lat, lon));
}

/** The shapes whose boundaries bound a volume piece: its footprint and its
 *  cuts. */
function shapesOf(v: AlertVolume): Shape[] {
	return [v, ...(v.within ? [v.within] : []), ...(v.holes ?? [])];
}

/** The distance to the nearest boundary of the volume's shapes, a cut's
 *  included: from inside a sector taken out of it, the volume begins at the
 *  sector's edge. */
function lateralDistanceM(v: AlertVolume, lat: number, lon: number): number {
	let min = Infinity;
	for (const shape of shapesOf(v)) {
		const d = shapeDistanceM(shape, lat, lon);
		if (d < min) {
			min = d;
		}
	}
	return min;
}

/** The distance to a shape's boundary, its rings' lines and its circles'
 *  edges, from either side. */
function shapeDistanceM(v: Shape, lat: number, lon: number): number {
	let min = Infinity;
	for (const ring of v.rings) {
		if (ring.length < 2) {
			continue;
		}
		const closed = ring.map(([la, lo]) => ({ lat: la, lon: lo }));
		closed.push(closed[0]);
		const d = pointToPolylineDistanceM(lat, lon, closed);
		if (d < min) {
			min = d;
		}
	}
	for (const c of v.circles) {
		const d = Math.abs(equirectangularDistanceM(lat, lon, c.lat, c.lon) - c.radiusM);
		if (d < min) {
			min = d;
		}
	}
	return min;
}

/** All boundary crossings of the lookahead segment against the volume's
 *  union geometry, sorted. Intervals between them are classified by
 *  midpoint containment, which stays correct when a graze or an edge run
 *  yields no strict crossing (the segmentRingCrossings contract). */
function crossingsAlong(
	v: AlertVolume,
	aLat: number,
	aLon: number,
	bLat: number,
	bLon: number,
): number[] {
	const ts: number[] = [];
	for (const shape of shapesOf(v)) {
		for (const ring of shape.rings) {
			ts.push(...segmentRingCrossings(aLat, aLon, bLat, bLon, ring));
		}
		for (const c of shape.circles) {
			ts.push(...segmentCircleCrossings(aLat, aLon, bLat, bLon, c.lat, c.lon, c.radiusM));
		}
	}
	ts.sort((x, y) => x - y);
	return ts;
}

/** The first inside run along the segment (called with the start outside):
 *  entry t and the matching exit t (1 when the segment ends inside), by
 *  midpoint classification of the intervals between crossings, each
 *  midpoint at its time on the segment (t0Ms plus t times spanMs). Null
 *  when the segment never enters. */
function firstEntry(
	v: AlertVolume,
	aLat: number,
	aLon: number,
	bLat: number,
	bLon: number,
	t0Ms: number,
	spanMs: number,
): { tEntry: number; tExit: number } | null {
	const ts = crossingsAlong(v, aLat, aLon, bLat, bLon);
	if (ts.length === 0) {
		return null;
	}
	const bounds = [0, ...ts, 1];
	const insideAt = (i: number): boolean => {
		const mid = (bounds[i] + bounds[i + 1]) / 2;
		return containsPoint(v, aLat + (bLat - aLat) * mid, aLon + (bLon - aLon) * mid, t0Ms + mid * spanMs);
	};
	for (let i = 0; i + 1 < bounds.length; i++) {
		if (!insideAt(i)) {
			continue;
		}
		let j = i;
		while (j + 2 < bounds.length && insideAt(j + 1)) {
			j++;
		}
		return { tEntry: bounds[i], tExit: bounds[j + 1] };
	}
	return null;
}

type VerticalState = 'in' | 'buffer' | 'out' | 'pending';

/** What one volume piece reads at the pose and along its projection
 *  (evaluateAlerts' pieceGeometry). */
interface PieceGeometry {
	piece: AlertVolume;
	vert: { state: VerticalState; gapSide: 'below' | 'above' | null; gapFt: number | null };
	insideNow: boolean;
	entry: { tEntry: number; tExit: number } | null;
	rawSeverity: AlertSeverity;
	etaSec: number | null;
	distNM: number | null;
	intervalFrom: number;
	intervalTo: number;
	gapForm: boolean;
	gapSide: 'below' | 'above' | null;
	gapClosing: boolean;
}

/** Point-vs-volume vertical test, the route/airspaces inBand composition:
 *  strict floor, inclusive ceiling, conservative AGL endpoints, the floor off
 *  the ground band's low end and the ceiling off its high one. The pose's
 *  ground is a POINT, so today both ends carry the same reading; the band is
 *  what a terrain lookahead along the projected segment would fill in. A SFC
 *  floor is unbounded below, since an aircraft is always above the surface:
 *  the strict floor would otherwise put a projection clamped at the terrain,
 *  or a fix reading under a coarse ground sample, just below the zone it is
 *  in. `buffer` widens both sides. Volumes with no usable extent overlap by
 *  policy (flagged extentUnknown for the phrasing). In the buffer state
 *  `gapFt` is the remaining vertical distance to the near boundary, what
 *  the gap-closing projection divides by the vertical speed. A piece a
 *  sector cuts starts at the higher of its floor and cutFloor and ends at
 *  the lower of its ceiling and cutCeiling, each read the side that
 *  alerts. */
function verticalState(
	v: AlertVolume,
	altFt: number,
	bufferFt: number,
	ground: GroundBand,
	groundKnown: boolean,
): { state: VerticalState; gapSide: 'below' | 'above' | null; gapFt: number | null } {
	if (!v.knownExtent) {
		return { state: 'in', gapSide: null, gapFt: null };
	}
	const floorAgl = (f: VLimit | null | undefined) => f?.ref === 'AGL' && f.ft > 0;
	const ceilingAgl = (c: VLimit | null | undefined) => c?.ref === 'AGL' && !c.unl;
	const needsGround =
		floorAgl(v.vLower) || ceilingAgl(v.vUpper) || floorAgl(v.cutFloor) || ceilingAgl(v.cutCeiling);
	if (needsGround && !groundKnown) {
		return { state: 'pending', gapSide: null, gapFt: null };
	}
	const floorFt = (f: VLimit | null | undefined) => (f && !f.sfc ? floorMinFt(f, ground.minFt) : -Infinity);
	const lo = Math.max(floorFt(v.vLower), floorFt(v.cutFloor));
	const hi = Math.min(
		v.vUpper ? ceilingMaxFt(v.vUpper, ground.maxFt) : Infinity,
		v.cutCeiling ? ceilingMaxFt(v.cutCeiling, ground.maxFt) : Infinity,
	);
	if (lo < altFt && hi >= altFt) {
		return { state: 'in', gapSide: null, gapFt: null };
	}
	const below = altFt <= lo;
	const gapSide: 'below' | 'above' = below ? 'below' : 'above';
	const gapFt = below ? lo - altFt : altFt - hi;
	if (lo < altFt + bufferFt && hi >= altFt - bufferFt) {
		return { state: 'buffer', gapSide, gapFt };
	}
	// The out state keeps the gap figures too: the beyond-buffer closing
	// test (laterally inside, climbing hard toward a shelf) divides by them.
	return { state: 'out', gapSide, gapFt };
}

/** Dominance: action rank (planned clearance demoted between equipment and
 *  caution), then severity, then soonest entry; unacked before acked.
 *  Exported for the presentation fold (nav/alertSurface.ts), which keeps
 *  the same dominance but swaps the eta tiebreaker for order stability. */
export function dominanceRank(a: VolumeAlert): number {
	if (a.planned) {
		return ACTION_RANK.caution + 0.5;
	}
	return ACTION_RANK[a.action];
}

function compareAlerts(a: VolumeAlert, b: VolumeAlert): number {
	if (a.acked !== b.acked) {
		return a.acked ? 1 : -1;
	}
	const rank = dominanceRank(b) - dominanceRank(a);
	if (rank !== 0) {
		return rank;
	}
	const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
	if (sev !== 0) {
		return sev;
	}
	return (a.etaSec ?? 0) - (b.etaSec ?? 0);
}

export function evaluateAlerts(input: AlertInput, prev: AlertPrevState): AlertEvalResult {
	const { pose, params, nowMs } = input;
	const lookaheadMs = params.lookaheadMin * 60_000;
	const alerts: VolumeAlert[] = [];
	/** Per-alert composition reference, aligned with `alerts`: the projected
	 *  entry point (imminent / approaching), the pose (inside), else null
	 *  (proximity and the vertical-gap forms project no entry). */
	const refs: ({ lat: number; lon: number } | null)[] = [];
	/** Avoid-graded volumes vertically `in` at the pose altitude, collected
	 *  ahead of the ack / tier gates: the covering set for the
	 *  cumulative-conditions pass below. */
	const covers: AlertVolume[] = [];
	const fired: AlertFire[] = [];
	const nextShown: AlertPrevState['shown'] = new Map();
	const nextSounded: AlertPrevState['sounded'] = new Map();
	// Pre-takeoff the aircraft is ON the ground, so an untrusted device
	// altitude does not degrade the judgement to lateral-only: the known
	// terrain elevation IS the altitude. Grading a parked aircraft
	// lateral-only put it "inside" the FL 115-195 sectors stacked over the
	// aerodrome the moment a cached startup fix arrived (the
	// start-of-flight R 205/11 flash). While the terrain sample is still
	// pending there is nothing to grade against, and the ASFC hold idiom
	// applies volume-wide for the tick rather than crying wolf. AIRBORNE,
	// the conservative lateral-only judgement stands: an aircraft without
	// a trusted altitude could be at any level.
	let effMslFt = pose.mslFt;
	let effTrusted = pose.altTrusted;
	let preTakeoffHold = false;
	if (!input.airborne && (effMslFt == null || !effTrusted)) {
		if (input.groundKnown && input.groundFt != null) {
			effMslFt = input.groundFt + PARKED_AGL_FT;
			effTrusted = true;
		} else {
			preTakeoffHold = true;
		}
	}
	const altKnown = effMslFt != null && effTrusted;

	// Dead-reckoning segment for the lookahead horizon.
	const canProject =
		pose.trackDeg != null && pose.speedKt >= MIN_LOOKAHEAD_KT;
	const segLenM = canProject
		? pose.speedKt * (NM_TO_METERS / 60) * params.lookaheadMin
		: 0;
	const dest = canProject
		? destinationPoint(pose.lat, pose.lon, pose.trackDeg as number, segLenM)
		: null;

	/** One volume piece's reading: its vertical state at the pose, inside
	 *  now or its first projected entry, and the severity they give, or
	 *  'pending' while a ground it needs is unknown, or 'out' beyond its
	 *  vertical reach. */
	const pieceGeometry = (p: AlertVolume): PieceGeometry | 'pending' | 'out' => {
		let vert = {
			state: 'in' as VerticalState,
			gapSide: null as 'below' | 'above' | null,
			gapFt: null as number | null,
		};
		if (preTakeoffHold) {
			vert = { state: 'pending', gapSide: null, gapFt: null };
		} else if (altKnown) {
			vert = verticalState(
				p,
				effMslFt as number,
				params.verticalBufferFt,
				groundBandAtPoint(input.groundFt),
				input.groundKnown,
			);
		}
		if (vert.state === 'pending') {
			return 'pending';
		}
		if (vert.state === 'out') {
			// Out of vertical reach AT THE POSE, but the trajectory may still
			// meet the band: a climb toward a shelf ahead, or hard toward one
			// laterally overhead. One re-test widened by the projectable delta
			// (|vs| over the imminent horizon) keeps the gate a float compare;
			// volumes beyond even that reach drop here.
			const projPadFt = pose.vsFpm != null ? Math.abs(pose.vsFpm) * params.imminentMin : 0;
			if (
				projPadFt === 0 ||
				verticalState(
					p,
					effMslFt as number,
					params.verticalBufferFt + projPadFt,
					groundBandAtPoint(input.groundFt),
					input.groundKnown,
				).state === 'out'
			) {
				return 'out';
			}
		}

		// Lateral geometry: inside now, else the first projected entry, else
		// plain proximity to the boundary. The segment spans exactly the
		// lookahead horizon at the current ground speed, so the parametric t
		// maps linearly to time.
		const insideNow = containsPoint(p, pose.lat, pose.lon, nowMs);
		let entry: { tEntry: number; tExit: number } | null = null;
		if (!insideNow && dest) {
			entry = firstEntry(p, pose.lat, pose.lon, dest.lat, dest.lon, nowMs, lookaheadMs);
		}
		let rawSeverity: AlertSeverity = 'clear';
		let etaSec: number | null = null;
		let distNM: number | null = null;
		let intervalFrom = nowMs;
		let intervalTo = nowMs + lookaheadMs;
		let gapForm = false;
		let gapSide: 'below' | 'above' | null = null;
		let gapClosing = false;
		if (insideNow) {
			if (vert.state === 'in') {
				rawSeverity = 'inside';
			} else {
				// The vertical gap grades by TRAJECTORY, the SkyDemon model:
				// riding level just under a shelf is normal ops and reads as
				// a quiet proximity; a climb or descent whose projection
				// closes the remaining gap within the imminent horizon is the
				// actual infringement path and escalates, with the chime.
				// Beyond the buffer (through the widened gate) only the
				// closing form exists: level flight 800 ft under a shelf
				// stays silent.
				const vs = pose.vsFpm;
				if (vs != null && vert.gapFt != null) {
					const closingFpm = vert.gapSide === 'below' ? vs : -vs;
					gapClosing =
						closingFpm > 0 && (vert.gapFt / closingFpm) * 60 <= params.imminentMin * 60;
				}
				if (vert.state === 'buffer') {
					rawSeverity = gapClosing ? 'imminent' : 'proximity';
					gapForm = true;
					gapSide = vert.gapSide;
				} else if (gapClosing) {
					rawSeverity = 'imminent';
					gapForm = true;
					gapSide = vert.gapSide;
				}
			}
		} else if (entry) {
			// The band is judged where the trajectory MEETS the volume, not
			// at the pose: the smoothed vertical speed carries the altitude
			// to the entry, credited over at most the imminent horizon so a
			// long descent is not extrapolated into fantasy. Strictly inside
			// there warns as before; only the buffer overlapping is the
			// quiet passing-clear note; clear of the band is silent (the
			// descent under a 2500 ft floor that used to alert).
			const entryEta = entry.tEntry * params.lookaheadMin * 60;
			let vertEntry = vert;
			if (altKnown) {
				const vs = pose.vsFpm;
				let projAltFt =
					(effMslFt as number) +
					(vs != null ? (vs * Math.min(entryEta, params.imminentMin * 60)) / 60 : 0);
				// A descent never projects underground: clamped at the
				// terrain under the pose, so a landing-rate descent at low
				// height cannot silence a surface-based volume ahead.
				if (input.groundKnown && input.groundFt != null) {
					projAltFt = Math.max(projAltFt, input.groundFt);
				}
				vertEntry = verticalState(
					p,
					projAltFt,
					params.verticalBufferFt,
					groundBandAtPoint(input.groundFt),
					input.groundKnown,
				);
			}
			if (vertEntry.state === 'in') {
				distNM = entry.tEntry * (segLenM / NM_TO_METERS);
				etaSec = entryEta;
				intervalFrom = nowMs + entry.tEntry * lookaheadMs;
				intervalTo = nowMs + entry.tExit * lookaheadMs;
				rawSeverity = etaSec <= params.imminentMin * 60 ? 'imminent' : 'approaching';
			} else if (vertEntry.state === 'buffer') {
				intervalFrom = nowMs + entry.tEntry * lookaheadMs;
				intervalTo = nowMs + entry.tExit * lookaheadMs;
				rawSeverity = 'proximity';
				gapForm = true;
				gapSide = vertEntry.gapSide;
			}
		} else if (vert.state !== 'out') {
			const latM = lateralDistanceM(p, pose.lat, pose.lon);
			if (latM <= params.proximityNM * NM_TO_METERS) {
				rawSeverity = 'proximity';
				distNM = latM / NM_TO_METERS;
			}
		}

		return {
			piece: p,
			vert,
			insideNow,
			entry,
			rawSeverity,
			etaSec,
			distNM,
			intervalFrom,
			intervalTo,
			gapForm,
			gapSide,
			gapClosing,
		};
	};

	for (const v of input.volumes) {
		// A volume its exclusion sectors cut alerts as its most severe piece
		// (alertVolumes.ts supaipVolumes), under its one key. The vertical
		// gate goes first: cheap float compares, and the pending state must
		// hold the verdict without starting a demotion.
		let geo: PieceGeometry | null = null;
		let pending = false;
		for (const piece of v.pieces ?? [v]) {
			const g = pieceGeometry(piece);
			if (g === 'pending') {
				pending = true;
				break;
			}
			if (g !== 'out' && (geo === null || SEVERITY_RANK[g.rawSeverity] > SEVERITY_RANK[geo.rawSeverity])) {
				geo = g;
			}
		}
		if (pending) {
			const held = prev.shown.get(v.key);
			if (held) {
				nextShown.set(v.key, held);
			}
			const heldSound = prev.sounded.get(v.key);
			if (heldSound) {
				nextSounded.set(v.key, heldSound);
			}
			continue;
		}
		if (geo === null) {
			continue;
		}
		const {
			piece,
			vert,
			insideNow,
			entry,
			rawSeverity,
			etaSec,
			distNM,
			intervalFrom,
			intervalTo,
			gapForm,
			gapSide,
			gapClosing,
		} = geo;

		// Hotness over the traversal interval, then the action. `briefed` is
		// what separates "the briefing says this zone is inactive" from "no
		// briefing covers it here and now": only the first earns silence.
		const activity = resolveActivity(
			{
				...v.activity,
				rtba: v.rtba,
				confirmed: input.notamWindows.get(v.id),
				// A briefing silent on a zone is silent for a reason only where
				// the app links its activation NOTAMs to it.
				briefed: (v.rtba ? input.briefed.rtba : input.briefed.notam) && volumeLinksActivations(v),
				briefedAtMs: input.briefed.at,
				amended: input.amendedWindows?.get(v.id)?.some((w) => w.startMs <= intervalTo && w.endMs >= intervalFrom),
				note: input.notes?.get(v.id),
			},
			intervalFrom,
			intervalTo,
		);
		const action = classifyVolume(v, activity.state, input.profile);
		if (action === 'avoid' && vert.state === 'in') {
			covers.push(piece);
		}
		const pref = tierPref(action);
		if (
			action === 'none' ||
			pref == null ||
			!input.tiers[pref] ||
			(!input.airborne && action !== 'avoid')
		) {
			continue;
		}
		if (rawSeverity === 'clear' && !prev.shown.has(v.key)) {
			continue;
		}

		// Demotion hold: promotion is instant, a lower severity must persist.
		const prevEntry = prev.shown.get(v.key);
		let shown = rawSeverity;
		let downSinceMs: number | null = null;
		if (prevEntry && SEVERITY_RANK[rawSeverity] < SEVERITY_RANK[prevEntry.severity]) {
			if (prevEntry.downSinceMs == null) {
				shown = prevEntry.severity;
				downSinceMs = nowMs;
			} else if (nowMs - prevEntry.downSinceMs < DEMOTE_HOLD_MS) {
				shown = prevEntry.severity;
				downSinceMs = prevEntry.downSinceMs;
			}
		}
		if (shown === 'clear') {
			continue;
		}
		nextShown.set(v.key, { severity: shown, downSinceMs });

		const planned = input.plannedKeys.has(v.key) && action === 'clearance';
		const shownRank = SEVERITY_RANK[shown];
		const ackRank = input.acks.get(v.key) ?? 0;
		const acked = ackRank >= shownRank;

		// Sound edges: threshold per action, escalation refires, ack and
		// planned suppress, and a cleared volume re-arms after the hold.
		const prevSound = prev.sounded.get(v.key) ?? { rank: 0, clearSinceMs: null };
		const th = soundThresholdRank(action);
		if (shownRank >= th) {
			if (shownRank > prevSound.rank && !acked && !planned) {
				fired.push({ key: v.key, action, severity: shown });
				nextSounded.set(v.key, { rank: shownRank, clearSinceMs: null });
			} else {
				nextSounded.set(v.key, {
					rank: Math.max(prevSound.rank, shownRank),
					clearSinceMs: null,
				});
			}
		}

		let ref: { lat: number; lon: number } | null = null;
		if (insideNow && vert.state === 'in') {
			ref = { lat: pose.lat, lon: pose.lon };
		} else if (entry && dest) {
			// Just INSIDE the boundary, not on it: a coextensive cover (the
			// CTR PARIS / LF-R 275 pair shares one ring) puts the exact entry
			// point on its own edge, where containment is a knife-edge. 1e-4
			// of the segment is metres, capped to stay within the inside run.
			const tRef = entry.tEntry + Math.min(1e-4, (entry.tExit - entry.tEntry) / 2);
			ref = {
				lat: pose.lat + (dest.lat - pose.lat) * tRef,
				lon: pose.lon + (dest.lon - pose.lon) * tRef,
			};
		}
		refs.push(ref);
		alerts.push({
			subject: 'volume',
			key: v.key,
			volume: v,
			action,
			severity: shown,
			etaSec,
			distNM,
			activityState: activity.state,
			window: activity.state === 'inactive' ? null : activity.period,
			coveredBy: null,
			verticalGap: gapForm,
			gapSide,
			gapClosing,
			planned,
			altUnknown: !altKnown,
			extentUnknown: v.extent !== 'known',
			acked,
		});
	}

	// The rest of the sound memory decays: a volume below its threshold
	// this tick, or one the caller's query left out (a zone the aircraft
	// turned away from), keeps its re-arm window running, so leaving and
	// re-entering within the hold stays silent.
	for (const [key, held] of prev.sounded) {
		if (nextSounded.has(key)) {
			continue;
		}
		const clearSince = held.clearSinceMs ?? nowMs;
		if (nowMs - clearSince < SOUND_REARM_MS) {
			nextSounded.set(key, { rank: held.rank, clearSinceMs: clearSince });
		}
	}

	// Cumulative conditions (docs/nav-alerts.md): a clearance / equipment
	// boundary whose reference point lies inside an active avoid-graded
	// volume states that volume's prohibition; the covering set was
	// collected ahead of the ack / tier gates, so the composed line holds
	// while the covering volume's own alert is acknowledged or its tier is
	// off. A covering volume qualifies by the action it displays this tick,
	// so its own row and the composed line agree.
	for (let i = 0; i < alerts.length; i++) {
		const a = alerts[i];
		const ref = refs[i];
		if (
			ref == null ||
			(a.action !== 'clearance' && a.action !== 'radio' && a.action !== 'transponder')
		) {
			continue;
		}
		const cover = covers.find((av) => av.key !== a.key && containsPoint(av, ref.lat, ref.lon, nowMs));
		if (cover) {
			a.coveredBy = cover.name;
		}
	}

	alerts.sort(compareAlerts);
	return {
		alerts,
		dominant: alerts[0] ?? null,
		prev: { shown: nextShown, sounded: nextSounded },
		fired,
	};
}
