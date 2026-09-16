/* WHICH instant the weather map is drawn for.
 *
 * The toolbar's viewing period is the app's one statement of when the map is
 * read, and every other dated surface obeys it (NOTAMs, SUP AIP, the
 * activation hatch, SIGMETs, the cue rings, the profile overlays). The
 * winds-aloft family joins them here: its valid time DEFAULTS to the period's
 * own instant (state/timeWindow.svelte.ts's periodAnchor), so briefing
 * tomorrow's flight no longer draws today's barbs over it, and the hour the
 * map shows is the hour the nav log's first leg flies.
 *
 * It resolves on READ, the effectiveTransitionAltFt idiom, rather than being
 * mirrored into a field by an effect: an instant written by two owners drifts,
 * and only a pure rule can be pinned by a spec (vitest mounts no component).
 *
 * Its own module because windAloft.svelte.ts cannot host it: routeWind (home
 * of the flight's departure) and route.svelte both import windAloft, so the
 * resolution there would close a cycle. Nothing imports THIS module but the
 * two components that display and fetch, which is what keeps that true.
 *
 * Reads reactive state, so call these inside a $derived or $effect. */

import { untrack } from 'svelte';
import { forecastRangeEndMs, windModel, type WindModelId } from '$lib/weather/openMeteo';
import { filter } from './filter.svelte';
import { flightPrep } from './flightPrep.svelte';
import { mapState } from './map.svelte';
import { notamState } from './notam.svelte';
import {
	customWindow,
	periodAnchor,
	plannedFlightWindow,
	type PeriodAnchorSource,
} from './timeWindow.svelte';
import { effectiveWindModel, floorHourMs, windAloft, windGrid } from './windAloft.svelte';

/** Where the shown instant comes from: the period's own sources, or the
 *  pilot's own hand. */
export type WxTimeSource = PeriodAnchorSource | 'pin';

export interface WxValidTime {
	/** The instant the map draws and the panel's Valid field shows. */
	ms: number;
	/** The period's own instant, unclamped: what `ms` would be if the forecast
	 *  reached that far, which is what the shortfall note names. */
	briefedMs: number;
	source: WxTimeSource;
	/** Where the PERIOD's own instant comes from, whether or not a pin is
	 *  covering it: what the panel's second anchor button offers and names. */
	periodSource: PeriodAnchorSource;
	/** `ms` was pulled back to `reachEndMs` because the forecast stops short. */
	clamped: boolean;
	/** The last hour this model can answer for. */
	reachEndMs: number;
}

/** The pilot's own instant, and the period statement it was set under. The
 *  period taking the instant back IS that statement changing, so the pin
 *  carries it rather than a "touched" bit: a pin made under one period must
 *  not revive when that period comes round again. Session-only, like the
 *  instant it overrides. */
const pinned = $state<{ atMs: number | null; sig: string }>({ atMs: null, sig: '' });

/** The last hour a forecast can answer for: the model's own horizon from the
 *  current hour, and never past the endpoint's own range (GFS sees 384 h,
 *  Open-Meteo's forecast API accepts +15 days, so the min is load-bearing).
 *  Pure. */
export function forecastReachEndMs(nowMs: number, horizonH: number): number {
	return Math.min(floorHourMs(nowMs) + horizonH * 3600_000, forecastRangeEndMs(nowMs));
}

/** What the period ASKS FOR, judged against what the model can answer: a
 *  flight further out than the forecast reaches shows the last hour it does
 *  reach, with the shortfall said rather than implied, so the map keeps its
 *  barbs instead of going blank on the default. Pure. */
export function clampToReach(atMs: number, reachEndMs: number): { ms: number; clamped: boolean } {
	return atMs > reachEndMs ? { ms: reachEndMs, clamped: true } : { ms: atMs, clamped: false };
}

/** The period statement the pin is judged against: what DEFINES the default
 *  instant, never what merely moves it. The look-ahead is out (6 / 24 / 48 h
 *  all start now), and so is the clock, so a pin taken under 'now' survives
 *  the hour rolling over. Whether each sourced branch RESOLVES is in, though:
 *  a range typed from > to, or a route deleted under a flight period, falls
 *  through to the current hour, and the instant moving is the whole test. */
