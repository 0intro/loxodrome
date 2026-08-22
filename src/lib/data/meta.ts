/* Typed loaders for the dataset companion `.meta.json` files. Used by the
 * About modal to show how fresh the bundled data is; AIRAC cycle, source
 * counts, and the build timestamp. Each loader caches its promise so
 * re-opening the modal is instant; failures are surfaced to the caller
 * (the modal renders "unavailable" rather than blocking). */

import { parseEffectiveMs } from '$lib/data/airac';

/** The lat/lon envelope of a dataset's own rows, in GeoJSON order
 *  [minLon, minLat, maxLon, maxLat]. Written by internal/aip/bbox.go and
 *  read by the coverage gate (src/lib/state/coverage.svelte.ts) to decide
 *  whether a publisher is worth fetching at all. Absent means "unknown",
 *  never "empty": a dataset without one always loads. */
export type DatasetBBox = [number, number, number, number];

/** The pieces a dataset's rows really occupy, when the publisher's
 *  territory is not connected: France's AIP covers Guadeloupe, Guyane,
 *  Reunion, Polynesia and New Caledonia beside the metropole, so its
 *  single envelope spans 157 W to 170 E and would be true of almost any
 *  viewport. Absent when the rows form one group, in which case `bbox`
 *  already says everything. */
export type DatasetBBoxes = DatasetBBox[];

export interface FrenchAirspacesMeta {
	generatedAt: string;
	source: string;
	sourceSha256: string;
	effective: string;
	airspaceCount: number;
	skippedNoBoundary: number;
	skippedNoClassify?: number;
	withRadio: number;
	siaSectorMappedCount: number;
	siaSectorInjectCount: number;
	counts: Record<string, number>;
	/** The rows' lat/lon envelope, and the disjoint pieces they occupy
	 *  where the publisher's territory is not connected. The coverage
	 *  gate reads both (src/lib/state/coverage.svelte.ts). */
	bbox?: DatasetBBox;
	bboxes?: DatasetBBoxes;
}

/** fr-obstacles.meta.json: per-type counts of the SIA AIXM <Obs> records. */
export interface ObstaclesMeta {
	generatedAt: string;
	source: string;
	sourceSha256: string;
	effective: string;
	obstacleCount: number;
	litCount: number;
	groupCount: number;
	skippedNoGeo: number;
	unknownTypes: string[];
	counts: Record<string, number>;
	/** The rows' lat/lon envelope, and the disjoint pieces they occupy
	 *  where the publisher's territory is not connected. The coverage
	 *  gate reads both (src/lib/state/coverage.svelte.ts). */
	bbox?: DatasetBBox;
	bboxes?: DatasetBBoxes;
}

/** airports.meta.json: worldwide OurAirports baseline. */
export interface AirportsMeta {
	generatedAt: string;
	sourceSha256: string;
	rawRowCount: number;
	rowCount: number;
	runwayCount: number;
	unknownTypes: string[];
	/** The rows' lat/lon envelope, and the disjoint pieces they occupy
	 *  where the publisher's territory is not connected. The coverage
	 *  gate reads both (src/lib/state/coverage.svelte.ts). */
	bbox?: DatasetBBox;
	bboxes?: DatasetBBoxes;
}

/** fr-airports.meta.json: French AIXM-derived airport enrichment. */
export interface FrAirportsMeta {
	generatedAt: string;
	source: string;
	sourceSha256: string;
	effective: string;
	ahpCount: number;
	/** Aerodromes the SIA publishes with no ICAO location indicator, so they
	 *  carry its own codeId as their ident (hospital helipads, usage-restreint
	 *  airfields, decommissioned fields). */
	nationalCodeCount: number;
	accessCounts: Record<string, number>;
	militaryCount: number;
	/** The rows' lat/lon envelope, and the disjoint pieces they occupy
	 *  where the publisher's territory is not connected. The coverage
	 *  gate reads both (src/lib/state/coverage.svelte.ts). */
	bbox?: DatasetBBox;
	bboxes?: DatasetBBoxes;
}

/** AIXM 5.1 airspaces meta sidecar (cmd/uk, cmd/es). Same JSON shape on
 *  both pipelines: feature counts + the soft-skip / unresolved-xlink
 *  counters from internal/aixm5. ES leaves `effective` empty (ENAIRE
 *  doesn't stamp an AIRAC date on AIP files); UK populates it. */
export interface AixmAirspacesMeta {
	generatedAt: string;
	source: string;
	sourceSha256: string;
	effective: string;
	airspaceCount: number;
	skippedNoBoundary: number;
	skippedNoType: number;
	skippedNonBaseline: number;
	unresolvedXlinks: number;
	counts: Record<string, number>;
	/** The rows' lat/lon envelope, and the disjoint pieces they occupy
	 *  where the publisher's territory is not connected. The coverage
	 *  gate reads both (src/lib/state/coverage.svelte.ts). */
	bbox?: DatasetBBox;
	bboxes?: DatasetBBoxes;
}

