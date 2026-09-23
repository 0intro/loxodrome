/* Live terrain and obstacle alerts around the pure fold (nav/terrainAlert.ts;
 * contract docs/terrain-awareness.md): the corridor's ground read from the
 * decoded terrain tiles, the obstacles inside it, the nearest aerodrome, the
 * pose, and the session presentation state (preferences, the pilot's inhibit,
 * acknowledgements, the fold's prev memory, the sound-edge queue).
 *
 * Built like state/airspaceAlert.svelte.ts and gated the same way: off with
 * the alerts' own master switch, nothing without a pose, nothing on a LOST
 * position (a frozen pose must not alert); the clock is the playhead, so a
 * replay scrub reconstructs the historical states, a live recording widening
 * it with the 1 Hz wall clock; the session memory belongs to one trace array.
 * The selector is memoised on an input signature read BEFORE the cache check,
 * so callers track it like a derived while the fold's prev advances once per
 * evaluation instant however many surfaces read it.
 *
 * The corridor's ground is read SYNCHRONOUSLY (peekCapsuleGround): the tiles
 * already decoded, the preferred level first and a coarser one when the fine
 * tiles are not in hand (a pooled maximum is exact and conservative). The
 * tiles still missing are warmed by ONE fetch batch at a time, and their
 * arrival re-keys the signature through `tileRev`, since the tile cache is a
 * plain Map nothing reactive watches. The write happens in the batch's
 * settle, never inside a caller's derived. */

import RBush from 'rbush';
import {
	AERODROME_ZONE_NM,
	ALONG_BIN_M,
	CAUTION_S,
	FLTA_HALF_WIDTH_NM,
	LEVEL_RANK,
	TRACK_STRIP_M,
	emptyTerrainPrev,
	evaluateTerrain,
	type TerrainAlertKind,
	type TerrainEvalResult,
	type TerrainField,
	type TerrainFire,
	type TerrainGround,
	type TerrainObstacle,
	type TerrainPrevState,
} from '$lib/nav/terrainAlert';
import {
	capsuleFrame,
	capsuleTrackMaxFt,
	capsulePoint,
	capsuleQuad,
	peekCapsuleGround,
	terrainTileDue,
	visitTiles,
	type CapsuleFrame,
	type TileCoord,
} from '$lib/map/terrain';
import type { TerrainThreat } from '$lib/map/terrainThreatLayer';
import { smoothedMotionAt, type TrackPoint } from '$lib/nav/trace';
import { nearestAerodromes, nearestCandidatesFor } from '$lib/nav/nearest';
import { M_PER_DEG, destinationPoint, equirectangularDistanceM, initialBearingDeg } from '$lib/notam/geometry';
import { NM_TO_METERS } from '$lib/notam/units';
import type { Obstacle } from '$lib/data/obstacles';
import type { Airport } from '$lib/data/airports';
import { readItem, removeItem, writeItem } from './persist';
import { currentPose, nav, poseAltMslFt, positionQuality } from './navRecording.svelte';
import { alertPrefs } from './airspaceAlert.svelte';
import { departureWatermark, firstAirborneMs } from './airborne';
import { dataState, getAirports, getObstacles } from './data.svelte';
import { routeSettings } from './route.svelte';

// ---- preferences (stored only away from the default) ----

const TERRAIN_OFF_KEY = 'loxodrome:nav-alert-terrain-off';
const OBSTACLE_OFF_KEY = 'loxodrome:nav-alert-obstacle-off';

/** The two rows' switches, both on by default. The master switch is the
 *  alerts' own (alertPrefs.enabled): one channel, one suspension. */
export const terrainPrefs = $state<{ terrain: boolean; obstacle: boolean }>({
	terrain: readItem(TERRAIN_OFF_KEY) !== '1',
	obstacle: readItem(OBSTACLE_OFF_KEY) !== '1',
});

