/* The forward-looking terrain and obstacle alert (contract:
 * docs/terrain-awareness.md): the flight path is projected one minute ahead
 * along the smoothed track, and the ground and the obstacles under that
 * corridor are graded against a clearance. A violation within 60 s is a
 * CAUTION, within 30 s a WARNING (the 3.0 / 1.5 NM Avidyne documents for its
 * FLTA at 180 kt, the same minute and half minute).
 *
 * WHICH clearance follows the flight rules. Under IFR it is the one a
 * certified FLTA applies, TSO-C151c's required terrain clearance by phase of
 * flight, the table Garmin's Terrain Alerting prints (GPS 175 pilot's guide,
 * "Alerting Thresholds"):
 *
 *   phase       level flight   descending
 *   en route        700 ft        500 ft
 *   terminal        350 ft        300 ft
 *   approach        150 ft        100 ft
 *   departure       100 ft        100 ft
 *
 * Under VFR it is VFR_CLEARANCE_FT in every phase, the red of the terrain
 * layer (Garmin's and ForeFlight's "within 100 ft"): the alert fires where the
 * map already shows red on the path. The TSO table is an IFR design, and the
 * corpus measured it: on club flights under the Paris TMA, some 800 ft above
 * the Brie plateau, it put a caution or a red warning on two flights in five,
 * over a plateau edge or a pylon 600 ft below (docs/terrain-awareness.md
 * "Measured on the corpus").
 *
 * Position-referenced like the airspace evaluator (nav/airspaceAlert.ts) and
 * deliberately a separate fold: the question and its inputs differ, and
 * docs/nav-alerts.md keeps evaluators from absorbing each other. Pure and
 * deterministic: the pose, the corridor's ground, the obstacles, the nearest
 * aerodrome and the clock all arrive as data, so a replay scrub reconstructs
 * the same states. The prev state carries only presentation memory (the
 * demotion hold, the sound re-arm), the airspace engine's own idiom.
 *
 * TWO deliberate departures from a certified FLTA:
 *
 * THE RISE GATE: ground alerts only where it stands at least RISE_FT above
 * the ground under the aircraft (the corridor's highest, bin 0). Without it
 * every low leg over flat country sits under the clearance for its whole
 * length, and every final onto a strip the aerodrome data does not list (so
 * the runway inhibit cannot fire) projects into the ground; a caution that
 * fires on every low leg and every landing is a caution the pilot switches
 * off. A ridge, a plateau or a valley wall closing on the path rises, and
 * alerts. A descent toward flat ground is the pilot's own act, and the
 * premature-descent function (PDA) that would judge it is an instrument
 * approach function this app does not build. One thing overrides the gate:
 * ground ON THE TRACK (the strip TRACK_STRIP_M either side) standing above
 * the aircraft. Gated alone, a valley wall beside the aircraft raised the
 * ground "under" it, and a spur straight ahead above the aircraft went silent
 * (82 of 1 375 such paths at 300 ft AGL over the Mont Blanc tile). Comparing
 * the corridor lane by lane instead caught those and alerted on ordinary
 * steep descents over rolling country: 13 more flights of the 626-trace
 * corpus, every one of them descending at 600 to 3 000 fpm.
 *
 * THE AERODROME'S SURROUNDINGS: within AERODROME_ZONE_NM of the nearest
 * aerodrome's runway ends, ground and obstacles standing less than
 * AERODROME_SURROUND_FT above the aerodrome never alert. A circuit is flown
 * about 1 000 ft above the field, which clears them by construction, and the
 * VAC charts them; what the corpus showed there was circuit work (the
 * straight projection of a touch-and-go pointing at Lognes' water towers
 * 238 ft above the field, a descent on final through the tree line the
 * surface model carries at a runway end), never a threat. Garmin inhibits
 * its whole function below 200 ft within half a mile of the runway; this is
 * wider in reach and narrower in kind, since relief standing higher near a
 * field (a valley wall at Annemasse) still alerts.
 *
 * Obstacles carry no rise gate: they rise by definition.
 *
 * Advisory: the phrasing (components/alertText.ts) states facts, never a
 * manoeuvre, docs/nav-alerts.md's AMC 20-25A posture; there is no "PULL UP". */

