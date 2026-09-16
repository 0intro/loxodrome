/* SIGMET session cache: ONE small global fetch (the two AWC feeds cover
 * the whole world in ~100 KB), TTL-paced, auto-refreshed by the shared
 * minute tick through the MapView ensure effect (the 4a2dafe rules:
 * failures stamp the cache so outages retry at the TTL, never per
 * minute). Reactivity contract (the metarStations one): the normalised
 * list lives in a plain module variable and consumers re-derive through
 * the `seq` counter; ensure-path status writes happen inside untrack().
 * Everything is gated on display.liveWeather; the map draw additionally
 * on the show-on-map toggle, but a SELECTED sigmet keeps the fetch alive
 * so its panel fills with the layer off (linked lists always show). */

import { untrack } from 'svelte';
import { readItem, removeItem, writeItem } from './persist';
import { isFresh } from './asyncCache';
import { display } from './display.svelte';
import { ui } from './ui.svelte';
import { activeAltitudeBand } from './filter.svelte';
import { activeEvalWindow } from './notam.svelte';
import { firRowsForIdent } from './data.svelte';
import { pointInRing } from '$lib/data/airspaces';
import { fetchAirsigmets, fetchIsigmets } from '$lib/weather/awc';
import {
	fromAirsigmet,
	fromIsigmet,
	ringAreaDeg2,
	sigmetActiveDuring,
	sigmetInBand,
	uniqueSigmetIds,
	type Sigmet,
} from '$lib/weather/sigmet';

const SHOW_KEY = 'loxodrome:sigmet-map';
const TTL_MS = 5 * 60_000;

export const sigmets = $state<{
	showOnMap: boolean;
	/** The Weather tab is rendered (its list shows with the map toggle
	 *  off, so it keeps the fetch alive too); session-only. */
	tabOpen: boolean;
	status: 'idle' | 'loading' | 'ok' | 'error';
	error: string | null;
	fetchedAtMs: number;
	/** Bumped per completed fetch; consumers re-derive through it. */
	seq: number;
}>({
	showOnMap: readItem(SHOW_KEY) === 'on',
	tabOpen: false,
	status: 'idle',
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
let all: Sigmet[] = [];
let inflight: Promise<void> | null = null;

/** Whether anything needs the SIGMET set: the map layer, the Weather
 *  tab's list, or an open sigmet panel (which must fill even with the
 *  layer off). Tracked. */
export function sigmetsWanted(): boolean {
	return sigmets.showOnMap || sigmets.tabOpen || ui.detail?.kind === 'sigmet';
}

/** Start (or keep) the global fetch. Cheap when fresh; failures stamp
 *  fetchedAtMs so the minute tick retries at the TTL. One feed failing
 *  keeps the other's advisories (a safety layer degrades, never blanks). */
export function ensureSigmets(nowMs = Date.now()): void {
	if (!display.liveWeather || !sigmetsWanted()) {
		untrack(() => {
			if (sigmets.status !== 'idle') {
				sigmets.status = 'idle';
				sigmets.error = null;
			}
		});
		return;
	}
	if (inflight || isFresh(sigmets.fetchedAtMs, TTL_MS, nowMs)) {
		// Fresh data returning from the gated-off idle (toggle flip within
		// the TTL) is still good; no refetch.
		untrack(() => {
			if (sigmets.status === 'idle' && all.length > 0) {
				sigmets.status = 'ok';
			}
		});
		return;
	}
	untrack(() => {
		if (all.length === 0) {
			sigmets.status = 'loading';
		}
	});
	inflight = Promise.allSettled([fetchIsigmets(), fetchAirsigmets()])
		.then(([intl, us]) => {
			const next: Sigmet[] = [];
			if (intl.status === 'fulfilled') {
				next.push(...intl.value.map(fromIsigmet));
			}
			if (us.status === 'fulfilled') {
				next.push(...us.value.map(fromAirsigmet));
			}
			sigmets.fetchedAtMs = Date.now();
			if (intl.status === 'rejected' && us.status === 'rejected') {
				sigmets.status = 'error';
				sigmets.error =
					intl.reason instanceof Error ? intl.reason.message : String(intl.reason);
				return;
			}
			all = uniqueSigmetIds(next);
			sigmets.status = 'ok';
			sigmets.error = null;
			sigmets.seq++;
		})
		.finally(() => {
			inflight = null;
		});
}

/** Drop the cache and refetch on the next ensure pass (the Refresh button). */
export function refreshSigmets(): void {
	all = [];
	sigmets.fetchedAtMs = 0;
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

/** The smallest visible advisory containing the point; the map hit-test
 *  (gated on the toggle: a hidden layer is not clickable, the house
 *  invariant; panel links still reach hidden advisories). */
export function sigmetAt(lat: number, lon: number): Sigmet | null {
	if (!display.liveWeather || !sigmets.showOnMap) {
		return null;
	}
	let best: Sigmet | null = null;
	let bestArea = Infinity;
	for (const s of visibleSigmets()) {
		const rings = sigmetRings(s);
		for (const ring of rings) {
			if (pointInRing(lat, lon, ring)) {
				const area = ringAreaDeg2(ring);
				if (area < bestArea) {
					best = s;
					bestArea = area;
				}
				break;
			}
		}
	}
	return best;
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