export function setTerrainTier(kind: TerrainAlertKind, on: boolean): void {
	terrainPrefs[kind] = on;
	const key = kind === 'terrain' ? TERRAIN_OFF_KEY : OBSTACLE_OFF_KEY;
	if (on) {
		removeItem(key);
	} else {
		writeItem(key, '1');
	}
}

// ---- the pilot's inhibit (Garmin's TER INHB) ----

/* Scoped to the trace ARRAY it was set on: every fresh session replaces the
 * array (a new recording, an import, a restored outing, the boot adopt), so
 * the inhibit clears the way Garmin's clears at a power cycle, and a
 * Continue, which appends in place, keeps it. No hook anywhere. */
const inhibit = $state<{ points: readonly TrackPoint[] | null }>({ points: null });

export function terrainInhibited(): boolean {
	return inhibit.points != null && inhibit.points === nav.points;
}

export function setTerrainInhibit(on: boolean): void {
	inhibit.points = on ? nav.points : null;
}

// ---- the nearest aerodrome (the phase and the runway inhibit) ----

/** Re-scan once the aircraft moved this far (the scan walks 31 k fields). */
const FIELD_RESCAN_M = 0.2 * NM_TO_METERS;
/** Past this the nearest field shapes nothing: the phases reach 15 NM. */
const FIELD_RADIUS_NM = 15;

let fieldMemo: {
	airports: readonly Airport[];
	lat: number;
	lon: number;
	airport: Airport | null;
} | null = null;

/* The fields that can shape anything: a field with no stated elevation cannot
 * say how high the aircraft is above it, so it shapes neither the phase nor
 * the inhibit, and it must not hide the one beside it that can (1 200
 * candidates carry none, French strips among them). Memoised on the
 * dataset's array, the nearest module's own idiom. */
let elevatedMemo: { airports: readonly Airport[]; candidates: Airport[] } | null = null;

function elevatedCandidates(airports: readonly Airport[]): Airport[] {
	if (elevatedMemo?.airports !== airports) {
		elevatedMemo = {
			airports,
			candidates: nearestCandidatesFor(airports).filter((a) => a.elevFt != null),
		};
	}
	return elevatedMemo.candidates;
}

function nearestField(airports: readonly Airport[] | null, lat: number, lon: number): TerrainField | null {
	if (!airports) {
		return null;
	}
	if (
		!fieldMemo ||
		fieldMemo.airports !== airports ||
		equirectangularDistanceM(lat, lon, fieldMemo.lat, fieldMemo.lon) > FIELD_RESCAN_M
	) {
		const [near] = nearestAerodromes(elevatedCandidates(airports), lat, lon, {
			limit: 1,
			radiusNM: FIELD_RADIUS_NM,
		});
		fieldMemo = { airports, lat, lon, airport: near?.airport ?? null };
	}
	const a = fieldMemo.airport;
	if (!a || a.elevFt == null) {
		return null;
	}
	const ends: { lat: number; lon: number }[] = [];
	for (const r of a.runways) {
		for (const p of [r.lePos, r.hePos]) {
			if (p) {
				ends.push({ lat: p[0], lon: p[1] });
			}
		}
	}
	if (ends.length === 0) {
		ends.push({ lat: a.lat, lon: a.lon });
	}
	return {
		distNM: equirectangularDistanceM(lat, lon, a.lat, a.lon) / NM_TO_METERS,
		bearingDeg: initialBearingDeg(lat, lon, a.lat, a.lon),
		elevFt: a.elevFt,
		ends,
	};
}

// ---- the obstacles in the corridor ----

interface ObstacleItem {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
	o: Obstacle;
}

let obstacleIndex: { obstacles: readonly Obstacle[]; tree: RBush<ObstacleItem> } | null = null;

/** The dataset's own index, keyed on its array (replaced whole when a
 *  country lands). The map's obstacle index is the display layer's and only
 *  exists while a group is on; a safety evaluation reads the dataset. */