/** AIXM 5.1 airports meta sidecar (cmd/uk, cmd/es). */
export interface AixmAirportsMeta {
	generatedAt: string;
	source: string;
	sourceSha256: string;
	effective: string;
	ahpCount: number;
	runwayCount: number;
	militaryCount: number;
	counts: Record<string, number>;
	/** The rows' lat/lon envelope, and the disjoint pieces they occupy
	 *  where the publisher's territory is not connected. The coverage
	 *  gate reads both (src/lib/state/coverage.svelte.ts). */
	bbox?: DatasetBBox;
	bboxes?: DatasetBBoxes;
}

/** AIXM 5.1 obstacles meta sidecar (cmd/uk, cmd/es). */
export interface AixmObstaclesMeta {
	generatedAt: string;
	source: string;
	sourceSha256: string;
	effective: string;
	obstacleCount: number;
	litCount: number;
	skippedNonBaseline: number;
	multiPartObstacles: number;
	unknownTypes: string[];
	counts: Record<string, number>;
	/** The rows' lat/lon envelope, and the disjoint pieces they occupy
	 *  where the publisher's territory is not connected. The coverage
	 *  gate reads both (src/lib/state/coverage.svelte.ts). */
	bbox?: DatasetBBox;
	bboxes?: DatasetBBoxes;
}

/** fr-navaids.meta.json: per-type counts of the SIA AIXM navaid records. */
export interface FacilitiesMeta {
	generatedAt: string;
	source: string;
	sourceSha256: string;
	effective: string;
	aerodromeCount: number;
	/** Rows carrying a helipad directory. */
	heliportCount?: number;
	/** Annotations the builder did not recognise (AIXM publishers only):
	 *  a publisher adding a propertyName shows up here. */
	skippedNotes?: number;
	counts: Record<string, number>;
}

/** us-adcharts.meta.json (cmd/faa): the FAA d-TPP chart dataset. */
export interface UsAdChartsMeta {
	generatedAt: string;
	effective: string;
	source: string;
	cycle: string;
	base: string;
	airports: number;
	charts: number;
	byFamily: Record<string, number>;
}

/** de-adcharts.meta.json (cmd/de -only adcharts): the DFS VFR eAIP
 *  aerodrome-page permalink index. No AIRAC slot (cycle-independent). */
export interface DeAdChartsMeta {
	generatedAt: string;
	source: string;
	base: string;
	aerodromes: number;
	skipped: number;
}

/** uk-adcharts.meta.json (cmd/ukcharts): the NATS eAIP chart-link scrape. */
export interface UkAdChartsMeta {
	generatedAt: string;
	effective: string;
	source: string;
	base: string;
	aerodromes: number;
	charts: number;
	byFamily: Record<string, number>;
	pagesFetched: number;
	miscTitles: string[];
}

/** fr-adcharts.meta.json (cmd/adcharts): the SIA eAIP chart-link scrape. */
export interface FrAdChartsMeta {
	generatedAt: string;
	effective: string;
	source: { site: string; menu: string };
	aerodromes: number;
	charts: number;
	byFamily: Record<string, number>;
	pagesFetched: number;
	emptyPages: number;
	parserVersion: number;
}

/** fr-vacgeo.meta.json (cmd/vacgeo): where each VAC panel sits on the
 *  ground. The counts say how much of the atlas could be placed and why the
 *  rest could not, which is what the Layers tab's coverage line reads. */
export interface FrVacGeoMeta {
	generatedAt: string;
	effective: string;
	source: { site: string; dataset: string; plates: string };
	plates: number;
	panels: number;
	aerodromes: number;
	byKind: Record<string, number>;
	overrides: number;
	noGraticule: number;
	gateRejected: number;
	missingPlate: number;
	byReason: Record<string, number>;
	bbox?: DatasetBBox;
	parserVersion: number;
}

export interface NavaidsMeta {
	generatedAt: string;
	source: string;
	sourceSha256: string;
	effective: string;
	navaidCount: number;
	counts: Record<string, number>;
	/** The rows' lat/lon envelope, and the disjoint pieces they occupy
	 *  where the publisher's territory is not connected. The coverage
	 *  gate reads both (src/lib/state/coverage.svelte.ts). */
	bbox?: DatasetBBox;
	bboxes?: DatasetBBoxes;
}

/** French SIA nature-zone meta sidecar (cmd/fr nature.go): PRN + SUR counts. */
export interface NatureMeta {
	generatedAt: string;
	source: string;
	sourceSha256: string;
	effective: string;
	zoneCount: number;
	counts: Record<string, number>;
	/** The rows' lat/lon envelope, and the disjoint pieces they occupy
	 *  where the publisher's territory is not connected. The coverage
	 *  gate reads both (src/lib/state/coverage.svelte.ts). */
	bbox?: DatasetBBox;
	bboxes?: DatasetBBoxes;
}

/** AIXM 5.1 navaids meta sidecar (cmd/uk, cmd/es). */
export interface AixmNavaidsMeta {
	generatedAt: string;
	source: string;
	sourceSha256: string;
	effective: string;
	navaidCount: number;
	skippedNonBaseline: number;
	unresolvedXlinks: number;
	counts: Record<string, number>;
	/** The rows' lat/lon envelope, and the disjoint pieces they occupy
	 *  where the publisher's territory is not connected. The coverage
	 *  gate reads both (src/lib/state/coverage.svelte.ts). */
	bbox?: DatasetBBox;
	bboxes?: DatasetBBoxes;
}

