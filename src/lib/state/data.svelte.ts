/* Lazily-loaded reference datasets: airports and airspaces.
 *
 * Per-country layout (Phase 0 onwards):
 *
 *   - airports.json: worldwide OurAirports baseline (monthly refresh,
 *     no AIRAC slot).
 *   - fr-airports.json (+ .next.json): French AIXM enrichment; merges
 *     onto the OurAirports baseline at load time. Other countries plug
 *     in here later (uk-airports.json, es-airports.json, ...).
 *   - fr-airspaces.json (+ .next.json): French SIA AIXM; ensureAirspaces
 *     unions it with the pruatlas and FAA overlays. Other countries
 *     plug in here later.
 *   - fr-obstacles.json (+ .next.json): French SIA obstacles. Other
 *     countries plug in here later.
 *
 * `ensureAirspaces()` / `ensureAirports()` / `ensureObstacles()` fetch
 * the per-country current + next .meta.json siblings, pick the slot
 * whose effective date is <= now, and load that dataset. A 60-second
 * tick re-evaluates the active slot; when the answer changes
 * mid-session, `dataState.airacSwitchPending` is set so the UI can
 * prompt the user to reload. Mid-session swap isn't performed: tearing
 * down buildAirspaceLayer / activation overlay / autorouter ICAO state
 * would be more disruptive than the reload. */

import {
	AIRPORTS_URL,
	ES_AIRPORTS_URL,
	ES_AIRPORTS_NEXT_URL,
	BE_AIRPORTS_URL,
	BE_AIRPORTS_NEXT_URL,
	DE_AIRPORTS_URL,
	DE_AIRPORTS_NEXT_URL,
	AT_AIRPORTS_URL,
	AT_AIRPORTS_NEXT_URL,
	GE_AIRPORTS_URL,
	GE_AIRPORTS_NEXT_URL,
	NL_AIRPORTS_URL,
	NL_AIRPORTS_NEXT_URL,
	IT_AIRPORTS_URL,
	IT_AIRPORTS_NEXT_URL,
	FAA_AIRPORTS_URL,
	FAA_AIRPORTS_NEXT_URL,
	FR_AIRPORTS_URL,
	UK_AIRPORTS_URL,
	UK_AIRPORTS_NEXT_URL,
	loadAirports,
	loadFrAirports,
	type Airport,
} from '$lib/data/airports';
import {
	mergeAixmOverlay,
	applyFrAutoInfoFrequency,
	applyDeMilitaryStatus,
	dropStaleBaseline,
} from '$lib/data/airportMerge';
import { mergeAirspaces } from '$lib/data/airspaceMerge';
import type { Publisher } from '$lib/state/layers.svelte';
import {
	AIRSPACES_URL,
	BE_AIRSPACES_URL,
	BE_AIRSPACES_NEXT_URL,
	loadBeAirspaces,
	DE_AIRSPACES_URL,
	DE_AIRSPACES_NEXT_URL,
	loadDeAirspaces,
	AT_AIRSPACES_URL,
	AT_AIRSPACES_NEXT_URL,
	loadAtAirspaces,
	GE_AIRSPACES_URL,
	GE_AIRSPACES_NEXT_URL,
	loadGeAirspaces,
	NL_AIRSPACES_URL,
	NL_AIRSPACES_NEXT_URL,
	loadNlAirspaces,
	SK_AIRSPACES_URL,
	IE_AIRSPACES_URL,
	RS_AIRSPACES_URL,
	XK_AIRSPACES_URL,
	IT_AIRSPACES_URL,
	SK_AIRSPACES_NEXT_URL,
	IE_AIRSPACES_NEXT_URL,
	RS_AIRSPACES_NEXT_URL,
	XK_AIRSPACES_NEXT_URL,
	IT_AIRSPACES_NEXT_URL,
	loadSkAirspaces,
	loadIeAirspaces,
	loadRsAirspaces,
	loadXkAirspaces,
	loadItAirspaces,
	ES_AIRSPACES_URL,
	ES_AIRSPACES_NEXT_URL,
	UK_AIRSPACES_URL,
	UK_AIRSPACES_NEXT_URL,
	firIdent,
	loadAirspaces,
	loadEsAirspaces,
	loadFaaAirspaces,
	loadPruatlasFirs,
	loadUkAirspaces,
	type Airspace,
} from '$lib/data/airspaces';
import {
	ES_OBSTACLES_URL,
	ES_OBSTACLES_NEXT_URL,
	BE_OBSTACLES_URL,
	BE_OBSTACLES_NEXT_URL,
	DE_OBSTACLES_URL,
	DE_OBSTACLES_NEXT_URL,
	AT_OBSTACLES_URL,
	AT_OBSTACLES_NEXT_URL,
	OBSTACLES_URL,
	UK_OBSTACLES_URL,
	UK_OBSTACLES_NEXT_URL,
	FAA_OBSTACLES_URL,
	FAA_OBSTACLES_NEXT_URL,
	CH_OBSTACLES_URL,
	CH_OBSTACLES_NEXT_URL,
	FI_OBSTACLES_URL,
	FI_OBSTACLES_NEXT_URL,
	loadObstacles,
	type Obstacle,
} from '$lib/data/obstacles';
import {
	BE_NAVAIDS_URL,
	BE_NAVAIDS_NEXT_URL,
	DE_NAVAIDS_URL,
	DE_NAVAIDS_NEXT_URL,
	AT_NAVAIDS_URL,
	AT_NAVAIDS_NEXT_URL,
	GE_NAVAIDS_URL,
	GE_NAVAIDS_NEXT_URL,
	NL_NAVAIDS_URL,
	NL_NAVAIDS_NEXT_URL,
	SK_NAVAIDS_URL,
	IE_NAVAIDS_URL,
	RS_NAVAIDS_URL,
	XK_NAVAIDS_URL,
	IT_NAVAIDS_URL,
	SK_NAVAIDS_NEXT_URL,
	IE_NAVAIDS_NEXT_URL,
	RS_NAVAIDS_NEXT_URL,
	XK_NAVAIDS_NEXT_URL,
	IT_NAVAIDS_NEXT_URL,
	ES_NAVAIDS_URL,
	ES_NAVAIDS_NEXT_URL,
	NAVAIDS_URL,
	NAVAIDS_NEXT_URL,
	UK_NAVAIDS_URL,
	UK_NAVAIDS_NEXT_URL,
	FAA_NAVAIDS_URL,
	FAA_NAVAIDS_NEXT_URL,
	loadNavaids,
	type Navaid,
} from '$lib/data/navaids';
import {
	NATURE_URL,
	NATURE_NEXT_URL,
	BE_NATURE_URL,
	BE_NATURE_NEXT_URL,
	IT_NATURE_URL,
	IT_NATURE_NEXT_URL,
	loadNature,
	type Nature,
} from '$lib/data/nature';
import {
	loadFrenchAirspacesMeta,
	loadFrenchAirspacesNextMeta,
	loadFrAirportsMeta,
	loadFrAirportsNextMeta,
	loadObstaclesMeta,
	loadObstaclesNextMeta,
	loadUkAirspacesMeta,
	loadUkAirspacesNextMeta,
	loadUkAirportsMeta,
	loadUkAirportsNextMeta,
	loadUkObstaclesMeta,
	loadUkObstaclesNextMeta,
	loadEsAirspacesMeta,
	loadEsAirspacesNextMeta,
	loadEsAirportsMeta,
	loadEsAirportsNextMeta,
	loadEsObstaclesMeta,
	loadEsObstaclesNextMeta,
	loadNavaidsMeta,
	loadNavaidsNextMeta,
	loadUkNavaidsMeta,
	loadUkNavaidsNextMeta,
	loadEsNavaidsMeta,
	loadEsNavaidsNextMeta,
	loadNatureMeta,
	loadNatureNextMeta,
	loadBeAirspacesMeta,
	loadBeAirspacesNextMeta,
	loadBeAirportsMeta,
	loadBeAirportsNextMeta,
	loadBeObstaclesMeta,
	loadBeObstaclesNextMeta,
	loadBeNavaidsMeta,
	loadBeNavaidsNextMeta,
	loadBeNatureMeta,
	loadBeNatureNextMeta,
	loadDeAirspacesMeta,
	loadDeAirspacesNextMeta,
	loadAtAirspacesMeta,
	loadAtAirspacesNextMeta,
	loadDeAirportsMeta,
	loadDeAirportsNextMeta,
	loadAtAirportsMeta,
	loadAtAirportsNextMeta,
	loadDeObstaclesMeta,
	loadDeObstaclesNextMeta,
	loadAtObstaclesMeta,
	loadAtObstaclesNextMeta,
	loadDeNavaidsMeta,
	loadDeNavaidsNextMeta,
	loadAtNavaidsMeta,
	loadAtNavaidsNextMeta,
	loadFaaAirportsMeta,
	loadFaaAirportsNextMeta,
	loadFaaNavaidsMeta,
	loadFaaNavaidsNextMeta,
	loadGeAirspacesMeta,
	loadGeAirspacesNextMeta,
	loadGeAirportsMeta,
	loadGeAirportsNextMeta,
	loadGeNavaidsMeta,
	loadGeNavaidsNextMeta,
	loadNlAirspacesMeta,
	loadNlAirspacesNextMeta,
	loadNlAirportsMeta,
	loadNlAirportsNextMeta,
	loadNlNavaidsMeta,
	loadNlNavaidsNextMeta,
	loadFaaObstaclesMeta,
	loadFaaObstaclesNextMeta,
	loadChObstaclesMeta,
	loadChObstaclesNextMeta,
	loadFiObstaclesMeta,
	loadFiObstaclesNextMeta,
	loadSkAirspacesMeta,
	loadSkAirspacesNextMeta,
	loadIeAirspacesMeta,
	loadIeAirspacesNextMeta,
	loadRsAirspacesMeta,
	loadRsAirspacesNextMeta,
	loadRsNavaidsMeta,
	loadRsNavaidsNextMeta,
	loadXkAirspacesMeta,
	loadXkAirspacesNextMeta,
	loadXkNavaidsMeta,
	loadXkNavaidsNextMeta,
	loadItAirspacesMeta,
	loadItAirspacesNextMeta,
	loadItAirportsMeta,
	loadItAirportsNextMeta,
	loadSkNavaidsMeta,
	loadSkNavaidsNextMeta,
	loadIeNavaidsMeta,
	loadIeNavaidsNextMeta,
	loadItNavaidsMeta,
	loadItNavaidsNextMeta,
	loadItNatureMeta,
	loadItNatureNextMeta,
	loadFaaAirspacesMeta,
	loadSupAipMeta,
	loadBeSupAipMeta,
	pickActiveDataset,
	wouldSwitch,
	type DatasetBBox,
	type DatasetBBoxes,
} from '$lib/data/meta';
import { coverageWants } from '$lib/state/coverage.svelte';
import { loadSupAip, SUPAIP_URL, BE_SUPAIP_URL, type SupAip } from '$lib/data/supaip';
import { notamState } from './notam.svelte';
import { ui } from './ui.svelte';

