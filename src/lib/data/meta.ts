/* Typed loaders for the dataset companion `.meta.json` files. Used by the
 * About modal to show how fresh the bundled data is; AIRAC cycle, source
 * counts, and the build timestamp. Each loader caches its promise so
 * re-opening the modal is instant; failures are surfaced to the caller
 * (the modal renders "unavailable" rather than blocking). */

import { parseEffectiveMs } from '$lib/data/airac';
import { datasetMetaUrl, type DatasetKind, type Publisher } from '$lib/data/publishers';
import { DataReadError, readDataJson } from '$lib/data/fetchData';

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

/** What every dataset sidecar carries, whatever else it adds: the AIRAC
 *  effective date the slot picker chooses by, and the envelope the
 *  coverage gate fetches by. */
export interface DatasetMetaBase {
	effective: string;
	bbox?: DatasetBBox;
	bboxes?: DatasetBBoxes;
}

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
	/** A stated boundary decoded to no ring: geometry lost. */
	skippedNoBoundary: number;
	/** No boundary stated, the extent other airspaces' (absent from a
	 *  sidecar written before 2026-09-28). */
	skippedNoProjection?: number;
	skippedNoType: number;
	skippedNonBaseline: number;
	/** Every feature's unresolved links; the boundaries' own share is
	 *  `unresolvedGeometryXlinks`, the figure to watch. */
	unresolvedXlinks: number;
	unresolvedGeometryXlinks?: number;
	/** TMA parts a drawn whole covers, not drawn again. */
	skippedCoveredParts?: number;
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
	/** The aerodrome chart links the rows carry, where the publisher files
	 *  them in its airport set (Belgium's eAIP column, cmd/be). */
	chartCount?: number;
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
	/** The Atlas VAC's own index: its aerodrome and heliport plates. */
	vacAerodromes?: number;
	vacHeliports?: number;
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

/** cmd/fuel: which grades each French aerodrome publishes.
 *
 * Two effective dates, and they are not the same date. The plate half
 * follows the fr-adcharts cycle and refreshes weekly in CI; the AIXM half
 * follows fr-aerodrome-facilities, rebuilt by hand from the SIA export.
 * Publishing one of them would misdate the other's rows. */
