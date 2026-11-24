/* The NOTAM briefing judged against the plan on screen: the loaded briefing,
 * the routes, the flight's window and the clock, handed to the pure verdict
 * (notam/briefingVerdict.ts, which holds the rules). Flight app only.
 *
 * Reads reactive state, so call these inside a $derived or $effect: the
 * minute tick moves the age and a window flown from the current minute. */

import { untrack } from 'svelte';
import {
	briefingVerdict,
	dayKey,
	routeCoverage,
	TAIL_TOLERANCE_MS,
	supsMissing,
	type BriefingReason,
	type BriefingVerdict,
	type PlanTrack,
	type VerdictInput,
} from '$lib/notam/briefingVerdict';
import { fetchCures, noticeShown, refreshDue, STILL_MS, type RefreshInput } from '$lib/notam/briefingRefresh';
import { notamSupPublisher } from '$lib/notam/aipSup';
import { isTriggerNotam } from '$lib/notam/relations';
import { NM_TO_METERS } from '$lib/notam/units';
import { isRtba } from '$lib/map/airspaceSymbology';
import { corridorIntersectsRing } from '$lib/route/notamCorridor';
import { liveAirborneGate } from './airborne';
import { airportByIdent, dataState, ensureSupaip, frSupaipList, getAirspaces, supaipByRef } from './data.svelte';
import { flightPrep } from './flightPrep.svelte';
import { nav } from './navRecording.svelte';
import { autorouter } from '$lib/autorouter/state.svelte';
import { display } from './display.svelte';
import {
	aerodromeBriefed,
	briefingGeneration,
	briefingLoaded,
	briefingRtbaDays,
	notamState,
	rawIndexedNotams,
	rawNotamsDuring,
	type IndexedNotam,
} from './notam.svelte';
import { notamFetchBusy, notamSource } from './notamSource.svelte';
import { newListedCount } from './notamOrder.svelte';
import { printBusy } from './printProgress.svelte';
import { routes, routeSettings, type Route } from './route.svelte';
import { routeEndpointsLabel, sofiaBriefsRoute, sofiaCanBrief, sofiaCanBriefEvery } from './routeNotamFetch';
import { VALIDITY_WINDOW_DAYS } from '$lib/autorouter/fetch';
import { sofiaDepartureMs, SOFIA_DURATION_MS } from '$lib/sofia/client';
import { SOFIA_MAX_DAYS } from '$lib/sofia/fetch';
import { briefingWindow, hasFlyableRoute, plannedFlightAt } from './timeWindow.svelte';

/** The plan's tracks, every route of two waypoints, alternates included: what
 *  the route fetch briefs. The same array while no waypoint moves. */
let tracksMemo: { sig: string; out: PlanTrack[] } | null = null;

function drawnRoutes(): Route[] {
	return routes.list.filter((r) => r.waypoints.length >= 2);
}

/** Every drawn route's points, in order, and its label: what tells one
 *  plan from another, and names a track in the verdict's reasons. */
function tracksSig(drawn: readonly Route[]): string {
	return drawn
		.map((r) => `${routeEndpointsLabel(r)}:${r.waypoints.map((w) => `${w.lat},${w.lon},${w.ident ?? ''}`).join(';')}`)
		.join('#');
}

export function planTracks(): PlanTrack[] {
	const drawn = drawnRoutes();
	const sig = tracksSig(drawn);
	if (tracksMemo && tracksMemo.sig === sig) {
		return tracksMemo.out;
	}
	const out = drawn.map((r) => ({
		label: routeEndpointsLabel(r),
		path: r.waypoints.map((w) => ({ lat: w.lat, lon: w.lon })),
	}));
	tracksMemo = { sig, out };
	return out;
}

/** Does a plan corridor cross an RTBA zone laterally? The zones reach from
 *  the surface, or 800 ft above it, to as high as FL085, the whole band a
 *  VFR flight crosses. */
let rtbaCrossMemo: { tracks: PlanTrack[]; halfWidthNM: number; revision: number; out: boolean } | null = null;

function crossesRtba(tracks: PlanTrack[], halfWidthNM: number): boolean {
	const revision = dataState.revision.airspaces;
	if (
		rtbaCrossMemo &&
		rtbaCrossMemo.tracks === tracks &&
		rtbaCrossMemo.halfWidthNM === halfWidthNM &&
		rtbaCrossMemo.revision === revision
	) {
		return rtbaCrossMemo.out;
	}
	const zones = (getAirspaces() ?? []).filter((a) => isRtba(a.id));
	const halfWidthM = halfWidthNM * NM_TO_METERS;
	const out = tracks.some((tr) => zones.some((z) => corridorIntersectsRing(tr.path, halfWidthM, z.ring)));
	rtbaCrossMemo = { tracks, halfWidthNM, revision, out };
	return out;
}

