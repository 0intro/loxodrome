/* Live airspace-alert wiring around the pure evaluator
 * (nav/airspaceAlert.ts): one RBush over the normalised volumes of the
 * three sources, the evaluator input assembled from the pose each tick,
 * and the session presentation state (preferences, acknowledgements, the
 * evaluator's prev memory). The selector is memoised on an input
 * signature read BEFORE the cache check (the notamCorridor idiom), so
 * callers track it like a derived while the evaluator's prev advances
 * exactly once per evaluation instant however many surfaces read it.
 *
 * Source posture (docs/nav-alerts.md): airspace activation joins read the
 * RAW notam array, never visibleNotams(), because a list filter must not
 * gate a safety evaluation; SUP AIP zone activation rides the shared
 * supZoneActivations() links (the same source as the map's activation
 * hatch, so banner and hatch agree). The evaluation clock is the
 * playhead, so a replay scrub reconstructs the historical alert states;
 * a live recording widens it with the 1 Hz wall clock so a parked
 * aircraft still sees a zone go hot. */

import RBush from 'rbush';
import {
	SEVERITY_RANK,
	emptyAlertPrev,
	evaluateAlerts,
	type AlertEvalResult,
	type AlertFire,
	type AlertPrevState,
} from '$lib/nav/airspaceAlert';
import { alertSurface, type AlertSurfaceModel, type SuspendReason } from '$lib/nav/alertSurface';
import {
	airspaceVolumes,
	notamVolumes,
	supaipVolumes,
	type ActiveWindow,
	type AlertVolume,
} from '$lib/nav/alertVolumes';
import type { AlertTierPref } from '$lib/nav/alertRules';
import { smoothedMotionAt } from '$lib/nav/trace';
import { TAKEOFF_KT } from '$lib/nav/navlogLive';
import type { TrackPoint } from '$lib/nav/trace';
import { M_PER_DEG, destinationPoint, equirectangularDistanceM } from '$lib/notam/geometry';
import { NM_TO_METERS } from '$lib/notam/units';
import { isActivationQCode } from '$lib/notam/qcode';
import { isRtbaActivationNotam, rtbaZoneActivations } from '$lib/notam/rtba';
import type { Notam } from '$lib/notam/types';
import type { Airspace } from '$lib/data/airspaces';
import type { SupAip } from '$lib/data/supaip';
import type { RouteAirspaceEvent } from '$lib/route/airspaces';
import { elevationFtAt } from '$lib/map/terrain';
import { readItem, removeItem, writeItem } from './persist';
import { autoStop } from './autoStop.svelte';
import { currentPose, nav, poseAltMslFt, positionQuality } from './navRecording.svelte';
import { notamState } from './notam.svelte';
import { activatedAirspaceIds } from './notamLinks.svelte';
import { supZoneActivations } from './supaipLinks.svelte';
import { dataState, getAirspaces, getSupaips } from './data.svelte';
import { routeSettings, routes } from './route.svelte';
import { navRouteId } from './navRoute.svelte';
import { effectiveCruiseSpeedKt } from './aircraft.svelte';
import { cachedAirspaceSchedule } from './navlogSchedule';
import { routeTerrainSamples } from './routeTerrain.svelte';

const OFF_KEY = 'loxodrome:nav-alerts-off';
const TIER_OFF_KEYS: Record<AlertTierPref, string> = {
	avoid: 'loxodrome:nav-alert-avoid-off',
	clearance: 'loxodrome:nav-alert-clearance-off',
	equipment: 'loxodrome:nav-alert-equipment-off',
	caution: 'loxodrome:nav-alert-caution-off',
};
const BUFFER_KEY = 'loxodrome:nav-alert-buffer';
const LOOKAHEAD_KEY = 'loxodrome:nav-alert-lookahead';
const AUDIO_KEY = 'loxodrome:nav-alert-audio';
const AUDIO_CAUTION_KEY = 'loxodrome:nav-alert-audio-caution';

export const VERTICAL_BUFFER_CHOICES = [0, 100, 200, 500] as const;
export const LOOKAHEAD_CHOICES = [2, 5, 10] as const;

