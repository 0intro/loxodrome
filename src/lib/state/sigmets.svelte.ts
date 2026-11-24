/* SIGMET session cache: ONE small global fetch (the two AWC feeds cover
 * the whole world in ~100 KB), TTL-paced, auto-refreshed by the shared
 * minute tick through the MapView ensure effect (the 4a2dafe rules:
 * every attempt stamps its own pacing clock, so outages retry at the TTL,
 * never per minute). Each feed's last answer is held apart and kept
 * through a failure of that feed, a failed refresh and a closed gate: a
 * session keeps what it fetched, and the status says which feed it could
 * not refresh. Reactivity contract (the metarStations one): the
 * normalised list lives in a plain module variable and consumers
 * re-derive through the `seq` counter; ensure-path status writes happen
 * inside untrack(). Everything is gated on display.liveWeather; the map
 * draw additionally on the show-on-map toggle, but a SELECTED sigmet
 * keeps the fetch alive so its panel fills with the layer off (linked
 * lists always show), and so does a planned route, whose advisories the
 * Overview and the print review state (state/planSigmets.svelte.ts). */

import { untrack } from 'svelte';
import { readItem, removeItem, writeItem } from './persist';
import { isFresh } from './asyncCache';
import { display } from './display.svelte';
import { routes } from './route.svelte';
import { ui } from './ui.svelte';
import { activeAltitudeBand } from './filter.svelte';
import { activeEvalWindow } from './notam.svelte';
import { firRowsForIdent } from './data.svelte';
import { pointInRing } from '$lib/data/airspaces';
import { ringAreaM2 } from '$lib/notam/geometry';
import { fetchAirsigmets, fetchIsigmets } from '$lib/weather/awc';
import {
	fromAirsigmet,
	fromIsigmet,
	sigmetActiveDuring,
	sigmetInBand,
	uniqueSigmetIds,
	type Sigmet,
} from '$lib/weather/sigmet';

const SHOW_KEY = 'loxodrome:sigmet-map';
const TTL_MS = 5 * 60_000;

/** The feeds an attempt failed to refresh. */
export type SigmetFeedFailure = 'intl' | 'us' | 'both';

export const sigmets = $state<{
	showOnMap: boolean;
	/** The Weather tab is rendered (its list shows with the map toggle
	 *  off, so it keeps the fetch alive too); session-only. */
	tabOpen: boolean;
	/** The last attempt's outcome ('idle' before the first). */
	status: 'idle' | 'loading' | 'ok' | 'error';
	/** The feeds the last attempt failed to refresh, set with 'error'. */
	failed: SigmetFeedFailure | null;
	/** The first failure's wire line, in English (docs/i18n.md rule 7). */
	error: string | null;
	/** When both feeds last answered: the age of what the list holds. */
	fetchedAtMs: number;
	/** Bumped per settled attempt and per Refresh: consumers re-derive
	 *  through it. */
	seq: number;
}>({
	showOnMap: readItem(SHOW_KEY) === 'on',
	tabOpen: false,
	status: 'idle',
	failed: null,
	error: null,
	fetchedAtMs: 0,
	seq: 0,
});

export function setShowSigmetsOnMap(on: boolean): void {
	sigmets.showOnMap = on;
	if (on) {
		writeItem(SHOW_KEY, 'on');
	} else {
		removeItem(SHOW_KEY);
	}
}

// Plain (non-reactive) bookkeeping; see the contract in the header.
/** Each feed's last answer. `all` is their merge. */
const held: { intl: Sigmet[]; us: Sigmet[] } = { intl: [], us: [] };
let all: Sigmet[] = [];
/** Which feeds the last settled attempt brought. A feed that failed keeps
 *  its last answer held, which lacks what was issued since. */
const lastAnswer = { intl: false, us: false };
let inflight: Promise<void> | null = null;
/** When the last attempt settled, answered or failed: what paces the next
 *  one. A Refresh zeroes it. */
let attemptedAtMs = 0;

/** Whether anything needs the SIGMET set: the map layer, the Weather
 *  tab's list, an open sigmet panel (which must fill even with the layer
 *  off), or a planned route. Tracked. */
export function sigmetsWanted(): boolean {
	return (
		sigmets.showOnMap ||
		sigmets.tabOpen ||
		ui.detail?.kind === 'sigmet' ||
		routes.list.some((r) => r.waypoints.length >= 2)
	);
}

/** A settled feed's failure as its wire line, null when it answered. */
function failureOf(r: PromiseSettledResult<unknown>): string | null {
	if (r.status === 'fulfilled') {
		return null;
	}
	return r.reason instanceof Error ? r.reason.message : String(r.reason);
}

/** Start (or keep) the global fetch. Cheap when fresh. Every attempt
 *  stamps the pacing clock, so the minute tick retries a failure at the
 *  TTL. A feed that fails keeps its last answer beside the other's (a
 *  safety layer degrades, never blanks), and the outcome stands until the
 *  next attempt, whatever the gate does meanwhile. */
