/* TEMSI / WINTEM chart-catalog cache for the Weather tab and the print
 * prefetches (the weather.svelte.ts ensure idiom): one entry per zone holding
 * both products, in-flight-deduped, everything behind display.liveWeather.
 * The links inside are tokenized and EXPIRE, so the TTL stays short and no
 * catalog persists; the zone pick is a preference and does (setSofiaZone,
 * docs/preferences.md).
 *
 * A zone refresh asks for one anonymous session (sofia/session.ts) and spends
 * it on both catalog POSTs, paced like the route-NOTAM fetch (SOFIA
 * rate-limits bursts and is a safety-of-life government service). Each
 * product lands or fails ON ITS OWN, with its classified cause, so a failed
 * WINTEM never takes the TEMSI with it. The Weather tab paces its refreshes
 * by the TTL, failures included; a print never takes a failure it did not
 * see happen (sofiaChartsFor). Contract: docs/sofia-charts.md. */

import { untrack } from 'svelte';
import { display } from './display.svelte';
import { isFresh } from './asyncCache';
import { proxyBase } from '$lib/autorouter/state.svelte';
import {
	fetchSofiaChartsRetrying,
	SOFIA_CHART_PRODUCTS,
	SOFIA_ZONES,
	type SofiaChart,
	type SofiaChartProduct,
	type SofiaZone,
} from '$lib/sofia/charts';
import { SofiaError, type SofiaFailure, type SofiaFailureCode } from '$lib/sofia/failure';
import { fetchSofiaSession } from '$lib/sofia/session';
import { readItem, removeItem, writeItem } from './persist';

const ZONE_KEY = 'loxodrome:sofia-zone';
/** The zone the Weather tab opens on until another is picked. */
export const DEFAULT_SOFIA_ZONE: SofiaZone = 'FRANCE';

function storedZone(): SofiaZone {
	const v = readItem(ZONE_KEY);
	return SOFIA_ZONES.find((z) => z === v) ?? DEFAULT_SOFIA_ZONE;
}

const TTL_MS = 5 * 60_000;
const PACE_MS = 800;
/** How old a successful catalog a print may still use. The worker answers a
 *  catalog body from its own cache for 60 s (loxodrome-proxy/worker.js
 *  SOFIA_CACHE_TTL_MS), so asking again inside that window could only bring
 *  back the same links; past it, a print asks again. */
const PRINT_REUSE_MS = 60_000;

export interface SofiaChartsEntry {
	/** 'loading' while a refresh runs, 'error' when every product failed,
	 *  'ok' otherwise: a product may still have failed (`failures`). */
	status: 'loading' | 'ok' | 'error';
	temsi: SofiaChart[];
	wintem: SofiaChart[];
	/** The products the last refresh could not list, with why. A failed
	 *  product keeps the previous refresh's links for the Weather tab to show;
	 *  a print never uses them (catalogOf). */
	failures: Partial<Record<SofiaChartProduct, SofiaFailure>>;
	/** When the last refresh started, and when it settled. */
	startedAtMs: number;
	fetchedAtMs: number;
}

export const sofiaCharts = $state<{
	/** The Weather tab's zone pick, remembered (setSofiaZone). */
	zone: SofiaZone;
	byZone: Record<string, SofiaChartsEntry>;
}>({ zone: storedZone(), byZone: {} });

/** Pick the zone the Weather tab lists, and remember it: stored only away
 *  from France. */
export function setSofiaZone(zone: SofiaZone): void {
	sofiaCharts.zone = zone;
	if (zone === DEFAULT_SOFIA_ZONE) {
		removeItem(ZONE_KEY);
	} else {
		writeItem(ZONE_KEY, zone);
	}
}

// eslint-disable-next-line svelte/prefer-svelte-reactivity -- in-flight dedup bookkeeping, not state
const inflight = new Map<string, Promise<void>>();