function initialChoice(key: string, choices: readonly number[], dflt: number): number {
	const raw = readItem(key);
	if (raw == null) {
		return dflt;
	}
	const n = Number(raw);
	return choices.includes(n) ? n : dflt;
}

/** Alert preferences. Everything defaults ON except audio, which is a
 *  deliberate arm gesture (it doubles as the browser audio unlock). */
export const alertPrefs = $state<{
	enabled: boolean;
	tiers: Record<AlertTierPref, boolean>;
	bufferFt: number;
	lookaheadMin: number;
	audio: boolean;
	audioCaution: boolean;
}>({
	enabled: readItem(OFF_KEY) !== '1',
	tiers: {
		avoid: readItem(TIER_OFF_KEYS.avoid) !== '1',
		clearance: readItem(TIER_OFF_KEYS.clearance) !== '1',
		equipment: readItem(TIER_OFF_KEYS.equipment) !== '1',
		caution: readItem(TIER_OFF_KEYS.caution) !== '1',
	},
	bufferFt: initialChoice(BUFFER_KEY, VERTICAL_BUFFER_CHOICES, 200),
	lookaheadMin: initialChoice(LOOKAHEAD_KEY, LOOKAHEAD_CHOICES, 5),
	audio: readItem(AUDIO_KEY) === '1',
	audioCaution: readItem(AUDIO_CAUTION_KEY) === '1',
});

function rememberOff(key: string, on: boolean): void {
	if (on) {
		removeItem(key);
	} else {
		writeItem(key, '1');
	}
}

export function setAlertsEnabled(on: boolean): void {
	alertPrefs.enabled = on;
	rememberOff(OFF_KEY, on);
}

export function setAlertTier(tier: AlertTierPref, on: boolean): void {
	alertPrefs.tiers[tier] = on;
	rememberOff(TIER_OFF_KEYS[tier], on);
}

export function setAlertBuffer(ft: number): void {
	alertPrefs.bufferFt = ft;
	if (ft === 200) {
		removeItem(BUFFER_KEY);
	} else {
		writeItem(BUFFER_KEY, String(ft));
	}
}

export function setAlertLookahead(min: number): void {
	alertPrefs.lookaheadMin = min;
	if (min === 5) {
		removeItem(LOOKAHEAD_KEY);
	} else {
		writeItem(LOOKAHEAD_KEY, String(min));
	}
}

export function setAlertAudio(on: boolean): void {
	alertPrefs.audio = on;
	if (on) {
		writeItem(AUDIO_KEY, '1');
	} else {
		removeItem(AUDIO_KEY);
	}
}

export function setAlertCautionAudio(on: boolean): void {
	alertPrefs.audioCaution = on;
	if (on) {
		writeItem(AUDIO_CAUTION_KEY, '1');
	} else {
		removeItem(AUDIO_CAUTION_KEY);
	}
}

// ---- candidate volumes + spatial index ----

interface TreeItem {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
	v: AlertVolume;
}

let volCache: {
	airspaces: Airspace[] | null;
	sups: SupAip[] | null;
	notams: Notam[];
	tree: RBush<TreeItem>;
} | null = null;

function volumeTree(
	airspaces: Airspace[] | null,
	sups: SupAip[] | null,
	notams: Notam[],
): RBush<TreeItem> {
	if (
		volCache &&
		volCache.airspaces === airspaces &&
		volCache.sups === sups &&
		volCache.notams === notams
	) {
		return volCache.tree;
	}
	const vols = [
		...(airspaces ? airspaceVolumes(airspaces) : []),
		...(sups ? supaipVolumes(sups) : []),
		...notamVolumes(notams),
	];
	const tree = new RBush<TreeItem>();
	tree.load(
		vols.map((v) => ({
			minX: v.bbox.minLon,
			minY: v.bbox.minLat,
			maxX: v.bbox.maxLon,
			maxY: v.bbox.maxLat,
			v,
		})),
	);
	volCache = { airspaces, sups, notams, tree };
	return tree;
}

// ---- NOTAM activation windows, joined by volume id ----

let windowCache: {
	notams: Notam[];
	supLinks: unknown;
	map: Map<string, ActiveWindow[]>;
} | null = null;