/** metar-stations.meta.json: the worldwide NOAA AWC METAR station catalog
 *  (cmd/metar, weekly). No AIRAC slot; `requests` is a crawl diagnostic. */
export interface MetarStationsMeta {
	generatedAt: string;
	source: string;
	stationCount: number;
	tafCount: number;
	countryCount: number;
	requests: number;
}

/** faa-designators.meta.json: the FAA JO 7360.1 aircraft type designator
 *  catalog (cmd/designators; refreshed by hand per order edition, roughly
 *  annual). Public domain (US Government work). */
export interface FaaDesignatorsMeta {
	generatedAt: string;
	source: string;
	edition: string;
	effectiveDate: string;
	designatorCount: number;
	modelCount: number;
	license: string;
}

export interface SourceMeta {
	url?: string;
	sha256?: string;
	count?: number;
	cycle?: number;
}

/** pruatlas-firs.meta.json: one upstream, one AIRAC cycle. */
export interface PruatlasFirsMeta {
	generatedAt: string;
	airspaceCount: number;
	source: SourceMeta;
	/** The rows' lat/lon envelope, and the disjoint pieces they occupy
	 *  where the publisher's territory is not connected. The coverage
	 *  gate reads both (src/lib/state/coverage.svelte.ts). */
	bbox?: DatasetBBox;
	bboxes?: DatasetBBoxes;
}

/** faa-airspaces.meta.json: three upstreams, per-type counts, no AIRAC. */
export interface FaaAirspacesMeta {
	generatedAt: string;
	airspaceCount: number;
	boundary: SourceMeta;
	specialUse: SourceMeta;
	class: SourceMeta;
	counts: Record<string, number>;
	/** The rows' lat/lon envelope, and the disjoint pieces they occupy
	 *  where the publisher's territory is not connected. The coverage
	 *  gate reads both (src/lib/state/coverage.svelte.ts). */
	bbox?: DatasetBBox;
	bboxes?: DatasetBBoxes;
}

/** French SUP AIP overlay meta (cmd/supaip): provenance plus parse-coverage
 *  counts that show how much of the PDF geometry extraction succeeded. */
export interface SupAipMeta {
	generatedAt: string;
	source: {
		site: string;
		pdfBase: string;
		listingShas?: Record<string, string>;
	};
	total: number;
	active: number;
	upcoming: number;
	withGeometry: number;
	withVertical: number;
	polygon: number;
	circle: number;
	mixed: number;
	none: number;
	byRegion: Record<string, number>;
	pdfFetched: number;
	pdfCached: number;
	parseErrors: number;
	parserVersion: number;
}

/** aircraft.meta.json: the committed aircraft-library sidecar. Doubles as the
 *  file index (`files` names the per-plane YAML sheets under /data/aircraft/);
 *  hand-maintained, cross-checked against the directory by a vitest spec. */
export interface AircraftMeta {
	generatedAt: string;
	source?: string | undefined;
	aircraftCount: number;
	files: string[];
	counts: Record<string, number>;
}

async function fetchJSON<T>(path: string): Promise<T> {
	const res = await fetch(path);
	if (!res.ok) {
		throw new Error(`${path}: HTTP ${res.status}`);
	}
	const ct = res.headers.get('content-type') ?? '';
	if (!ct.includes('json')) {
		// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
		throw new Error(`${path}: not JSON (got ${ct || 'no content-type'})`);
	}
	return (await res.json()) as T;
}

/** Like `fetchJSON` but treats a missing file as a normal "no such
 *  file" result (returns null). Handles both HTTP 404 (production
 *  builds) and Vite dev's SPA fallback that serves index.html with a
 *  text/html Content-Type when the static file is absent.
 *
 *  The .next.meta.json files don't exist between AIRAC pre-releases,
 *  so a missing-file response is the steady state, not a failure. */
async function fetchOptionalJSON<T>(path: string): Promise<T | null> {
	const res = await fetch(path);
	if (res.status === 404) {
		return null;
	}
	if (!res.ok) {
		throw new Error(`${path}: HTTP ${res.status}`);
	}
	const ct = res.headers.get('content-type') ?? '';
	if (!ct.includes('json')) {
		return null;
	}
	return (await res.json()) as T;
}

/** Build a loader over `fetchJSON` for one meta sidecar: caches its promise
 *  (re-opening the About modal is instant) and clears the cache on failure
 *  so a later call can retry. */
function metaLoader<T>(path: string): () => Promise<T> {
	let promise: Promise<T> | null = null;
	return () => {
		if (!promise) {
			promise = fetchJSON<T>(path).catch((e: unknown) => {
				promise = null;
				throw e;
			});
		}
		return promise;
	};
}

/** `metaLoader` over `fetchOptionalJSON`: a missing sidecar resolves null
 *  (the steady state for `.next` slots and not-yet-published datasets). */
