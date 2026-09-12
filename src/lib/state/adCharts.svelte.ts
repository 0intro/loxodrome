/* Lazily-loaded aerodrome chart-link datasets, one per publisher: SIA
 * (cmd/adcharts), NATS (cmd/ukcharts), FAA d-TPP (cmd/faa), Austro
 * Control (cmd/at) and DFS (cmd/de). Most are AIRAC-slot-picked like the
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
import {
	loadFrAdChartsMeta,
	loadFrAdChartsNextMeta,
	loadUkAdChartsMeta,
	loadUkAdChartsNextMeta,
	loadUsAdChartsMeta,
	loadUsAdChartsNextMeta,
	loadAtAdChartsMeta,
	loadAtAdChartsNextMeta,
	pickActiveDataset,
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

function message(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** One lazily-loaded per-publisher chart dataset: an idempotent `ensure`
 *  (fail-soft callers catch its rejection; the promise resets on failure
 *  so a later panel open retries) and an ident lookup that reads the
 *  loaded flag so a `$derived` re-runs once the plain index fills.
 *  `meta` / `nextMeta` / `nextUrl` make it AIRAC-slot-picked like
 *  ensureAerodromeFacilities; without them the dataset is a single
 *  cycle-independent file (DE). */
function chartSet<T extends { ident: string }>(cfg: {
	status: ChartSetStatus;
	meta?: () => Promise<{ effective: string } | null>;
	nextMeta?: () => Promise<{ effective: string } | null>;
	url: string;
	nextUrl?: string;
	load: (url: string, nowMs: number) => Promise<T[]>;
}): { ensure: () => Promise<T[]>; byIdent: (ident: string) => T | null } {
	let list: T[] | null = null;
	let index: Map<string, T> | null = null;
	let promise: Promise<T[]> | null = null;
	const ensure = (): Promise<T[]> => {
		if (list) {
			return Promise.resolve(list);
		}
		if (promise) {
			return promise;
		}
		cfg.status.loading = true;
		cfg.status.error = null;
		promise = (async () => {
			let url = cfg.url;
			let nowMs = Date.now();
			if (cfg.meta && cfg.nextMeta && cfg.nextUrl) {
				const [meta, nextMeta] = await Promise.all([
					cfg.meta().catch(() => null),
					cfg.nextMeta().catch(() => null),
				]);
				// One-shot timestamp passed by value; not a reactive ref.
				const now = new Date();
				nowMs = now.getTime();
				url = pickActiveDataset(
					meta?.effective ?? null,
					nextMeta?.effective ?? null,
					cfg.url,
					cfg.nextUrl,
					now,
				).url;
			}
			const rows = await cfg.load(url, nowMs);
			list = rows;
			index = new Map(rows.map((r) => [r.ident.toUpperCase(), r]));
			cfg.status.loaded = true;
			cfg.status.loading = false;
			return rows;
		})().catch((e: unknown) => {
			cfg.status.error = message(e);
			cfg.status.loading = false;
			promise = null;
			throw e;
		});
		return promise;
	};
	const byIdent = (ident: string): T | null => {
		// Track the load so a $derived re-runs once the plain index fills.
		void cfg.status.loaded;
		return index?.get(ident.toUpperCase()) ?? null;
	};
	return { ensure, byIdent };
}

const frSet = chartSet<AerodromeCharts>({
	status: adChartsState.fr,
	meta: loadFrAdChartsMeta,
	nextMeta: loadFrAdChartsNextMeta,
	url: FR_ADCHARTS_URL,
	nextUrl: FR_ADCHARTS_NEXT_URL,
	load: loadFrAdCharts,
});

const ukSet = chartSet<UkAerodromeCharts>({
	status: adChartsState.uk,
	meta: loadUkAdChartsMeta,
	nextMeta: loadUkAdChartsNextMeta,
	url: UK_ADCHARTS_URL,
	nextUrl: UK_ADCHARTS_NEXT_URL,
	load: loadUkAdCharts,
});

const usSet = chartSet<UsAerodromeCharts>({
	status: adChartsState.us,
	meta: loadUsAdChartsMeta,
	nextMeta: loadUsAdChartsNextMeta,
	url: US_ADCHARTS_URL,
	nextUrl: US_ADCHARTS_NEXT_URL,
	load: loadUsAdCharts,
});

const atSet = chartSet<AerodromeAipLinks>({
	status: adChartsState.at,
	meta: loadAtAdChartsMeta,
	nextMeta: loadAtAdChartsNextMeta,
	url: AT_ADCHARTS_URL,
	nextUrl: AT_ADCHARTS_NEXT_URL,
	load: loadAtAdCharts,
});

const deSet = chartSet<AerodromeAipLink>({
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
