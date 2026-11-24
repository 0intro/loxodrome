/* The Weather tab's DWD front-chart list (weather/frontCharts.ts,
 * docs/front-charts.md): one cached index of both halves, the analyses
 * through the relay and the forecast files' dates straight from www.dwd.de,
 * asked while the tab is open and live weather is on. Paced by its own
 * lifetime: an analysis lands every six hours and the forecasts four times a
 * day, so a quarter of an hour is fresh, and the minute tick that calls the
 * ensure costs nothing in between. A failure is paced the same way. Prints
 * do not read this: a print asks its own index, current to the click
 * (components/flightprep/chartsPrefetch.ts fetchFrontsForPrint). */

import { untrack } from 'svelte';
import { display } from './display.svelte';
import { isFresh } from './asyncCache';
import { proxyBase } from '$lib/autorouter/state.svelte';
import { fetchFrontIndex, type FrontChartsIndex } from '$lib/weather/frontCharts';

const TTL_MS = 15 * 60_000;

export interface FrontChartsEntry {
	status: 'loading' | 'ok';
	/** The last index asked (kept through a refresh, so the list stays). */
	index: FrontChartsIndex | null;
	fetchedAtMs: number;
}

export const frontCharts = $state<{ entry: FrontChartsEntry | null }>({ entry: null });

/** The request in flight: a plain module variable, never a reactive read. */
let inflight: Promise<void> | null = null;

/** Ask for the index unless a fresh one is held or one is on its way. Reads
 *  and writes the cache untracked, so a calling effect subscribes to none of
 *  what it starts (the effect-writes-subscribe trap). */
export function ensureFrontCharts(): void {
	if (!display.liveWeather || inflight) {
		return;
	}
	const cur = untrack(() => frontCharts.entry);
	if (cur && cur.status === 'ok' && isFresh(cur.fetchedAtMs, TTL_MS)) {
		return;
	}
	untrack(() => {
		frontCharts.entry = { status: 'loading', index: cur?.index ?? null, fetchedAtMs: cur?.fetchedAtMs ?? 0 };
	});
	inflight = (async () => {
		try {
			const index = await fetchFrontIndex(proxyBase());
			frontCharts.entry = { status: 'ok', index, fetchedAtMs: index.fetchedAtMs };
		} finally {
			inflight = null;
		}
	})();
}

/** The section's Refresh: forget the stamp and ask again. */
export function refreshFrontCharts(): void {
	const cur = frontCharts.entry;
	if (cur && cur.status === 'ok') {
		frontCharts.entry = { ...cur, fetchedAtMs: 0 };
	}
	ensureFrontCharts();
}