function buildNotamWindows(
	notams: Notam[],
	supLinks: ReadonlyMap<string, { notam: Notam }[]>,
): Map<string, ActiveWindow[]> {
	if (windowCache && windowCache.notams === notams && windowCache.supLinks === supLinks) {
		return windowCache.map;
	}
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- rebuilt whole on input change, consumers key on the reference
	const map = new Map<string, ActiveWindow[]>();
	const add = (id: string, w: ActiveWindow): void => {
		const list = map.get(id);
		if (list) {
			list.push(w);
		} else {
			map.set(id, [w]);
		}
	};
	const validity = (n: Notam): ActiveWindow | null => {
		if (n.permanent) {
			return { startMs: 0, endMs: Infinity };
		}
		// Missing bounds resolve inactive, the activatedAirspaceLinks rule.
		if (!n.startDate || !n.endDate) {
			return null;
		}
		return { startMs: n.startDate.getTime(), endMs: n.endDate.getTime() };
	};
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- build-local dedup, discarded with the pass
	const seen = new Set<string>();
	for (const n of notams) {
		if (!isActivationQCode(n.qCode) || seen.has(n.id)) {
			continue;
		}
		seen.add(n.id);
		if (isRtbaActivationNotam(n)) {
			for (const z of rtbaZoneActivations(n)) {
				add(z.airspaceId, { startMs: z.start.getTime(), endMs: z.end.getTime() });
			}
			continue;
		}
		const w = validity(n);
		if (!w) {
			continue;
		}
		for (const id of activatedAirspaceIds(n)) {
			add(id, w);
		}
	}
	for (const [zoneKey, entries] of supLinks) {
		for (const { notam } of entries) {
			const w = validity(notam);
			if (w) {
				add(zoneKey, w);
			}
		}
	}
	windowCache = { notams, supLinks, map };
	return map;
}

// ---- planned traversal keys (the flown route's schedule) ----

const EMPTY_KEYS: ReadonlySet<string> = new Set();
let plannedCache: { schedule: RouteAirspaceEvent[]; keys: Set<string> } | null = null;

function plannedKeys(airspaces: Airspace[] | null): ReadonlySet<string> {
	if (!airspaces) {
		return EMPTY_KEYS;
	}
	const id = navRouteId();
	const route = routes.list.find((r) => r.id === id);
	if (!route || route.waypoints.length < 2) {
		return EMPTY_KEYS;
	}
	const schedule = cachedAirspaceSchedule(
		route.waypoints,
		airspaces,
		effectiveCruiseSpeedKt(),
		routeSettings.defaultAltitudeFt,
		routeTerrainSamples(route.id, route.waypoints),
	);
	if (plannedCache?.schedule !== schedule) {
		plannedCache = { schedule, keys: new Set(schedule.map((ev) => ev.key)) };
	}
	return plannedCache.keys;
}

// ---- terrain at the pose (async, refreshed by movement) ----

/** Refresh the ground sample once the aircraft moved this far. */
const GROUND_REFRESH_M = NM_TO_METERS;
/** A sample farther than this from the pose no longer answers for it. */
const GROUND_VALID_M = 2 * NM_TO_METERS;

let ground = $state<{ lat: number; lon: number; ft: number | null } | null>(null);
let groundPending = false;

function ensureGround(lat: number, lon: number): void {
	if (groundPending) {
		return;
	}
	if (ground && equirectangularDistanceM(lat, lon, ground.lat, ground.lon) < GROUND_REFRESH_M) {
		return;
	}
	groundPending = true;
	elevationFtAt(lat, lon)
		.then((ft) => {
			ground = { lat, lon, ft };
		})
		.catch(() => {
			ground = { lat, lon, ft: null };
		})
		.finally(() => {
			groundPending = false;
		});
}

// ---- airborne watermark (position-referenced, no route needed) ----

let airWm: { points: TrackPoint[] | null; scanned: number; firstMs: number | null } = {
	points: null,
	scanned: 0,
	firstMs: null,
};

const MS_PER_KT = 1852 / 3600;