import type { ObstacleType } from '$lib/data/obstacles';
import { M_PER_DEG, equirectangularDistanceM } from '$lib/notam/geometry';
import { NM_TO_METERS } from '$lib/notam/units';

export type FlightPhase = 'departure' | 'terminal' | 'approach' | 'enroute';
export type TerrainAlertKind = 'terrain' | 'obstacle';
/** A row's key in the shared alert stack, prefixed with its subject so it
 *  can never meet a volume key there (nav/alertSurface.ts). */
export type TerrainAlertKey = `terrain:${TerrainAlertKind}`;
export type TerrainAlertLevel = 'caution' | 'warning';

/** The look-ahead: a violation this close in time is a caution... */
export const CAUTION_S = 60;
/** ...and this close a warning. */
export const WARNING_S = 30;
/** Half-width of the searched corridor either side of the track: narrower
 *  than the TERPS primary area, as TSO-C151c 3.1 asks. */
export const FLTA_HALF_WIDTH_NM = 0.25;
/** Along-track resolution of the corridor's ground, metres. */
export const ALONG_BIN_M = 200;
/** The rise gate (see the header): the ground ahead must stand this far above
 *  the ground under the aircraft to alert. */
export const RISE_FT = 100;
/** A vertical speed at or below this is "descending" for the clearance table:
 *  outside the smoothed 1 Hz GPS altitude's own noise. */
export const DESCENT_FPM = -300;
/** Below this ground speed there is no trajectory to project. */
export const MIN_TRACK_KT = 5;
/** Garmin's automatic inhibit: below this height above the aerodrome... */
export const RUNWAY_INHIBIT_FT = 200;
/** ...within this distance of a runway end (or of the reference point where
 *  the data states no runway position). Garmin reads 0.5 NM off the approach
 *  end; one mile holds the whole short final of a light aircraft. */
export const RUNWAY_INHIBIT_NM = 1;
/** The aerodrome's surroundings (see the header): this far from the nearest
 *  aerodrome's runway ends... */
export const AERODROME_ZONE_NM = 2;
/** ...what stands less than this above the aerodrome never alerts. */
export const AERODROME_SURROUND_FT = 500;
/** The vertical speed is credited over at most this long: past it a steady
 *  climb or descent is not extrapolated into a trajectory nobody flies. */
export const VS_CREDIT_S = WARNING_S;
/** A demoting level holds this long before the shown state follows. The
 *  same span without an evaluation (a lost position, a forward scrub) ends
 *  every hold: what was shown then is not being held now. */
export const DEMOTE_HOLD_MS = 10_000;
/** A threat must stay below its sound threshold this long before it can
 *  sound again (the airspace engine's cry-wolf guard). An obstacle is one
 *  threat by its id, the ground by where its threatening stretch lies
 *  (GROUND_SAME_M). */
export const SOUND_REARM_MS = 300_000;

/** Two ground threats are one when their threatening stretches
 *  (TerrainAlert.alongM to toM, on the ground) come this close ALONG the
 *  track, and lie inside the corridor's half-width of it across. The same
 *  ground read from the next fix overlaps itself along, the ground staying
 *  where it is while the bins move with the aircraft, and swings across by
 *  the track's own jitter times its distance (100 m and more at the far end
 *  of the minute, for 2 degrees); the next ridge lies past at least one
 *  clear bin (ALONG_BIN_M). A ground threat has no id, and a constant one
 *  made every ridge the same threat: acknowledging one quieted the next,
 *  whether it arrived inside the demotion hold or after a gap; named by its
 *  crest instead, the name jumped whenever higher ground came into the
 *  look-ahead and the sound fired again each time (seven times in 38 s on
 *  one corpus flight). */
export const GROUND_SAME_M = 100;

/** Half-width of the strip about the track whose ground, standing above the
 *  aircraft, overrides the rise gate: a quarter of the corridor's. */
export const TRACK_STRIP_M = (FLTA_HALF_WIDTH_NM * NM_TO_METERS) / 4;

/** The threat an obstacle row is about. */
export function obstacleThreat(id: string): string {
	return `obstacle:${id}`;
}

/** The clearance a VFR flight is alerted at, every phase: the terrain
 *  layer's red (nav/terrainAwareness.ts), so an alert fires where the map
 *  already shows red on the path. */
