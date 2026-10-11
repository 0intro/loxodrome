/* Lazily-loaded reference catalogs behind single panels and editors: the
 * per-publisher aerodrome facilities (cmd/fr, cmd/be, internal/aixm5build
 * for DE / UK / ES), the worldwide METAR station
 * catalog (cmd/metar) and the FAA JO 7360.1 aircraft type designators
 * (cmd/designators). The datasets stay outside $state (immutable after
 * load); only load status is reactive. Re-exported through
 * data.svelte.ts, the importers' single entry point. */

import {
	FR_FACILITIES_URL,
	FR_FACILITIES_NEXT_URL,
	loadFacilities,
	type AerodromeFacilities,
} from '$lib/data/facilities';
import {
	METAR_STATIONS_URL,
	loadMetarStations,
	type MetarStation,
} from '$lib/data/metarStations';
import { loadFaaDesignators, type DesignatorType } from '$lib/data/designators';
import { normalizeFleetText } from '$lib/aircraft/fleetSearch';
import {
	loadFacilitiesMeta,
	loadFacilitiesNextMeta,
	datasetMeta,
	loadActiveSlot,
	type SidecarLoader,
} from '$lib/data/meta';
import { datasetUrl, publishersOf } from '$lib/data/publishers';
import { retryAfterFailure, retryCleared, retryRefusal } from '$lib/state/dataRetry.svelte';

// Aerodrome facilities: one dataset per publisher, AIRAC-sliced where the
// publisher has a pre-release slot, lazy-loaded when an airport panel opens
// and only for the country that panel belongs to. Indexed by ident.
interface FacilitySet {
	url: string;
	nextUrl?: string;
	meta?: SidecarLoader<{ effective: string } | null>;
	nextMeta?: SidecarLoader<{ effective: string } | null>;
	list: AerodromeFacilities[] | null;
	index: Map<string, AerodromeFacilities> | null;
	promise: Promise<AerodromeFacilities[]> | null;
}

/** The aerodrome directory of every publisher that files one: France's
 *  explicitly, the rest from the publisher registry ($lib/data/publishers),
 *  which says who does. Austria has none: its KML gives a helipad an
 *  identifier and a name and says so, and its dAIP publishes three AD 3
 *  pages, all chart indexes (docs/at-aip.md). The FAA and pruatlas sets are
 *  airspace-only. */
const facilitySets: Record<string, FacilitySet> = {
	fr: {
		url: FR_FACILITIES_URL, nextUrl: FR_FACILITIES_NEXT_URL,
		meta: loadFacilitiesMeta, nextMeta: loadFacilitiesNextMeta,
		list: null, index: null, promise: null,
	},
	...Object.fromEntries(
		publishersOf('facilities').map((id): [string, FacilitySet] => [id, {
			url: datasetUrl(id, 'facilities'), nextUrl: datasetUrl(id, 'facilities', true),
			meta: datasetMeta(id, 'facilities'), nextMeta: datasetMeta(id, 'facilities', true),
			list: null, index: null, promise: null,
		}]),
	),
};

function facilitySet(source: string | null | undefined): FacilitySet | null {
	return source != null ? (facilitySets[source] ?? null) : null;
}

// METAR station catalog: one plain worldwide dataset, static station
// metadata joined onto the live /wx observation by ident. Indexed by
// icaoId (the ident the observation feed uses).
let metarCatalog: MetarStation[] | null = null;
let metarCatalogIndex: Map<string, MetarStation> | null = null;
let metarCatalogPromise: Promise<MetarStation[]> | null = null;

// FAA aircraft type designator catalog: one plain static dataset behind
// the aircraft editor's icaoType suggestions and the soft
// unknown-designator warnings. The set holds the codes; searchRows carries
// the (code, manufacturer, model) tuples with their normalized fields
// precomputed for the per-keystroke suggestion filter.
let designatorSet: Set<string> | null = null;
let designatorSearchRows:
	| { t: DesignatorType; code: string; manufacturer: string; model: string }[]
	| null = null;
let designatorsPromise: Promise<void> | null = null;

export const referenceDataState = $state<{
	facilitiesLoaded: boolean;
	/** Bumped each time a publisher's facilities land. facilitiesLoaded is one
	 *  flag for every publisher and flips on the first, so a lookup reading
	 *  only the flag never saw the second publisher's directory. */
	facilitiesRevision: number;
	facilitiesLoading: boolean;
	facilitiesError: string | null;
	metarCatalogLoaded: boolean;
	metarCatalogLoading: boolean;
	metarCatalogError: string | null;
	designatorsLoaded: boolean;
	designatorsLoading: boolean;
	designatorsError: string | null;
}>({
	facilitiesLoaded: false,
	facilitiesRevision: 0,
	facilitiesLoading: false,
	facilitiesError: null,
	metarCatalogLoaded: false,
	metarCatalogLoading: false,
	metarCatalogError: null,
	designatorsLoaded: false,
	designatorsLoading: false,
	designatorsError: null,
});