/** The coverage test, memoised on the plan and on what the fetch asked: the
 *  sampled walk is the verdict's one costly part, and the minute tick and a
 *  recording's fixes re-run everything else. */
let coverMemo: {
	tracks: PlanTrack[];
	halfWidthNM: number;
	asked: unknown;
	out: ReturnType<typeof routeCoverage>;
} | null = null;

const cover: typeof routeCoverage = (plan, asked) => {
	if (
		coverMemo &&
		coverMemo.tracks === plan.tracks &&
		coverMemo.halfWidthNM === plan.halfWidthNM &&
		coverMemo.asked === asked
	) {
		return coverMemo.out;
	}
	const out = routeCoverage(plan, asked);
	coverMemo = { tracks: plan.tracks, halfWidthNM: plan.halfWidthNM, asked, out };
	return out;
};

/** Outside a recorded flight's air time: a replay and a helicopter's trace
 *  stay on the ground, the gate being read only while a recording runs. */
export function aircraftOnGround(nowMs: number): boolean {
	return !(nav.recording && liveAirborneGate(nowMs).airborne);
}

/** What the automatic briefing (state/briefingFetch.ts) last did, for the
 *  next decision (notam/briefingRefresh.ts) and for the verdict. */
export const briefingRun = $state<{
	running: boolean;
	/** The last run's start. */
	lastMs: number | null;
	/** Failed runs in a row, and when the last one failed. */
	failures: number;
	failedMs: number | null;
	/** The reasons the last committed run left standing, for the plan, the
	 *  UTC day and the source it ran for. */
	left: { sig: string; day: string; source: string; codes: string[]; held?: boolean } | null;
}>({ running: false, lastMs: null, failures: 0, failedMs: null, left: null });

/** The plan as the briefing covers it: every track, the corridor's
 *  half-width, the flight's planned span or day, and the performance
 *  page's own aerodromes. A change of any is a briefing to fetch again. */
export function planSignature(): string {
	const at = plannedFlightAt();
	return `${tracksSig(drawnRoutes())}|${routeSettings.corridorRadiusNM}|${at.fromMs}|${at.toMs}|${perfIdents().join(',')}`;
}

const ICAO = /^[A-Z]{4}$/;

/** The aerodromes the performance page adds, upper-case. */
function perfIdents(): string[] {
	return flightPrep.perf.manualIcaos.map((s) => s.trim().toUpperCase()).filter((s) => ICAO.test(s));
}

/** The aerodromes the routes end at, which their briefing holds whole. */
function routeEndIdents(): Set<string> {
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a local lookup, never rendered
	const out = new Set<string>();
	for (const r of routes.list) {
		for (const w of [r.waypoints[0], r.waypoints[r.waypoints.length - 1]]) {
			if (w?.kind === 'airport' && w.ident) {
				out.add(w.ident.trim().toUpperCase());
			}
		}
	}
	return out;
}

/** The aerodromes the briefing owes by name, in the order a run asks them:
 *  those a run missed or a fetch dropped (notamState.aerodromesMissed),
 *  then the performance page's own, less a route's ends, those fetched by
 *  name and those the loaded briefing holds whole (an autorouter corridor,
 *  a map view's box). Only a fetch owes any: nothing says what a bulletin
 *  by hand holds. */
export function aerodromesOwed(): string[] {
	if (!notamState.lastFetch) {
		return [];
	}
	const ends = routeEndIdents();
	const out: string[] = [];
	const owe = (id: string, unplaced: boolean): void => {
		if (ends.has(id) || out.includes(id) || notamState.aerodromeFetches[id]) {
			return;
		}
		const ad = airportByIdent(id);
		if (ad ? aerodromeBriefed({ ident: id, lat: ad.lat, lon: ad.lon }) !== 'full' : unplaced) {
			out.push(id);
		}
	};
	for (const id of notamState.aerodromesMissed) {
		owe(id, true);
	}
	// While the airports load, a page aerodrome is placed nowhere yet.
	for (const id of perfIdents()) {
		owe(id, !dataState.airportsLoading);
	}
	return out;
}

/** Failed runs in a row: none once a fetch committed after the last one,
 *  the pilot's own included. */