export const VFR_CLEARANCE_FT = 100;

/** The required terrain clearance under IFR, feet, by phase: TSO-C151c
 *  table 3.1.1. */
export const RTC_FT: Readonly<Record<FlightPhase, { level: number; descending: number }>> = {
	enroute: { level: 700, descending: 500 },
	terminal: { level: 350, descending: 300 },
	approach: { level: 150, descending: 100 },
	departure: { level: 100, descending: 100 },
};

/** Ranks of the shown levels (0 = clear). */
export const LEVEL_RANK: Readonly<Record<TerrainAlertLevel, number>> = { caution: 1, warning: 2 };

export interface TerrainPose {
	lat: number;
	lon: number;
	/** Height above mean sea level (poseAltMslFt), null when the device gives
	 *  none. */
	mslFt: number | null;
	/** False on a degraded fix: an altitude that may be hundreds of feet out
	 *  grades nothing against terrain. */
	altTrusted: boolean;
	trackDeg: number | null;
	speedKt: number;
	vsFpm: number | null;
}

/** The nearest fixed-wing aerodrome, what the phase and the runway inhibit
 *  read. */
export interface TerrainField {
	distNM: number;
	/** Initial bearing from the aircraft to the field, degrees true. */
	bearingDeg: number;
	/** Aerodrome elevation, feet. */
	elevFt: number;
	/** The published runway ends, else the reference point. */
	ends: readonly { lat: number; lon: number }[];
}

/** The corridor's ground, bin 0 under the aircraft and bin i centred
 *  i * binM ahead, feet (the highest ground in each bin's footprint). A null
 *  bin holds no ground: the open sea when nothing is `missing`, unknown
 *  otherwise. */
export interface TerrainGround {
	binM: number;
	/** Per bin, the highest ground across the whole corridor. */
	maxFt: readonly (number | null)[];
	/** Per bin, the highest ground in the strip TRACK_STRIP_M either side of
	 *  the track, which overrides the rise gate where it stands above the
	 *  aircraft. Absent = no such reading (the gate alone decides). */
	trackFt?: readonly (number | null)[] | undefined;
	/** Corridor tiles not in hand (loading, or failed to load). */
	missing: number;
	/** Per bin: its centre lies within AERODROME_ZONE_NM of the nearest
	 *  aerodrome's runway ends (the field's reference point where none is
	 *  published). Null without an aerodrome. */
	nearField: readonly boolean[] | null;
}

/** An obstacle inside the corridor. */
export interface TerrainObstacle {
	id: string;
	name: string;
	type: ObstacleType;
	lat: number;
	lon: number;
	/** Along-track distance from the aircraft, metres. */
	alongM: number;
	/** Top elevation, feet MSL (the dataset's `elev`, never elev + hgt). */
	topFt: number;
	/** Within AERODROME_ZONE_NM of the nearest aerodrome's runway ends. */
	nearField: boolean;
}

export interface TerrainInput {
	nowMs: number;
	pose: TerrainPose;
	/** The flight rules in force (the route's): VFR is alerted at
	 *  VFR_CLEARANCE_FT, IFR at the TSO table. */
	vfr: boolean;
	/** Takeoff committed (the shared airborne watermark). */
	airborne: boolean;
	/** The departure phase is over (1 500 ft above the departure reached). */
	departureEnded: boolean;
	field: TerrainField | null;
	/** Null when no corridor could be read at all (no segment). */
	ground: TerrainGround | null;
	obstacles: readonly TerrainObstacle[];
	/** The acknowledged rank per THREAT (TerrainAlert.threat; the state
	 *  module's ledger), so one pylon's acknowledgement never silences the
	 *  next one. */
	acks: ReadonlyMap<string, number>;
	tiers: { terrain: boolean; obstacle: boolean };
	/** The pilot's manual inhibit (Garmin's TER INHB). */
	inhibited: boolean;
}