function optionalMetaLoader<T>(path: string): () => Promise<T | null> {
	let promise: Promise<T | null> | null = null;
	return () => {
		if (!promise) {
			promise = fetchOptionalJSON<T>(path).catch((e: unknown) => {
				promise = null;
				throw e;
			});
		}
		return promise;
	};
}

/** French SIA airspace meta; counts, AIRAC effective date, source file. */
export const loadFrenchAirspacesMeta = metaLoader<FrenchAirspacesMeta>(
	'/data/fr-airspaces.meta.json',
);

/** Next-AIRAC SIA airspace meta. Resolves to null when the `.next.meta.json`
 *  file isn't published (the normal state between SIA releases). */
export const loadFrenchAirspacesNextMeta = optionalMetaLoader<FrenchAirspacesMeta>(
	'/data/fr-airspaces.next.meta.json',
);

/** Worldwide OurAirports airports meta. No AIRAC slot; monthly refresh. */
export const loadAirportsMeta = metaLoader<AirportsMeta>('/data/airports.meta.json');

/** Worldwide NOAA AWC METAR station catalog meta. No AIRAC slot; weekly. */
export const loadMetarStationsMeta = metaLoader<MetarStationsMeta>(
	'/data/metar-stations.meta.json',
);

/** FAA aircraft type designator catalog meta. No AIRAC slot; manual
 *  refresh per order edition. */
export const loadFaaDesignatorsMeta = metaLoader<FaaDesignatorsMeta>(
	'/data/faa-designators.meta.json',
);

/** Committed aircraft-library meta (also the per-plane YAML file index). */
export const loadAircraftMeta = metaLoader<AircraftMeta>('/data/aircraft.meta.json');

/** French SIA AIXM airport enrichment meta; AIRAC effective + AIXM counts. */
export const loadFrAirportsMeta = metaLoader<FrAirportsMeta>(
	'/data/fr-airports.meta.json',
);

/** Next-AIRAC French airport meta. Null when no `.next.meta.json` is published. */
export const loadFrAirportsNextMeta = optionalMetaLoader<FrAirportsMeta>(
	'/data/fr-airports.next.meta.json',
);

/** French SIA obstacles meta; per-type counts, AIRAC effective date. */
export const loadObstaclesMeta = metaLoader<ObstaclesMeta>(
	'/data/fr-obstacles.meta.json',
);

/** Next-AIRAC obstacles meta. Null when no `.next.meta.json` is published. */
export const loadObstaclesNextMeta = optionalMetaLoader<ObstaclesMeta>(
	'/data/fr-obstacles.next.meta.json',
);

/** French SIA AD-2 aerodrome-facilities meta; AIRAC effective date. */
export const loadFacilitiesMeta = metaLoader<FacilitiesMeta>(
	'/data/fr-aerodrome-facilities.meta.json',
);

/** Next-AIRAC facilities meta. Null when no `.next.meta.json` is published. */
export const loadFacilitiesNextMeta = optionalMetaLoader<FacilitiesMeta>(
	'/data/fr-aerodrome-facilities.next.meta.json',
);

/** The other publishers' aerodrome-facilities metas (internal/aixm5build):
 *  the same shape, plus the counters the shared builder adds. Belgium and
 *  Germany publish a pre-release slot; the UK and Spain do not. */
export const loadBeFacilitiesMeta = metaLoader<FacilitiesMeta>(
	'/data/be-aerodrome-facilities.meta.json',
);
export const loadBeFacilitiesNextMeta = optionalMetaLoader<FacilitiesMeta>(
	'/data/be-aerodrome-facilities.next.meta.json',
);
export const loadDeFacilitiesMeta = metaLoader<FacilitiesMeta>(
	'/data/de-aerodrome-facilities.meta.json',
);
export const loadDeFacilitiesNextMeta = optionalMetaLoader<FacilitiesMeta>(
	'/data/de-aerodrome-facilities.next.meta.json',
);
export const loadUkFacilitiesMeta = metaLoader<FacilitiesMeta>(
	'/data/uk-aerodrome-facilities.meta.json',
);
export const loadEsFacilitiesMeta = metaLoader<FacilitiesMeta>(
	'/data/es-aerodrome-facilities.meta.json',
);
export const loadGeFacilitiesMeta = metaLoader<FacilitiesMeta>(
	'/data/ge-aerodrome-facilities.meta.json',
);

/** at-adcharts.meta.json (cmd/at): the Austro Control eAIP link scrape. */
export interface AtAdChartsMeta {
	generatedAt: string;
	effective: string;
	validUntil?: string;
	source: string;
	edition: string;
	base: string;
	aerodromes: number;
	heliports: number;
	withCharts: number;
	charts: number;
	byFamily: Record<string, number>;
	unknownChartNumbers: string[];
}

/** SIA eAIP aerodrome chart-links meta (cmd/adcharts); AIRAC effective. */
export const loadFrAdChartsMeta = metaLoader<FrAdChartsMeta>(
	'/data/fr-adcharts.meta.json',
);

/** Next-cycle chart-links meta. Null outside the SIA pre-release window. */
export const loadFrAdChartsNextMeta = optionalMetaLoader<FrAdChartsMeta>(
	'/data/fr-adcharts.next.meta.json',
);