const AIRSPACES_NEXT_URL = '/data/fr-airspaces.next.json';
const FR_AIRPORTS_NEXT_URL = '/data/fr-airports.next.json';
const OBSTACLES_NEXT_URL = '/data/fr-obstacles.next.json';

// The datasets are kept outside $state; they never mutate after load, and
// proxying tens of thousands of objects would be wasteful. Only load status
// is reactive.
let airports: Airport[] | null = null;
let airportIndex: Map<string, Airport> | null = null;
let airportsPromise: Promise<Airport[]> | null = null;
// The OurAirports baseline is kept apart from the merged result: a later
// coverage extension re-merges the country overlays onto it rather than
// re-fetching it.
let airportBaseline: Airport[] = [];
// The two worldwide airspace overlays are likewise kept so an extension
// can re-merge without re-fetching.
let pruatlasRows: Airspace[] = [];
let faaRows: Airspace[] = [];

let airspaces: Airspace[] | null = null;
let airspaceIndex: Map<string, Airspace> | null = null;
let airspacesPromise: Promise<Airspace[]> | null = null;

let obstacles: Obstacle[] | null = null;
let obstacleIndex: Map<string, Obstacle> | null = null;
let obstaclesPromise: Promise<Obstacle[]> | null = null;

let navaids: Navaid[] | null = null;
let navaidIndex: Map<string, Navaid> | null = null;
let navaidsPromise: Promise<Navaid[]> | null = null;

// Nature zones (FR PRN parks / réserves + SUR sensitive sites, BE bird
// areas), each publisher AIRAC-slot-picked then concatenated.
let nature: Nature[] | null = null;
let natureIndex: Map<string, Nature> | null = null;
let naturePromise: Promise<Nature[]> | null = null;

// SUP AIP is a single plain dataset (not AIRAC-sliced): each supplement
// carries its own validity window, filtered client-side. supaipRefIndex keys
// by "<year>/<number>[a]" so a NOTAM "AIP SUP NNN/YY" citation can light up.
let supaips: SupAip[] | null = null;
let supaipIndex: Map<string, SupAip> | null = null;
let supaipRefIndex: Map<string, SupAip> | null = null;
let supaipPromise: Promise<SupAip[]> | null = null;

export const dataState = $state<{
	airportsLoaded: boolean;
	airportsLoading: boolean;
	airportsError: string | null;
	airspacesLoaded: boolean;
	airspacesLoading: boolean;
	airspacesError: string | null;
	obstaclesLoaded: boolean;
	obstaclesLoading: boolean;
	obstaclesError: string | null;
	navaidsLoaded: boolean;
	navaidsLoading: boolean;
	navaidsError: string | null;
	natureLoaded: boolean;
	natureLoading: boolean;
	natureError: string | null;
	/** AIRAC effective + next-effective dates and the loaded slot of every
	 *  per-country dataset, stamped by loadCountryDatasets; the cell for a
	 *  (dataset, country) pair exists once its slot has been picked. The
	 *  worldwide OurAirports baseline has no AIRAC, so these cells are
	 *  what drive the swap heartbeat. */
	airac: Record<AiracDataset, Partial<Record<AiracCountry, AiracSlot>>>;
	/** Bumped whenever a dataset is (re)published, which the coverage gate
	 *  makes a repeatable event: a country loading later widens the array
	 *  in place, and the getters read this so their consumers re-derive. */
	revision: Record<AiracDataset, number>;
	supaipLoaded: boolean;
	supaipLoading: boolean;
	supaipError: string | null;
	/** Set when any per-country `*.next.json` becomes effective while a
	 *  `.json` is loaded (or vice versa: an older `.json` would supersede
	 *  a stale `.next.json`). UI surfaces a banner; user reloads to pick
	 *  up the swap. */
	airacSwitchPending: boolean;
}>({
	airportsLoaded: false,
	airportsLoading: false,
	airportsError: null,
	airspacesLoaded: false,
	airspacesLoading: false,
	airspacesError: null,
	obstaclesLoaded: false,
	obstaclesLoading: false,
	obstaclesError: null,
	navaidsLoaded: false,
	navaidsLoading: false,
	navaidsError: null,
	natureLoaded: false,
	natureLoading: false,
	natureError: null,
	airac: {
		airports: {},
		airspaces: {},
		obstacles: {},
		navaids: {},
		nature: {},
	},
	revision: {
		airports: 0,
		airspaces: 0,
		obstacles: 0,
		navaids: 0,
		nature: 0,
	},
	supaipLoaded: false,
	supaipLoading: false,
	supaipError: null,
	airacSwitchPending: false,
});