export interface TerrainAlert {
	subject: 'terrain';
	key: TerrainAlertKey;
	/** One row per kind, the most threatening. */
	kind: TerrainAlertKind;
	/** What the row is about: the ground by where its threatening stretch
	 *  lies (`terrain@<lat>,<lon>` of the stretch it was first seen as,
	 *  matched within GROUND_SAME_M), or obstacleThreat(id). The
	 *  acknowledgement and the sound memory are keyed on it. */
	threat: string;
	level: TerrainAlertLevel;
	/** Seconds to the threat along the projected path. */
	etaSec: number;
	/** Along-track metres to the near and the far end of the threatening
	 *  stretch, the edges of its bins (the map outlines [alongM, toM]); an
	 *  obstacle's position, both. */
	alongM: number;
	toM: number;
	/** The threat's top, feet MSL. */
	threatFt: number;
	/** Projected altitude minus the threat's top, feet: negative is below it. */
	clearanceFt: number;
	/** The clearance the alert was graded against. */
	rtcFt: number;
	/** The flight rules that clearance comes from: under VFR it is the
	 *  terrain layer's red, which the phrasing leaves unsaid. */
	rules: 'vfr' | 'ifr';
	phase: FlightPhase;
	obstacle: { id: string; name: string; type: ObstacleType; lat: number; lon: number } | null;
	acked: boolean;
	/** Kept by the demotion hold with no threat found this evaluation: the
	 *  figures above are the last threat's, measured from where the aircraft
	 *  was then, so the surfaces stop ticking them and the map keeps the patch
	 *  where that threat stood. */
	held: boolean;
}

export interface TerrainFire {
	kind: TerrainAlertKind;
	level: TerrainAlertLevel;
}

/** A point on the ground. */
interface GroundPoint {
	lat: number;
	lon: number;
}

/** A ground threat remembered by where its threatening stretch lay when
 *  last seen. */
interface GroundThreat {
	threat: string;
	from: GroundPoint;
	to: GroundPoint;
	seenMs: number;
}

/** Presentation memory between calls; reset on a backward playhead jump. */
export interface TerrainPrevState {
	/** The instant of the evaluation the memory is from, null for none. */
	atMs: number | null;
	shown: Map<TerrainAlertKind, { rank: number; downSinceMs: number | null; last: TerrainAlert }>;
	/** By threat (TerrainAlert.threat). */
	sounded: Map<string, { rank: number; clearSinceMs: number | null }>;
	/** The ground threats seen in the last SOUND_REARM_MS, by stretch. */
	grounds: GroundThreat[];
}

export function emptyTerrainPrev(): TerrainPrevState {
	return { atMs: null, shown: new Map(), sounded: new Map(), grounds: [] };
}

/** The memory as it stands at `nowMs`: after longer than a hold without an
 *  evaluation, nothing shown then is held now, and a sound still ringing
 *  then has been quiet since then (so a threat back after the re-arm period
 *  sounds again). */
function freshen(prev: TerrainPrevState, nowMs: number): TerrainPrevState {
	if (prev.atMs == null || nowMs - prev.atMs <= DEMOTE_HOLD_MS) {
		return prev;
	}
	const at = prev.atMs;
	const sounded: TerrainPrevState['sounded'] = new Map();
	for (const [threat, s] of prev.sounded) {
		sounded.set(threat, { rank: s.rank, clearSinceMs: s.clearSinceMs ?? at });
	}
	return { atMs: at, shown: new Map(), sounded, grounds: prev.grounds };
}

/** The ground threat whose threatening stretch lies `alongM` to `toM` ahead
 *  of the pose on its track: a remembered one whose stretch, seen in the
 *  pose's own track frame, comes within GROUND_SAME_M along and lies inside
 *  the corridor's half-width across, else a new one. The memory keeps what
 *  was seen in the last SOUND_REARM_MS, the span a sound is remembered for,
 *  each threat where it was last seen. */