function periodSig(): string {
	const w = filter.window;
	if (w.mode === 'custom') {
		return `custom|${w.fromDate}|${w.fromTime}|${customWindow() != null}`;
	}
	if (w.mode === 'flight') {
		const d = flightPrep.dossier;
		return `flight|${d.flightDate ?? ''}|${d.departureTime ?? ''}|${plannedFlightWindow() != null}`;
	}
	return 'now';
}

/** The model the lattice is being read through: the one that served it, else
 *  the one the map centre resolves to (the Weather tab's own rule). */
export function wxModelInUse(): WindModelId {
	return windGrid.model ?? effectiveWindModel(mapState.center.lat, mapState.center.lng);
}

/** What the period alone shows, clamped to the forecast's reach: the value a
 *  hand-set instant is judged equal to before it counts as a pin, and the
 *  answer itself whenever nothing is pinned. */
function periodInstant(nowMs: number): {
	ms: number;
	briefedMs: number;
	source: PeriodAnchorSource;
	clamped: boolean;
	reachEndMs: number;
} {
	const reachEndMs = forecastReachEndMs(nowMs, windModel(wxModelInUse()).horizonH);
	const a = periodAnchor(nowMs);
	const { ms, clamped } = clampToReach(a.ms, reachEndMs);
	return { ms, briefedMs: a.ms, source: a.source, clamped, reachEndMs };
}

/** The instant the weather map is read at, and why. Tracked. */
export function wxValidTime(): WxValidTime {
	const p = periodInstant(Date.now());
	if (p.source === 'now' || p.source === 'flight-day') {
		// Only the wall-clock-relative sources opt into the 60-second
		// heartbeat, as activeEvalWindow does it: a typed range or a stated
		// ETD must not re-render once a minute. This read is what makes 'now'
		// mean now rather than the hour the page was opened at.
		void notamState.tick;
	}
	if (pinned.atMs !== null && pinned.sig === periodSig()) {
		// A pinned instant is the pilot's own instruction and is never
		// clamped: the note says the forecast does not reach it.
		return {
			ms: pinned.atMs,
			briefedMs: p.briefedMs,
			source: 'pin',
			periodSource: p.source,
			clamped: false,
			reachEndMs: p.reachEndMs,
		};
	}
	return { ...p, periodSource: p.source };
}

/** The instant alone: the hot path for the map layers and the fetch. */
export function wxValidTimeMs(): number {
	return wxValidTime().ms;
}

/** Show `ms`. A value equal to what the period already shows releases the pin
 *  instead of setting one (the setWaypointAltitude(id, ft, autoTarget) idiom),
 *  so pressing Now while the period IS now hands the field back rather than
 *  freezing it. */
export function setWxValidTime(ms: number): void {
	if (ms === untrack(() => periodInstant(Date.now()).ms)) {
		releaseWxValidTime();
		return;
	}
	pinned.atMs = ms;
	pinned.sig = untrack(periodSig);
}

/** Hand the shown instant back to the viewing period. */
export function releaseWxValidTime(): void {
	pinned.atMs = null;
	pinned.sig = '';
}

/** Drop a pin the period has moved out from under. Called from one always
 *  mounted effect: wxValidTime() already ignores such a pin, but a stale one
 *  left in place would REVIVE if the pilot came back to the period it was
 *  taken under, and the period is meant to take the instant back for good. */
export function reconcileWxPin(): void {
	const sig = periodSig();
	untrack(() => {
		if (pinned.atMs !== null && pinned.sig !== sig) {
			releaseWxValidTime();
		}
	});
}

/** Engage the animation slider, FREEZING the instant its span is built
 *  around: the lattice's cache namespace keys on that span's floored hours,
 *  so an anchor that followed the scrub would re-key, and refetch the whole
 *  viewport, on every frame. Idempotent, so a scrub mid-sweep keeps the
 *  anchor it started from. */
export function startWxAnimation(): void {
	if (windAloft.animAnchorMs === null) {
		windAloft.animAnchorMs = untrack(() => wxValidTime().ms);
	}
}

/** Leave the animation: the lattice narrows back to its two-hour window
 *  around the shown instant, which keeps the scrub position. */
export function stopWxAnimation(): void {
	windAloft.animAnchorMs = null;
	windAloft.playing = false;
}
