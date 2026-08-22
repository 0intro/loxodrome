/* TEMSI / WINTEM chart-catalog cache for the Weather tab (the
 * weather.svelte.ts ensure idiom): one entry per zone holding both
 * products, TTL-gated, in-flight-deduped, everything behind
 * display.liveWeather. The links inside are tokenized and EXPIRE, so the
 * TTL stays short and nothing here persists. The two catalog POSTs per
 * zone are paced like the route-NOTAM fetch (each is a session GET + a
 * POST upstream; SOFIA rate-limits bursts and is a safety-of-life
 * government service). */

import { untrack } from 'svelte';
import { display } from './display.svelte';
import { isFresh } from './asyncCache';
import { proxyBase } from '$lib/autorouter/state.svelte';
import {
	fetchSofiaCharts,
	type SofiaChart,
	type SofiaZone,
} from '$lib/sofia/charts';

const TTL_MS = 5 * 60_000;
const PACE_MS = 800;

export interface SofiaChartsEntry {
	status: 'loading' | 'ok' | 'error';
	temsi: SofiaChart[];
	wintem: SofiaChart[];
	error: string | null;
	fetchedAtMs: number;
}

export const sofiaCharts = $state<{
	/** The Weather tab's zone pick (session-only). */
	zone: SofiaZone;
	byZone: Record<string, SofiaChartsEntry>;
}>({ zone: 'FRANCE', byZone: {} });

// eslint-disable-next-line svelte/prefer-svelte-reactivity -- in-flight dedup bookkeeping, not state
const inflight = new Map<string, Promise<void>>();

function pause(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Start (or keep) the catalog fetch for a zone; cheap when fresh. Safe
 *  from component effects: the synchronous 'loading' stamp is untracked
 *  (the sibling-cache idiom), so a calling effect that read the entry
 *  through this call is not re-triggered by the write; the results are
 *  written from the async continuations. */
export function ensureSofiaCharts(zone: SofiaZone): void {
	if (!display.liveWeather) {
		return;
	}
	const cur = sofiaCharts.byZone[zone];
	// Errors are TTL-paced like successes: the minute tick re-runs this
	// ensure, and a failing SOFIA must not be retried every minute (the
	// Refresh button drops the entry for an immediate manual retry).
	if (inflight.has(zone) || (cur && cur.status !== 'loading' && isFresh(cur.fetchedAtMs, TTL_MS))) {
		return;
	}
	const prev = cur ?? { temsi: [], wintem: [], error: null, fetchedAtMs: 0 };
	untrack(() => {
		sofiaCharts.byZone[zone] = { ...prev, status: 'loading', error: null };
	});
	const p = (async () => {
		try {
			const temsi = await fetchSofiaCharts(proxyBase(), 'TEMSI', zone);
			await pause(PACE_MS);
			const wintem = await fetchSofiaCharts(proxyBase(), 'WINTEM', zone);
			sofiaCharts.byZone[zone] = {
				status: 'ok',
				temsi,
				wintem,
				error: null,
				fetchedAtMs: Date.now(),
			};
		} catch (err) {
			sofiaCharts.byZone[zone] = {
				...prev,
				status: 'error',
				error: err instanceof Error ? err.message : String(err),
				fetchedAtMs: Date.now(),
			};
		} finally {
			inflight.delete(zone);
		}
	})();
	inflight.set(zone, p);
}

/** The current zone's entry (no write on read). */
export function sofiaChartsEntry(): SofiaChartsEntry | null {
	return sofiaCharts.byZone[sofiaCharts.zone] ?? null;
}

/** Awaitable read-through for the print prefetches: per zone, a fresh cache
 *  entry answers without any network, else this awaits the shared (deduped,
 *  paced) ensure fetch and returns whatever entry settles, error entries
 *  included. One pacing authority: the Weather tab's minute-tick ensure and a
 *  print run can never double-POST SOFIA for the same zone, and consecutive
 *  zone fetches keep the same 800 ms spacing the two per-zone POSTs use.
 *  Zones absent from the result mean no catalog (live weather off). */
export async function sofiaChartsFor(
	zones: readonly SofiaZone[],
): Promise<Partial<Record<SofiaZone, SofiaChartsEntry>>> {
	const out: Partial<Record<SofiaZone, SofiaChartsEntry>> = {};
	let paced = false;
	for (const zone of zones) {
		const cur = sofiaCharts.byZone[zone];
		const fresh = cur && cur.status !== 'loading' && isFresh(cur.fetchedAtMs, TTL_MS);
		if (!inflight.has(zone) && fresh) {
			out[zone] = cur;
			continue;
		}
		if (paced) {
			await pause(PACE_MS);
		}
		ensureSofiaCharts(zone);
		const p = inflight.get(zone);
		if (p) {
			await p;
			paced = true;
		}
		const entry = sofiaCharts.byZone[zone];
		if (entry) {
			out[zone] = entry;
		}
	}
	return out;
}

/** Drop the zone's cache and refetch on the next ensure pass. */
export function refreshSofiaCharts(): void {
	delete sofiaCharts.byZone[sofiaCharts.zone];
}