function groundThreatAt(
	grounds: readonly GroundThreat[],
	pose: TerrainPose,
	trackDeg: number,
	alongM: number,
	toM: number,
	nowMs: number,
): { threat: string; grounds: GroundThreat[] } {
	const live = grounds.filter((g) => nowMs - g.seenMs < SOUND_REARM_MS);
	const acrossM = FLTA_HALF_WIDTH_NM * NM_TO_METERS;
	let best: GroundThreat | null = null;
	let bestGap = Infinity;
	for (const g of live) {
		const a = trackFrame(pose, trackDeg, g.from);
		const b = trackFrame(pose, trackDeg, g.to);
		const gap = Math.max(0, Math.min(a.along, b.along) - toM, alongM - Math.max(a.along, b.along));
		if (gap <= GROUND_SAME_M && Math.max(Math.abs(a.across), Math.abs(b.across)) <= acrossM && gap < bestGap) {
			best = g;
			bestGap = gap;
		}
	}
	const from = pointAhead(pose, trackDeg, alongM);
	const to = pointAhead(pose, trackDeg, toM);
	const threat = best?.threat ?? `terrain@${from.lat.toFixed(5)},${from.lon.toFixed(5)}`;
	const rest = live.filter((g) => g !== best);
	return { threat, grounds: [...rest, { threat, from, to, seenMs: nowMs }].slice(-32) };
}

/** A point on the ground in the pose's track frame, metres: along the track
 *  and across it (left positive). Flat earth about the pose, the stretches
 *  lying within a minute of flight. */
function trackFrame(pose: TerrainPose, trackDeg: number, p: GroundPoint): { along: number; across: number } {
	const t = (trackDeg * Math.PI) / 180;
	const cosLat = Math.cos((pose.lat * Math.PI) / 180) || 1e-6;
	const east = (((((p.lon - pose.lon + 180) % 360) + 360) % 360) - 180) * cosLat * M_PER_DEG;
	const north = (p.lat - pose.lat) * M_PER_DEG;
	return { along: east * Math.sin(t) + north * Math.cos(t), across: -east * Math.cos(t) + north * Math.sin(t) };
}

/** Why nothing was graded this tick; null when the corridor was graded. */
export type TerrainIdle = 'ground' | 'noAltitude' | 'noTrack' | 'inhibited' | 'runway';

export interface TerrainEvalResult {
	/** Shown rows, the more severe first (a warning, then the sooner). */
	alerts: TerrainAlert[];
	prev: TerrainPrevState;
	/** Sound edges this call (acknowledgement filtered). */
	fired: TerrainFire[];
	phase: FlightPhase | null;
	idle: TerrainIdle | null;
	/** Part of the corridor could not be read and no ground threat was found
	 *  in the rest: the surface says so rather than stay silent, whatever an
	 *  obstacle row says. */
	unread: boolean;
}

/** The phase of flight, stateless (TSO-C151c 10.x), so a replay scrub
 *  answers the same at the same instant: departure from takeoff until
 *  1 500 ft above the departure; approach within 5 NM of the nearest
 *  aerodrome, at or below 1 900 ft above it and closing; terminal within
 *  15 NM, closing and at or below the line from 3 500 ft at 15 NM to
 *  1 900 ft at 5 NM; en route otherwise. "Closing" is read off the track
 *  against the bearing to the field, which needs no memory. */
export function flightPhase(i: {
	airborne: boolean;
	departureEnded: boolean;
	mslFt: number;
	trackDeg: number | null;
	field: TerrainField | null;
}): FlightPhase {
	if (i.airborne && !i.departureEnded) {
		return 'departure';
	}
	const f = i.field;
	if (!f) {
		return 'enroute';
	}
	const above = i.mslFt - f.elevFt;
	const closing =
		i.trackDeg != null && Math.cos(((f.bearingDeg - i.trackDeg) * Math.PI) / 180) > 0;
	if (!closing) {
		return 'enroute';
	}
	if (f.distNM <= 5 && above <= 1900) {
		return 'approach';
	}
	if (f.distNM <= 15 && above <= 1900 + ((3500 - 1900) * Math.max(0, f.distNM - 5)) / 10) {
		return 'terminal';
	}
	return 'enroute';
}

/** The clearance alerted at: VFR_CLEARANCE_FT under VFR, else the phase's
 *  TSO figure for the pose's vertical speed. */
export function requiredClearanceFt(phase: FlightPhase, vsFpm: number | null, vfr: boolean): number {
	if (vfr) {
		return VFR_CLEARANCE_FT;
	}
	const r = RTC_FT[phase];
	return vsFpm != null && vsFpm <= DESCENT_FPM ? r.descending : r.level;
}

/** The runway inhibit: close to the ground at a known aerodrome, where every
 *  landing would otherwise project into the runway. */