/** VAC panel georeference meta (cmd/vacgeo); AIRAC effective. */
export const loadFrVacGeoMeta = optionalMetaLoader<FrVacGeoMeta>(
	'/data/fr-vacgeo.meta.json',
);

/** Next-cycle panel georeference meta. Null outside the pre-release window. */
export const loadFrVacGeoNextMeta = optionalMetaLoader<FrVacGeoMeta>(
	'/data/fr-vacgeo.next.meta.json',
);

/** NATS eAIP aerodrome chart-links meta (cmd/ukcharts); AIRAC effective. */
export const loadUkAdChartsMeta = optionalMetaLoader<UkAdChartsMeta>(
	'/data/uk-adcharts.meta.json',
);

/** Next-cycle chart-links meta. Null outside the NATS pre-release window. */
export const loadUkAdChartsNextMeta = optionalMetaLoader<UkAdChartsMeta>(
	'/data/uk-adcharts.next.meta.json',
);

/** FAA d-TPP chart meta (cmd/faa -only adcharts); AIRAC effective. */
export const loadUsAdChartsMeta = optionalMetaLoader<UsAdChartsMeta>(
	'/data/us-adcharts.meta.json',
);

/** Next-cycle chart meta; the FAA publishes cycles ahead. */
export const loadUsAdChartsNextMeta = optionalMetaLoader<UsAdChartsMeta>(
	'/data/us-adcharts.next.meta.json',
);

/** DFS VFR eAIP aerodrome-link meta (cmd/de -only adcharts). */
export const loadDeAdChartsMeta = optionalMetaLoader<DeAdChartsMeta>(
	'/data/de-adcharts.meta.json',
);

/** Austro Control eAIP aerodrome-links meta (cmd/at -only adcharts). */
export const loadAtAdChartsMeta = optionalMetaLoader<AtAdChartsMeta>(
	'/data/at-adcharts.meta.json',
);

/** Next-edition links meta; the eAIP publishes editions ahead. */
export const loadAtAdChartsNextMeta = optionalMetaLoader<AtAdChartsMeta>(
	'/data/at-adcharts.next.meta.json',
);

/** French SIA navaids meta; per-type counts, AIRAC effective date. */
export const loadNavaidsMeta = metaLoader<NavaidsMeta>('/data/fr-navaids.meta.json');

/** Next-AIRAC navaids meta. Null when no `.next.meta.json` is published. */
export const loadNavaidsNextMeta = optionalMetaLoader<NavaidsMeta>(
	'/data/fr-navaids.next.meta.json',
);

/** French SIA nature-zone meta; PRN + SUR counts, AIRAC effective date. */
export const loadNatureMeta = metaLoader<NatureMeta>('/data/fr-nature.meta.json');

/** Next-AIRAC nature-zone meta. Null when no `.next.meta.json` is published. */
export const loadNatureNextMeta = optionalMetaLoader<NatureMeta>(
	'/data/fr-nature.next.meta.json',
);

/* --- UK NATS AIXM 5.1 metas (cmd/uk) ---
 * All return optional (null when the file isn't published yet), since the
 * UK dataset itself is optional: a fresh clone before the first weekly
 * workflow run won't have these files. */

export const loadUkAirspacesMeta = optionalMetaLoader<AixmAirspacesMeta>(
	'/data/uk-airspaces.meta.json',
);
export const loadUkAirspacesNextMeta = optionalMetaLoader<AixmAirspacesMeta>(
	'/data/uk-airspaces.next.meta.json',
);
export const loadUkAirportsMeta = optionalMetaLoader<AixmAirportsMeta>(
	'/data/uk-airports.meta.json',
);
export const loadUkAirportsNextMeta = optionalMetaLoader<AixmAirportsMeta>(
	'/data/uk-airports.next.meta.json',
);
export const loadUkObstaclesMeta = optionalMetaLoader<AixmObstaclesMeta>(
	'/data/uk-obstacles.meta.json',
);
export const loadUkObstaclesNextMeta = optionalMetaLoader<AixmObstaclesMeta>(
	'/data/uk-obstacles.next.meta.json',
);
export const loadUkNavaidsMeta = optionalMetaLoader<AixmNavaidsMeta>(
	'/data/uk-navaids.meta.json',
);
export const loadUkNavaidsNextMeta = optionalMetaLoader<AixmNavaidsMeta>(
	'/data/uk-navaids.next.meta.json',
);

/* --- ES ENAIRE AIXM 5.1 metas (cmd/es) ---
 * ENAIRE doesn't stamp an AIRAC `effective` date on AIP files, so the
 * dual-slot picker treats next as a no-op until that changes. */