function obstacleTree(obstacles: readonly Obstacle[]): RBush<ObstacleItem> {
	if (obstacleIndex?.obstacles !== obstacles) {
		const tree = new RBush<ObstacleItem>();
		tree.load(
			obstacles
				.filter((o) => o.elev != null)
				.map((o) => ({ minX: o.lon, minY: o.lat, maxX: o.lon, maxY: o.lat, o })),
		);
		obstacleIndex = { obstacles, tree };
	}
	return obstacleIndex.tree;
}

function corridorObstacles(
	obstacles: readonly Obstacle[] | null,
	f: CapsuleFrame,
	field: TerrainField | null,
): TerrainObstacle[] {
	if (!obstacles) {
		return [];
	}
	const hw = f.halfWidthM;
	const endM = f.legM + hw;
	// The capsule's bounding box, in degrees, unwrapped (capsulePoint does not
	// wrap): past the antimeridian it is searched again a turn round, or an
	// obstacle just across it was never in the corridor.
	const pts = capsuleQuad(f, -hw, endM);
	const lats = pts.map((p) => p[0]);
	const lons = pts.map((p) => p[1]);
	const box = { minX: Math.min(...lons), minY: Math.min(...lats), maxX: Math.max(...lons), maxY: Math.max(...lats) };
	const boxes = [box];
	if (box.maxX > 180) {
		boxes.push({ ...box, minX: box.minX - 360, maxX: box.maxX - 360 });
	}
	if (box.minX < -180) {
		boxes.push({ ...box, minX: box.minX + 360, maxX: box.maxX + 360 });
	}
	const out: TerrainObstacle[] = [];
	for (const { o } of boxes.flatMap((b) => obstacleTree(obstacles).search(b))) {
		const dLon = ((((o.lon - f.aLon + 180) % 360) + 360) % 360) - 180;
		const wx = dLon * f.cosLat * M_PER_DEG;
		const wy = (o.lat - f.aLat) * M_PER_DEG;
		const along = wx * f.ux + wy * f.uy;
		const cross = -wx * f.uy + wy * f.ux;
		if (along < 0 || along > f.legM || Math.abs(cross) > hw || o.elev == null) {
			continue;
		}
		out.push({
			id: o.id,
			name: o.name,
			type: o.type,
			lat: o.lat,
			lon: o.lon,
			alongM: along,
			topFt: o.elev,
			nearField: inFieldZone(field, o.lat, o.lon),
		});
	}
	return out;
}

/** Is (lat, lon) inside the aerodrome's zone: within AERODROME_ZONE_NM of
 *  one of its runway ends (the fold leaves the aerodrome's surroundings out
 *  of the threats there). */
function inFieldZone(field: TerrainField | null, lat: number, lon: number): boolean {
	const reach = AERODROME_ZONE_NM * NM_TO_METERS;
	return field != null && field.ends.some((e) => equirectangularDistanceM(lat, lon, e.lat, e.lon) <= reach);
}

/** Which corridor bins lie in the aerodrome's zone, by their centres. */
function fieldBins(f: CapsuleFrame, alongBins: number, field: TerrainField): boolean[] {
	const out: boolean[] = [];
	for (let i = 0; i <= alongBins; i++) {
		const [lat, lon] = capsulePoint(f, i * f.alongBinM);
		out.push(inFieldZone(field, lat, lon));
	}
	return out;
}

// ---- the corridor's tiles: one warm in flight ----

/** Bumped when a warm batch settles, so the memo re-reads the tiles. */
const tileRev = $state({ n: 0 });
let warmInFlight = false;