export function runwayInhibited(pose: { lat: number; lon: number; mslFt: number }, field: TerrainField | null): boolean {
	if (!field || pose.mslFt - field.elevFt >= RUNWAY_INHIBIT_FT) {
		return false;
	}
	const reach = RUNWAY_INHIBIT_NM * NM_TO_METERS;
	return field.ends.some((e) => equirectangularDistanceM(pose.lat, pose.lon, e.lat, e.lon) <= reach);
}

/** The projected altitude `t` seconds ahead: the vertical speed credited both
 *  ways, over at most VS_CREDIT_S. Never clamped at the ground: a path that
 *  meets the ground IS the imminent-impact case. */
function projectedAltFt(mslFt: number, vsFpm: number | null, t: number): number {
	return mslFt + (vsFpm != null ? (vsFpm * Math.min(t, VS_CREDIT_S)) / 60 : 0);
}

/** One graded threat before the presentation memory. A ground threat is
 *  named in evaluateTerrain by where its stretch lies (alongM to toM). */
interface Raw {
	level: TerrainAlertLevel;
	alert: Omit<TerrainAlert, 'level' | 'acked' | 'held'>;
}

/** The point `alongM` ahead on the track, flat earth about the pose (a
 *  minute of flight). */
function pointAhead(pose: TerrainPose, trackDeg: number, alongM: number): GroundPoint {
	const t = (trackDeg * Math.PI) / 180;
	const cosLat = Math.cos((pose.lat * Math.PI) / 180) || 1e-6;
	return {
		lat: pose.lat + (alongM * Math.cos(t)) / M_PER_DEG,
		lon: pose.lon + (alongM * Math.sin(t)) / (M_PER_DEG * cosLat),
	};
}

function gradeTerrain(
	input: TerrainInput,
	mslFt: number,
	speedMps: number,
	phase: FlightPhase,
	rtc: number,
): { raw: Raw | null; unread: boolean } {
	const g = input.ground;
	if (!g || g.maxFt.length < 2) {
		return { raw: null, unread: g == null || g.missing > 0 };
	}
	const known = g.missing === 0;
	// A bin holding no ground is the sea when every tile was read; unknown
	// otherwise, and an unknown bin grades nothing (never "clear" either).
	const at = (i: number): number | null => g.maxFt[i] ?? (known ? 0 : null);
	const here = at(0);
	let first = -1;
	let last = -1;
	let worst: { t: number; ground: number; clearance: number } | null = null;
	let unknownAhead = false;
	for (let i = 1; i < g.maxFt.length; i++) {
		const t = (i * g.binM) / speedMps;
		if (t > CAUTION_S) {
			break;
		}
		const ground = at(i);
		// Ground on the track above the aircraft overrides the rise gate,
		// graded on its own height: the valley wall beside the track that
		// the gate keeps quiet stays out of it.
		const track = g.trackFt?.[i] ?? null;
		let graded: number;
		if (ground != null && here != null && ground >= here + RISE_FT) {
			graded = ground;
		} else if (track != null && track > mslFt) {
			graded = track;
		} else if (ground == null || here == null) {
			unknownAhead = true;
			continue;
		} else {
			if (first >= 0) {
				break; // the end of the first threatening stretch
			}
			continue;
		}
		if (g.nearField?.[i] === true && surrounds(input.field, graded)) {
			if (first >= 0) {
				break;
			}
			continue;
		}
		const clearance = projectedAltFt(mslFt, input.pose.vsFpm, t) - graded;
		if (clearance >= rtc) {
			if (first >= 0) {
				break;
			}
			continue;
		}
		if (first < 0) {
			first = i;
			worst = { t, ground: graded, clearance };
		} else if (worst && clearance < worst.clearance) {
			worst = { t: worst.t, ground: graded, clearance };
		}
		last = i;
	}
	if (first < 0 || !worst) {
		return { raw: null, unread: unknownAhead || g.missing > 0 };
	}
	const tFirst = (first * g.binM) / speedMps;
	const alongM = Math.max(0, (first - 0.5) * g.binM);
	const toM = (last + 0.5) * g.binM;
	return {
		raw: {
			level: tFirst <= WARNING_S ? 'warning' : 'caution',
			alert: {
				subject: 'terrain',
				key: 'terrain:terrain',
				kind: 'terrain',
				// Named by its stretch in evaluateTerrain (groundThreatAt).
				threat: '',
				etaSec: tFirst,
				alongM,
				toM,
				threatFt: worst.ground,
				clearanceFt: worst.clearance,
				rtcFt: rtc,
				rules: input.vfr ? 'vfr' : 'ifr',
				phase,
				obstacle: null,
			},
		},
		unread: false,
	};
}

