/* Night, in one state: the THEME (docs/nav-live.md "In-flight
 * ergonomics"). The night theme dims the map raster panes behind the
 * Settings-tab intensity, identically whether it was reached by a choice or
 * automatically; recording past civil twilight at the aircraft position
 * merely TRIGGERS that same theme, so the automatic and the manual night
 * never differ.
 *
 * The auto-trigger is EDGE-TRIGGERED so a manual override is never
 * fought: the dusk edge turns the automatic night on, the dawn edge (or the
 * recording stopping) turns it off, and a Day or Night the pilot picks in
 * between ends it at once (state/theme.svelte.ts). The automatic night is
 * never written into the pilot's theme choice, so nothing here has to be
 * remembered and put back: when it ends, the choice shows through again. */

import { pastDuskAtLoad, setAutoNight } from './theme.svelte';
import { readItem, removeItem, writeItem } from './persist';
import { isCivilNightUtc } from '$lib/route/sun';

const DIM_KEY = 'loxodrome:night-dim';

export const DIM_MIN_PCT = 40;
export const DIM_MAX_PCT = 100;
const DIM_DEFAULT_PCT = 70;

function initialDim(): number {
	const raw = readItem(DIM_KEY);
	if (raw == null) {
		return DIM_DEFAULT_PCT;
	}
	const n = Number(raw);
	return Number.isFinite(n) && n >= DIM_MIN_PCT && n <= DIM_MAX_PCT ? n : DIM_DEFAULT_PCT;
}

/** Raster brightness in the night theme, percent. */
export const nightDim = $state<{ pct: number }>({ pct: initialDim() });

export function setNightDim(pct: number): void {
	const p = Math.min(DIM_MAX_PCT, Math.max(DIM_MIN_PCT, Math.round(pct)));
	nightDim.pct = p;
	if (p === DIM_DEFAULT_PCT) {
		removeItem(DIM_KEY);
	} else {
		writeItem(DIM_KEY, String(p));
	}
}

/** Put the night dimming back to its default, in place, storage included
 *  (Restore default settings). */
export function restoreNightDimDefault(): void {
	setNightDim(DIM_DEFAULT_PCT);
}

/** The last edge seen. Seeded from the automatic night's transient key at
 *  load, in force or held by a pick (state/theme.svelte.ts), so a restart
 *  during a night recording resumes past the dusk edge rather than firing
 *  it again, over the pilot's pick too, and a boot away from any flight
 *  ends it on the first reconcile. */
let nightNow = pastDuskAtLoad;

/** Reconcile the AUTOMATIC night trigger. The caller (App.svelte's effect,
 *  per minute tick) passes where the aircraft is: the pose while recording,
 *  or the last fix of a flight the app went away in the middle of, which
 *  may END the night (dawn there) but never start one (`canStart` false),
 *  and null with no flight, which reads as day and is what ends the
 *  automatic night at the stop or at a desk replay. With a recording but no
 *  fix yet the caller passes nothing at all: unknown is not day. Pure theme
 *  edges, no DOM: the dimming itself is the night theme's CSS. */
export function applyAutoNight(
	lat: number | null,
	lon: number | null,
	nowMs: number,
	canStart = true,
): void {
	const night = lat != null && lon != null && isCivilNightUtc(lat, lon, nowMs);
	if (night === nightNow || (night && !canStart)) {
		return;
	}
	nightNow = night;
	setAutoNight(night);
}

/** One reconcile over where the automatic night is judged (navRecording's
 *  autoNightFix, which App.svelte's effect passes per minute tick): a pose,
 *  an interrupted flight's last fix that may only end the night, null for no
 *  flight, or `undefined` while a recording has no fix yet, which is unknown
 *  and changes nothing (a restart must not end the night before the resumed
 *  recording's first fix). */
export function reconcileAutoNight(
	at: { lat: number; lon: number; canStart: boolean } | null | undefined,
	nowMs: number,
): void {
	if (at === undefined) {
		return;
	}
	applyAutoNight(at?.lat ?? null, at?.lon ?? null, nowMs, at?.canStart ?? true);
}