function warmCorridor(levels: readonly (readonly TileCoord[])[]): void {
	if (warmInFlight) {
		return;
	}
	// A tile that failed a moment ago is not asked again until the cache's
	// retry delay is over, or a batch of instant misses would re-key the
	// memo and start the next batch forever. The finest level with tiles due
	// is asked for: when the finest level's tiles keep failing (offline, a
	// 5xx), the coarser one the read would fall back to is asked instead,
	// where it once stayed unasked and the corridor unread for good.
	let due: TileCoord[] = [];
	for (const missing of levels) {
		due = missing.filter((t) => terrainTileDue(t.z, t.x, t.y));
		if (due.length > 0) {
			break;
		}
	}
	if (due.length === 0) {
		return;
	}
	warmInFlight = true;
	void visitTiles(due, () => {}).finally(() => {
		warmInFlight = false;
		tileRev.n++;
	});
}

// ---- acknowledgements ----

/** An acknowledgement expires this long after its row stopped alerting
 *  (nav/terrainAlert.ts SOUND_REARM_MS). */
const ACK_TTL_MS = 300_000;

/* By THREAT (TerrainAlert.threat), never by kind: acknowledging one pylon
 * must not silence the next, nor one ridge every ridge after it. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- session ledger; reactivity rides ackRev
const acks = new Map<string, { rank: number; lastShownMs: number }>();
let ackRev = $state(0);

/** Acknowledge a row at its current level: it leaves the banner, its sound
 *  stays quiet, and a caution escalating to a warning alerts again. The
 *  acknowledgement is of the threat the row names now. */
export function acknowledgeTerrainAlert(kind: TerrainAlertKind): void {
	const cur = lastResult?.alerts.find((a) => a.kind === kind);
	if (!cur) {
		return;
	}
	acks.set(cur.threat, { rank: LEVEL_RANK[cur.level], lastShownMs: lastEvalMs });
	ackRev++;
}

// ---- sound edges ----

const FIRED_QUEUE_MAX = 8;
let firedQueue: TerrainFire[] = [];

/** Take every queued sound edge (empties the queue). Filled only while a
 *  recording runs: a replay debrief stays visual, and a queue carried
 *  across a stopped recording must not chime into the next one. */
export function drainTerrainFires(): TerrainFire[] {
	const out = firedQueue;
	if (out.length > 0) {
		firedQueue = [];
	}
	return out;
}

// ---- the memoised selector ----

const NO_THREATS: readonly TerrainThreat[] = [];

let evalSig: unknown[] | null = null;
let lastResult: TerrainEvalResult | null = null;
/** What the map outlines (map/terrainThreatLayer.ts). */
let lastThreats: readonly TerrainThreat[] = NO_THREATS;
/** The terrain row's stretch, placed on the map when the threat was last
 *  found: a row the demotion hold keeps is drawn where its threat stood,
 *  not re-measured from where the aircraft is now. */
let terrainQuad: [number, number][] | null = null;
let prevState: TerrainPrevState = emptyTerrainPrev();
let lastEvalMs = 0;
let sessionPoints: readonly TrackPoint[] | null = null;