/** First trace instant at or above the takeoff speed; the alert gate's
 *  route-free stand-in for the motion fold's takeoff commit. Watermarked
 *  per trace array, playhead-aware so a scrubbed replay answers for its
 *  own instant. A point without a device speed (a bare GPX import) gets
 *  one derived from its predecessor, so a replayed debrief still passes
 *  the airborne gate. */
function firstAirborneMs(points: TrackPoint[]): number | null {
	if (airWm.points !== points) {
		airWm = { points, scanned: 0, firstMs: null };
	}
	if (airWm.firstMs == null) {
		for (let i = airWm.scanned; i < points.length; i++) {
			let kt = points[i].speedKt;
			if (kt == null && i > 0) {
				const dtS = (points[i].timeMs - points[i - 1].timeMs) / 1000;
				if (dtS > 0) {
					const dM = equirectangularDistanceM(
						points[i - 1].lat,
						points[i - 1].lon,
						points[i].lat,
						points[i].lon,
					);
					kt = dM / dtS / MS_PER_KT;
				}
			}
			if ((kt ?? 0) >= TAKEOFF_KT) {
				airWm.firstMs = points[i].timeMs;
				break;
			}
		}
		airWm.scanned = points.length;
	}
	return airWm.firstMs;
}

// ---- acknowledgements ----

/** An ack expires this long after its volume stopped alerting. */
const ACK_TTL_MS = 300_000;

// eslint-disable-next-line svelte/prefer-svelte-reactivity -- session ledger; reactivity rides ackRev
const acks = new Map<string, { rank: number; lastShownMs: number }>();
let ackRev = $state(0);

/** Acknowledge a volume at its current severity: the banner dims, the
 *  sound stays quiet, and an escalation past this severity re-alerts. */
export function acknowledgeAlert(key: string): void {
	const cur = lastResult?.alerts.find((a) => a.key === key);
	const rank = cur ? SEVERITY_RANK[cur.severity] : SEVERITY_RANK.inside;
	acks.set(key, { rank, lastShownMs: lastEvalMs });
	ackRev++;
}

// ---- sound edges: the multi-consumer-safe hand-off ----

/** Defensive cap; a real evaluation fires at most a handful of edges. */
const FIRED_QUEUE_MAX = 16;

/** Edges fired since the last drain. The evaluator emits each edge exactly
 *  once (on the one cache-miss evaluation of a pass), but WHICH consumer's
 *  read performs that evaluation depends on effect order, so the edges are
 *  queued here and MapView's audio effect drains them: however many
 *  surfaces read airspaceAlerts(), each edge reaches audio exactly once. */
let firedQueue: AlertFire[] = [];

/** Take every queued sound edge (empties the queue). The audio effect
 *  drains on every pass while recording, armed or not, so an audio-off
 *  session cannot stockpile stale chimes. */
export function drainAlertFires(): AlertFire[] {
	const out = firedQueue;
	if (out.length > 0) {
		firedQueue = [];
	}
	return out;
}

// ---- the memoised selector ----

let evalSig: unknown[] | null = null;
let lastResult: AlertEvalResult | null = null;
let prevState: AlertPrevState = emptyAlertPrev();
let lastEvalMs = 0;