export function runFailures(): number {
	const f = notamState.lastFetch;
	const failed = briefingRun.failedMs;
	return briefingRun.failures > 0 && f !== null && failed !== null && f.at > failed ? 0 : briefingRun.failures;
}

/** May the app replace the loaded briefing by itself? None loaded, or a
 *  route fetch aimed at the flight: a bulletin by hand, a map view's fetch
 *  and a typed period's stay until the pilot replaces them. */
export function briefingReplaceable(): boolean {
	if (notamState.byHand) {
		return false;
	}
	const f = notamState.lastFetch;
	return f === null || (f.kind === 'route' && f.asked?.aim !== 'period');
}

/** The reasons a briefing that still covers the plan has none of. */
const SHORT: ReadonlySet<BriefingReason['code']> = new Set(['none', 'failed', 'route', 'period']);

/** Does the loaded fetch still cover the plan? A run then replaces it with
 *  a whole answer only (`wholeOnly`). */
export function briefingCovers(v: BriefingVerdict): boolean {
	return v.source === 'fetch' && !v.reasons.some((r) => SHORT.has(r.code));
}

/** Can the picked source brief the plan? The relay configured, a route of
 *  two waypoints, and for SOFIA an aerodrome on it to anchor on. A briefing
 *  that covers the plan is replaced whole only, so SOFIA must then anchor
 *  every route. */
export function briefingSourceReady(verdict = briefingVerdictNow()): boolean {
	if (!autorouter.proxyUrl || !hasFlyableRoute()) {
		return false;
	}
	if (notamSource.source !== 'sofia') {
		return true;
	}
	return briefingCovers(verdict) ? sofiaCanBriefEvery() : sofiaCanBrief();
}

/** Would a fetch by the picked source leave this reason standing? A period
 *  past what it briefs (SOFIA three days from the departure, autorouter
 *  thirty from now), and routes SOFIA lost for want of an aerodrome to
 *  anchor on. The runs, a print and the Fly tap leave them to the pilot. */
function lastingReason(r: BriefingReason, nowMs: number): boolean {
	if (r.code === 'period') {
		const reach =
			notamSource.source === 'sofia'
				? sofiaDepartureMs(r.span.from, nowMs) + SOFIA_MAX_DAYS * SOFIA_DURATION_MS
				: nowMs + VALIDITY_WINDOW_DAYS * 86_400_000;
		return r.span.to > reach + TAIL_TOLERANCE_MS;
	}
	if (r.code === 'failed' && notamSource.source === 'sofia') {
		const unanchored = new Set(drawnRoutes().filter((rt) => !sofiaBriefsRoute(rt)).map(routeEndpointsLabel));
		return r.labels.every((l) => unanchored.has(l));
	}
	return false;
}

/** The verdict's reasons a fetch by the picked source could cure. */
function curableReasons(v: BriefingVerdict, nowMs: number): BriefingReason[] {
	return v.reasons.filter((r) => !lastingReason(r, nowMs));
}

/** The aerodromes owed by name, for the verdict's aerodromes reason. */
function missedNow(): string[] | undefined {
	const out = aerodromesOwed();
	return out.length > 0 ? out : undefined;
}

function briefingRecord(): Pick<VerdictInput, 'loaded' | 'fetch' | 'byHand' | 'gaps' | 'rtbaDays'> {
	const f = notamState.lastFetch;
	const gaps = notamState.gaps;
	return {
		loaded: briefingLoaded(),
		fetch: f ? { at: f.at, briefed: f.briefed, asked: f.asked ?? null } : null,
		byHand: notamState.byHand,
		gaps: gaps ? { total: gaps.total, labels: gaps.routes.map((g) => g.label) } : null,
		rtbaDays: briefingRtbaDays(),
	};
}

let triggersMemo: { items: IndexedNotam[]; out: boolean } | null = null;

/** Does the loaded briefing hold a French trigger NOTAM, which the verdict
 *  judges against the SUP AIP list? */
export function briefingCitesFrSups(): boolean {
	const items = rawIndexedNotams();
	if (triggersMemo?.items !== items) {
		triggersMemo = {
			items,
			out: items.some((it) => isTriggerNotam(it.notam) && notamSupPublisher(it.notam) === 'fr'),
		};
	}
	return triggersMemo.out;
}

/** Ask for the SUP AIP list while the briefing holds a French trigger
 *  NOTAM: the list loads otherwise with its layer or an activation in the
 *  period. Run from an effect (BriefingHost). */
export function ensureSupaipForTriggers(): void {
	if (briefingCitesFrSups() && !dataState.supaipLoaded) {
		untrack(() => {
			void ensureSupaip().catch(() => {
				/* error is surfaced via dataState.supaipError */
			});
		});
	}
}