function message(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/* ---- aerodrome facilities ---- */

/** The AIP directory record for an ident, or null until its publisher's
 *  dataset loads (and for a publisher that emits none). Reads
 *  `facilitiesRevision` so the AirportDetail `$derived` re-runs once the
 *  plain index fills, each publisher's in turn; the index is a plain,
 *  non-reactive ref. */
export function facilitiesForIdent(
	ident: string,
	source: string | null | undefined,
): AerodromeFacilities | null {
	void referenceDataState.facilitiesRevision;
	return facilitySet(source)?.index?.get(ident.toUpperCase()) ?? null;
}

/** Lazily load one publisher's aerodrome-facilities dataset, picking the
 *  current / next AIRAC slot where it has one, like ensureObstacles. A
 *  publisher without a dataset resolves to []; fail-soft otherwise, so a
 *  missing file just leaves the panel's directory section off. */
export function ensureAerodromeFacilities(
	source: string | null | undefined,
): Promise<AerodromeFacilities[]> {
	const set = facilitySet(source);
	if (!set || source == null) {
		return Promise.resolve([]);
	}
	if (set.list) {
		return Promise.resolve(set.list);
	}
	if (set.promise) {
		return set.promise;
	}
	// A read that failed for a reason that may pass waits for its retry
	// (state/dataRetry.svelte.ts), whoever asks.
	const refused = retryRefusal(`facilities:${source}`);
	if (refused) {
		return Promise.reject(refused);
	}
	return startFacilities(source, set, false);
}

function startFacilities(source: string, set: FacilitySet, retrying: boolean): Promise<AerodromeFacilities[]> {
	const key = `facilities:${source}`;
	// Loaded, the retry clears its key (the chart sets' rule).
	const retry = (): Promise<unknown> => {
		if (set.list) {
			retryCleared(key);
			return Promise.resolve();
		}
		return set.promise ?? startFacilities(source, set, true);
	};
	if (!retrying) {
		referenceDataState.facilitiesLoading = true;
		referenceDataState.facilitiesError = null;
	}
	set.promise = (async () => {
		const list =
			set.meta && set.nextMeta && set.nextUrl
				? await loadActiveSlot(set.meta, set.nextMeta, set.url, set.nextUrl, (url) => loadFacilities(url))
				: await loadFacilities(set.url);
		// The index first, the set last (the chart sets' rule).
		const byIdent = new Map(list.map((f) => [f.ident.toUpperCase(), f]));
		retryCleared(key);
		set.list = list;
		set.index = byIdent;
		referenceDataState.facilitiesLoaded = true;
		referenceDataState.facilitiesLoading = false;
		referenceDataState.facilitiesError = null;
		referenceDataState.facilitiesRevision++;
		return list;
	})().catch((e: unknown) => {
		retryAfterFailure(key, 'facilities', e, retry, [source]);
		referenceDataState.facilitiesError = message(e);
		referenceDataState.facilitiesLoading = false;
		set.promise = null;
		throw e;
	});
	return set.promise;
}

/* ---- METAR station catalog ---- */

export function getMetarStationCatalog(): MetarStation[] | null {
	return metarCatalog;
}

/** The static catalog record for an observation ident (ICAO / WMO), or null
 *  until the catalog loads. Reads `metarCatalogLoaded` so a panel `$derived`
 *  re-runs once the plain index fills. */
export function metarStationByIdent(ident: string): MetarStation | null {
	void referenceDataState.metarCatalogLoaded;
	return metarCatalogIndex?.get(ident) ?? null;
}

/** Lazily load the worldwide METAR station catalog (cmd/metar). Single plain
 *  file (no AIRAC slot). loadMetarStations is fail-soft, so a missing file
 *  resolves to an empty catalog rather than throwing: the map's live
 *  observations are unaffected, the panel just shows no extra metadata. */
export function ensureMetarStationCatalog(): Promise<MetarStation[]> {
	if (metarCatalog) {
		return Promise.resolve(metarCatalog);
	}
	if (metarCatalogPromise) {
		return metarCatalogPromise;
	}
	const refused = retryRefusal('metarStations');
	if (refused) {
		return Promise.reject(refused);
	}
	return startMetarCatalog(false);
}

function retryMetarCatalog(): Promise<unknown> {
	// Loaded, the retry clears its key (the chart sets' rule).
	if (metarCatalog) {
		retryCleared('metarStations');
		return Promise.resolve();
	}
	return metarCatalogPromise ?? startMetarCatalog(true);
}

function startMetarCatalog(retrying: boolean): Promise<MetarStation[]> {
	if (!retrying) {
		referenceDataState.metarCatalogLoading = true;
		referenceDataState.metarCatalogError = null;
	}
	metarCatalogPromise = (async () => {
		const list = await loadMetarStations(METAR_STATIONS_URL);
		const byIdent = new Map(list.map((s) => [s.icaoId, s]));
		retryCleared('metarStations');
		metarCatalog = list;
		metarCatalogIndex = byIdent;
		referenceDataState.metarCatalogLoaded = true;
		referenceDataState.metarCatalogLoading = false;
		referenceDataState.metarCatalogError = null;
		return list;
	})().catch((e: unknown) => {
		retryAfterFailure('metarStations', 'metarStations', e, retryMetarCatalog);
		referenceDataState.metarCatalogError = message(e);
		referenceDataState.metarCatalogLoading = false;
		metarCatalogPromise = null;
		throw e;
	});
	return metarCatalogPromise;
}

/* ---- FAA aircraft type designators ---- */

/** Lazily load the FAA JO 7360.1 designator catalog (cmd/designators).
 *  Single plain static file. Callers fire-and-forget it when an icaoType
 *  edit surface opens; on failure the promise resets so a later open
 *  retries, and until it loads isKnownDesignator stays null (no warning)
 *  and searchDesignators returns no suggestions. */
export function ensureFaaDesignators(): Promise<void> {
	if (designatorSet) {
		return Promise.resolve();
	}
	if (designatorsPromise) {
		return designatorsPromise;
	}
	const refused = retryRefusal('designators');
	if (refused) {
		return Promise.reject(refused);
	}
	return startDesignators(false);
}

function retryDesignators(): Promise<unknown> {
	// Loaded, the retry clears its key (the chart sets' rule).
	if (designatorSet) {
		retryCleared('designators');
		return Promise.resolve();
	}
	return designatorsPromise ?? startDesignators(true);
}

function startDesignators(retrying: boolean): Promise<void> {
	if (!retrying) {
		referenceDataState.designatorsLoading = true;
		referenceDataState.designatorsError = null;
	}
	designatorsPromise = (async () => {
		const data = await loadFaaDesignators();
		// The search rows first, the set last: `designatorSet` is what says
		// the catalog loaded.
		const rows = data.types.map((t) => ({
			t,
			code: normalizeFleetText(t.code),
			manufacturer: normalizeFleetText(t.manufacturer),
			model: normalizeFleetText(t.model),
		}));
		retryCleared('designators');
		designatorSearchRows = rows;
		designatorSet = new Set(data.designators);
		referenceDataState.designatorsLoaded = true;
		referenceDataState.designatorsLoading = false;
		referenceDataState.designatorsError = null;
	})().catch((e: unknown) => {
		retryAfterFailure('designators', 'designators', e, retryDesignators);
		referenceDataState.designatorsError = message(e);
		referenceDataState.designatorsLoading = false;
		designatorsPromise = null;
		throw e;
	});
	return designatorsPromise;
}

/** Whether a typed ICAO type designator is in the FAA JO 7360.1 list:
 *  null until the catalog loads (show nothing), else set membership on the
 *  trimmed upper-cased value (stored values are never rewritten). The FAA
 *  order is a subset of Doc 8643, so false is advisory, never an error.
 *  Reads `designatorsLoaded` so a `$derived` re-runs once the set fills. */
export function isKnownDesignator(code: string): boolean | null {
	void referenceDataState.designatorsLoaded;
	if (!designatorSet) {
		return null;
	}
	return designatorSet.has(code.trim().toUpperCase());
}

/** Designator suggestions for the aircraft editor: every whitespace query
 *  token must substring-match the code, manufacturer or model (the
 *  fleet-search normalization, so case and accents fold away). Exact code
 *  matches rank first, then code prefixes, then name matches, keeping the
 *  catalog's by-code order within each tier. Empty query or unloaded
 *  catalog return []. */
export function searchDesignators(query: string, limit = 12): DesignatorType[] {
	void referenceDataState.designatorsLoaded;
	const rows = designatorSearchRows;
	if (!rows) {
		return [];
	}
	const tokens = normalizeFleetText(query).split(/\s+/).filter(Boolean);
	if (tokens.length === 0) {
		return [];
	}
	const whole = tokens.join(' ');
	const exact: DesignatorType[] = [];
	const prefix: DesignatorType[] = [];
	const rest: DesignatorType[] = [];
	for (const r of rows) {
		if (!tokens.every((tk) => r.code.includes(tk) || r.manufacturer.includes(tk) || r.model.includes(tk))) {
			continue;
		}
		if (r.code === whole) {
			exact.push(r.t);
		} else if (r.code.startsWith(whole)) {
			prefix.push(r.t);
		} else {
			rest.push(r.t);
		}
		if (exact.length >= limit) {
			break;
		}
	}
	return [...exact, ...prefix, ...rest].slice(0, limit);
}
