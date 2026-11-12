/* Lazily-loaded aerodrome chart-link datasets, one per publisher: SIA
 * (cmd/adcharts), NATS (cmd/ukcharts), FAA d-TPP (cmd/faa), Austro
 * Control (cmd/at), DFS (cmd/de) and the eAIP States' indexes (cmd/eaip,
 * $lib/data/aipCharts), each of those found by the aerodrome's ICAO
 * prefix rather than its publisher. Most are AIRAC-slot-picked like the
 * primary datasets in data.svelte.ts; the DFS permalinks are
 * cycle-independent. The lists and indexes stay outside $state (immutable
 * after load); only load status is reactive. Re-exported through
 * data.svelte.ts, the importers' single entry point. */

import {
	FR_ADCHARTS_URL,
	FR_ADCHARTS_NEXT_URL,
	loadFrAdCharts,
	type AerodromeCharts,
} from '$lib/data/adcharts';
import type { VacAtlas } from '$lib/data/airports';
import { retryAfterFailure, retryCleared, retryRefusal } from '$lib/state/dataRetry.svelte';
import {
	UK_ADCHARTS_URL,
	UK_ADCHARTS_NEXT_URL,
	loadUkAdCharts,
	type AerodromeCharts as UkAerodromeCharts,
} from '$lib/data/ukAdcharts';
import {
	US_ADCHARTS_URL,
	US_ADCHARTS_NEXT_URL,
	loadUsAdCharts,
	type AerodromeCharts as UsAerodromeCharts,
} from '$lib/data/usAdcharts';
import {
	AT_ADCHARTS_URL,
	AT_ADCHARTS_NEXT_URL,
	loadAtAdCharts,
	type AerodromeAipLinks,
} from '$lib/data/atAdcharts';
import {
	DE_ADCHARTS_URL,
	loadDeAdCharts,
	type AerodromeAipLink,
} from '$lib/data/deAdcharts';
import { AIP_CHART_INDEXES, aipChartIndexFor, aipChartsUrl, loadAipCharts } from '$lib/data/aipCharts';
import {
	loadFrAdChartsMeta,
	loadFrAdChartsNextMeta,
	loadUkAdChartsMeta,
	loadUkAdChartsNextMeta,
	loadUsAdChartsMeta,
	loadUsAdChartsNextMeta,
	loadAtAdChartsMeta,
	loadAtAdChartsNextMeta,
	aipChartsMeta,
	loadActiveSlot,
	type SidecarLoader,
} from '$lib/data/meta';

const NO_CHARTS: never[] = [];

interface ChartSetStatus {
	loaded: boolean;
	loading: boolean;
	error: string | null;
}

/** Load status per publisher; the row data itself is non-reactive. */
export const adChartsState = $state<Record<'fr' | 'uk' | 'us' | 'at' | 'de', ChartSetStatus>>({
	fr: { loaded: false, loading: false, error: null },
	uk: { loaded: false, loading: false, error: null },
	us: { loaded: false, loading: false, error: null },
	at: { loaded: false, loading: false, error: null },
	de: { loaded: false, loading: false, error: null },
});

/** Load status per eAIP chart index, every index's entry present from the
 *  start so a lookup's read of it is tracked before the load begins. */
export const aipChartsState = $state<Record<string, ChartSetStatus>>(
	Object.fromEntries(AIP_CHART_INDEXES.map((x) => [x.id, { loaded: false, loading: false, error: null }])),
);

/** The publisher a chart set's retry names in the banner: its key's id,
 *  the US set being the FAA's. */
function chartPart(key: string): string {
	const id = key.slice('charts:'.length);
	return id === 'us' ? 'faa' : id;
}