/** What the French SUP AIP list lacks of the briefing over the window,
 *  memoised on the briefing's entries in it and on the list. */
let supMemo: { items: IndexedNotam[]; listAt: number | null; revision: number; out: VerdictInput['supaip'] } | null =
	null;

function supaipNow(span: { from: number; to: number } | null): VerdictInput['supaip'] {
	const list = frSupaipList();
	if (list === null || !span) {
		return null;
	}
	const listAt = list.at;
	const items = rawNotamsDuring(span);
	const revision = dataState.revision.supaip;
	if (supMemo && supMemo.items === items && supMemo.listAt === listAt && supMemo.revision === revision) {
		return supMemo.out;
	}
	const missing = supsMissing(
		items.map((it) => it.notam),
		(number, year) => supaipByRef(number, year, 'fr') !== null,
	);
	const out = { listAt, missing };
	supMemo = { items, listAt, revision, out };
	return out;
}

/** The briefing judged against the planned flight. */
export function briefingVerdictNow(): BriefingVerdict {
	void notamState.tick;
	const nowMs = Date.now();
	const tracks = planTracks();
	const halfWidthNM = routeSettings.corridorRadiusNM;
	const span = briefingWindow(nowMs);
	return briefingVerdict({
		...briefingRecord(),
		nowMs,
		plan: tracks.length > 0 ? { tracks, halfWidthNM } : null,
		span,
		onGround: aircraftOnGround(nowMs),
		crossesRtba: tracks.length > 0 && crossesRtba(tracks, halfWidthNM),
		aerodromesMissed: missedNow(),
		supaip: supaipNow(span),
		cover,
	});
}

/** Would a gesture (a print, the Fly tap) fetch the briefing? One the app
 *  may replace, and a fetch curing a reason of the verdict, whatever the
 *  last run left standing (state/briefingFetch.ts ensureBriefing). */
export function briefingWanted(nowMs: number, verdict = briefingVerdictNow()): boolean {
	return briefingReplaceable() && fetchCures(curableReasons(verdict, nowMs), nowMs);
}

/** What BriefingHost watches of the page and the plan, for the run's
 *  decision and for the notice: the page online and visible, the plan
 *  restored, the instant its signature last changed, and the reasons the
 *  pilot folded the notice over. */
export const briefingWatch = $state<{
	online: boolean;
	visible: boolean;
	restored: boolean;
	planSince: number;
	/** The reasons' key the notice's ✕ folded it at, until they change. */
	folded: string | null;
}>({ online: true, visible: true, restored: false, planSince: 0, folded: null });

/** The run's decision input (notam/briefingRefresh.ts), as the app stands.
 *  `activeMs` is the pilot's last press, which only the host tracks. */
export function refreshInputNow(nowMs: number, activeMs: number | null, verdict = briefingVerdictNow()): RefreshInput {
	return {
		nowMs,
		enabled: display.autoNotams,
		restored: briefingWatch.restored,
		sourceReady: briefingSourceReady(verdict),
		visible: briefingWatch.visible,
		online: briefingWatch.online,
		busy: notamFetchBusy() || briefingRun.running || printBusy(),
		onGround: aircraftOnGround(nowMs),
		replaceable: briefingReplaceable(),
		planSig: planSignature(),
		planSigSinceMs: briefingWatch.planSince,
		lastRunMs: briefingRun.lastMs,
		failures: runFailures(),
		failedMs: briefingRun.failedMs,
		reasons: curableReasons(verdict, nowMs),
		ageMs: verdict.at === null ? null : nowMs - verdict.at,
		activeMs,
		left: briefingRun.left,
		day: dayKey(nowMs),
		source: notamSource.source,
	};
}

export interface BriefingNotice {
	/** The row in the map's alert stack. */
	show: boolean;
	/** The row's test on the ground, whatever the phase and the fold: the
	 *  briefing needs the pilot. */
	short: boolean;
	/** The dot on the NOTAMs tab and the phone's Brief destination: short,
	 *  or new NOTAMs waiting. */
	dot: boolean;
	/** The reason the row states: the first a fetch would cure now, which
	 *  its button offers, else the verdict's first. */
	reason: BriefingReason | null;
	verdict: BriefingVerdict;
	/** The key the ✕ folds the row at: the briefing, the plan, the reasons,
	 *  whether a fetch would cure one, a failed run and the day. */
	key: string;
	/** NOTAMs new since the list last showed the briefing. */
	fresh: number;
}