function message(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/* ---- per-country AIRAC slot pipeline ---- */

// The AIRAC-sliced multi-country datasets and the publishers that feed
// them. France gets an AIRAC slot for every dataset; the other pipelines
// share the same .next.json mechanism via cmd/<cc> -target auto. `nature`
// only ever carries FR + BE rows.
const AIRAC_DATASETS = ['airports', 'airspaces', 'obstacles', 'navaids', 'nature'] as const;
const AIRAC_COUNTRIES = ['fr', 'uk', 'es', 'be', 'de', 'at', 'faa', 'ge', 'nl', 'ch', 'fi', 'it', 'sk', 'ie', 'rs', 'xk'] as const;
export type AiracDataset = (typeof AIRAC_DATASETS)[number];
export type AiracCountry = (typeof AIRAC_COUNTRIES)[number];

/** One (dataset, country) cell of `dataState.airac`: the loaded slot's
 *  effective date, the next cycle's when a .next.meta.json is published,
 *  and which file this session loaded ('next' is terminal until reload). */
export interface AiracSlot {
	effective: string | null;
	nextEffective: string | null;
	slot: 'current' | 'next';
}

/** One country's inputs to `loadCountryDatasets`: the airac matrix cell it
 *  fills, the current + next meta sidecars, the two dataset URLs the slot
 *  picker chooses between, and the row loader. Array position is the
 *  callers' merge-precedence position. */
interface CountrySource<T> {
	country: AiracCountry;
	meta: () => Promise<{ effective: string; bbox?: DatasetBBox; bboxes?: DatasetBBoxes } | null>;
	nextMeta: () => Promise<{ effective: string; bbox?: DatasetBBox; bboxes?: DatasetBBoxes } | null>;
	url: string;
	nextUrl: string;
	load: (url: string) => Promise<T[]>;
}

/** The dual-AIRAC pipeline every multi-country dataset shares: fetch each
 *  country's current + next meta sidecars in parallel (fail-soft: a missing
 *  or failing sidecar degrades that country to its current slot), pick each
 *  country's active slot by effective date, load the picked files in
 *  parallel, and stamp the airac matrix cells the heartbeat below watches.
 *  Returns the per-country rows in source order. */
async function loadCountryDatasets<T>(
	dataset: AiracDataset,
	sources: readonly CountrySource<T>[],
	skip?: (country: AiracCountry) => boolean,
): Promise<Map<AiracCountry, T[]>> {
	const metas = await Promise.all(
		sources.flatMap((s) => [s.meta().catch(() => null), s.nextMeta().catch(() => null)]),
	);
	// One-shot timestamp passed by value; not a reactive ref.
	const now = new Date();
	const picked = sources.map((s, i) =>
		pickActiveDataset(
			metas[2 * i]?.effective ?? null,
			metas[2 * i + 1]?.effective ?? null,
			s.url,
			s.nextUrl,
			now,
		),
	);
	// The coverage gate: a publisher whose rows cannot reach the current
	// view is not fetched. The envelope comes off the slot actually
	// picked, so a country that moves between cycles is judged on the
	// file about to be read. The sidecars are fetched either way; they
	// are a few hundred bytes and they carry the AIRAC dates the banner
	// needs.
	const wanted = sources.map((s, i) => {
		if (skip?.(s.country)) {
			return false;
		}
		const slotMeta = picked[i].slot === 'next' ? metas[2 * i + 1] : metas[2 * i];
		return coverageWants(s.country, slotMeta?.bbox, slotMeta?.bboxes);
	});
	const rows = await Promise.all(
		sources.map((s, i) => (wanted[i] ? s.load(picked[i].url) : Promise.resolve([] as T[]))),
	);
	// Stamp the AIRAC matrix for every publisher, loaded or not: the
	// switch heartbeat and the About dialog report on the whole fleet,
	// and a gated-out country still has a cycle.
	sources.forEach((s, i) => {
		dataState.airac[dataset][s.country] = {
			effective: picked[i].effective,
			nextEffective: metas[2 * i + 1]?.effective ?? null,
			slot: picked[i].slot,
		};
	});
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- plain result map, not reactive state
	const out = new Map<AiracCountry, T[]>();
	sources.forEach((s, i) => {
		if (wanted[i]) {
			out.set(s.country, rows[i]);
		}
	});
	return out;
}

/** The per-country rows one multi-country dataset has loaded so far.
 *
 *  Kept per publisher, not pre-merged, because the coverage gate means a
 *  higher-priority country can arrive AFTER a lower-priority one: the
 *  merge has to be redone from the parts, in source order, every time the
 *  set grows. */
interface CountryStore<T> {
	dataset: AiracDataset;
	sources: readonly CountrySource<T>[];
	rows: Map<AiracCountry, T[]>;
	inflight: Promise<void> | null;
}

function countryStore<T>(
	dataset: AiracDataset,
	sources: readonly CountrySource<T>[],
): CountryStore<T> {
	 
	return { dataset, sources, rows: new Map<AiracCountry, T[]>(), inflight: null };
}

/** Load every country the current coverage wants and this store has not
 *  got yet. Serialised: a second caller waits for the first rather than
 *  racing it into the same slots. Resolves true when anything new landed. */
async function fillStore<T>(store: CountryStore<T>): Promise<boolean> {
	while (store.inflight) {
		await store.inflight;
	}
	const before = store.rows.size;
	const run = (async () => {
		const got = await loadCountryDatasets(store.dataset, store.sources, (c) => store.rows.has(c));
		for (const [country, rows] of got) {
			store.rows.set(country, rows);
		}
	})();
	store.inflight = run;
	try {
		await run;
	} finally {
		store.inflight = null;
	}
	return store.rows.size !== before;
}

/** The store's rows in source order, an empty array standing in for a
 *  country the gate has not loaded. Position is merge precedence. */
function storeRows<T>(store: CountryStore<T>): T[][] {
	return store.sources.map((s) => store.rows.get(s.country) ?? []);
}

/* ---- airports ---- */

export function getAirports(): Airport[] | null {
	void dataState.revision.airports;
	return airports;
}

// Per-country AIXM airport overlays; each pipeline (cmd/fr, cmd/uk, cmd/es,
// cmd/be, cmd/de, cmd/at) emits its own current + next .meta.json pair
// under -target auto, so the slot picker runs once per publisher.
const AIRPORT_SOURCES: readonly CountrySource<Airport>[] = [
	{
		country: 'fr',
		meta: loadFrAirportsMeta, nextMeta: loadFrAirportsNextMeta,
		url: FR_AIRPORTS_URL, nextUrl: FR_AIRPORTS_NEXT_URL,
		load: (url) => loadFrAirports(url, 'fr'),
	},
	{
		country: 'uk',
		meta: loadUkAirportsMeta, nextMeta: loadUkAirportsNextMeta,
		url: UK_AIRPORTS_URL, nextUrl: UK_AIRPORTS_NEXT_URL,
		load: (url) => loadFrAirports(url, 'uk'),
	},
	{
		country: 'es',
		meta: loadEsAirportsMeta, nextMeta: loadEsAirportsNextMeta,
		url: ES_AIRPORTS_URL, nextUrl: ES_AIRPORTS_NEXT_URL,
		load: (url) => loadFrAirports(url, 'es'),
	},
	{
		country: 'be',
		meta: loadBeAirportsMeta, nextMeta: loadBeAirportsNextMeta,
		url: BE_AIRPORTS_URL, nextUrl: BE_AIRPORTS_NEXT_URL,
		load: (url) => loadFrAirports(url, 'be'),
	},
	{
		country: 'de',
		meta: loadDeAirportsMeta, nextMeta: loadDeAirportsNextMeta,
		url: DE_AIRPORTS_URL, nextUrl: DE_AIRPORTS_NEXT_URL,
		load: (url) => loadFrAirports(url, 'de'),
	},
	{
		country: 'at',
		meta: loadAtAirportsMeta, nextMeta: loadAtAirportsNextMeta,
		url: AT_AIRPORTS_URL, nextUrl: AT_AIRPORTS_NEXT_URL,
		load: (url) => loadFrAirports(url, 'at'),
	},
	{
		country: 'ge',
		meta: loadGeAirportsMeta, nextMeta: loadGeAirportsNextMeta,
		url: GE_AIRPORTS_URL, nextUrl: GE_AIRPORTS_NEXT_URL,
		load: (url) => loadFrAirports(url, 'ge'),
	},
	{
		country: 'nl',
		meta: loadNlAirportsMeta, nextMeta: loadNlAirportsNextMeta,
		url: NL_AIRPORTS_URL, nextUrl: NL_AIRPORTS_NEXT_URL,
		load: (url) => loadFrAirports(url, 'nl'),
	},
	{
		country: 'it',
		meta: loadItAirportsMeta, nextMeta: loadItAirportsNextMeta,
		url: IT_AIRPORTS_URL, nextUrl: IT_AIRPORTS_NEXT_URL,
		load: (url) => loadFrAirports(url, 'it'),
	},
	{
		country: 'faa',
		meta: loadFaaAirportsMeta, nextMeta: loadFaaAirportsNextMeta,
		url: FAA_AIRPORTS_URL, nextUrl: FAA_AIRPORTS_NEXT_URL,
		load: (url) => loadFrAirports(url, 'faa'),
	},
];

const airportStore = countryStore<Airport>('airports', AIRPORT_SOURCES);

// Publishers whose export is an exhaustive national aerodrome list, so a
// baseline field they do not carry can be dropped as stale or closed
// (LFSY). France only for now: SIA's AIXM 4.5 is a broad, current national
// export. UK (NATS civil AIP Data Set: civil-only, no military) and ES (a
// stale 2024 partial, missing e.g. LEMH) are not exhaustive, so enforcing
// them would hide active aerodromes; add them once complete.
const AUTHORITATIVE_PUBLISHERS: readonly Publisher[] = ['fr'];

/** Merge the loaded country overlays onto the baseline and publish.
 *  Re-runnable: the coverage gate can bring a country in later, and the
 *  merge has to be redone from the parts because precedence is by source
 *  order, not by arrival order. */
function publishAirports(): Airport[] {
	// FR > UK > ES > BE > DE > AT precedence (AIRPORT_SOURCES order, each
	// publisher merging onto the view below it, so the LAST one to carry a
	// field wins for its own aerodromes). Each per-country merge layers
	// AIXM data on top of the lower-priority view, preserving the existing
	// OurAirports type / iso_country for matching ICAOs.
	let merged = airportBaseline;
	for (const rows of storeRows(airportStore)) {
		merged = mergeAixmOverlay(merged, rows);
	}
	// Treat the national AIXM as the authoritative aerodrome list and drop
	// any OurAirports baseline field it doesn't list (see
	// AUTHORITATIVE_PUBLISHERS above), but only for a publisher whose rows
	// actually loaded: a gated-out overlay must not empty the map.
	const authoritative: Publisher[] = AUTHORITATIVE_PUBLISHERS.filter(
		(p) => (airportStore.rows.get(p as AiracCountry)?.length ?? 0) > 0,
	);
	merged = dropStaleBaseline(merged, authoritative);
	// Germany's military fields live only in the baseline (the DFS AIXM is
	// the civil AIP), so their status comes from the curated table.
	merged = applyDeMilitaryStatus(merged);
	merged = applyFrAutoInfoFrequency(merged);
	airports = merged;
	 
	airportIndex = new Map(merged.map((ap) => [ap.ident.toUpperCase(), ap]));
	dataState.airportsLoaded = true;
	dataState.airportsLoading = false;
	dataState.revision.airports++;
	return merged;
}

export function ensureAirports(): Promise<Airport[]> {
	if (airports) {
		return Promise.resolve(airports);
	}
	if (airportsPromise) {
		return airportsPromise;
	}
	dataState.airportsLoading = true;
	dataState.airportsError = null;
	airportsPromise = (async () => {
		// Worldwide OurAirports baseline (no AIRAC slot). Loaded
		// unconditionally; the per-country AIXM overlays below merge on top.
		airportBaseline = await loadAirports(AIRPORTS_URL);
		await fillStore(airportStore);
		return publishAirports();
	})().catch((e: unknown) => {
		dataState.airportsError = message(e);
		dataState.airportsLoading = false;
		airportsPromise = null;
		throw e;
	});
	return airportsPromise;
}

/** Airport-coordinate lookup for the parser's "RDL … ARP <ICAO>" anchoring. */
export function airportLookup(ident: string): { lat: number; lon: number } | null {
	const a = airportIndex?.get(ident.toUpperCase());
	return a ? { lat: a.lat, lon: a.lon } : null;
}

/** Full airport record by ICAO ident, or null. Used by the route profile for
 *  the charted field elevation at an anchored airport endpoint. */
export function airportByIdent(ident: string): Airport | null {
	return airportIndex?.get(ident.toUpperCase()) ?? null;
}

export function selectedAirport(): Airport | null {
	if (ui.detail?.kind !== 'airport') {
		return null;
	}
	// Track the load so the DetailPanel $derived re-runs once the airport
	// dataset arrives (airportIndex is a plain, non-reactive ref). The set is
	// on by default, but a waypoint selected from the nav log or the route
	// profile can still race ensureAirports().
	void dataState.airportsLoaded;
	return airportIndex?.get(ui.detail.id.toUpperCase()) ?? null;
}

/* ---- airspaces ---- */

export function getAirspaces(): Airspace[] | null {
	// `airspaces` is a plain module variable, so reading it alone establishes no
	// reactive dependency. Touch the load flag here, at the single accessor, so
	// every reactive caller (the activation map overlay, the named-airspace
	// highlight, the detail-panel lists + vertical stack) re-runs the instant the
	// lazy fetch resolves. Centralised here rather than per-consumer because
	// airspaces have many readers and one already forgot the flag; getObstacles /
	// getNavaids / getSupaips keep the per-consumer form (one or two readers each).
	void dataState.airspacesLoaded;
	void dataState.revision.airspaces;
	return airspaces;
}

// Array order IS merge precedence, so this list is the one place the
// airspace priority is stated. Austria sits ahead of Germany on purpose:
// the Austrian LOWS2 TMA bands must win over the Salzburg volumes DFS
// republishes for its cross-border traffic.
const AIRSPACE_SOURCES: readonly CountrySource<Airspace>[] = [
	{
		country: 'fr',
		meta: loadFrenchAirspacesMeta, nextMeta: loadFrenchAirspacesNextMeta,
		url: AIRSPACES_URL, nextUrl: AIRSPACES_NEXT_URL,
		load: loadAirspaces,
	},
	{
		country: 'uk',
		meta: loadUkAirspacesMeta, nextMeta: loadUkAirspacesNextMeta,
		url: UK_AIRSPACES_URL, nextUrl: UK_AIRSPACES_NEXT_URL,
		load: loadUkAirspaces,
	},
	{
		country: 'es',
		meta: loadEsAirspacesMeta, nextMeta: loadEsAirspacesNextMeta,
		url: ES_AIRSPACES_URL, nextUrl: ES_AIRSPACES_NEXT_URL,
		load: loadEsAirspaces,
	},
	{
		country: 'be',
		meta: loadBeAirspacesMeta, nextMeta: loadBeAirspacesNextMeta,
		url: BE_AIRSPACES_URL, nextUrl: BE_AIRSPACES_NEXT_URL,
		load: loadBeAirspaces,
	},
	{
		country: 'at',
		meta: loadAtAirspacesMeta, nextMeta: loadAtAirspacesNextMeta,
		url: AT_AIRSPACES_URL, nextUrl: AT_AIRSPACES_NEXT_URL,
		load: loadAtAirspaces,
	},
	{
		country: 'de',
		meta: loadDeAirspacesMeta, nextMeta: loadDeAirspacesNextMeta,
		url: DE_AIRSPACES_URL, nextUrl: DE_AIRSPACES_NEXT_URL,
		load: loadDeAirspaces,
	},
	{
		country: 'ge',
		meta: loadGeAirspacesMeta, nextMeta: loadGeAirspacesNextMeta,
		url: GE_AIRSPACES_URL, nextUrl: GE_AIRSPACES_NEXT_URL,
		load: loadGeAirspaces,
	},
	{
		country: 'nl',
		meta: loadNlAirspacesMeta, nextMeta: loadNlAirspacesNextMeta,
		url: NL_AIRSPACES_URL, nextUrl: NL_AIRSPACES_NEXT_URL,
		load: loadNlAirspaces,
	},
	{
		country: 'it',
		meta: loadItAirspacesMeta, nextMeta: loadItAirspacesNextMeta,
		url: IT_AIRSPACES_URL, nextUrl: IT_AIRSPACES_NEXT_URL,
		load: loadItAirspaces,
	},
	{
		country: 'sk',
		meta: loadSkAirspacesMeta, nextMeta: loadSkAirspacesNextMeta,
		url: SK_AIRSPACES_URL, nextUrl: SK_AIRSPACES_NEXT_URL,
		load: loadSkAirspaces,
	},
	{
		country: 'ie',
		meta: loadIeAirspacesMeta, nextMeta: loadIeAirspacesNextMeta,
		url: IE_AIRSPACES_URL, nextUrl: IE_AIRSPACES_NEXT_URL,
		load: loadIeAirspaces,
	},
	{
		country: 'rs',
		meta: loadRsAirspacesMeta, nextMeta: loadRsAirspacesNextMeta,
		url: RS_AIRSPACES_URL, nextUrl: RS_AIRSPACES_NEXT_URL,
		load: loadRsAirspaces,
	},
	{
		country: 'xk',
		meta: loadXkAirspacesMeta, nextMeta: loadXkAirspacesNextMeta,
		url: XK_AIRSPACES_URL, nextUrl: XK_AIRSPACES_NEXT_URL,
		load: loadXkAirspaces,
	},
];

const airspaceStore = countryStore<Airspace>('airspaces', AIRSPACE_SOURCES);

/** Fetch the FAA airspace overlay when the coverage reaches it, once.
 *  Resolves true when rows landed that were not there before, which is
 *  the caller's signal to re-merge. */
let faaWanted = false;
async function loadFaaIfWanted(): Promise<boolean> {
	if (faaWanted) {
		return false;
	}
	const meta = await loadFaaAirspacesMeta().catch(() => null);
	if (!coverageWants('faa', meta?.bbox, meta?.bboxes)) {
		return false;
	}
	faaWanted = true;
	faaRows = await loadFaaAirspaces();
	return true;
}

/** Merge the loaded country rows with the two worldwide overlays and
 *  publish. Re-runnable for the same reason publishAirports is. */
function publishAirspaces(): Airspace[] {
	// Merge in AIRSPACE_SOURCES order, then the two worldwide overlays:
	// any overlay row whose id is already in a HIGHER-PRIORITY dataset is
	// dropped (BE after FR keeps the SIA row for the republished LFR616L;
	// AT before DE keeps the Austrian LOWS2 TMA bands over the Salzburg
	// volumes DFS republishes for its cross-border traffic; the pruatlas
	// FIR rings yield to every local AIP), while same-id siblings within
	// one dataset all load: publishers file distinct volumes and
	// multi-piece rings under one designator (ENAIRE's FIR + UIR + TMA
	// under LECM). Semantics and the `#N` key suffixing live in
	// mergeAirspaces (src/lib/data/airspaceMerge.ts).
	const a = mergeAirspaces([...storeRows(airspaceStore), pruatlasRows, faaRows]);
	airspaces = a;
	// Key by the per-row `key` (not `id`) so rows sharing an id;
	// MOA parent + exclusions each get their own index entry.
	 
	airspaceIndex = new Map(a.map((sp) => [sp.key, sp]));
	dataState.airspacesLoaded = true;
	dataState.airspacesLoading = false;
	dataState.revision.airspaces++;
	return a;
}

export function ensureAirspaces(): Promise<Airspace[]> {
	if (airspaces) {
		return Promise.resolve(airspaces);
	}
	if (airspacesPromise) {
		return airspacesPromise;
	}
	dataState.airspacesLoading = true;
	dataState.airspacesError = null;
	airspacesPromise = (async () => {
		// The worldwide pruatlas FIR overlay and the FAA airspace overlay
		// ride the same fetch round as the per-country slot loads; neither
		// carries an AIRAC slot of its own. pruatlas is genuinely
		// worldwide and always loads (it is the FIR ring everywhere no
		// national AIP is bundled); the FAA set is a country's, four
		// megabytes of it, so it is gated on its own envelope like one.
		await Promise.all([
			fillStore(airspaceStore),
			loadPruatlasFirs().then((rows) => {
				pruatlasRows = rows;
			}),
			loadFaaIfWanted(),
		]);
		return publishAirspaces();
	})().catch((e: unknown) => {
		dataState.airspacesError = message(e);
		dataState.airspacesLoading = false;
		airspacesPromise = null;
		throw e;
	});
	return airspacesPromise;
}

// FIR-ident cache, keyed on the loaded array's identity: the merged list is
// replaced wholesale on (re)load, never mutated, so a reference compare is a
// sound invalidation test.
let firIdentSrc: Airspace[] | null = null;
let firIdents: Set<string> | null = null;
const EMPTY_FIR_IDENTS = new Set<string>();

/** Upper-cased ICAO idents of every loaded FIR-like row (FIR / UIR / OCA +
 *  FAA ARTCC), for NOTAM Item A) ownership resolution. Reads getAirspaces(),
 *  so reactive callers re-run once the lazy dataset load resolves. Empty
 *  before load. */
export function firIdentSet(): Set<string> {
	const all = getAirspaces();
	if (!all) {
		return EMPTY_FIR_IDENTS;
	}
	if (all !== firIdentSrc || !firIdents) {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
		const s = new Set<string>();
		for (const a of all) {
			const ident = firIdent(a);
			if (ident) {
				s.add(ident);
			}
		}
		firIdentSrc = all;
		firIdents = s;
	}
	return firIdents;
}

let firRowsSrc: Airspace[] | null = null;
let firRowsIdx: Map<string, Airspace[]> | null = null;

/** The loaded FIR-like rows grouped by ident (LFFF names both the FIR and
 *  the UIR, so several rows / rings per ident are normal), for the
 *  FIR-wide fallbacks (a SIGMET without geometry draws its FIR's rings).
 *  Reads getAirspaces(), so reactive callers re-run once the dataset
 *  loads; empty before load or for an unknown ident. */
export function firRowsForIdent(ident: string): Airspace[] {
	const all = getAirspaces();
	if (!all) {
		return [];
	}
	if (all !== firRowsSrc || !firRowsIdx) {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- derived index, not reactive state
		const m = new Map<string, Airspace[]>();
		for (const a of all) {
			const id = firIdent(a);
			if (!id) {
				continue;
			}
			const rows = m.get(id);
			if (rows) {
				rows.push(a);
			} else {
				m.set(id, [a]);
			}
		}
		firRowsSrc = all;
		firRowsIdx = m;
	}
	return firRowsIdx.get(ident.toUpperCase()) ?? [];
}

/* ---- obstacles ---- */

export function getObstacles(): Obstacle[] | null {
	void dataState.revision.obstacles;
	return obstacles;
}

const OBSTACLE_SOURCES: readonly CountrySource<Obstacle>[] = [
	{
		country: 'fr',
		meta: loadObstaclesMeta, nextMeta: loadObstaclesNextMeta,
		url: OBSTACLES_URL, nextUrl: OBSTACLES_NEXT_URL,
		load: loadObstacles,
	},
	{
		country: 'uk',
		meta: loadUkObstaclesMeta, nextMeta: loadUkObstaclesNextMeta,
		url: UK_OBSTACLES_URL, nextUrl: UK_OBSTACLES_NEXT_URL,
		load: loadObstacles,
	},
	{
		country: 'es',
		meta: loadEsObstaclesMeta, nextMeta: loadEsObstaclesNextMeta,
		url: ES_OBSTACLES_URL, nextUrl: ES_OBSTACLES_NEXT_URL,
		load: loadObstacles,
	},
	{
		country: 'be',
		meta: loadBeObstaclesMeta, nextMeta: loadBeObstaclesNextMeta,
		url: BE_OBSTACLES_URL, nextUrl: BE_OBSTACLES_NEXT_URL,
		load: loadObstacles,
	},
	{
		country: 'de',
		meta: loadDeObstaclesMeta, nextMeta: loadDeObstaclesNextMeta,
		url: DE_OBSTACLES_URL, nextUrl: DE_OBSTACLES_NEXT_URL,
		load: loadObstacles,
	},
	{
		country: 'at',
		meta: loadAtObstaclesMeta, nextMeta: loadAtObstaclesNextMeta,
		url: AT_OBSTACLES_URL, nextUrl: AT_OBSTACLES_NEXT_URL,
		load: loadObstacles,
	},
	{
		country: 'faa',
		meta: loadFaaObstaclesMeta, nextMeta: loadFaaObstaclesNextMeta,
		url: FAA_OBSTACLES_URL, nextUrl: FAA_OBSTACLES_NEXT_URL,
		load: loadObstacles,
	},
	{
		country: 'ch',
		meta: loadChObstaclesMeta, nextMeta: loadChObstaclesNextMeta,
		url: CH_OBSTACLES_URL, nextUrl: CH_OBSTACLES_NEXT_URL,
		load: loadObstacles,
	},
	{
		country: 'fi',
		meta: loadFiObstaclesMeta, nextMeta: loadFiObstaclesNextMeta,
		url: FI_OBSTACLES_URL, nextUrl: FI_OBSTACLES_NEXT_URL,
		load: loadObstacles,
	},
];

const obstacleStore = countryStore<Obstacle>('obstacles', OBSTACLE_SOURCES);

/** Concatenate the loaded country rows and publish. Re-runnable: the
 *  coverage gate can bring a country in after the first load.
 *  Ids are namespaced by publisher at emit time, so no dedup is needed. */
function publishObstacles(): Obstacle[] {
	const o = storeRows(obstacleStore).flat();
	obstacles = o;
	 
	obstacleIndex = new Map(o.map((ob) => [ob.id, ob]));
	dataState.obstaclesLoaded = true;
	dataState.obstaclesLoading = false;
	dataState.revision.obstacles++;
	return o;
}

export function ensureObstacles(): Promise<Obstacle[]> {
	if (obstacles) {
		return Promise.resolve(obstacles);
	}
	if (obstaclesPromise) {
		return obstaclesPromise;
	}
	dataState.obstaclesLoading = true;
	dataState.obstaclesError = null;
	obstaclesPromise = (async () => {
		// IDs are namespaced by country prefix at emit time, so concat
		// without dedup. cmd/es/obstacles.go applies a 30 m AGL height
		// threshold (matching SIA's de facto floor + ICAO Annex 15
		// Area 2), keeping the Spain file in line with FR / UK
		// payloads; cmd/de ships the DFS eTOD Area 1 set (>100 m).
		await fillStore(obstacleStore);
		return publishObstacles();
	})().catch((e: unknown) => {
		dataState.obstaclesError = message(e);
		dataState.obstaclesLoading = false;
		obstaclesPromise = null;
		throw e;
	});
	return obstaclesPromise;
}

export function selectedObstacle(): Obstacle | null {
	if (ui.detail?.kind !== 'obstacle') {
		return null;
	}
	// Track the load so the DetailPanel $derived re-runs once the obstacle
	// dataset finishes lazy-loading (obstacleIndex is a plain, non-reactive ref).
	void dataState.obstaclesLoaded;
	return obstacleIndex?.get(ui.detail.id) ?? null;
}

/** Obstacle row by dataset id (null before the lazy dataset arrives).
 *  Tracks the load like selectedObstacle so deriveds re-run on arrival. */
export function obstacleById(id: string): Obstacle | null {
	void dataState.obstaclesLoaded;
	return obstacleIndex?.get(id) ?? null;
}

/* ---- navaids ---- */

export function getNavaids(): Navaid[] | null {
	void dataState.revision.navaids;
	return navaids;
}

const NAVAID_SOURCES: readonly CountrySource<Navaid>[] = [
	{
		country: 'fr',
		meta: loadNavaidsMeta, nextMeta: loadNavaidsNextMeta,
		url: NAVAIDS_URL, nextUrl: NAVAIDS_NEXT_URL,
		load: loadNavaids,
	},
	{
		country: 'uk',
		meta: loadUkNavaidsMeta, nextMeta: loadUkNavaidsNextMeta,
		url: UK_NAVAIDS_URL, nextUrl: UK_NAVAIDS_NEXT_URL,
		load: loadNavaids,
	},
	{
		country: 'es',
		meta: loadEsNavaidsMeta, nextMeta: loadEsNavaidsNextMeta,
		url: ES_NAVAIDS_URL, nextUrl: ES_NAVAIDS_NEXT_URL,
		load: loadNavaids,
	},
	{
		country: 'be',
		meta: loadBeNavaidsMeta, nextMeta: loadBeNavaidsNextMeta,
		url: BE_NAVAIDS_URL, nextUrl: BE_NAVAIDS_NEXT_URL,
		load: loadNavaids,
	},
	{
		country: 'de',
		meta: loadDeNavaidsMeta, nextMeta: loadDeNavaidsNextMeta,
		url: DE_NAVAIDS_URL, nextUrl: DE_NAVAIDS_NEXT_URL,
		load: loadNavaids,
	},
	{
		country: 'at',
		meta: loadAtNavaidsMeta, nextMeta: loadAtNavaidsNextMeta,
		url: AT_NAVAIDS_URL, nextUrl: AT_NAVAIDS_NEXT_URL,
		load: loadNavaids,
	},
	{
		country: 'faa',
		meta: loadFaaNavaidsMeta, nextMeta: loadFaaNavaidsNextMeta,
		url: FAA_NAVAIDS_URL, nextUrl: FAA_NAVAIDS_NEXT_URL,
		load: loadNavaids,
	},
	{
		country: 'ge',
		meta: loadGeNavaidsMeta, nextMeta: loadGeNavaidsNextMeta,
		url: GE_NAVAIDS_URL, nextUrl: GE_NAVAIDS_NEXT_URL,
		load: loadNavaids,
	},
	{
		country: 'nl',
		meta: loadNlNavaidsMeta, nextMeta: loadNlNavaidsNextMeta,
		url: NL_NAVAIDS_URL, nextUrl: NL_NAVAIDS_NEXT_URL,
		load: loadNavaids,
	},
	{
		country: 'it',
		meta: loadItNavaidsMeta, nextMeta: loadItNavaidsNextMeta,
		url: IT_NAVAIDS_URL, nextUrl: IT_NAVAIDS_NEXT_URL,
		load: loadNavaids,
	},
	{
		country: 'sk',
		meta: loadSkNavaidsMeta, nextMeta: loadSkNavaidsNextMeta,
		url: SK_NAVAIDS_URL, nextUrl: SK_NAVAIDS_NEXT_URL,
		load: loadNavaids,
	},
	{
		country: 'ie',
		meta: loadIeNavaidsMeta, nextMeta: loadIeNavaidsNextMeta,
		url: IE_NAVAIDS_URL, nextUrl: IE_NAVAIDS_NEXT_URL,
		load: loadNavaids,
	},
	{
		country: 'rs',
		meta: loadRsNavaidsMeta, nextMeta: loadRsNavaidsNextMeta,
		url: RS_NAVAIDS_URL, nextUrl: RS_NAVAIDS_NEXT_URL,
		load: loadNavaids,
	},
	{
		country: 'xk',
		meta: loadXkNavaidsMeta, nextMeta: loadXkNavaidsNextMeta,
		url: XK_NAVAIDS_URL, nextUrl: XK_NAVAIDS_NEXT_URL,
		load: loadNavaids,
	},
];

const navaidStore = countryStore<Navaid>('navaids', NAVAID_SOURCES);

/** Concatenate the loaded country rows and publish. Re-runnable: the
 *  coverage gate can bring a country in after the first load.
 *  Ids are namespaced by publisher at emit time, so no dedup is needed. */
function publishNavaids(): Navaid[] {
	const n = storeRows(navaidStore).flat();
	navaids = n;
	 
	navaidIndex = new Map(n.map((nv) => [nv.id, nv]));
	dataState.navaidsLoaded = true;
	dataState.navaidsLoading = false;
	dataState.revision.navaids++;
	return n;
}

export function ensureNavaids(): Promise<Navaid[]> {
	if (navaids) {
		return Promise.resolve(navaids);
	}
	if (navaidsPromise) {
		return navaidsPromise;
	}
	dataState.navaidsLoading = true;
	dataState.navaidsError = null;
	navaidsPromise = (async () => {
		// IDs are namespaced by country prefix at emit time (FR uses
		// "<Type>:<mid>", UK / ES / DE / AT use "uk:" / "es:" / "de:" /
		// "at:"), so concat without dedup.
		await fillStore(navaidStore);
		return publishNavaids();
	})().catch((e: unknown) => {
		dataState.navaidsError = message(e);
		dataState.navaidsLoading = false;
		navaidsPromise = null;
		throw e;
	});
	return navaidsPromise;
}

export function selectedNavaid(): Navaid | null {
	if (ui.detail?.kind !== 'navaid') {
		return null;
	}
	// Track the load so the DetailPanel $derived re-runs once the navaid
	// dataset finishes lazy-loading (navaidIndex is a plain, non-reactive ref).
	void dataState.navaidsLoaded;
	return navaidIndex?.get(ui.detail.id) ?? null;
}

/** Lookup by raw id, for the detail panel's "Back to navaid X" label
 *  (navaid ids like "DME:1527279" aren't user-facing; callers show the
 *  resolved ident instead). */
export function navaidById(id: string): Navaid | null {
	void dataState.navaidsLoaded;
	return navaidIndex?.get(id) ?? null;
}

/* ---- Nature zones (FR PRN parks / réserves + SUR sensitive sites) ---- */

export function getNature(): Nature[] | null {
	void dataState.revision.nature;
	return nature;
}

const NATURE_SOURCES: readonly CountrySource<Nature>[] = [
	{
		country: 'fr',
		meta: loadNatureMeta, nextMeta: loadNatureNextMeta,
		url: NATURE_URL, nextUrl: NATURE_NEXT_URL,
		load: loadNature,
	},
	{
		country: 'be',
		meta: loadBeNatureMeta, nextMeta: loadBeNatureNextMeta,
		url: BE_NATURE_URL, nextUrl: BE_NATURE_NEXT_URL,
		load: loadNature,
	},
	{
		country: 'it',
		meta: loadItNatureMeta, nextMeta: loadItNatureNextMeta,
		url: IT_NATURE_URL, nextUrl: IT_NATURE_NEXT_URL,
		load: loadNature,
	},
];

const natureStore = countryStore<Nature>('nature', NATURE_SOURCES);

/** Concatenate the loaded country rows and publish. Re-runnable: the
 *  coverage gate can bring a country in after the first load.
 *  Ids are namespaced by publisher at emit time, so no dedup is needed. */
function publishNatures(): Nature[] {
	const n = storeRows(natureStore).flat();
	nature = n;
	 
	natureIndex = new Map(n.map((z) => [z.id, z]));
	dataState.natureLoaded = true;
	dataState.natureLoading = false;
	dataState.revision.nature++;
	return n;
}

/** Re-run the coverage gate for every dataset already in memory and load
 *  whatever the widened area now wants, republishing the ones that grew.
 *
 *  The gate only ever WIDENS what is loaded: a dataset nothing has asked
 *  for stays unloaded, so this never starts a fetch on its own. Callers
 *  are the map (its viewport and the routes' extent) and the briefing
 *  (the publishers its NOTAMs point at). */
export async function extendCoverage(): Promise<void> {
	await Promise.all([
		airports && !dataState.airportsLoading
			? fillStore(airportStore).then((grew) => {
					if (grew) publishAirports();
				})
			: null,
		airspaces && !dataState.airspacesLoading
			? Promise.all([fillStore(airspaceStore), loadFaaIfWanted()]).then(([grew, faaGrew]) => {
					if (grew || faaGrew) publishAirspaces();
				})
			: null,
		obstacles && !dataState.obstaclesLoading
			? fillStore(obstacleStore).then((grew) => {
					if (grew) publishObstacles();
				})
			: null,
		navaids && !dataState.navaidsLoading
			? fillStore(navaidStore).then((grew) => {
					if (grew) publishNavaids();
				})
			: null,
		nature && !dataState.natureLoading
			? fillStore(natureStore).then((grew) => {
					if (grew) publishNatures();
				})
			: null,
	]);
}

export function ensureNature(): Promise<Nature[]> {
	if (nature) {
		return Promise.resolve(nature);
	}
	if (naturePromise) {
		return naturePromise;
	}
	dataState.natureLoading = true;
	dataState.natureError = null;
	naturePromise = (async () => {
		// Dual-AIRAC like the primary datasets: pick the current or next slot
		// by effective date once per publisher (FR PRN/SUR + BE bird areas),
		// then concatenate.
		await fillStore(natureStore);
		return publishNatures();
	})().catch((e: unknown) => {
		dataState.natureError = message(e);
		dataState.natureLoading = false;
		naturePromise = null;
		throw e;
	});
	return naturePromise;
}

export function selectedNature(): Nature | null {
	if (ui.detail?.kind !== 'nature') {
		return null;
	}
	// Track the load so the DetailPanel $derived re-runs once the dataset
	// finishes lazy-loading (natureIndex is a plain, non-reactive ref).
	void dataState.natureLoaded;
	return natureIndex?.get(ui.detail.id) ?? null;
}

export function natureById(id: string): Nature | null {
	void dataState.natureLoaded;
	return natureIndex?.get(id) ?? null;
}

/* ---- SUP AIP ---- */

export function getSupaips(): SupAip[] | null {
	return supaips;
}

export function supaipById(id: string): SupAip | null {
	void dataState.supaipLoaded;
	return supaipIndex?.get(id) ?? null;
}

/** Look up a metropole SUP AIP by its NOTAM-citation number/year (e.g. an
 *  "AIP SUP 080/2026" reference). Returns null until the dataset loads. */
export function supaipByRef(number: number, year: number): SupAip | null {
	void dataState.supaipLoaded;
	return supaipRefIndex?.get(`${year}/${number}`) ?? null;
}

export function selectedSupaip(): SupAip | null {
	if (ui.detail?.kind !== 'supaip') {
		return null;
	}
	void dataState.supaipLoaded;
	return supaipIndex?.get(ui.detail.id) ?? null;
}

/** Lazily load the SUP AIP dataset. Single plain file (no AIRAC slot); each
 *  supplement carries its own validity window, filtered by visibleSupaips. */
export function ensureSupaip(): Promise<SupAip[]> {
	if (supaips) {
		return Promise.resolve(supaips);
	}
	if (supaipPromise) {
		return supaipPromise;
	}
	dataState.supaipLoading = true;
	dataState.supaipError = null;
	supaipPromise = (async () => {
		// Meta is loaded for provenance (About panel); a failure is non-fatal.
		await Promise.all([
			loadSupAipMeta().catch(() => null),
			loadBeSupAipMeta().catch(() => null),
		]);
		const [frSup, beSup] = await Promise.all([
			loadSupAip(SUPAIP_URL),
			loadSupAip(BE_SUPAIP_URL),
		]);
		const list = frSup.concat(beSup);
		supaips = list;
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
		supaipIndex = new Map(list.map((s) => [s.id, s]));
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
		const refs = new Map<string, SupAip>();
		for (const s of list) {
			if (
				s.region === 'metropole' &&
				Number.isFinite(s.number) &&
				Number.isFinite(s.year)
			) {
				refs.set(`${s.year}/${s.number}`, s);
			}
		}
		supaipRefIndex = refs;
		dataState.supaipLoaded = true;
		dataState.supaipLoading = false;
		return list;
	})().catch((e: unknown) => {
		dataState.supaipError = message(e);
		dataState.supaipLoading = false;
		supaipPromise = null;
		throw e;
	});
	return supaipPromise;
}

/* ---- split-out lazy datasets ----
 *
 * The per-publisher aerodrome chart-link sets and the reference catalogs
 * (AD-2 facilities, METAR stations, FAA designators) live in sibling
 * modules; re-exported here so every importer keeps the one data.svelte
 * entry point. */

export {
	ensureFrAdCharts,
	frAdChartsForIdent,
	frVacForIdent,
	ensureUkAdCharts,
	ukAdChartsForIdent,
	ensureUsAdCharts,
	usAdChartsForIdent,
	ensureAtAdCharts,
	atAdLinksForIdent,
	ensureDeAdCharts,
	deAdLinkForIdent,
} from './adCharts.svelte';
export {
	ensureAerodromeFacilities,
	facilitiesForIdent,
	ensureMetarStationCatalog,
	getMetarStationCatalog,
	metarStationByIdent,
	ensureFaaDesignators,
	isKnownDesignator,
	searchDesignators,
} from './referenceData.svelte';

export function selectedAirspace(): Airspace | null {
	if (ui.detail?.kind !== 'airspace') {
		return null;
	}
	// Track the load so the DetailPanel $derived re-runs once the airspace
	// dataset finishes lazy-loading (airspaceIndex is a plain, non-reactive ref).
	void dataState.airspacesLoaded;
	return airspaceIndex?.get(ui.detail.key) ?? null;
}

/** Airspace row by key (id|name; null before the dataset arrives). Tracks
 *  the load like selectedAirspace so deriveds re-run on arrival. */
export function airspaceByKey(key: string): Airspace | null {
	void dataState.airspacesLoaded;
	return airspaceIndex?.get(key) ?? null;
}

/* ---- AIRAC switch heartbeat ----
 *
 * Re-uses notamState.tick (60-second setInterval already running for NOTAM
 * activation re-evaluation). On each tick, if a per-country dataset is
 * loaded and the picker would now choose a different slot, flip
 * dataState.airacSwitchPending. The UI prompts the user to reload; we
 * don't swap in place to avoid tearing down map layers / autorouter state
 * / activation overlay.
 *
 * Module-scope $effect.root keeps the watcher alive for the page lifetime
 * without requiring a host component. */

$effect.root(() => {
	$effect(() => {
		// Track the tick so this effect re-runs once a minute.
		void notamState.tick;
		const now = new Date();
		// One cell per loaded (dataset, country) slot. Any swap flips
		// airacSwitchPending; the banner asks the user to reload.
		let pending = false;
		for (const dataset of AIRAC_DATASETS) {
			for (const country of AIRAC_COUNTRIES) {
				const cell = dataState.airac[dataset][country];
				if (cell && wouldSwitch(cell.effective, cell.nextEffective, cell.slot, now)) {
					pending = true;
				}
			}
		}
		dataState.airacSwitchPending = pending;
	});
});