function sameSig(a: unknown[], b: unknown[]): boolean {
	return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** The live terrain alert state for the pose, or null while the alerts are
 *  off, no pose exists, or the position is lost. Reads every reactive input
 *  before its cache check, so calling it inside a $derived / $effect tracks
 *  like a derived. */
export function terrainAlerts(): TerrainEvalResult | null {
	if (!alertPrefs.enabled) {
		return null;
	}
	const pose = currentPose();
	if (!pose) {
		return null;
	}
	const quality = positionQuality();
	if (quality === 'lost') {
		return null;
	}
	const ack = ackRev;
	const points = nav.points;
	if (sessionPoints !== points) {
		sessionPoints = points;
		acks.clear();
		prevState = emptyTerrainPrev();
		firedQueue = [];
		evalSig = null;
		lastResult = null;
		lastThreats = NO_THREATS;
		terrainQuad = null;
		lastEvalMs = 0;
	}
	const playhead = nav.playheadMs;
	const evalNow = nav.recording ? Math.max(playhead, nav.nowMs) : playhead;
	const mslFt = poseAltMslFt(pose);
	const obstacles = terrainPrefs.obstacle ? getObstacles() : null;
	const airports = getAirports();
	const inhibited = terrainInhibited();
	const vfr = routeSettings.vfr;
	const rev = tileRev.n;
	const sig: unknown[] = [
		evalNow,
		ack,
		pose.lat,
		pose.lon,
		mslFt,
		points,
		quality,
		rev,
		obstacles,
		airports,
		inhibited,
		vfr,
		terrainPrefs.terrain,
		terrainPrefs.obstacle,
	];
	if (evalSig && sameSig(evalSig, sig) && lastResult) {
		return lastResult;
	}
	// A backward playhead jump replays history: the presentation memory and
	// the acknowledgements reset so the reconstruction is deterministic (an
	// acknowledgement made later in the flight must not quiet an alert the
	// replay shows before it). A plain Map, cleared without touching ackRev:
	// this runs inside consumers' deriveds, and the clock re-keys anyway.
	if (evalNow < lastEvalMs - 1000) {
		prevState = emptyTerrainPrev();
		firedQueue = [];
		acks.clear();
	}

	const motion = smoothedMotionAt(points, playhead);
	const speedKt = motion?.speedKt ?? pose.speedKt ?? 0;
	const trackDeg = motion?.trackDeg ?? null;
	const vsFpm = motion?.vsFpm ?? null;
	const first = firstAirborneMs(points);
	const airborne = first != null && first <= playhead;
	const dep = departureWatermark(points);
	const departureEnded = dep.endMs != null && dep.endMs <= playhead;

	const field = nearestField(airports, pose.lat, pose.lon);

	// The corridor: one minute ahead along the smoothed track, a bin every
	// ALONG_BIN_M, the searched half-width either side. Its ground is read
	// (and its tiles warmed) only while the ground row can alert: a switched
	// off row or the pilot's inhibit costs no fetch and churns no tile out of
	// the phone's budget.
	let ground: TerrainGround | null = null;
	let frame: CapsuleFrame | null = null;
	let nearby: TerrainObstacle[] = [];
	if (airborne && trackDeg != null && speedKt > 0 && mslFt != null) {
		const lenM = ((speedKt * NM_TO_METERS) / 3600) * CAUTION_S + ALONG_BIN_M;
		const dest = destinationPoint(pose.lat, pose.lon, trackDeg, lenM);
		const alongBins = Math.max(1, Math.round(lenM / ALONG_BIN_M));
		const here = { lat: pose.lat, lon: pose.lon };
		const halfWidthM = FLTA_HALF_WIDTH_NM * NM_TO_METERS;
		// Three lanes across the corridor, the centre one the strip
		// TRACK_STRIP_M either side of the track, whose ground above the
		// aircraft overrides the rise gate (nav/terrainAlert.ts).
		const opts = { halfWidthM, alongBins, crossMax: 1, crossBinM: 2 * TRACK_STRIP_M };
		if (terrainPrefs.terrain && !inhibited) {
			// By footprint: a level coarser than the bins must neither leave a
			// bin empty (read as the sea) nor drop a pixel covering the edge.
			const peek = peekCapsuleGround(here, dest, { ...opts, footprint: true });
			frame = peek.frame;
			const { maxFt, trackFt } = capsuleTrackMaxFt(peek.bins, alongBins);
			ground = {
				binM: peek.frame.alongBinM,
				maxFt,
				trackFt,
				// Not resolved: a bin holding no ground is unknown, not the sea.
				missing: peek.resolved ? 0 : Math.max(1, peek.missing.length),
				nearField: field ? fieldBins(peek.frame, alongBins, field) : null,
			};
			// The finer level is asked for even when a coarser one answered,
			// so the next evaluation reads the ground the bins were made for.
			if (peek.warmLevels.length > 0) {
				warmCorridor(peek.warmLevels);
			}
		} else {
			frame = capsuleFrame(here, dest, opts);
		}
		nearby = corridorObstacles(obstacles, frame, field);
	}

	// An acknowledgement past its expiry is dropped BEFORE it is applied.
	for (const [threat, entry] of acks) {
		if (evalNow - entry.lastShownMs > ACK_TTL_MS) {
			acks.delete(threat);
		}
	}

	const result = evaluateTerrain(
		{
			nowMs: evalNow,
			pose: {
				lat: pose.lat,
				lon: pose.lon,
				mslFt,
				altTrusted: quality === 'good',
				trackDeg,
				speedKt,
				vsFpm,
			},
			vfr,
			airborne,
			departureEnded,
			field,
			ground,
			obstacles: nearby,
			acks: ackMap(),
			tiers: { terrain: terrainPrefs.terrain, obstacle: terrainPrefs.obstacle },
			inhibited,
		},
		prevState,
	);

	// Ack upkeep: refresh the seen stamp of every threat still shown; one no
	// longer shown expires ACK_TTL_MS after its row left, a ridge by where
	// its threatening stretch lies and an obstacle by its id alike, so the
	// next ridge, another threat, is never born acknowledged.
	for (const [threat, entry] of acks) {
		if (result.alerts.some((a) => a.threat === threat)) {
			entry.lastShownMs = evalNow;
		}
	}

	if (nav.recording) {
		if (result.fired.length > 0) {
			firedQueue.push(...result.fired);
			if (firedQueue.length > FIRED_QUEUE_MAX) {
				firedQueue.splice(0, firedQueue.length - FIRED_QUEUE_MAX);
			}
		}
	} else if (firedQueue.length > 0) {
		firedQueue = [];
	}

	const threats: TerrainThreat[] = [];
	for (const a of result.alerts) {
		if (a.kind === 'terrain') {
			if (!a.held && frame) {
				terrainQuad = capsuleQuad(frame, a.alongM, a.toM);
			}
			if (terrainQuad) {
				threats.push({ kind: 'terrain', level: a.level, acked: a.acked, quad: terrainQuad });
			}
		} else if (a.obstacle) {
			threats.push({ kind: 'obstacle', level: a.level, acked: a.acked, lat: a.obstacle.lat, lon: a.obstacle.lon });
		}
	}
	if (!result.alerts.some((a) => a.kind === 'terrain')) {
		terrainQuad = null;
	}
	lastThreats = threats.length > 0 ? threats : NO_THREATS;
	prevState = result.prev;
	lastEvalMs = evalNow;
	evalSig = sig;
	lastResult = result;
	return result;
}

/** The threats the map outlines (the last evaluation's), empty while the
 *  alerts are off. Reads terrainAlerts() first, so it tracks like it. */
export function terrainThreats(): readonly TerrainThreat[] {
	return terrainAlerts() ? lastThreats : NO_THREATS;
}

/** What the evaluation cannot see, while the alerts are armed and a pose is
 *  on the map: part of the corridor's ground not read (tiles loading or
 *  failed to load), and the obstacle dataset not loaded. Null when there is
 *  nothing to say. A caveat for the panel and the Navigation tab, never a
 *  chip: a bare data gap raises none (docs/nav-alerts.md). */
export function terrainInputGaps(): { unread: boolean; obstacles: boolean } | null {
	const r = terrainAlerts();
	if (!r) {
		return null;
	}
	const unread = r.unread;
	const obstacles = terrainPrefs.obstacle && r.idle == null && !dataState.obstaclesLoaded;
	return unread || obstacles ? { unread, obstacles } : null;
}

function ackMap(): ReadonlyMap<string, number> {
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- snapshot handed to the pure fold
	const m = new Map<string, number>();
	for (const [threat, entry] of acks) {
		m.set(threat, entry.rank);
	}
	return m;
}