export const loadEsAirspacesMeta = optionalMetaLoader<AixmAirspacesMeta>(
	'/data/es-airspaces.meta.json',
);
export const loadEsAirspacesNextMeta = optionalMetaLoader<AixmAirspacesMeta>(
	'/data/es-airspaces.next.meta.json',
);
export const loadEsAirportsMeta = optionalMetaLoader<AixmAirportsMeta>(
	'/data/es-airports.meta.json',
);
export const loadEsAirportsNextMeta = optionalMetaLoader<AixmAirportsMeta>(
	'/data/es-airports.next.meta.json',
);
export const loadEsObstaclesMeta = optionalMetaLoader<AixmObstaclesMeta>(
	'/data/es-obstacles.meta.json',
);
export const loadEsObstaclesNextMeta = optionalMetaLoader<AixmObstaclesMeta>(
	'/data/es-obstacles.next.meta.json',
);
export const loadEsNavaidsMeta = optionalMetaLoader<AixmNavaidsMeta>(
	'/data/es-navaids.meta.json',
);
export const loadEsNavaidsNextMeta = optionalMetaLoader<AixmNavaidsMeta>(
	'/data/es-navaids.next.meta.json',
);

/** Pruatlas FIR/UIR overlay meta; one upstream URL, sha256, and the AIRAC
 *  cycle the file claims. */
export const loadPruatlasFirsMeta = metaLoader<PruatlasFirsMeta>(
	'/data/pruatlas-firs.meta.json',
);

/** FAA airspace overlay meta; three upstreams (Boundary, Special-Use, Class)
 *  and the per-type count breakdown. */
export const loadFaaAirspacesMeta = metaLoader<FaaAirspacesMeta>(
	'/data/faa-airspaces.meta.json',
);

/* ---- Belgium & Luxembourg (cmd/be, skeyes eAIP) ---- */

export const loadBeAirspacesMeta = optionalMetaLoader<AixmAirspacesMeta>(
	'/data/be-airspaces.meta.json',
);
export const loadBeAirspacesNextMeta = optionalMetaLoader<AixmAirspacesMeta>(
	'/data/be-airspaces.next.meta.json',
);
export const loadBeAirportsMeta = optionalMetaLoader<AixmAirportsMeta>(
	'/data/be-airports.meta.json',
);
export const loadBeAirportsNextMeta = optionalMetaLoader<AixmAirportsMeta>(
	'/data/be-airports.next.meta.json',
);
export const loadBeObstaclesMeta = optionalMetaLoader<AixmObstaclesMeta>(
	'/data/be-obstacles.meta.json',
);
export const loadBeObstaclesNextMeta = optionalMetaLoader<AixmObstaclesMeta>(
	'/data/be-obstacles.next.meta.json',
);
export const loadBeNavaidsMeta = optionalMetaLoader<AixmNavaidsMeta>(
	'/data/be-navaids.meta.json',
);
export const loadBeNavaidsNextMeta = optionalMetaLoader<AixmNavaidsMeta>(
	'/data/be-navaids.next.meta.json',
);