/** What the map says of the briefing. */
export function briefingNoticeNow(nowMs: number): BriefingNotice {
	const verdict = briefingVerdictNow();
	const d = refreshDue(refreshInputNow(nowMs, null, verdict));
	const base = {
		reasons: verdict.reasons,
		curing: (d.due || d.wakeMs !== null) && runFailures() === 0,
		running: notamFetchBusy() || briefingRun.running,
		enabled: display.autoNotams,
		planStill: nowMs - briefingWatch.planSince >= STILL_MS,
	};
	const phase = !nav.recording ? 'ground' : aircraftOnGround(nowMs) ? 'departing' : 'air';
	// The first reason a fetch would cure: an RTBA release still to come
	// sorts before the aerodromes and the age, and no fetch brings it.
	const curable = curableReasons(verdict, nowMs).find((r) => fetchCures([r], nowMs)) ?? null;
	// The fold holds for this briefing and this plan as the pilot saw them:
	// a new briefing, an edited plan, other reasons, a release passed, a
	// failed run or another day unfold the row.
	const key = [
		briefingGeneration(),
		planSignature(),
		verdict.reasons.map((r) => r.code).join(','),
		curable ? 'cures' : '',
		runFailures() > 0 ? 'failed' : '',
		dayKey(nowMs),
	].join('|');
	const fresh = newListedCount();
	const short = noticeShown({ ...base, phase: 'ground' });
	return {
		show: noticeShown({ ...base, phase }) && briefingWatch.folded !== key,
		short,
		dot: short || fresh > 0,
		reason: curable ?? verdict.reasons[0] ?? null,
		verdict,
		key,
		fresh,
	};
}

/** The instant the notice and its dots are read at: the minute tick, and a
 *  wake once the plan has held still STILL_MS, between two ticks, which the
 *  row waits for with the switch off. With `live`, a running recording's
 *  second too, so the takeoff ends the row as it happens. Call it while a
 *  component initialises: it owns an effect. */
export function noticeClock(live = false): { readonly now: number } {
	let wake = $state(0);
	$effect(() => {
		const wait = briefingWatch.planSince + STILL_MS - Date.now();
		if (wait <= 0) {
			return;
		}
		const id = setTimeout(() => {
			wake += 1;
		}, wait + 50);
		return () => clearTimeout(id);
	});
	const now = $derived.by(() => {
		void notamState.tick;
		void wake;
		if (live && nav.recording) {
			void nav.nowMs;
		}
		return Date.now();
	});
	return {
		get now() {
			return now;
		},
	};
}

/** What the briefing leaves unknown of the zones activated by NOTAM along
 *  one route (its endpoints' label, routeEndpointsLabel): every such zone
 *  while the briefing misses the flight (none, its period, this route lost,
 *  its track off the one briefed), and an RTBA zone also before the day's
 *  release. The route profile's crossings and the dossier's read it. */
export function briefingActivityUnknown(label: string): { notam: boolean; rtba: boolean } {
	let notam = false;
	let rtba = false;
	for (const r of briefingVerdictNow().reasons) {
		if (r.code === 'none' || r.code === 'period') {
			notam = true;
		} else if (r.code === 'failed' && r.labels.includes(label)) {
			notam = true;
		} else if (r.code === 'route' && r.labels.includes(label) && trackLeftBriefing(label)) {
			notam = true;
		} else if (r.code === 'rtba') {
			rtba = true;
		}
	}
	return { notam, rtba: notam || rtba };
}

let trackLeftMemo: { tracks: PlanTrack[]; asked: unknown; label: string; out: boolean } | null = null;

/** Does the track named `label` itself leave what the fetch briefed? The
 *  route reason judges the plan's whole corridor, and a crossing lies on
 *  the track, as briefedAt judges a position: a turning point nudged, or
 *  a corridor widened, leaves the track's crossings briefed. */
function trackLeftBriefing(label: string): boolean {
	const asked = notamState.lastFetch?.asked;
	const tracks = planTracks();
	if (trackLeftMemo && trackLeftMemo.tracks === tracks && trackLeftMemo.asked === asked && trackLeftMemo.label === label) {
		return trackLeftMemo.out;
	}
	const named = tracks.filter((tr) => tr.label === label);
	const left = (() => {
		if (!asked || named.length === 0) {
			return true;
		}
		const out = routeCoverage({ tracks: named, halfWidthNM: 0 }, asked);
		return out.failed.length + out.outside.length > 0;
	})();
	trackLeftMemo = { tracks, asked, label, out: left };
	return left;
}