export function ensureSigmets(nowMs = Date.now()): void {
	if (!display.liveWeather || !sigmetsWanted()) {
		return;
	}
	if (inflight || isFresh(attemptedAtMs, TTL_MS, nowMs)) {
		return;
	}
	untrack(() => {
		if (all.length === 0) {
			sigmets.status = 'loading';
		}
	});
	inflight = Promise.allSettled([fetchIsigmets(), fetchAirsigmets()])
		.then(([intl, us]) => {
			attemptedAtMs = Date.now();
			if (intl.status === 'fulfilled') {
				held.intl = intl.value.map(fromIsigmet);
			}
			if (us.status === 'fulfilled') {
				held.us = us.value.map(fromAirsigmet);
			}
			lastAnswer.intl = intl.status === 'fulfilled';
			lastAnswer.us = us.status === 'fulfilled';
			const intlError = failureOf(intl);
			const usError = failureOf(us);
			if (intlError === null || usError === null) {
				all = uniqueSigmetIds([...held.intl, ...held.us]);
			}
			sigmets.seq++;
			if (intlError === null && usError === null) {
				sigmets.status = 'ok';
				sigmets.failed = null;
				sigmets.error = null;
				sigmets.fetchedAtMs = attemptedAtMs;
				return;
			}
			sigmets.status = 'error';
			sigmets.failed = intlError === null ? 'us' : usError === null ? 'intl' : 'both';
			sigmets.error = intlError ?? usError;
		})
		.finally(() => {
			inflight = null;
		});
}

/** A fresh set for a print: asks again past the TTL, or at once after an
 *  attempt that failed a feed, and settles once that attempt has (at once
 *  while the gate is closed). */
export function sigmetsSettled(nowMs = Date.now()): Promise<void> {
	if (!inflight && attemptedAtMs > 0 && !(lastAnswer.intl && lastAnswer.us)) {
		attemptedAtMs = 0;
	}
	ensureSigmets(nowMs);
	return inflight ?? Promise.resolve();
}

/** Whether the last attempt brought the feeds a plan needs, the
 *  international one always and the US one for a plan reaching the
 *  Americas: what lets a surface say none meets the plan rather than that
 *  it cannot tell. Tracked via seq. */
export function sigmetsKnown(needUs = false): boolean {
	void sigmets.seq;
	return lastAnswer.intl && (!needUs || lastAnswer.us);
}

/** Every advisory held, whatever the viewing period and level band: what a
 *  surface about the planned flight judges. Tracked via seq. */
export function allSigmets(): Sigmet[] {
	void sigmets.seq;
	return all;
}

/** Refetch on the next ensure pass (the Refresh button). What is held stays
 *  listed and drawn until an answer replaces it. */
export function refreshSigmets(): void {
	attemptedAtMs = 0;
	sigmets.status = 'loading';
	sigmets.seq++;
}

/** The advisories active in the evaluation window (the viewing period when set,
 *  else now onwards on the minute tick) and overlapping the altitude
 *  filter band. Tracked via seq / the window / the band. */
export function visibleSigmets(): Sigmet[] {
	void sigmets.seq;
	const w = activeEvalWindow();
	const band = activeAltitudeBand();
	return all.filter((s) => sigmetActiveDuring(s, w.from, w.to) && sigmetInBand(s, band));
}

/** The rings a sigmet draws: its own ring, else the loaded rings of its
 *  FIR (a FIR-wide advisory; several rows per ident are normal). Reactive
 *  on the airspace dataset load through firRowsForIdent. */
export function sigmetRings(s: Sigmet): [number, number][][] {
	if (s.ring) {
		return [s.ring];
	}
	if (!s.fir) {
		return [];
	}
	return firRowsForIdent(s.fir)
		.map((a) => a.ring)
		.filter((r) => r.length >= 3);
}

/** One advisory by id, from the full set (selection is filter-independent
 *  so an expired selection still shows its panel). */
export function sigmetById(id: string): Sigmet | null {
	void sigmets.seq;
	return all.find((s) => s.id === id) ?? null;
}

/** The selected sigmet, once the cache holds it. */
export function selectedSigmet(): Sigmet | null {
	return ui.detail?.kind === 'sigmet' ? sigmetById(ui.detail.id) : null;
}

/** An advisory under the point, with the footprint of the RING that contained
 *  it: what the click resolver ranks against the other area kinds. A FIR-wide
 *  advisory has no ring of its own and is hit-tested against its FIR's rows, so
 *  measuring the advisory rather than the ring would leave it unmeasurable. */
export interface SigmetAreaHit {
	sigmet: Sigmet;
	areaM2: number;
}

/** The smallest visible advisory containing the point; the map hit-test
 *  (gated on the toggle: a hidden layer is not clickable, the house
 *  invariant; panel links still reach hidden advisories). */
export function sigmetAreaAt(lat: number, lon: number): SigmetAreaHit | null {
	if (!display.liveWeather || !sigmets.showOnMap) {
		return null;
	}
	let best: SigmetAreaHit | null = null;
	for (const s of visibleSigmets()) {
		for (const ring of sigmetRings(s)) {
			if (pointInRing(lat, lon, ring)) {
				// Same shoelace ordering this always used, now in the metres
				// the cross-kind ranking needs: the cos(lat) scale is monotone,
				// so the advisory this picks is unchanged.
				const areaM2 = ringAreaM2(ring);
				if (!best || areaM2 < best.areaM2) {
					best = { sigmet: s, areaM2 };
				}
				break;
			}
		}
	}
	return best;
}

/** The same answer without the footprint, for callers that only need the row. */
export function sigmetAt(lat: number, lon: number): Sigmet | null {
	return sigmetAreaAt(lat, lon)?.sigmet ?? null;
}

/** Every visible advisory containing the point (the context menu). */
export function sigmetsAt(lat: number, lon: number): Sigmet[] {
	if (!display.liveWeather || !sigmets.showOnMap) {
		return [];
	}
	return visibleSigmets().filter((s) =>
		sigmetRings(s).some((ring) => pointInRing(lat, lon, ring)),
	);
}