function message(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** One lazily-loaded per-publisher chart dataset: an idempotent `ensure`
 *  (fail-soft callers catch its rejection) and an ident lookup that reads
 *  the loaded flag so a `$derived` re-runs once the plain index fills. A
 *  read that failed for a reason that may pass is read again by the retry
 *  schedule (state/dataRetry.svelte.ts) under `key`, and until then every
 *  ensure answers that failure without reading again; the panel fills in
 *  when the retry lands. `meta` / `nextMeta` / `nextUrl` make it
 *  AIRAC-slot-picked like ensureAerodromeFacilities; without them the
 *  dataset is a single cycle-independent file (DE). */
function chartSet<T extends { ident: string }>(cfg: {
	/** The set's key with the retry schedule. */
	key: string;
	status: ChartSetStatus;
	meta?: SidecarLoader<{ effective: string } | null>;
	nextMeta?: SidecarLoader<{ effective: string } | null>;
	url: string;
	nextUrl?: string;
	load: (url: string, nowMs: number) => Promise<T[]>;
}): { ensure: () => Promise<T[]>; byIdent: (ident: string) => T | null } {
	let list: T[] | null = null;
	let index: Map<string, T> | null = null;
	let promise: Promise<T[]> | null = null;
	// A retry finding the set loaded clears its key: returning alone left
	// the entry rescheduled for good (settle reads a retry that is still
	// registered as one that failed again).
	const retry = (): Promise<unknown> => {
		if (list) {
			retryCleared(cfg.key);
			return Promise.resolve();
		}
		return promise ?? start(true);
	};
	// A retry's attempt (`retrying`) leaves the load flags alone; the load
	// clears the error.
	const start = (retrying: boolean): Promise<T[]> => {
		if (!retrying) {
			cfg.status.loading = true;
			cfg.status.error = null;
		}
		promise = (async () => {
			const rows =
				cfg.meta && cfg.nextMeta && cfg.nextUrl
					? await loadActiveSlot(cfg.meta, cfg.nextMeta, cfg.url, cfg.nextUrl, cfg.load)
					: await cfg.load(cfg.url, Date.now());
			// The index first, the set last: a row it cannot take throws
			// with nothing stored, so the retry reads again.
			const byIdent = new Map(rows.map((r) => [r.ident.toUpperCase(), r]));
			retryCleared(cfg.key);
			list = rows;
			index = byIdent;
			cfg.status.loaded = true;
			cfg.status.loading = false;
			cfg.status.error = null;
			return rows;
		})().catch((e: unknown) => {
			retryAfterFailure(cfg.key, 'charts', e, retry, [chartPart(cfg.key)]);
			cfg.status.error = message(e);
			cfg.status.loading = false;
			promise = null;
			throw e;
		});
		return promise;
	};
	const ensure = (): Promise<T[]> => {
		if (list) {
			return Promise.resolve(list);
		}
		if (promise) {
			return promise;
		}
		const refused = retryRefusal(cfg.key);
		if (refused) {
			return Promise.reject(refused);
		}
		return start(false);
	};
	const byIdent = (ident: string): T | null => {
		// Track the load so a $derived re-runs once the plain index fills.
		void cfg.status.loaded;
		return index?.get(ident.toUpperCase()) ?? null;
	};
	return { ensure, byIdent };
}

const frSet = chartSet<AerodromeCharts>({
	key: 'charts:fr',
	status: adChartsState.fr,
	meta: loadFrAdChartsMeta,
	nextMeta: loadFrAdChartsNextMeta,
	url: FR_ADCHARTS_URL,
	nextUrl: FR_ADCHARTS_NEXT_URL,
	load: loadFrAdCharts,
});

const ukSet = chartSet<UkAerodromeCharts>({
	key: 'charts:uk',
	status: adChartsState.uk,
	meta: loadUkAdChartsMeta,
	nextMeta: loadUkAdChartsNextMeta,
	url: UK_ADCHARTS_URL,
	nextUrl: UK_ADCHARTS_NEXT_URL,
	load: loadUkAdCharts,
});

const usSet = chartSet<UsAerodromeCharts>({
	key: 'charts:us',
	status: adChartsState.us,
	meta: loadUsAdChartsMeta,
	nextMeta: loadUsAdChartsNextMeta,
	url: US_ADCHARTS_URL,
	nextUrl: US_ADCHARTS_NEXT_URL,
	load: loadUsAdCharts,
});

const atSet = chartSet<AerodromeAipLinks>({
	key: 'charts:at',
	status: adChartsState.at,
	meta: loadAtAdChartsMeta,
	nextMeta: loadAtAdChartsNextMeta,
	url: AT_ADCHARTS_URL,
	nextUrl: AT_ADCHARTS_NEXT_URL,
	load: loadAtAdCharts,
});

const deSet = chartSet<AerodromeAipLink>({
	key: 'charts:de',
	status: adChartsState.de,
	url: DE_ADCHARTS_URL,
	load: loadDeAdCharts,
});

/** The stored chart set for an ICAO ident ([] until the dataset loads or
 *  when the aerodrome has no eAIP page). Reads the load flag so the
 *  AirportDetail `$derived` re-runs once the plain index fills. */
export function frAdChartsForIdent(ident: string): AerodromeCharts['charts'] {
	return frSet.byIdent(ident)?.charts ?? NO_CHARTS;
}

/** Which SIA Atlas VAC publishes this ident's plate, or null when neither
 *  does (and while the dataset loads: the membership IS the gate, so an
 *  unknown ident and an uncharted one answer alike and the panel simply
 *  waits, as it already does for the chart list below the link). */
export function frVacForIdent(ident: string): VacAtlas | null {
	return frSet.byIdent(ident)?.vac ?? null;
}

/** Lazily load the SIA eAIP chart-links dataset (cmd/adcharts), picking
 *  the current / next AIRAC slot like ensureAerodromeFacilities. FR-only
 *  and fail-soft: a missing file resolves to an empty index, so the
 *  airport panel simply omits its chart list. */
export const ensureFrAdCharts = frSet.ensure;

/** The stored chart set for a UK ICAO ident ([] until the dataset loads
 *  or when the aerodrome publishes none). */
export function ukAdChartsForIdent(ident: string): AerodromeCharts['charts'] {
	return ukSet.byIdent(ident)?.charts ?? NO_CHARTS;
}

/** Lazily load the NATS eAIP chart-links dataset (cmd/ukcharts), picking
 *  the current / next AIRAC slot. UK-only and fail-soft: a missing file
 *  resolves to an empty index, so the panel keeps its plain AD 2 link. */
export const ensureUkAdCharts = ukSet.ensure;

/** The stored chart set for a US ident ([] until the dataset loads or
 *  when the airport publishes none). */
export function usAdChartsForIdent(ident: string): AerodromeCharts['charts'] {
	return usSet.byIdent(ident)?.charts ?? NO_CHARTS;
}

/** Lazily load the FAA d-TPP chart dataset (cmd/faa), picking the current
 *  / next cycle slot. US-only and fail-soft: a missing file resolves to
 *  an empty index, so the panel simply shows no chart row. */
export const ensureUsAdCharts = usSet.ensure;

/** The AD 2 / AD 3 links of an Austrian aerodrome (null until the dataset
 *  loads or when the field has no AIP section). */
export function atAdLinksForIdent(ident: string): AerodromeAipLinks | null {
	return atSet.byIdent(ident);
}

/** Lazily load the Austro Control eAIP link dataset (cmd/at), picking the
 *  current / next edition slot like ensureFrAdCharts. AT-only and
 *  fail-soft: a missing file resolves to an empty index, so the airport
 *  panel simply omits its chart row. */
export const ensureAtAdCharts = atSet.ensure;

// One set per eAIP chart index, made the first time an aerodrome of its
// State is asked for.
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a plain cache of set objects; their load status is the reactive part
const aipSets = new Map<string, ReturnType<typeof chartSet<AerodromeAipLinks>>>();

function aipSetFor(ident: string): ReturnType<typeof chartSet<AerodromeAipLinks>> | null {
	const index = aipChartIndexFor(ident);
	if (!index) {
		return null;
	}
	let set = aipSets.get(index.id);
	if (!set) {
		set = chartSet<AerodromeAipLinks>({
			key: `charts:${index.id}`,
			status: aipChartsState[index.id],
			meta: aipChartsMeta(index.id),
			nextMeta: aipChartsMeta(index.id, true),
			url: aipChartsUrl(index.id),
			nextUrl: aipChartsUrl(index.id, true),
			load: loadAipCharts,
		});
		aipSets.set(index.id, set);
	}
	return set;
}

/** The eAIP page and charts of an aerodrome in one of the generated-eAIP
 *  States (null until its index loads, or when the index lists no page
 *  for it). */
export function aipLinksForIdent(ident: string): AerodromeAipLinks | null {
	return aipSetFor(ident)?.byIdent(ident) ?? null;
}

/** Lazily load the chart index covering an aerodrome, picking the current
 *  / next AIRAC slot. Resolves at once for an aerodrome no index covers;
 *  fail-soft otherwise, like the other chart sets. */
export function ensureAipCharts(ident: string): Promise<AerodromeAipLinks[]> {
	return aipSetFor(ident)?.ensure() ?? Promise.resolve([]);
}

/** The DFS aerodrome-page link for an ICAO ident (null until the dataset
 *  loads or when the field is not in the DFS VFR index). */
export function deAdLinkForIdent(ident: string): AerodromeAipLink | null {
	return deSet.byIdent(ident);
}

/** Lazily load the DFS aerodrome-link dataset (cmd/de). DE-only and
 *  fail-soft: a missing file resolves to an empty index, so the airport
 *  panel falls back to the generic DFS eAIP landing page. No AIRAC slot:
 *  the permalinks are cycle-independent. */
export const ensureDeAdCharts = deSet.ensure;
