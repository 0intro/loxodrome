/* Night, in one state: the THEME (docs/nav-live.md "In-flight
 * ergonomics"). The night theme dims the map raster panes behind the
 * Display-tab intensity, identically whether it was reached by the
 * toolbar toggle or automatically; recording past civil twilight at the
 * aircraft position merely TRIGGERS that same theme, so the automatic
 * and the manual night never differ.
 *
 * The auto-trigger is EDGE-TRIGGERED so a manual override is never
 * fought: the dusk edge remembers the current theme and sets night, the
 * dawn edge (or the recording stopping) restores it. */

import { setTheme, theme, type Theme } from './theme.svelte';
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

let nightNow = false;
let themeBefore: Theme | null = null;

/** Reconcile the AUTOMATIC night trigger. The caller (App.svelte's
 *  effect, per minute tick) passes the pose ONLY while recording; null
 *  coordinates read as day, which is what ends the automatic night on
 *  landing or at a desk replay. Pure theme edges, no DOM: the dimming
 *  itself is the night theme's CSS. */
export function applyAutoNight(lat: number | null, lon: number | null, nowMs: number): void {
	const night = lat != null && lon != null && isCivilNightUtc(lat, lon, nowMs);
	if (night === nightNow) {
		return;
	}
	if (night) {
		themeBefore = theme.value;
		setTheme('night');
	} else if (themeBefore != null) {
		// Restore only while our own night setting is still in force: a
		// manual change between the edges wins in BOTH directions, so a
		// pilot who chose the day theme mid-night keeps it at dawn.
		if (theme.value === 'night') {
			setTheme(themeBefore);
		}
		themeBefore = null;
	}
	nightNow = night;
}