export interface FrFuelMeta {
	generatedAt: string;
	effective: string;
	aixmEffective: string;
	source: { site: string; plates: string; dataset: string; facilities: string };
	aerodromes: number;
	withGrades: number;
	noFuel: number;
	/** Entries the AIP states and no grammar could read. Their prose still
	 *  shows; this is the residue to work down. */
	statedNoGrade: number;
	bySource: Record<string, number>;
	agreement: Record<string, number>;
	byGrade: Record<string, number>;
	/** The closed vocabulary this build could emit; tests/fuelGrades.spec.ts
	 *  pins FUEL_TYPES against it. */
	grades: string[];
	plates: {
		plates: number;
		missing: number;
		withItem: number;
		noItem: number;
		cutByPage: number;
	};
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

/** A sidecar the deployment must hold: rejects on any failure, an absent
 *  file included, a transient one saying so (src/lib/data/fetchData.ts). */
function fetchJSON<T>(path: string, fresh = false): Promise<T> {
	return readDataJson<T>(path, fresh ? { cache: 'no-cache' } : {});
}

/** Like `fetchJSON` but treats a missing file as a normal "no such
 *  file" result (returns null): a 404 or a 410, or Vite dev's SPA
 *  fallback that serves index.html when the static file is absent.
 *
 *  The .next.meta.json files don't exist between AIRAC pre-releases,
 *  so a missing-file response is the steady state, not a failure. A
 *  failure worth asking again still rejects, so the loader below forgets
 *  it and the next call reads again. */
async function fetchOptionalJSON<T>(path: string, fresh = false): Promise<T | null> {
	try {
		return await readDataJson<T>(path, fresh ? { cache: 'no-cache' } : {});
	} catch (e) {
		if (e instanceof DataReadError && e.absent) {
			return null;
		}
		throw e;
	}
}

/** One sidecar's loader. Its answer is kept for the session; `fresh` reads
 *  the sidecar again, from the server whatever the browser holds
 *  (loadActiveSlot, when the file a kept answer picked is gone). */
export type SidecarLoader<T> = (fresh?: boolean) => Promise<T>;

/** Build a loader over `fetchJSON` for one meta sidecar: caches its promise
 *  (re-opening the About modal is instant) and clears the cache on failure
 *  so a later call can retry. */
function metaLoader<T>(path: string): SidecarLoader<T> {
	let promise: Promise<T> | null = null;
	return (fresh = false) => {
		if (!promise || fresh) {
			const p: Promise<T> = fetchJSON<T>(path, fresh).catch((e: unknown) => {
				if (promise === p) {
					promise = null;
				}
				throw e;
			});
			promise = p;
		}
		return promise;
	};
}

/** `metaLoader` over `fetchOptionalJSON`: a missing sidecar resolves null
 *  (the steady state for `.next` slots and not-yet-published datasets). */
function optionalMetaLoader<T>(path: string): SidecarLoader<T | null> {
	let promise: Promise<T | null> | null = null;
	return (fresh = false) => {
		if (!promise || fresh) {
			const p: Promise<T | null> = fetchOptionalJSON<T>(path, fresh).catch((e: unknown) => {
				if (promise === p) {
					promise = null;
				}
				throw e;
			});
			promise = p;
		}
		return promise;
	};
}

/** The sidecar loaders of the publisher registry's datasets
 *  ($lib/data/publishers), one per path and shared by every caller, so the
 *  slot picker and the About modal never fetch one sidecar twice. Optional
 *  like every per-country sidecar: a dataset whose first build has not run
 *  resolves null. */
const datasetMetaLoaders = new Map<string, SidecarLoader<unknown>>();

export function datasetMeta<T = DatasetMetaBase>(
	id: Publisher,
	kind: DatasetKind,
	next = false,
): SidecarLoader<T | null> {
	const path = datasetMetaUrl(id, kind, next);
	let loader = datasetMetaLoaders.get(path);
	if (!loader) {
		loader = optionalMetaLoader<unknown>(path);
		datasetMetaLoaders.set(path, loader);
	}
	return loader as SidecarLoader<T | null>;
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

/** An eAIP chart index's meta (cmd/eaip -only adcharts,
 *  $lib/data/aipCharts). */
export interface AipChartsMeta {
	generatedAt: string;
	effective: string;
	source: string;
	edition: string;
	base: string;
	aerodromes: number;
	heliports: number;
	withCharts: number;
	withVac: number;
	charts: number;
	byFamily: Record<string, number>;
}

/** The eAIP chart indexes' sidecar loaders, one per path. */
const aipChartsMetaLoaders = new Map<string, SidecarLoader<AipChartsMeta | null>>();

/** One chart index's sidecar loader, current slot or the next one. */
export function aipChartsMeta(id: string, next = false): SidecarLoader<AipChartsMeta | null> {
	const path = `/data/${id}-adcharts${next ? '.next' : ''}.meta.json`;
	let loader = aipChartsMetaLoaders.get(path);
	if (!loader) {
		loader = optionalMetaLoader<AipChartsMeta>(path);
		aipChartsMetaLoaders.set(path, loader);
	}
	return loader;
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

export const loadFrFuelMeta = optionalMetaLoader<FrFuelMeta>('/data/fr-fuel.meta.json');

/** Next-cycle fuel meta. cmd/fuel writes that slot only when BOTH its
 *  sources have one, so this stays null through a window in which only the
 *  facilities dataset has a pre-release. */
export const loadFrFuelNextMeta = optionalMetaLoader<FrFuelMeta>(
	'/data/fr-fuel.next.meta.json',
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

/* --- ES ENAIRE AIXM 5.1 metas (cmd/es) ---
 * ENAIRE doesn't stamp an AIRAC `effective` date on AIP files, so the
 * dual-slot picker treats next as a no-op until that changes. */

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
export const loadBeSupAipMeta = optionalMetaLoader<SupAipMeta>(
	'/data/be-supaip.meta.json',
);
/** Spanish SUP AIP meta (cmd/es). Like the Belgian one, a subset of the
 *  French shape: the ENAIRE editions are HTML, so the PDF-parse counters
 *  do not apply. */
export const loadEsSupAipMeta = optionalMetaLoader<SupAipMeta>(
	'/data/es-supaip.meta.json',
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

/** Read the file the sidecars pick ({@link pickActiveDataset}), a NEXT pick
 *  that answers nothing checked against fresh sidecars. The loaders keep a
 *  sidecar's answer for the session, and a build RETIRES a next pair once
 *  the current slot has caught up with it (pruneSupersededNext in
 *  internal/aip), so a session that read the pair before that build picks a
 *  file that is gone: a loader reading a missing file as nothing there
 *  answered an empty list for the rest of the session, and one requiring its
 *  file failed every retry on the same kept answer. Read again, the
 *  sidecars pick the current slot, which holds that cycle now. A next file
 *  that really is empty costs the two sidecar reads and stands. `load` is
 *  handed the picking instant, which the chart indexes date their links by.
 *  The country datasets apply the same rule inside their own pass
 *  (loadCountryDatasets in state/data.svelte.ts), where the coverage gate
 *  sits between the pick and the read. */
export async function loadActiveSlot<T>(
	meta: SidecarLoader<{ effective: string } | null>,
	nextMeta: SidecarLoader<{ effective: string } | null>,
	url: string,
	nextUrl: string,
	load: (url: string, nowMs: number) => Promise<T[]>,
): Promise<T[]> {
	const pick = async (fresh: boolean): Promise<{ url: string; slot: 'current' | 'next'; nowMs: number }> => {
		const [m, n] = await Promise.all([meta(fresh).catch(() => null), nextMeta(fresh).catch(() => null)]);
		// One-shot timestamp passed by value; not a reactive ref.
		const now = new Date();
		const picked = pickActiveDataset(m?.effective ?? null, n?.effective ?? null, url, nextUrl, now);
		return { url: picked.url, slot: picked.slot, nowMs: now.getTime() };
	};
	const first = await pick(false);
	if (first.slot !== 'next') {
		return load(first.url, first.nowMs);
	}
	let rows: T[];
	try {
		rows = await load(first.url, first.nowMs);
	} catch (e) {
		if (!(e instanceof DataReadError && e.absent)) {
			throw e;
		}
		const again = await pick(true);
		if (again.url === first.url) {
			throw e;
		}
		return load(again.url, again.nowMs);
	}
	if (rows.length > 0) {
		return rows;
	}
	const again = await pick(true);
	return again.url === first.url ? rows : load(again.url, again.nowMs);
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