/** Does `topFt`, standing inside the aerodrome's zone, belong to its
 *  surroundings? */
function surrounds(field: TerrainField | null, topFt: number): boolean {
	return field != null && topFt < field.elevFt + AERODROME_SURROUND_FT;
}

function gradeObstacles(
	input: TerrainInput,
	mslFt: number,
	speedMps: number,
	phase: FlightPhase,
	rtc: number,
): Raw | null {
	let best: { t: number; o: TerrainObstacle; clearance: number } | null = null;
	for (const o of input.obstacles) {
		if (o.alongM < 0 || (o.nearField && surrounds(input.field, o.topFt))) {
			continue;
		}
		const t = o.alongM / speedMps;
		if (t > CAUTION_S) {
			continue;
		}
		const clearance = projectedAltFt(mslFt, input.pose.vsFpm, t) - o.topFt;
		if (clearance >= rtc) {
			continue;
		}
		// The sooner threat leads; at a tie in time, the lower clearance.
		if (!best || t < best.t - 1e-9 || (Math.abs(t - best.t) <= 1e-9 && clearance < best.clearance)) {
			best = { t, o, clearance };
		}
	}
	if (!best) {
		return null;
	}
	const { t, o, clearance } = best;
	return {
		level: t <= WARNING_S ? 'warning' : 'caution',
		alert: {
			subject: 'terrain',
			key: 'terrain:obstacle',
			kind: 'obstacle',
			threat: obstacleThreat(o.id),
			etaSec: t,
			alongM: o.alongM,
			toM: o.alongM,
			threatFt: o.topFt,
			clearanceFt: clearance,
			rtcFt: rtc,
			rules: input.vfr ? 'vfr' : 'ifr',
			phase,
			obstacle: { id: o.id, name: o.name, type: o.type, lat: o.lat, lon: o.lon },
		},
	};
}

/** Grade the corridor, then the presentation memory: the demotion hold
 *  (promotion instant, a lower level held DEMOTE_HOLD_MS), acknowledgement
 *  by rank (an escalation re-alerts), and the sound edges with their re-arm.
 *  The airspace engine's rules, on two rows, each remembered by its THREAT:
 *  a row whose threat changed shows the new one at its own level, and is
 *  acknowledged and sounded afresh. */
