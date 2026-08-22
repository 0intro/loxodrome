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
	BE_FACILITIES_URL,
	BE_FACILITIES_NEXT_URL,
	DE_FACILITIES_URL,
	DE_FACILITIES_NEXT_URL,
	UK_FACILITIES_URL,
	ES_FACILITIES_URL,
	GE_FACILITIES_URL,
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
	loadBeFacilitiesMeta,
	loadBeFacilitiesNextMeta,
	loadDeFacilitiesMeta,
	loadDeFacilitiesNextMeta,
	pickActiveDataset,
} from '$lib/data/meta';

// Aerodrome facilities: one dataset per publisher, AIRAC-sliced where the
// publisher has a pre-release slot, lazy-loaded when an airport panel opens
// and only for the country that panel belongs to. Indexed by ident.
interface FacilitySet {
	url: string;
	nextUrl?: string;
	meta?: () => Promise<{ effective: string } | null>;
	nextMeta?: () => Promise<{ effective: string } | null>;
	list: AerodromeFacilities[] | null;
	index: Map<string, AerodromeFacilities> | null;
	promise: Promise<AerodromeFacilities[]> | null;
}

const facilitySets: Record<FacilityPublisher, FacilitySet> = {
	fr: {
		url: FR_FACILITIES_URL, nextUrl: FR_FACILITIES_NEXT_URL,
		meta: loadFacilitiesMeta, nextMeta: loadFacilitiesNextMeta,
		list: null, index: null, promise: null,
	},
	be: {
		url: BE_FACILITIES_URL, nextUrl: BE_FACILITIES_NEXT_URL,
		meta: loadBeFacilitiesMeta, nextMeta: loadBeFacilitiesNextMeta,
		list: null, index: null, promise: null,
	},
	de: {
		url: DE_FACILITIES_URL, nextUrl: DE_FACILITIES_NEXT_URL,
		meta: loadDeFacilitiesMeta, nextMeta: loadDeFacilitiesNextMeta,
		list: null, index: null, promise: null,
	},
	uk: { url: UK_FACILITIES_URL, list: null, index: null, promise: null },
	es: { url: ES_FACILITIES_URL, list: null, index: null, promise: null },
	ge: { url: GE_FACILITIES_URL, list: null, index: null, promise: null },
};

/** The publishers that emit an aerodrome-facilities dataset. Austria has
 *  none: its KML gives a helipad an identifier and a name and says so, and
 *  its dAIP publishes three AD 3 pages, all chart indexes (docs/at-aip.md).
 *  The FAA and pruatlas sets are airspace-only. */
export type FacilityPublisher = 'fr' | 'be' | 'de' | 'uk' | 'es' | 'ge';

function facilitySet(source: string | null | undefined): FacilitySet | null {
	return source != null && source in facilitySets
		? facilitySets[source as FacilityPublisher]
		: null;
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
 *  `facilitiesLoaded` so the AirportDetail `$derived` re-runs once the plain
 *  index fills; the index is a plain, non-reactive ref. */
export function facilitiesForIdent(
	ident: string,
	source: string | null | undefined,
): AerodromeFacilities | null {
	void referenceDataState.facilitiesLoaded;
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
	if (!set) {
		return Promise.resolve([]);
	}
	if (set.list) {
		return Promise.resolve(set.list);
	}
	if (set.promise) {
		return set.promise;
	}
	referenceDataState.facilitiesLoading = true;
	referenceDataState.facilitiesError = null;
	set.promise = (async () => {
		let url = set.url;
		if (set.meta && set.nextMeta && set.nextUrl) {
			const [meta, nextMeta] = await Promise.all([
				set.meta().catch(() => null),
				set.nextMeta().catch(() => null),
			]);
			// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
			const now = new Date();
			url = pickActiveDataset(
				meta?.effective ?? null,
				nextMeta?.effective ?? null,
				set.url,
				set.nextUrl,
				now,
			).url;
		}
		const list = await loadFacilities(url);
		set.list = list;
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
		set.index = new Map(list.map((f) => [f.ident.toUpperCase(), f]));
		referenceDataState.facilitiesLoaded = true;
		referenceDataState.facilitiesLoading = false;
		return list;
	})().catch((e: unknown) => {
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
	referenceDataState.metarCatalogLoading = true;
	referenceDataState.metarCatalogError = null;
	metarCatalogPromise = (async () => {
		const list = await loadMetarStations(METAR_STATIONS_URL);
		metarCatalog = list;
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
		metarCatalogIndex = new Map(list.map((s) => [s.icaoId, s]));
		referenceDataState.metarCatalogLoaded = true;
		referenceDataState.metarCatalogLoading = false;
		return list;
	})().catch((e: unknown) => {
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
	referenceDataState.designatorsLoading = true;
	referenceDataState.designatorsError = null;
	designatorsPromise = (async () => {
		const data = await loadFaaDesignators();
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
		designatorSet = new Set(data.designators);
		designatorSearchRows = data.types.map((t) => ({
			t,
			code: normalizeFleetText(t.code),
			manufacturer: normalizeFleetText(t.manufacturer),
			model: normalizeFleetText(t.model),
		}));
		referenceDataState.designatorsLoaded = true;
		referenceDataState.designatorsLoading = false;
	})().catch((e: unknown) => {
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