export const loadDeAirspacesMeta = optionalMetaLoader<AixmAirspacesMeta>(
	'/data/de-airspaces.meta.json',
);
export const loadDeAirspacesNextMeta = optionalMetaLoader<AixmAirspacesMeta>(
	'/data/de-airspaces.next.meta.json',
);
export const loadDeAirportsMeta = optionalMetaLoader<AixmAirportsMeta>(
	'/data/de-airports.meta.json',
);
export const loadDeAirportsNextMeta = optionalMetaLoader<AixmAirportsMeta>(
	'/data/de-airports.next.meta.json',
);
export const loadDeObstaclesMeta = optionalMetaLoader<AixmObstaclesMeta>(
	'/data/de-obstacles.meta.json',
);
export const loadDeObstaclesNextMeta = optionalMetaLoader<AixmObstaclesMeta>(
	'/data/de-obstacles.next.meta.json',
);
export const loadDeNavaidsMeta = optionalMetaLoader<AixmNavaidsMeta>(
	'/data/de-navaids.meta.json',
);
export const loadDeNavaidsNextMeta = optionalMetaLoader<AixmNavaidsMeta>(
	'/data/de-navaids.next.meta.json',
);
export const loadAtAirspacesMeta = optionalMetaLoader<AixmAirspacesMeta>(
	'/data/at-airspaces.meta.json',
);
export const loadAtAirspacesNextMeta = optionalMetaLoader<AixmAirspacesMeta>(
	'/data/at-airspaces.next.meta.json',
);
export const loadAtAirportsMeta = optionalMetaLoader<AixmAirportsMeta>(
	'/data/at-airports.meta.json',
);
export const loadAtAirportsNextMeta = optionalMetaLoader<AixmAirportsMeta>(
	'/data/at-airports.next.meta.json',
);
export const loadAtObstaclesMeta = optionalMetaLoader<AixmObstaclesMeta>(
	'/data/at-obstacles.meta.json',
);
export const loadAtObstaclesNextMeta = optionalMetaLoader<AixmObstaclesMeta>(
	'/data/at-obstacles.next.meta.json',
);
export const loadAtNavaidsMeta = optionalMetaLoader<AixmNavaidsMeta>(
	'/data/at-navaids.meta.json',
);
export const loadAtNavaidsNextMeta = optionalMetaLoader<AixmNavaidsMeta>(
	'/data/at-navaids.next.meta.json',
);
export const loadFaaAirportsMeta = optionalMetaLoader<AixmAirportsMeta>(
	'/data/faa-airports.meta.json',
);
export const loadFaaAirportsNextMeta = optionalMetaLoader<AixmAirportsMeta>(
	'/data/faa-airports.next.meta.json',
);
export const loadFaaNavaidsMeta = optionalMetaLoader<AixmNavaidsMeta>(
	'/data/faa-navaids.meta.json',
);
export const loadFaaNavaidsNextMeta = optionalMetaLoader<AixmNavaidsMeta>(
	'/data/faa-navaids.next.meta.json',
);
export const loadFaaObstaclesMeta = optionalMetaLoader<AixmObstaclesMeta>(
	'/data/faa-obstacles.meta.json',
);
export const loadFaaObstaclesNextMeta = optionalMetaLoader<AixmObstaclesMeta>(
	'/data/faa-obstacles.next.meta.json',
);
export const loadGeAirspacesMeta = optionalMetaLoader<AixmAirspacesMeta>(
	'/data/ge-airspaces.meta.json',
);
export const loadGeAirspacesNextMeta = optionalMetaLoader<AixmAirspacesMeta>(
	'/data/ge-airspaces.next.meta.json',
);
export const loadGeAirportsMeta = optionalMetaLoader<AixmAirportsMeta>(
	'/data/ge-airports.meta.json',
);
export const loadGeAirportsNextMeta = optionalMetaLoader<AixmAirportsMeta>(
	'/data/ge-airports.next.meta.json',
);
export const loadGeNavaidsMeta = optionalMetaLoader<AixmNavaidsMeta>(
	'/data/ge-navaids.meta.json',
);
export const loadGeNavaidsNextMeta = optionalMetaLoader<AixmNavaidsMeta>(
	'/data/ge-navaids.next.meta.json',
);
export const loadItAirspacesMeta = optionalMetaLoader<AixmAirspacesMeta>(
	'/data/it-airspaces.meta.json',
);
export const loadItAirspacesNextMeta = optionalMetaLoader<AixmAirspacesMeta>(
	'/data/it-airspaces.next.meta.json',
);
export const loadItAirportsMeta = optionalMetaLoader<AixmAirportsMeta>(
	'/data/it-airports.meta.json',
);
export const loadItAirportsNextMeta = optionalMetaLoader<AixmAirportsMeta>(
	'/data/it-airports.next.meta.json',
);
export const loadItNavaidsMeta = optionalMetaLoader<AixmNavaidsMeta>(
	'/data/it-navaids.meta.json',
);
export const loadItNavaidsNextMeta = optionalMetaLoader<AixmNavaidsMeta>(
	'/data/it-navaids.next.meta.json',
);
export const loadItNatureMeta = optionalMetaLoader<NatureMeta>(
	'/data/it-nature.meta.json',
);
export const loadItNatureNextMeta = optionalMetaLoader<NatureMeta>(
	'/data/it-nature.next.meta.json',
);
export const loadChObstaclesMeta = optionalMetaLoader<AixmObstaclesMeta>(
	'/data/ch-obstacles.meta.json',
);
export const loadChObstaclesNextMeta = optionalMetaLoader<AixmObstaclesMeta>(
	'/data/ch-obstacles.next.meta.json',
);
export const loadFiObstaclesMeta = optionalMetaLoader<AixmObstaclesMeta>(
	'/data/fi-obstacles.meta.json',
);
export const loadFiObstaclesNextMeta = optionalMetaLoader<AixmObstaclesMeta>(
	'/data/fi-obstacles.next.meta.json',
);
export const loadNlAirspacesMeta = optionalMetaLoader<AixmAirspacesMeta>(
	'/data/nl-airspaces.meta.json',
);
export const loadNlAirspacesNextMeta = optionalMetaLoader<AixmAirspacesMeta>(
	'/data/nl-airspaces.next.meta.json',
);
export const loadNlAirportsMeta = optionalMetaLoader<AixmAirportsMeta>(
	'/data/nl-airports.meta.json',
);
export const loadNlAirportsNextMeta = optionalMetaLoader<AixmAirportsMeta>(
	'/data/nl-airports.next.meta.json',
);
export const loadNlNavaidsMeta = optionalMetaLoader<AixmNavaidsMeta>(
	'/data/nl-navaids.meta.json',
);
export const loadNlNavaidsNextMeta = optionalMetaLoader<AixmNavaidsMeta>(
	'/data/nl-navaids.next.meta.json',
);
export const loadSkAirspacesMeta = optionalMetaLoader<AixmAirspacesMeta>(
	'/data/sk-airspaces.meta.json',
);
export const loadSkAirspacesNextMeta = optionalMetaLoader<AixmAirspacesMeta>(
	'/data/sk-airspaces.next.meta.json',
);
export const loadIeAirspacesMeta = optionalMetaLoader<AixmAirspacesMeta>(
	'/data/ie-airspaces.meta.json',
);
export const loadIeAirspacesNextMeta = optionalMetaLoader<AixmAirspacesMeta>(
	'/data/ie-airspaces.next.meta.json',
);
export const loadSkNavaidsMeta = optionalMetaLoader<AixmNavaidsMeta>(
	'/data/sk-navaids.meta.json',
);
export const loadSkNavaidsNextMeta = optionalMetaLoader<AixmNavaidsMeta>(
	'/data/sk-navaids.next.meta.json',
);
export const loadIeNavaidsMeta = optionalMetaLoader<AixmNavaidsMeta>(
	'/data/ie-navaids.meta.json',
);
export const loadIeNavaidsNextMeta = optionalMetaLoader<AixmNavaidsMeta>(
	'/data/ie-navaids.next.meta.json',
);
export const loadRsAirspacesMeta = optionalMetaLoader<AixmAirspacesMeta>(
	'/data/rs-airspaces.meta.json',
);
export const loadRsAirspacesNextMeta = optionalMetaLoader<AixmAirspacesMeta>(
	'/data/rs-airspaces.next.meta.json',
);
export const loadRsNavaidsMeta = optionalMetaLoader<AixmNavaidsMeta>(
	'/data/rs-navaids.meta.json',
);
export const loadRsNavaidsNextMeta = optionalMetaLoader<AixmNavaidsMeta>(
	'/data/rs-navaids.next.meta.json',
);
export const loadXkAirspacesMeta = optionalMetaLoader<AixmAirspacesMeta>(
	'/data/xk-airspaces.meta.json',
);
export const loadXkAirspacesNextMeta = optionalMetaLoader<AixmAirspacesMeta>(
	'/data/xk-airspaces.next.meta.json',
);
export const loadXkNavaidsMeta = optionalMetaLoader<AixmNavaidsMeta>(
	'/data/xk-navaids.meta.json',
);
export const loadXkNavaidsNextMeta = optionalMetaLoader<AixmNavaidsMeta>(
	'/data/xk-navaids.next.meta.json',
);
export const loadBeNatureMeta = optionalMetaLoader<NatureMeta>(
	'/data/be-nature.meta.json',
);
export const loadBeNatureNextMeta = optionalMetaLoader<NatureMeta>(
	'/data/be-nature.next.meta.json',
);
export const loadBeSupAipMeta = optionalMetaLoader<SupAipMeta>(
	'/data/be-supaip.meta.json',
);