function sameSig(a: unknown[], b: unknown[]): boolean {
	return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** The live alert state for the current pose, or null while alerts are
 *  off, no pose exists, or the position is lost (a frozen pose must not
 *  alert). Reads every reactive input before its cache check, so calling
 *  it inside a $derived / $effect tracks like a derived. */
export function airspaceAlerts(): AlertEvalResult | null {
	// Gate first, so the whole machinery stays untracked while off.
	if (!alertPrefs.enabled) {
		return null;
	}
	const pose = currentPose();
	if (!pose) {
		return null;
	}
	if (positionQuality() === 'lost') {
		return null;
	}
	void notamState.tick;
	// In the signature, not just tracked: an acknowledgement changes the
	// evaluator's acks input, and with supZoneActivations properly memoised
	// nothing else invalidates the cache for it (the fresh-Map era hid
	// that, re-evaluating on every call).
	const ack = ackRev;
	const points = nav.points;
	const playhead = nav.playheadMs;
	const evalNow = nav.recording ? Math.max(playhead, nav.nowMs) : playhead;
	const airspaces = dataState.airspacesLoaded ? getAirspaces() : null;
	const sups = getSupaips();
	const rawNotams = notamState.notams;
	const supLinks = supZoneActivations();
	const vfr = routeSettings.vfr;
	const planned = plannedKeys(airspaces);
	const g = ground;
	const mslFt = poseAltMslFt(pose);
	const quality = positionQuality();
	const sig: unknown[] = [
		evalNow,
		ack,
		pose.lat,
		pose.lon,
		mslFt,
		points,
		airspaces,
		sups,
		rawNotams,
		supLinks,
		vfr,
		planned,
		g,
		quality,
		alertPrefs.tiers.avoid,
		alertPrefs.tiers.clearance,
		alertPrefs.tiers.equipment,
		alertPrefs.tiers.caution,
		alertPrefs.bufferFt,
		alertPrefs.lookaheadMin,
	];
	if (evalSig && sameSig(evalSig, sig) && lastResult) {
		return lastResult;
	}

	// A backward playhead jump replays history: presentation memory resets
	// so the reconstruction is deterministic (the sound queue and the
	// surface fold's row order with it).
	if (evalNow < lastEvalMs - 1000) {
		prevState = emptyAlertPrev();
		firedQueue = [];
		surfacePrevOrder = [];
	}

	ensureGround(pose.lat, pose.lon);
	const groundKnown =
		g != null && equirectangularDistanceM(pose.lat, pose.lon, g.lat, g.lon) <= GROUND_VALID_M;

	const motion = smoothedMotionAt(points, playhead);
	const speedKt = motion?.speedKt ?? pose.speedKt ?? 0;
	const trackDeg = motion?.trackDeg ?? null;

	// Query box: the lookahead segment padded by the proximity radius.
	const segM = speedKt * (NM_TO_METERS / 60) * alertPrefs.lookaheadMin;
	const dest =
		trackDeg != null && segM > 0
			? destinationPoint(pose.lat, pose.lon, trackDeg, segM)
			: { lat: pose.lat, lon: pose.lon };
	const padLat = NM_TO_METERS / M_PER_DEG;
	const padLon = padLat / (Math.cos((pose.lat * Math.PI) / 180) || 1);
	const tree = volumeTree(airspaces, sups, rawNotams);
	const candidates = tree
		.search({
			minX: Math.min(pose.lon, dest.lon) - padLon,
			minY: Math.min(pose.lat, dest.lat) - padLat,
			maxX: Math.max(pose.lon, dest.lon) + padLon,
			maxY: Math.max(pose.lat, dest.lat) + padLat,
		})
		.map((i) => i.v);

	const first = firstAirborneMs(points);
	const result = evaluateAlerts(
		{
			nowMs: evalNow,
			pose: {
				lat: pose.lat,
				lon: pose.lon,
				mslFt,
				altTrusted: quality === 'good',
				trackDeg,
				speedKt,
				vsFpm: motion?.vsFpm ?? null,
			},
			volumes: candidates,
			notamWindows: buildNotamWindows(rawNotams, supLinks),
			notamBriefingLoaded: rawNotams.length > 0,
			plannedKeys: planned,
			acks: ackMap(),
			profile: { vfr },
			params: {
				lookaheadMin: alertPrefs.lookaheadMin,
				imminentMin: 2,
				proximityNM: 0.5,
				verticalBufferFt: alertPrefs.bufferFt,
			},
			airborne: first != null && first <= playhead,
			groundFt: groundKnown ? (g?.ft ?? null) : null,
			groundKnown,
			tiers: { ...alertPrefs.tiers },
		},
		prevState,
	);

	// Ack upkeep: refresh the seen stamp, expire the departed.
	for (const [key, entry] of acks) {
		if (result.alerts.some((a) => a.key === key)) {
			entry.lastShownMs = evalNow;
		} else if (evalNow - entry.lastShownMs > ACK_TTL_MS) {
			acks.delete(key);
		}
	}

	// Queue this evaluation's sound edges for the audio effect's drain.
	// Live only: a replay debrief stays visual, and a queue carried across
	// a stopped recording must not chime into the next one.
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

	prevState = result.prev;
	lastEvalMs = evalNow;
	evalSig = sig;
	lastResult = result;
	return result;
}

/** Which of the evaluator's two data inputs are missing, while alerts are
 *  armed. An empty alert list is otherwise indistinguishable from "nothing
 *  to warn about", which is the one thing a safety surface may not be
 *  ambiguous about: without the airspace dataset there is no evaluation at
 *  all, and without a briefing the NOTAM-activated zones (the RTBA network
 *  above all) can only be graded as unknown. Null while alerts are off or
 *  everything the evaluator needs is present. */
export function alertInputGaps(): { airspaces: boolean; briefing: boolean } | null {
	if (!alertPrefs.enabled) {
		return null;
	}
	const airspaces = !dataState.airspacesLoaded;
	const briefing = notamState.notams.length === 0;
	return airspaces || briefing ? { airspaces, briefing } : null;
}

function ackMap(): ReadonlyMap<string, number> {
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- snapshot handed to the pure evaluator
	const m = new Map<string, number>();
	for (const [key, entry] of acks) {
		m.set(key, entry.rank);
	}
	return m;
}

// ---- the presentation surface ----

/** Whether this recording ever had a good fix: the lost/noFix split in
 *  alertSuspension below. Plain module state; the selector is called
 *  every pass, so the edge-detect needs no effect. */
let recWasOn = false;
let goodSeenThisRecording = false;

/** Why alert evaluation is suspended, or null while it runs. Recording
 *  only: a replay pose is a recorded fact, so there is nothing to
 *  suspend, and the desk never shows a suspension. `noFix` is the
 *  acquisition posture (the recording has no fix yet, or has never had a
 *  GOOD one: startup commonly serves a cached stale fix that ages
 *  straight into `lost` without the position ever having been live);
 *  `lost` is a live dropout, a position that WAS good this recording and
 *  stopped (positionQuality's LOST_MS), the only form that earns the
 *  danger dress. Deliberately NOT a third alertInputGaps() field: the
 *  gaps are data inputs, meaningful on the desk with no pose at all,
 *  while suspension is the pose input and REPLACES the banner. */
export function alertSuspension(): SuspendReason | null {
	if (!alertPrefs.enabled) {
		return null;
	}
	const rec = nav.recording;
	if (rec && !recWasOn) {
		goodSeenThisRecording = false;
	}
	recWasOn = rec;
	if (!rec) {
		return null;
	}
	if (!nav.lastFix) {
		return 'noFix';
	}
	const q = positionQuality();
	if (q === 'good') {
		goodSeenThisRecording = true;
		return null;
	}
	if (q !== 'lost') {
		return null;
	}
	return goodSeenThisRecording ? 'lost' : 'noFix';
}


let surfacePrevOrder: readonly string[] = [];
let surfaceSig: unknown[] | null = null;
let surfaceModel: AlertSurfaceModel | null = null;

/** The strip's render model (nav/alertSurface.ts): the one banner row,
 *  the channel-health chip, the panel sections and the region order.
 *  Memoised like airspaceAlerts(): every reactive input is read before
 *  the cache check, and the fold's row-order memory advances once per
 *  change however many surfaces read it. */
export function alertSurfaceNow(): AlertSurfaceModel {
	const result = airspaceAlerts();
	const suspended = alertSuspension();
	const gaps = alertInputGaps();
	const stopPending = autoStop.pending != null;
	const stale = nav.recording && positionQuality() !== 'good';
	const sig: unknown[] = [
		result,
		suspended,
		gaps?.airspaces ?? false,
		gaps?.briefing ?? false,
		stopPending,
		stale,
	];
	if (surfaceModel && surfaceSig && sameSig(surfaceSig, sig)) {
		return surfaceModel;
	}
	const model = alertSurface({
		alerts: result?.alerts ?? [],
		suspended,
		gaps,
		stopPending,
		stale,
		prevOrder: surfacePrevOrder,
	});
	surfacePrevOrder = model.order;
	surfaceSig = sig;
	surfaceModel = model;
	return model;
}