function pause(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One run of catalog requests: an ensure, or one print's sofiaChartsFor.
 *  Once SOFIA has failed a request on the transport (and that request spent
 *  its retry), the rest of the run gets one attempt each; once the proxy has
 *  refused one as busy, the rest are not asked at all and carry that refusal.
 *  A dead service then costs the pilot one budget per request, not two. */
interface Breaker {
	retries: 0 | 1;
	busy: SofiaFailure | null;
}

function newBreaker(): Breaker {
	return { retries: 1, busy: null };
}

/** The failures that say the service or the road to it is failing, as
 *  opposed to SOFIA answering something about this one request. */
function isTransportFailure(code: SofiaFailureCode): boolean {
	return code === 'timeout' || code === 'unreachable' || code === 'upstream' || code === 'proxy';
}

/** Whether the entry carries a failure for any product. */
export function hasCatalogFailure(e: SofiaChartsEntry): boolean {
	return SOFIA_CHART_PRODUCTS.some((p) => e.failures[p] != null);
}

/** One product of an entry, as a print may use it: its charts when the last
 *  refresh listed it, else its failure. */
export function catalogOf(
	e: SofiaChartsEntry,
	product: SofiaChartProduct,
): { charts: SofiaChart[]; failure: null } | { charts: null; failure: SofiaFailure } {
	const failure = e.failures[product];
	if (failure) {
		return { charts: null, failure };
	}
	return { charts: product === 'TEMSI' ? e.temsi : e.wintem, failure: null };
}

/** Refresh one zone's catalog: a session, then each product on its own,
 *  paced. Registers itself in `inflight` synchronously, so anything asking
 *  after this call joins it. Never rejects. */
function refreshZone(zone: SofiaZone, breaker: Breaker): Promise<void> {
	const prev = sofiaCharts.byZone[zone];
	const startedAtMs = Date.now();
	// Untracked: a calling effect that read the entry through this call must
	// not be re-triggered by the stamp (the sibling-cache idiom); the results
	// are written from the async continuation.
	untrack(() => {
		sofiaCharts.byZone[zone] = {
			status: 'loading',
			temsi: prev?.temsi ?? [],
			wintem: prev?.wintem ?? [],
			failures: prev?.failures ?? {},
			startedAtMs,
			fetchedAtMs: prev?.fetchedAtMs ?? 0,
		};
	});
	const p = (async () => {
		const lists: Partial<Record<SofiaChartProduct, SofiaChart[]>> = {};
		const failures: Partial<Record<SofiaChartProduct, SofiaFailure>> = {};
		try {
			const session = await fetchSofiaSession(proxyBase());
			for (const [i, product] of SOFIA_CHART_PRODUCTS.entries()) {
				if (i > 0) {
					await pause(PACE_MS);
				}
				if (breaker.busy) {
					failures[product] = breaker.busy;
					continue;
				}
				try {
					lists[product] = await fetchSofiaChartsRetrying(proxyBase(), product, zone, {
						session,
						maxRetries: breaker.retries,
					});
				} catch (e) {
					const failure: SofiaFailure =
						e instanceof SofiaError
							? e.failure
							: { code: 'malformed', detail: e instanceof Error ? e.message : String(e) };
					failures[product] = failure;
					if (failure.code === 'busy') {
						breaker.busy = failure;
					} else if (isTransportFailure(failure.code)) {
						breaker.retries = 0;
					}
				}
			}
		} finally {
			const failed = SOFIA_CHART_PRODUCTS.filter((pr) => failures[pr] != null).length;
			sofiaCharts.byZone[zone] = {
				status: failed === SOFIA_CHART_PRODUCTS.length ? 'error' : 'ok',
				temsi: lists.TEMSI ?? prev?.temsi ?? [],
				wintem: lists.WINTEM ?? prev?.wintem ?? [],
				failures,
				startedAtMs,
				fetchedAtMs: Date.now(),
			};
			inflight.delete(zone);
		}
	})();
	inflight.set(zone, p);
	return p;
}

/** Start (or keep) the catalog fetch for a zone; cheap when fresh. Safe
 *  from component effects (refreshZone's untracked stamp). Failures are
 *  TTL-paced like successes: the minute tick re-runs this ensure, and a
 *  failing SOFIA must not be asked every minute (the Refresh button drops
 *  the entry for an immediate manual retry). `errorsBeforeMs` asks again for
 *  a failure older than a gesture (the print menu's readiness line, as it
 *  opens), once: the refresh it starts is newer than the gesture. */
export function ensureSofiaCharts(zone: SofiaZone, opts: { errorsBeforeMs?: number } = {}): void {
	if (!display.liveWeather || inflight.has(zone)) {
		return;
	}
	const cur = sofiaCharts.byZone[zone];
	if (cur && cur.status !== 'loading' && isFresh(cur.fetchedAtMs, TTL_MS)) {
		const staleFailure =
			opts.errorsBeforeMs != null && hasCatalogFailure(cur) && cur.startedAtMs < opts.errorsBeforeMs;
		if (!staleFailure) {
			return;
		}
	}
	void refreshZone(zone, newBreaker());
}

/** The current zone's entry (no write on read). */
export function sofiaChartsEntry(): SofiaChartsEntry | null {
	return sofiaCharts.byZone[sofiaCharts.zone] ?? null;
}

/** Whether a print that started at `runStartMs` may take the entry as it
 *  stands: what this run asked for itself (its failures included: they were
 *  retried already), or a complete success fresh enough that asking again
 *  would bring back the same links. A failure the run did not see happen is
 *  never taken: SOFIA may be back. */
function printMayUse(e: SofiaChartsEntry | undefined, runStartMs: number): boolean {
	if (!e || e.status === 'loading') {
		return false;
	}
	if (e.startedAtMs >= runStartMs) {
		return true;
	}
	return !hasCatalogFailure(e) && e.fetchedAtMs >= runStartMs - PRINT_REUSE_MS;
}

/** Awaitable read-through for the print prefetches. Per zone: an entry the
 *  run may use answers at once (printMayUse); a refresh in flight is joined,
 *  and asked again once if it began before the run and failed; anything else
 *  is fetched now. One pacing authority with the Weather tab's ensure: the
 *  two can never POST SOFIA twice at once for a zone, and consecutive zone
 *  refreshes keep the 800 ms spacing the per-zone POSTs use. One breaker for
 *  the whole call. Zones absent from the result mean no catalog (live
 *  weather off). Never rejects. */
export async function sofiaChartsFor(
	zones: readonly SofiaZone[],
	opts: { runStartMs: number },
): Promise<Partial<Record<SofiaZone, SofiaChartsEntry>>> {
	const out: Partial<Record<SofiaZone, SofiaChartsEntry>> = {};
	const breaker = newBreaker();
	let paced = false;
	for (const zone of zones) {
		if (!display.liveWeather) {
			break;
		}
		// Two rounds at most: join what is running, then fetch ourselves if
		// what it brought cannot serve this run.
		for (let round = 0; round < 2; round++) {
			const running = inflight.get(zone);
			if (running) {
				await running;
				paced = true;
			}
			if (printMayUse(sofiaCharts.byZone[zone], opts.runStartMs)) {
				break;
			}
			if (paced) {
				await pause(PACE_MS);
			}
			if (inflight.has(zone)) {
				continue; // another caller started one during the pause: join it
			}
			await refreshZone(zone, breaker);
			paced = true;
			break;
		}
		const entry = sofiaCharts.byZone[zone];
		if (entry && entry.status !== 'loading') {
			out[zone] = entry;
		}
	}
	return out;
}

/** Drop the zone's cache and refetch on the next ensure pass. */
export function refreshSofiaCharts(): void {
	delete sofiaCharts.byZone[sofiaCharts.zone];
}

/** Make a zone's next print ask SOFIA again: a chart link it listed turned
 *  out spent (an `expired` download), and only a fresh catalog has links
 *  that serve. The entry stays for the Weather tab, just no longer fresh. */
export function staleSofiaCharts(zone: string): void {
	const e = sofiaCharts.byZone[zone];
	if (e && e.status !== 'loading') {
		sofiaCharts.byZone[zone] = { ...e, startedAtMs: 0, fetchedAtMs: 0 };
	}
}