/** French SUP AIP overlay meta. Single plain file (not AIRAC-sliced); each
 *  supplement carries its own validity window. */
export const loadSupAipMeta = metaLoader<SupAipMeta>('/data/fr-supaip.meta.json');

/** Decide which dataset URL to fetch given the two cycles' effective dates
 *  and the current wall-clock time. The next slot wins only when its
 *  effective is later than the current's AND has already arrived
 *  relative to `now`. Null / unparseable values are treated as "no
 *  candidate"; the current slot is the fallback. Effectives compare via
 *  `parseEffectiveMs` (UTC midnight of the stamp's own calendar date),
 *  so an SIA `+02:00` local-midnight stamp activates on the AIRAC date
 *  itself, not at 22:00Z the evening before. */
export function pickActiveDataset(
	currentEffective: string | null,
	nextEffective: string | null,
	currentUrl: string,
	nextUrl: string,
	now: Date,
): { url: string; effective: string | null; slot: 'current' | 'next' } {
	const nextMs = nextEffective ? (parseEffectiveMs(nextEffective) ?? NaN) : NaN;
	const currentMs = currentEffective ? (parseEffectiveMs(currentEffective) ?? -Infinity) : -Infinity;
	const nowMs = now.getTime();
	if (
		Number.isFinite(nextMs) &&
		nextMs <= nowMs &&
		nextMs > currentMs
	) {
		return { url: nextUrl, effective: nextEffective, slot: 'next' };
	}
	return {
		url: currentUrl,
		effective: currentEffective,
		slot: 'current',
	};
}

/** Heartbeat companion to {@link pickActiveDataset}: given the slot a session
 *  already loaded, would the picker now choose a different one (so the UI
 *  should prompt a reload)? `loadedEffective` is the loaded slot's own
 *  effective date (what `dataState.*Effective` stores), `nextEffective` the
 *  next cycle's.
 *
 *  Only a loaded **current** slot can go stale mid-session: once the next
 *  cycle's effective date arrives (and is newer than current), the picker
 *  upgrades current -> next. A loaded **next** slot is terminal, so this
 *  returns false for it: the wall clock only advances, so the picker keeps
 *  choosing next and never reverts to current within a session. That guard is
 *  also load-bearing, not just an optimisation: once next is loaded
 *  `loadedEffective` IS next's date, so re-deriving the choice would compare
 *  next against itself (`nextMs > currentMs` false on equality) and report a
 *  phantom switch on every tick, forever. */
export function wouldSwitch(
	loadedEffective: string | null,
	nextEffective: string | null,
	loadedSlot: 'current' | 'next' | null,
	now: Date,
): boolean {
	if (loadedSlot !== 'current') {
		return false;
	}
	// URLs are irrelevant here; only the chosen slot matters. In this branch
	// `loadedEffective` is the current cycle's date, so the call reproduces the
	// loader's original decision exactly.
	return pickActiveDataset(loadedEffective, nextEffective, '', '', now).slot === 'next';
}