export function evaluateTerrain(input: TerrainInput, prevIn: TerrainPrevState): TerrainEvalResult {
	const { pose, nowMs } = input;
	const prev = freshen(prevIn, nowMs);
	const nextShown: TerrainPrevState['shown'] = new Map();
	const nextSounded: TerrainPrevState['sounded'] = new Map();
	const fired: TerrainFire[] = [];
	const shownThreats = new Set<string>();

	// A threat not shown this evaluation keeps its sound memory for the
	// re-arm period (see SOUND_REARM_MS).
	const decaySounds = (): void => {
		for (const [threat, held] of prev.sounded) {
			if (shownThreats.has(threat)) {
				continue;
			}
			const clearSince = held.clearSinceMs ?? nowMs;
			if (nowMs - clearSince < SOUND_REARM_MS) {
				nextSounded.set(threat, { rank: held.rank, clearSinceMs: clearSince });
			}
		}
	};
	const idleResult = (idle: TerrainIdle, phase: FlightPhase | null): TerrainEvalResult => {
		decaySounds();
		return {
			alerts: [],
			prev: { atMs: nowMs, shown: nextShown, sounded: nextSounded, grounds: prev.grounds },
			fired,
			phase,
			idle,
			unread: false,
		};
	};

	if (!input.airborne) {
		return idleResult('ground', null);
	}
	if (pose.mslFt == null || !pose.altTrusted) {
		return idleResult('noAltitude', null);
	}
	const mslFt = pose.mslFt;
	const phase = flightPhase({
		airborne: input.airborne,
		departureEnded: input.departureEnded,
		mslFt,
		trackDeg: pose.trackDeg,
		field: input.field,
	});
	if (input.inhibited) {
		return idleResult('inhibited', phase);
	}
	if (runwayInhibited({ lat: pose.lat, lon: pose.lon, mslFt }, input.field)) {
		return idleResult('runway', phase);
	}
	if (pose.trackDeg == null || pose.speedKt < MIN_TRACK_KT) {
		return idleResult('noTrack', phase);
	}
	const speedMps = (pose.speedKt * NM_TO_METERS) / 3600;
	const rtc = requiredClearanceFt(phase, pose.vsFpm, input.vfr);

	const terrain = input.tiers.terrain ? gradeTerrain(input, mslFt, speedMps, phase, rtc) : { raw: null, unread: false };
	let grounds = prev.grounds;
	if (terrain.raw) {
		const a = terrain.raw.alert;
		const named = groundThreatAt(grounds, pose, pose.trackDeg ?? 0, a.alongM, a.toM, nowMs);
		terrain.raw.alert.threat = named.threat;
		grounds = named.grounds;
	}
	const raws: Record<TerrainAlertKind, Raw | null> = {
		terrain: terrain.raw,
		obstacle: input.tiers.obstacle ? gradeObstacles(input, mslFt, speedMps, phase, rtc) : null,
	};

	const alerts: TerrainAlert[] = [];
	for (const kind of ['terrain', 'obstacle'] as const) {
		const tierOn = input.tiers[kind];
		const raw = raws[kind];
		const prevEntry = prev.shown.get(kind);
		if (!tierOn || (!raw && !prevEntry)) {
			continue;
		}
		const rawRank = raw ? LEVEL_RANK[raw.level] : 0;
		let rank = rawRank;
		let downSinceMs: number | null = null;
		// The hold keeps a row from flickering off ITS threat; a different
		// threat is shown at its own level from the start.
		const sameThreat = prevEntry != null && (raw == null || raw.alert.threat === prevEntry.last.threat);
		if (prevEntry && sameThreat && rawRank < prevEntry.rank) {
			if (prevEntry.downSinceMs == null) {
				rank = prevEntry.rank;
				downSinceMs = nowMs;
			} else if (nowMs - prevEntry.downSinceMs < DEMOTE_HOLD_MS) {
				rank = prevEntry.rank;
				downSinceMs = prevEntry.downSinceMs;
			}
		}
		if (rank === 0) {
			continue;
		}
		const level: TerrainAlertLevel = rank >= LEVEL_RANK.warning ? 'warning' : 'caution';
		// A held row keeps the last threat it named: the corridor has let go
		// of it, but the banner does not flicker off for the hold.
		const detail = raw ? raw.alert : prevEntry!.last;
		const acked = (input.acks.get(detail.threat) ?? 0) >= rank;
		const alert: TerrainAlert = { ...detail, level, acked, held: raw == null };
		nextShown.set(kind, { rank, downSinceMs, last: alert });
		shownThreats.add(detail.threat);

		// A threat gone quiet for the re-arm period sounds again when it
		// comes back, whether or not a clear evaluation ran in between.
		const heldSound = prev.sounded.get(detail.threat);
		const prevSound =
			heldSound && (heldSound.clearSinceMs == null || nowMs - heldSound.clearSinceMs < SOUND_REARM_MS)
				? heldSound
				: { rank: 0, clearSinceMs: null };
		if (rank > prevSound.rank && !acked) {
			fired.push({ kind, level });
			nextSounded.set(detail.threat, { rank, clearSinceMs: null });
		} else {
			nextSounded.set(detail.threat, { rank: Math.max(prevSound.rank, rank), clearSinceMs: null });
		}
		alerts.push(alert);
	}
	decaySounds();
	alerts.sort((a, b) => {
		if (a.acked !== b.acked) {
			return a.acked ? 1 : -1;
		}
		return LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || a.etaSec - b.etaSec;
	});
	return {
		alerts,
		prev: { atMs: nowMs, shown: nextShown, sounded: nextSounded, grounds },
		fired,
		phase,
		idle: null,
		unread: !alerts.some((a) => a.kind === 'terrain') && terrain.unread,
	};
}
