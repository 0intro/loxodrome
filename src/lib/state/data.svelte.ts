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
	FAA_AIRPORTS_URL,
	FAA_AIRPORTS_NEXT_URL,
	FR_AIRPORTS_URL,
	loadAirports,
	loadFrAirports,
	type Airport,
} from '$lib/data/airports';
import {
	mergeAixmOverlays,
	applyFrAutoInfoFrequency,
	applyDeMilitaryStatus,
	dropStaleBaseline,
} from '$lib/data/airportMerge';
import {
	mergeAirspaces,
} from '$lib/data/airspaceMerge';
import type { Publisher } from '$lib/state/layers.svelte';
import {
	AIRAC_PUBLISHERS,
	MERGE_ORDER,
	datasetUrl,
	isPublisher,
	publisherArea,
	publishes,
	type RegistryPublisher,
} from '$lib/data/publishers';
import {
	AIRSPACES_URL,
	firIdent,
	loadAirspaceOverlay,
	loadAirspaces,
	loadFaaAirspaces,
	loadPruatlasFirs,
	type Airspace,
} from '$lib/data/airspaces';
import {
	OBSTACLES_URL,
	FAA_OBSTACLES_URL,
	FAA_OBSTACLES_NEXT_URL,
	loadObstacles,
	type Obstacle,
} from '$lib/data/obstacles';
import {
	NAVAIDS_URL,
	NAVAIDS_NEXT_URL,
	FAA_NAVAIDS_URL,
	FAA_NAVAIDS_NEXT_URL,
	loadNavaids,
	type Navaid,
} from '$lib/data/navaids';
import { uniqueRowIds } from '$lib/data/dedup';
import {
	NATURE_URL,
	NATURE_NEXT_URL,
	loadNature,
	type Nature,
} from '$lib/data/nature';
import {
	datasetMeta,
	loadFrenchAirspacesMeta,
	loadFrenchAirspacesNextMeta,
	loadFrAirportsMeta,
	loadFrAirportsNextMeta,
	loadObstaclesMeta,
	loadObstaclesNextMeta,
	loadNavaidsMeta,
	loadNavaidsNextMeta,
	loadNatureMeta,
	loadNatureNextMeta,
	loadFaaAirportsMeta,
	loadFaaAirportsNextMeta,
	loadFaaNavaidsMeta,
	loadFaaNavaidsNextMeta,
	loadFaaObstaclesMeta,
	loadFaaObstaclesNextMeta,
	loadFaaAirspacesMeta,
	loadSupAipMeta,
	loadBeSupAipMeta,
	loadEsSupAipMeta,
	pickActiveDataset,
	wouldSwitch,
	type DatasetBBox,
	type DatasetBBoxes,
	type SidecarLoader,
} from '$lib/data/meta';
import {
	dataExpired,
} from '$lib/data/airacValidity';
import {
	boxNearArea,
	coverage,
	coverageAreas,
	coverageStamp,
	coverageWants,
	publisherInCoverage,
	type CoverageArea,
} from '$lib/state/coverage.svelte';
import { untrack } from 'svelte';
import { DataReadError, isTransient } from '$lib/data/fetchData';
import {
	retryAfterFailure,
	retryCleared,
	retryParts,
	retryRefusal,
	type RetryGroup,
	type RetryPart,
} from '$lib/state/dataRetry.svelte';
import {
	loadSupAip,
	supaipPublisherOf,
	SUPAIP_URL,
	BE_SUPAIP_URL,
	ES_SUPAIP_URL,
	type SupAip,
	type SupAipPublisher,
} from '$lib/data/supaip';

/** The SUP AIP datasets, merged in this order into one list. Each is a
 *  plain file (no AIRAC slot): a supplement carries its own validity
 *  window, which is what visibleSupaipZones filters on. */
const SUPAIP_SOURCES: { url: string; publisher: Publisher; meta: () => Promise<unknown> }[] = [
	{ url: SUPAIP_URL, publisher: 'fr', meta: loadSupAipMeta },
	{ url: BE_SUPAIP_URL, publisher: 'be', meta: loadBeSupAipMeta },
	{ url: ES_SUPAIP_URL, publisher: 'es', meta: loadEsSupAipMeta },
];
import {
	airportsMerged,
	notamState,
} from './notam.svelte';
import {
	ui,
} from './ui.svelte';

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
// can re-merge without re-fetching. pruatlas is null until its read has
// answered; a read that failed for a reason that may pass is kept for its
// retry.
let pruatlasRows: Airspace[] | null = null;
let pruatlasFailure: Error | null = null;
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
// Each publisher's supplements once its file has answered, and the ones
// whose read failed for a reason that may pass, waiting for their retry.
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- plain per-publisher parts, not reactive state
const supaipParts = new Map<string, SupAip[]>();
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- plain per-publisher failures, not reactive state
const supaipFailed = new Map<string, Error>();

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
	 *  and the retry of a failed read make a repeatable event: a country
	 *  landing later widens the array in place, and the getters and every
	 *  lookup read this so their consumers re-derive. The loaded flags flip
	 *  once, on the first publish, so a lookup reading only its flag kept the
	 *  first merge's answer for a row that arrived later. */
	revision: Record<AiracDataset | 'supaip', number>;
	supaipLoaded: boolean;
	supaipLoading: boolean;
	supaipError: string | null;
	/** Set when any per-country `*.next.json` becomes effective while a
	 *  `.json` is loaded (or vice versa: an older `.json` would supersede
	 *  a stale `.next.json`). UI surfaces a banner; user reloads to pick
	 *  up the swap. */
	airacSwitchPending: boolean;
	/** Set once the clock passes the build's data validity
	 *  (__DATA_VALID_UNTIL__, src/lib/data/airacValidity.ts): the datasets
	 *  shipped with this build are a whole AIRAC cycle behind their newest
	 *  slot. What the Play app shows until its next release. */
	dataExpired: boolean;
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
		supaip: 0,
	},
	supaipLoaded: false,
	supaipLoading: false,
	supaipError: null,
	airacSwitchPending: false,
	dataExpired: false,
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
export type AiracDataset = (typeof AIRAC_DATASETS)[number];
export type AiracCountry = (typeof AIRAC_PUBLISHERS)[number];

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
	meta: SidecarLoader<{ effective: string; bbox?: DatasetBBox; bboxes?: DatasetBBoxes } | null>;
	nextMeta: SidecarLoader<{ effective: string; bbox?: DatasetBBox; bboxes?: DatasetBBoxes } | null>;
	url: string;
	nextUrl: string;
	load: (url: string) => Promise<T[]>;
}

/** One merged dataset's sources, in its MERGE_ORDER ($lib/data/publishers):
 *  France and the FAA from their explicit entries, every registry publisher
 *  from the registry's URLs and sidecars, read through the kind's own
 *  loader. An order naming a publisher that neither files the kind nor has
 *  an explicit entry is a programming error, caught at load. */
function countrySources<T>(
	kind: keyof typeof MERGE_ORDER,
	load: (url: string, id: RegistryPublisher) => Promise<T[]>,
	explicit: Partial<Record<'fr' | 'faa', CountrySource<T>>>,
): readonly CountrySource<T>[] {
	return MERGE_ORDER[kind].map((id): CountrySource<T> => {
		if (id === 'fr' || id === 'faa') {
			const own = explicit[id];
			if (!own) {
				// i18n-ignore: a programming error, caught by tests/publishers.spec.ts
				throw new Error(`${kind}: no explicit source for ${id}`);
			}
			return own;
		}
		if (!publishes(id, kind)) {
			// i18n-ignore: a programming error, caught by tests/publishers.spec.ts
			throw new Error(`${kind}: ${id} is ordered but files no ${kind}`);
		}
		const p: RegistryPublisher = id;
		return {
			country: p,
			meta: datasetMeta(p, kind),
			nextMeta: datasetMeta(p, kind, true),
			url: datasetUrl(p, kind),
			nextUrl: datasetUrl(p, kind, true),
			load: (url) => load(url, p),
		};
	});
}

/** A country whose read failed, kept out of the store's rows so its retry
 *  reads it again: soon for a failure that may pass, at the longest wait for
 *  a fact about the document (src/lib/data/fetchData.ts, the schedule in
 *  state/dataRetry.svelte.ts). Never an empty list: "nothing there" where
 *  something did not load. `envelope` is what its sidecar said, null when
 *  that failed too; whether the failure matters to the pilot is judged on it
 *  at every report (failureWanted), the coverage having moved since. */
interface CountryFailure {
	error: Error;
	envelope: { bbox?: DatasetBBox | undefined; bboxes?: DatasetBBoxes | undefined } | null;
}

/** Does a failed part matter to the pilot, over the coverage as it is now?
 *  Its envelope read, the gate judges it on that, as it judged the load;
 *  unread or unstated, on where its publisher is (publisherInCoverage):
 *  offline with the sidecars expired from the service worker, every country
 *  it never cached fails, and only the ones near the pilot are news. A
 *  sidecar that answered without a bbox is no envelope either: the gate
 *  loads such a country wherever the pilot is, and asked the same way its
 *  failure was news everywhere. */
function failureWanted(part: Publisher, f: CountryFailure): boolean {
	return f.envelope?.bbox && f.envelope.bbox.length >= 4
		? coverageWants(part, f.envelope.bbox, f.envelope.bboxes)
		: publisherInCoverage(part);
}

/** What one pass of the pipeline read: the rows of each country it loaded,
 *  the countries still missing, and the coverage stamp its gate was judged
 *  at. */
interface CountryPass<T> {
	rows: Map<AiracCountry, T[]>;
	failed: Map<AiracCountry, CountryFailure>;
	stamp: number;
}

/** Which failed parts a pass reads again: every one ('all': a first load,
 *  the whole dataset's retry), the ones a part's retry names, or none (a
 *  coverage pass, a failed part waiting for its own retry). */
type Reread = 'all' | ReadonlySet<string> | null;

function rereads(reread: Reread, part: string): boolean {
	return reread === 'all' || (reread !== null && reread.has(part));
}

/** A sidecar's answer, or the fact that it failed. A failure reads as no
 *  sidecar, as it always did: the current slot, an unknown envelope, so the
 *  country loads. Rejecting instead would starve an offline session: the
 *  next sidecar answers 404 between pre-releases, which the service worker
 *  never caches, and it keeps the sidecars a day where it keeps the data a
 *  month (docs/data-retry.md, "Sidecars"). */
function readSidecar<M>(load: () => Promise<M | null>): Promise<{ meta: M | null; failed: boolean }> {
	return load().then(
		(meta) => ({ meta, failed: false }),
		() => ({ meta: null, failed: true }),
	);
}

/** The dual-AIRAC pipeline every multi-country dataset shares: fetch each
 *  country's current + next meta sidecars in parallel (readSidecar), pick
 *  each country's active slot by effective date, load the picked files in
 *  parallel, each on its own, and stamp the airac matrix cells the
 *  heartbeat below watches.
 *
 *  A country already loaded is not read again. One whose last read failed
 *  is not read again either, its sidecars included, until its retry comes
 *  due (`reread`, which also re-judges it and lets it go if the coverage no
 *  longer wants it): a coverage pass runs on every settled pan, and in
 *  flight follow mode pans every few fixes, so it would otherwise ask a
 *  dead network again each time. One country failing never discards the
 *  others, and a failure, whatever it is, leaves that country missing. */
async function loadCountryDatasets<T>(store: CountryStore<T>, reread: Reread): Promise<CountryPass<T>> {
	const { dataset, sources } = store;
	const loaded = sources.map((s) => store.rows.has(s.country));
	const cooling = sources.map(
		(s, i) => !loaded[i] && store.failed.has(s.country) && !rereads(reread, s.country),
	);
	const metas = await Promise.all(
		sources.map((s, i) =>
			loaded[i] || cooling[i] ? Promise.resolve(null) : Promise.all([readSidecar(s.meta), readSidecar(s.nextMeta)]),
		),
	);
	// One-shot timestamp passed by value; not a reactive ref.
	const now = new Date();
	const picked = sources.map((s, i) =>
		pickActiveDataset(
			metas[i]?.[0].meta?.effective ?? null,
			metas[i]?.[1].meta?.effective ?? null,
			s.url,
			s.nextUrl,
			now,
		),
	);
	// The coverage gate: a publisher whose rows cannot reach the current
	// view is not fetched. The envelope comes off the slot actually
	// picked, so a country that moves between cycles is judged on the
	// file about to be read. The sidecars are fetched for every country
	// not loaded yet, gated out or not; they are a few hundred bytes (read
	// once, their loaders caching the answer) and they carry the AIRAC
	// dates the About dialog reports. The stamp is read in the same
	// synchronous step as the gate, so it names exactly the coverage this
	// pass judged.
	const stamp = untrack(coverageStamp);
	const wanted = sources.map((s, i) => {
		const m = metas[i];
		if (!m) {
			return false;
		}
		const slotMeta = picked[i].slot === 'next' ? m[1].meta : m[0].meta;
		return coverageWants(s.country, slotMeta?.bbox, slotMeta?.bboxes);
	});
	const settled = await Promise.allSettled(
		sources.map((s, i) => (wanted[i] ? s.load(picked[i].url) : Promise.resolve([] as T[]))),
	);
	// A NEXT pick that answered nothing is checked against fresh sidecars,
	// loadActiveSlot's rule ($lib/data/meta) for the single-file sets: the
	// kept sidecars can name a next pair a build has since RETIRED, the
	// current slot having caught up with it. A fail-soft loader read the
	// missing file as nothing there, which stored the country as loaded with
	// no rows, silently; France's, which requires its file, failed every
	// retry on the same kept answer. Read again, the sidecars pick the
	// current slot, judged by the gate and read in this pass.
	await Promise.all(
		sources.map(async (s, i) => {
			const r = settled[i];
			const nothing =
				r.status === 'fulfilled'
					? r.value.length === 0
					: r.reason instanceof DataReadError && r.reason.absent;
			if (!wanted[i] || picked[i].slot !== 'next' || !nothing) {
				return;
			}
			const fresh = await Promise.all([readSidecar(() => s.meta(true)), readSidecar(() => s.nextMeta(true))]);
			const again = pickActiveDataset(
				fresh[0].meta?.effective ?? null,
				fresh[1].meta?.effective ?? null,
				s.url,
				s.nextUrl,
				new Date(),
			);
			if (again.url === picked[i].url) {
				return;
			}
			metas[i] = fresh;
			picked[i] = again;
			const slotMeta = again.slot === 'next' ? fresh[1].meta : fresh[0].meta;
			wanted[i] = coverageWants(s.country, slotMeta?.bbox, slotMeta?.bboxes);
			[settled[i]] = await Promise.allSettled([wanted[i] ? s.load(again.url) : Promise.resolve([] as T[])]);
		}),
	);
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- plain result map, not reactive state
	const rows = new Map<AiracCountry, T[]>();
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- plain result map, not reactive state
	const failed = new Map<AiracCountry, CountryFailure>();
	sources.forEach((s, i) => {
		const m = metas[i];
		if (cooling[i]) {
			// Still missing, and not read: it waits for its retry.
			const prior = store.failed.get(s.country);
			if (prior) {
				failed.set(s.country, prior);
			}
			return;
		}
		if (!m) {
			return;
		}
		const r = settled[i];
		if (wanted[i]) {
			if (r.status === 'rejected') {
				const side = picked[i].slot === 'next' ? m[1] : m[0];
				failed.set(s.country, {
					error: asError(r.reason),
					envelope: side.failed ? null : { bbox: side.meta?.bbox, bboxes: side.meta?.bboxes },
				});
				return;
			}
			rows.set(s.country, r.value);
		}
		// Stamp the AIRAC matrix for every publisher this pass read, loaded
		// now or gated out: the About dialog reports on the whole fleet, and
		// a gated-out country still has a cycle. Never a country already
		// loaded, whose cell describes the file it was loaded FROM:
		// re-stamped from the picker's answer now, a pass after an AIRAC date
		// wrote "next" over rows loaded from "current", and the reload banner
		// never showed. Nor one whose read failed.
		dataState.airac[dataset][s.country] = {
			effective: picked[i].effective,
			nextEffective: m[1].meta?.effective ?? null,
			slot: picked[i].slot,
		};
		// A next sidecar that did not answer is an unknown next cycle, not
		// none: read again by the heartbeat, or a country loaded now would
		// never ask for the reload its next cycle brings.
		if (m[1].failed && picked[i].slot === 'current') {
			nextUnread.add(`${dataset}:${s.country}`);
		} else {
			nextUnread.delete(`${dataset}:${s.country}`);
		}
	});
	return { rows, failed, stamp };
}

// The (dataset, country) cells whose next sidecar did not answer when they
// were stamped: the heartbeat reads it again (refreshUnreadNext).
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- plain bookkeeping, not reactive state
const nextUnread = new Set<string>();

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
	/** The countries whose last read failed for a reason that may pass,
	 *  waiting for their retry. */
	failed: Map<AiracCountry, CountryFailure>;
	inflight: Promise<void> | null;
	/** The coverage stamp the last pass judged its gate at, so a later
	 *  pass over an unchanged coverage costs nothing; what that pass could
	 *  not read waits in `failed` for its retry, which passes `force`.
	 *  Null before the first. */
	judged: number | null;
}

function countryStore<T>(
	dataset: AiracDataset,
	sources: readonly CountrySource<T>[],
): CountryStore<T> {
	return {
		dataset,
		sources,
		rows: new Map<AiracCountry, T[]>(),
		failed: new Map<AiracCountry, CountryFailure>(),
		inflight: null,
		judged: null,
	};
}

/** Load every country the current coverage wants and this store has not
 *  got yet. Serialised: a second caller waits for the first rather than
 *  racing it into the same slots, then finds the gate already judged at the
 *  current coverage and returns. A retry (`reread`, 'all' for a first load)
 *  runs the pass whatever was judged, reading its failed countries again.
 *  Commits whatever landed, and says whether anything did. */
async function fillStore<T>(store: CountryStore<T>, reread: Reread): Promise<boolean> {
	while (store.inflight) {
		// A waiter runs its own pass whatever became of the one before.
		await store.inflight.catch(() => {});
	}
	// Untracked: an ensure called from an effect runs this synchronously,
	// and the stamp reads the coverage areas; tracked, that effect would
	// re-run on every pan.
	if (reread === null && store.judged !== null && store.judged === untrack(coverageStamp)) {
		return false;
	}
	const before = store.rows.size;
	const run = (async () => {
		const pass = await loadCountryDatasets(store, reread);
		for (const [country, rows] of pass.rows) {
			store.rows.set(country, rows);
		}
		store.failed = pass.failed;
		store.judged = pass.stamp;
	})();
	store.inflight = run;
	try {
		await run;
	} finally {
		store.inflight = null;
	}
	return store.rows.size !== before;
}

function asError(e: unknown): Error {
	return e instanceof Error ? e : new Error(String(e));
}

/** Does a failed part of a dataset come within a margin of an area? Judged
 *  on the envelope its sidecar states, the gate's own rule (failureWanted),
 *  else on its publisher's territory, whose registry box is drawn
 *  generously (Germany's spans 4 to 17 E). */
function failedPartNear<T>(store: CountryStore<T>, part: string, area: CoverageArea, latDeg: number, lonDeg: number): boolean {
	const f = store.failed.get(part as AiracCountry);
	if (!f) {
		return false;
	}
	const env = f.envelope;
	const boxes: readonly (readonly [number, number, number, number])[] =
		env?.bboxes && env.bboxes.length > 0
			? env.bboxes
			: env?.bbox && env.bbox.length >= 4
				? [env.bbox]
				: isPublisher(part)
					? publisherArea(part)
					: [];
	return boxes.some((b) => boxNearArea(b, area, latDeg, lonDeg));
}

/** Does a failed part of the obstacles come within a margin of an area (the
 *  route's MSA corridor, routeMsaIncomplete)? Plain, reads no state that
 *  moves: the caller's own reads of the retry mirror are what re-run it. */
export function obstaclePartNear(part: string, area: CoverageArea, latDeg: number, lonDeg: number): boolean {
	return failedPartNear(obstacleStore, part, area, latDeg, lonDeg);
}

function storeGaps<T>(store: CountryStore<T>): RetryPart[] {
	return [...store.failed].map(([part, f]) => ({
		part,
		error: f.error,
		wanted: failureWanted(part, f),
		judge: () => untrack(() => failureWanted(part, f)),
	}));
}

/** Tell the retry schedule what a published dataset still lacks after an
 *  attempt: each missing part under its own key and at its own pace, the
 *  whole dataset's key (its first load failed) forgotten. Called BEFORE the
 *  state writes that follow (a publish, a failure line): an effect those
 *  writes wake must already find the refusal, or it starts a second read. */
function reportGaps(group: RetryGroup, gaps: readonly RetryPart[], retryPart: (part: string) => unknown): void {
	retryCleared(group);
	retryParts(group, gaps, retryPart);
}

/** A first load that failed: its retry is scheduled, soon for a failure
 *  that may pass and at the longest wait for a fact, and until then every
 *  ensure answers the failure without reading. Called before the failure's
 *  state writes, for the same reason. */
function reportFailure(group: RetryGroup, e: unknown, retry: () => unknown): void {
	retryAfterFailure(group, group, e, retry);
}

/** A first load's verdict: something failed and no part answered at all
 *  rejects, with a failure that may pass when there is one (the dataset's
 *  retry then comes soon), which the retry reads again; anything else
 *  publishes, the missing parts retried each at its own pace. `landed` says
 *  whether a part beside the store answered (the airport baseline, the FIR
 *  rings, the FAA overlay). A country whose file the deployment does not
 *  hold has answered: nothing there. */
function firstVerdict(gaps: readonly RetryPart[], landed: boolean, store: CountryStore<unknown>): void {
	if (gaps.length > 0 && !landed && store.rows.size === 0) {
		throw (gaps.find((g) => isTransient(g.error)) ?? gaps[0]).error;
	}
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
const AIRPORT_SOURCES = countrySources<Airport>('airports', (url, id) => loadFrAirports(url, id), {
	fr: {
		country: 'fr',
		meta: loadFrAirportsMeta, nextMeta: loadFrAirportsNextMeta,
		url: FR_AIRPORTS_URL, nextUrl: FR_AIRPORTS_NEXT_URL,
		load: (url) => loadFrAirports(url, 'fr'),
	},
	faa: {
		country: 'faa',
		meta: loadFaaAirportsMeta, nextMeta: loadFaaAirportsNextMeta,
		url: FAA_AIRPORTS_URL, nextUrl: FAA_AIRPORTS_NEXT_URL,
		load: (url) => loadFrAirports(url, 'faa'),
	},
});

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
	// OurAirports type / iso_country for matching ICAOs; all of them in one
	// pass over lookups built once (mergeAixmOverlays).
	let merged = mergeAixmOverlays(airportBaseline, storeRows(airportStore));
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
	dataState.airportsError = null;
	dataState.revision.airports++;
	// The briefing may name an aerodrome this merge is the first to place.
	airportsMerged();
	return merged;
}

/** The airports, loading them if nothing has yet. While a failed first
 *  load waits for its retry (state/dataRetry.svelte.ts) it answers that
 *  failure and reads nothing, whoever asks: the alert effect asks on every
 *  GPS fix. */
export function ensureAirports(): Promise<Airport[]> {
	if (airports) {
		return Promise.resolve(airports);
	}
	if (airportsPromise) {
		return airportsPromise;
	}
	const refused = retryRefusal('airports');
	if (refused) {
		return Promise.reject(refused);
	}
	return firstAirports(false);
}

/** The first load: the worldwide baseline, then every country the coverage
 *  wants, the failed ones included. A retry's attempt (`retrying`) leaves
 *  the load flags alone, so the failure line does not blink to "Loading"
 *  every round; the publish clears it. */
function firstAirports(retrying: boolean): Promise<Airport[]> {
	if (!retrying) {
		dataState.airportsLoading = true;
		dataState.airportsError = null;
	}
	airportsPromise = (async () => {
		// Worldwide OurAirports baseline (no AIRAC slot). Loaded
		// unconditionally; the per-country AIXM overlays below merge on top.
		airportBaseline = await loadAirports(AIRPORTS_URL);
		await fillStore(airportStore, 'all');
		// The baseline landed, so this publishes, the missing countries
		// retried.
		reportGaps('airports', storeGaps(airportStore), retryAirportsPart);
		return publishAirports();
	})().catch((e: unknown) => {
		reportFailure('airports', e, retryAirports);
		dataState.airportsError = message(e);
		dataState.airportsLoading = false;
		airportsPromise = null;
		throw e;
	});
	return airportsPromise;
}

/** Widen the airports over the current coverage (`reread`: a retry's,
 *  reading those failed countries again) and publish what grew. */
async function widenAirports(reread: Reread): Promise<void> {
	const grew = await fillStore(airportStore, reread);
	reportGaps('airports', storeGaps(airportStore), retryAirportsPart);
	if (grew) {
		publishAirports();
	}
}

/** The airports' retry after a failed first load: the first load again.
 *  The value first, the promise staying set after a success. */
function retryAirports(): Promise<unknown> {
	return airports ? widenAirports('all') : (airportsPromise ?? firstAirports(true));
}

/** One missing country's retry, once the airports are published. */
function retryAirportsPart(part: string): Promise<unknown> {
	return airports ? widenAirports(new Set([part])) : (airportsPromise ?? firstAirports(true));
}

/** Airport-coordinate lookup for the parser's "RDL … ARP <ICAO>" anchoring. */
export function airportLookup(ident: string): { lat: number; lon: number } | null {
	const a = airportIndex?.get(ident.toUpperCase());
	return a ? { lat: a.lat, lon: a.lon } : null;
}

/** Full airport record by ICAO ident, or null. Used by the route profile for
 *  the charted field elevation at an anchored airport endpoint. Reads the
 *  airports revision, so a reactive caller re-runs when a merge replaces
 *  the row (the performance page's LIAF gaining the runways Italy's dataset
 *  lists, open flightmaps data rather than the Italian AIP, when the
 *  coverage brings Italy in). */
export function airportByIdent(ident: string): Airport | null {
	void dataState.revision.airports;
	return airportIndex?.get(ident.toUpperCase()) ?? null;
}

export function selectedAirport(): Airport | null {
	if (ui.detail?.kind !== 'airport') {
		return null;
	}
	// Track every publish so the DetailPanel $derived re-runs when the airport
	// dataset arrives, and again when a country lands later and replaces the
	// row (airportIndex is a plain, non-reactive ref): a waypoint selected
	// from the nav log or the route profile can race ensureAirports(), and an
	// aerodrome of a country the coverage has not reached yet shows the
	// baseline's row until it does.
	void dataState.revision.airports;
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
const AIRSPACE_SOURCES = countrySources<Airspace>('airspaces', (url, id) => loadAirspaceOverlay(url, id), {
	fr: {
		country: 'fr',
		meta: loadFrenchAirspacesMeta, nextMeta: loadFrenchAirspacesNextMeta,
		url: AIRSPACES_URL, nextUrl: AIRSPACES_NEXT_URL,
		load: loadAirspaces,
	},
});

const airspaceStore = countryStore<Airspace>('airspaces', AIRSPACE_SOURCES);

/** Fetch the FAA airspace overlay when the coverage reaches it, once.
 *  Resolves true when rows landed that were not there before, which is
 *  the caller's signal to re-merge. Passes run one after another: the first
 *  load and a widening can both ask, and each must see what the other did
 *  or the four megabytes come down twice.
 *
 *  The state moves to loaded only once a read has ANSWERED: it used to be
 *  latched before the fetch, so one that failed left the overlay out for
 *  the session. A failure, whatever it is, is kept for the retry (`force`)
 *  and not read again by a coverage pass meanwhile; a coverage that no
 *  longer reaches North America at the retry lets it go. */
let faaState: 'unjudged' | 'loaded' | 'failed' = 'unjudged';
let faaFailure: CountryFailure | null = null;
let faaPass: Promise<boolean> = Promise.resolve(false);
function loadFaaIfWanted(force = false): Promise<boolean> {
	const pass = faaPass
		.catch(() => false)
		.then(async () => {
			if (faaState === 'loaded' || (faaState === 'failed' && !force)) {
				return false;
			}
			// A sidecar that fails reads as none, as every sidecar does
			// (readSidecar): an unknown envelope, so the overlay loads.
			const { meta, failed } = await readSidecar(loadFaaAirspacesMeta);
			if (!coverageWants('faa', meta?.bbox, meta?.bboxes)) {
				faaState = 'unjudged';
				faaFailure = null;
				return false;
			}
			try {
				faaRows = await loadFaaAirspaces();
			} catch (e) {
				faaState = 'failed';
				faaFailure = { error: asError(e), envelope: failed ? null : { bbox: meta?.bbox, bboxes: meta?.bboxes } };
				return false;
			}
			faaState = 'loaded';
			faaFailure = null;
			return true;
		});
	faaPass = pass;
	return pass;
}

/** Read the worldwide FIR rings. Resolves true once they answered; a
 *  failure, whatever it is, is kept for the retry. */
async function loadPruatlas(): Promise<boolean> {
	try {
		pruatlasRows = await loadPruatlasFirs();
	} catch (e) {
		pruatlasFailure = asError(e);
		return false;
	}
	pruatlasFailure = null;
	return true;
}

/** What the airspaces still lack: the countries, the FIR rings (wanted
 *  wherever the pilot is), the FAA overlay. */
function airspaceGaps(): RetryPart[] {
	const gaps = storeGaps(airspaceStore);
	if (pruatlasFailure) {
		gaps.push({ part: 'pruatlas', error: pruatlasFailure, wanted: true });
	}
	if (faaFailure) {
		gaps.push({ part: 'faa', error: faaFailure.error, wanted: failureWanted('faa', faaFailure) });
	}
	return gaps;
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
	const a = mergeAirspaces([...storeRows(airspaceStore), pruatlasRows ?? [], faaRows]);
	airspaces = a;
	// Key by the per-row `key` (not `id`) so rows sharing an id;
	// MOA parent + exclusions each get their own index entry.
	 
	airspaceIndex = new Map(a.map((sp) => [sp.key, sp]));
	dataState.airspacesLoaded = true;
	dataState.airspacesLoading = false;
	dataState.airspacesError = null;
	dataState.revision.airspaces++;
	return a;
}

/** The airspaces, loading them if nothing has yet; a failed first load
 *  answers its failure until its retry, as ensureAirports does. */
export function ensureAirspaces(): Promise<Airspace[]> {
	if (airspaces) {
		return Promise.resolve(airspaces);
	}
	if (airspacesPromise) {
		return airspacesPromise;
	}
	const refused = retryRefusal('airspaces');
	if (refused) {
		return Promise.reject(refused);
	}
	return firstAirspaces(false);
}

function firstAirspaces(retrying: boolean): Promise<Airspace[]> {
	if (!retrying) {
		dataState.airspacesLoading = true;
		dataState.airspacesError = null;
	}
	airspacesPromise = (async () => {
		// The worldwide pruatlas FIR overlay and the FAA airspace overlay
		// ride the same fetch round as the per-country slot loads; neither
		// carries an AIRAC slot of its own. pruatlas is genuinely
		// worldwide and always loads (it is the FIR ring everywhere no
		// national AIP is bundled); the FAA set is a country's, four
		// megabytes of it, so it is gated on its own envelope like one.
		await Promise.all([
			fillStore(airspaceStore, 'all'),
			pruatlasRows === null ? loadPruatlas() : Promise.resolve(false),
			loadFaaIfWanted(true),
		]);
		const gaps = airspaceGaps();
		firstVerdict(gaps, pruatlasRows !== null || faaState === 'loaded', airspaceStore);
		reportGaps('airspaces', gaps, retryAirspacesPart);
		return publishAirspaces();
	})().catch((e: unknown) => {
		reportFailure('airspaces', e, retryAirspaces);
		dataState.airspacesError = message(e);
		dataState.airspacesLoading = false;
		airspacesPromise = null;
		throw e;
	});
	return airspacesPromise;
}

/** Widen the airspaces: the countries, the FAA overlay, and at their retry
 *  (`reread`) the parts that failed, the FIR rings among them. Each part on
 *  its own, so one failing does not keep what another landed off the map,
 *  and each published as it lands: waiting for all of them held a country
 *  read in a moment behind the four megabytes of the FAA overlay. */
async function widenAirspaces(reread: Reread): Promise<void> {
	const part = (p: Promise<boolean>): Promise<void> =>
		p.then(
			(grew) => {
				if (grew) {
					// The gaps as they stand first, reportGaps' order.
					reportGaps('airspaces', airspaceGaps(), retryAirspacesPart);
					publishAirspaces();
				}
			},
			// Nothing of ours rejects here (each part keeps its own failure):
			// a programming error, said and not swallowed.
			(e: unknown) => console.error(e),
		);
	await Promise.all([
		part(fillStore(airspaceStore, reread)),
		part(loadFaaIfWanted(rereads(reread, 'faa'))),
		part(pruatlasRows === null && rereads(reread, 'pruatlas') ? loadPruatlas() : Promise.resolve(false)),
	]);
	reportGaps('airspaces', airspaceGaps(), retryAirspacesPart);
}

function retryAirspaces(): Promise<unknown> {
	return airspaces ? widenAirspaces('all') : (airspacesPromise ?? firstAirspaces(true));
}

function retryAirspacesPart(part: string): Promise<unknown> {
	return airspaces ? widenAirspaces(new Set([part])) : (airspacesPromise ?? firstAirspaces(true));
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

const OBSTACLE_SOURCES = countrySources<Obstacle>('obstacles', (url) => loadObstacles(url), {
	fr: {
		country: 'fr',
		meta: loadObstaclesMeta, nextMeta: loadObstaclesNextMeta,
		url: OBSTACLES_URL, nextUrl: OBSTACLES_NEXT_URL,
		load: loadObstacles,
	},
	faa: {
		country: 'faa',
		meta: loadFaaObstaclesMeta, nextMeta: loadFaaObstaclesNextMeta,
		url: FAA_OBSTACLES_URL, nextUrl: FAA_OBSTACLES_NEXT_URL,
		load: loadObstacles,
	},
});

const obstacleStore = countryStore<Obstacle>('obstacles', OBSTACLE_SOURCES);

/** Concatenate the loaded country rows and publish. Re-runnable: the
 *  coverage gate can bring a country in after the first load. Ids are
 *  namespaced by publisher at emit time, so two countries never share one,
 *  and the builders now write each id once (ENAIRE's 216 rows filed twice,
 *  the French mid two obstacles shared, internal/aip TestCommittedIdsUnique
 *  failing on a committed repeat): uniqueRowIds is the safety net, keeping a
 *  repeated row once and giving a different one an occurrence id, since
 *  every list here is keyed by the id and the index would keep only the
 *  last row of it. */
function publishObstacles(): Obstacle[] {
	const o = uniqueRowIds(storeRows(obstacleStore).flat());
	obstacles = o;
	 
	obstacleIndex = new Map(o.map((ob) => [ob.id, ob]));
	dataState.obstaclesLoaded = true;
	dataState.obstaclesLoading = false;
	dataState.obstaclesError = null;
	dataState.revision.obstacles++;
	return o;
}

/** The obstacles, loading them if nothing has yet; a failed first load
 *  answers its failure until its retry, as ensureAirports does. */
export function ensureObstacles(): Promise<Obstacle[]> {
	if (obstacles) {
		return Promise.resolve(obstacles);
	}
	if (obstaclesPromise) {
		return obstaclesPromise;
	}
	const refused = retryRefusal('obstacles');
	if (refused) {
		return Promise.reject(refused);
	}
	return firstObstacles(false);
}

function firstObstacles(retrying: boolean): Promise<Obstacle[]> {
	if (!retrying) {
		dataState.obstaclesLoading = true;
		dataState.obstaclesError = null;
	}
	obstaclesPromise = (async () => {
		// IDs are namespaced by country prefix at emit time; a publisher's
		// own repeats are resolved at publish. cmd/es/obstacles.go applies a 30 m AGL height
		// threshold (matching SIA's de facto floor + ICAO Annex 15
		// Area 2), keeping the Spain file in line with FR / UK
		// payloads; cmd/de ships the DFS eTOD Area 1 set (>100 m).
		await fillStore(obstacleStore, 'all');
		const gaps = storeGaps(obstacleStore);
		firstVerdict(gaps, false, obstacleStore);
		reportGaps('obstacles', gaps, retryObstaclesPart);
		return publishObstacles();
	})().catch((e: unknown) => {
		reportFailure('obstacles', e, retryObstacles);
		dataState.obstaclesError = message(e);
		dataState.obstaclesLoading = false;
		obstaclesPromise = null;
		throw e;
	});
	return obstaclesPromise;
}

async function widenObstacles(reread: Reread): Promise<void> {
	const grew = await fillStore(obstacleStore, reread);
	reportGaps('obstacles', storeGaps(obstacleStore), retryObstaclesPart);
	if (grew) {
		publishObstacles();
	}
}

function retryObstacles(): Promise<unknown> {
	return obstacles ? widenObstacles('all') : (obstaclesPromise ?? firstObstacles(true));
}

function retryObstaclesPart(part: string): Promise<unknown> {
	return obstacles ? widenObstacles(new Set([part])) : (obstaclesPromise ?? firstObstacles(true));
}

export function selectedObstacle(): Obstacle | null {
	if (ui.detail?.kind !== 'obstacle') {
		return null;
	}
	// Track every publish so the DetailPanel $derived re-runs once the obstacle
	// dataset lands, first load and late countries alike (obstacleIndex is a
	// plain, non-reactive ref).
	void dataState.revision.obstacles;
	return obstacleIndex?.get(ui.detail.id) ?? null;
}

/** Obstacle row by dataset id (null before the lazy dataset arrives).
 *  Tracks every publish like selectedObstacle so deriveds re-run on
 *  arrival, a late country's included. */
export function obstacleById(id: string): Obstacle | null {
	void dataState.revision.obstacles;
	return obstacleIndex?.get(id) ?? null;
}

/* ---- navaids ---- */

export function getNavaids(): Navaid[] | null {
	void dataState.revision.navaids;
	return navaids;
}

const NAVAID_SOURCES = countrySources<Navaid>('navaids', (url) => loadNavaids(url), {
	fr: {
		country: 'fr',
		meta: loadNavaidsMeta, nextMeta: loadNavaidsNextMeta,
		url: NAVAIDS_URL, nextUrl: NAVAIDS_NEXT_URL,
		load: loadNavaids,
	},
	faa: {
		country: 'faa',
		meta: loadFaaNavaidsMeta, nextMeta: loadFaaNavaidsNextMeta,
		url: FAA_NAVAIDS_URL, nextUrl: FAA_NAVAIDS_NEXT_URL,
		load: loadNavaids,
	},
});

const navaidStore = countryStore<Navaid>('navaids', NAVAID_SOURCES);

/** Concatenate the loaded country rows and publish. Re-runnable: the
 *  coverage gate can bring a country in after the first load. Ids are
 *  namespaced by publisher at emit time, so two countries never share one,
 *  and the builders now write each id once (the FAA's 87 repeats, the two
 *  NDBs under faa:NDB:AA carrying their GLOBAL_ID, internal/aip
 *  TestCommittedIdsUnique failing on a committed repeat): uniqueRowIds is
 *  the safety net, keeping a repeated row once and giving a different one an
 *  occurrence id, since every list here is keyed by the id and the index
 *  would keep only the last row of it. */
function publishNavaids(): Navaid[] {
	const n = uniqueRowIds(storeRows(navaidStore).flat());
	navaids = n;
	 
	navaidIndex = new Map(n.map((nv) => [nv.id, nv]));
	dataState.navaidsLoaded = true;
	dataState.navaidsLoading = false;
	dataState.navaidsError = null;
	dataState.revision.navaids++;
	return n;
}

/** The navaids, loading them if nothing has yet; a failed first load
 *  answers its failure until its retry, as ensureAirports does. */
export function ensureNavaids(): Promise<Navaid[]> {
	if (navaids) {
		return Promise.resolve(navaids);
	}
	if (navaidsPromise) {
		return navaidsPromise;
	}
	const refused = retryRefusal('navaids');
	if (refused) {
		return Promise.reject(refused);
	}
	return firstNavaids(false);
}

function firstNavaids(retrying: boolean): Promise<Navaid[]> {
	if (!retrying) {
		dataState.navaidsLoading = true;
		dataState.navaidsError = null;
	}
	navaidsPromise = (async () => {
		// IDs are namespaced by country prefix at emit time (FR uses
		// "<Type>:<mid>", UK / ES / DE / AT use "uk:" / "es:" / "de:" /
		// "at:"), so countries concat as they are; a publisher's own repeats
		// are resolved at publish.
		await fillStore(navaidStore, 'all');
		const gaps = storeGaps(navaidStore);
		firstVerdict(gaps, false, navaidStore);
		reportGaps('navaids', gaps, retryNavaidsPart);
		return publishNavaids();
	})().catch((e: unknown) => {
		reportFailure('navaids', e, retryNavaids);
		dataState.navaidsError = message(e);
		dataState.navaidsLoading = false;
		navaidsPromise = null;
		throw e;
	});
	return navaidsPromise;
}

async function widenNavaids(reread: Reread): Promise<void> {
	const grew = await fillStore(navaidStore, reread);
	reportGaps('navaids', storeGaps(navaidStore), retryNavaidsPart);
	if (grew) {
		publishNavaids();
	}
}

function retryNavaids(): Promise<unknown> {
	return navaids ? widenNavaids('all') : (navaidsPromise ?? firstNavaids(true));
}

function retryNavaidsPart(part: string): Promise<unknown> {
	return navaids ? widenNavaids(new Set([part])) : (navaidsPromise ?? firstNavaids(true));
}

export function selectedNavaid(): Navaid | null {
	if (ui.detail?.kind !== 'navaid') {
		return null;
	}
	// Track every publish so the DetailPanel $derived re-runs once the navaid
	// dataset lands, first load and late countries alike (navaidIndex is a
	// plain, non-reactive ref).
	void dataState.revision.navaids;
	return navaidIndex?.get(ui.detail.id) ?? null;
}

/** Lookup by raw id, for the detail panel's "Back to navaid X" label
 *  (navaid ids like "DME:1527279" aren't user-facing; callers show the
 *  resolved ident instead). */
export function navaidById(id: string): Navaid | null {
	void dataState.revision.navaids;
	return navaidIndex?.get(id) ?? null;
}

/* ---- Nature zones (FR PRN parks / réserves + SUR sensitive sites) ---- */

export function getNature(): Nature[] | null {
	void dataState.revision.nature;
	return nature;
}

const NATURE_SOURCES = countrySources<Nature>('nature', (url) => loadNature(url), {
	fr: {
		country: 'fr',
		meta: loadNatureMeta, nextMeta: loadNatureNextMeta,
		url: NATURE_URL, nextUrl: NATURE_NEXT_URL,
		load: loadNature,
	},
});

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
	dataState.natureError = null;
	dataState.revision.nature++;
	return n;
}

/** Re-run the coverage gate for every dataset something has asked for and
 *  load whatever the current areas now want, republishing the ones that
 *  grew.
 *
 *  The gate only ever WIDENS what is loaded: a dataset nothing has asked
 *  for stays unloaded, so this never starts a fetch on its own. One whose
 *  first load is still running is waited for rather than skipped: the
 *  first load judged the gate once, and an area that moved during it (the
 *  map settling on a restored view, a plan restoring into an empty
 *  workspace) would otherwise wait for the next move. A country whose read
 *  failed is left to its retry (state/dataRetry.svelte.ts), and a first
 *  load that failed too. */
export async function extendCoverage(): Promise<void> {
	await Promise.all([
		widen(airportsPromise, () => widenAirports(null)),
		widen(airspacesPromise, () => widenAirspaces(null)),
		widen(obstaclesPromise, () => widenObstacles(null)),
		widen(navaidsPromise, () => widenNavaids(null)),
		widen(naturePromise, () => widenNature(null)),
		// SUP AIP loads whole, but whether a publisher it lacks matters is
		// judged on the coverage, which just moved.
		supaips ? Promise.resolve(reportGaps('supaip', supaipGaps(), retrySupaipPart)) : Promise.resolve(),
	]);
}

/** Widen one dataset: behind its first load, never instead of one. A
 *  dataset nothing asked for (no first load) is left alone, and so is one
 *  whose first load failed, for its ensure to report and its retry to read
 *  again. A widening reports its own gaps to the retry. */
async function widen(first: Promise<unknown> | null, run: () => Promise<void>): Promise<void> {
	if (!first) {
		return;
	}
	try {
		await first;
	} catch {
		return;
	}
	await run().catch((e: unknown) => {
		// Each part keeps its own failure: a rejection here is a
		// programming error, said and not swallowed.
		console.error(e);
	});
}

/** Widen what is loaded whenever the areas of interest or the forced
 *  publishers change. Call from a component that lives as long as the map
 *  (MapView, NotamMapView): it registers an $effect, torn down with it. The
 *  two reads are the whole subscription; extendCoverage runs untracked, its
 *  own reads being none of this effect's business. */
export function watchCoverage(): void {
	$effect(() => {
		void coverageAreas();
		void coverage.forced;
		untrack(() => {
			void extendCoverage();
		});
	});
}

/** The nature zones, loading them if nothing has yet; a failed first load
 *  answers its failure until its retry, as ensureAirports does. */
export function ensureNature(): Promise<Nature[]> {
	if (nature) {
		return Promise.resolve(nature);
	}
	if (naturePromise) {
		return naturePromise;
	}
	const refused = retryRefusal('nature');
	if (refused) {
		return Promise.reject(refused);
	}
	return firstNature(false);
}

function firstNature(retrying: boolean): Promise<Nature[]> {
	if (!retrying) {
		dataState.natureLoading = true;
		dataState.natureError = null;
	}
	naturePromise = (async () => {
		// Dual-AIRAC like the primary datasets: pick the current or next slot
		// by effective date once per publisher (FR PRN/SUR + BE bird areas),
		// then concatenate.
		await fillStore(natureStore, 'all');
		const gaps = storeGaps(natureStore);
		firstVerdict(gaps, false, natureStore);
		reportGaps('nature', gaps, retryNaturePart);
		return publishNatures();
	})().catch((e: unknown) => {
		reportFailure('nature', e, retryNature);
		dataState.natureError = message(e);
		dataState.natureLoading = false;
		naturePromise = null;
		throw e;
	});
	return naturePromise;
}

async function widenNature(reread: Reread): Promise<void> {
	const grew = await fillStore(natureStore, reread);
	reportGaps('nature', storeGaps(natureStore), retryNaturePart);
	if (grew) {
		publishNatures();
	}
}

function retryNature(): Promise<unknown> {
	return nature ? widenNature('all') : (naturePromise ?? firstNature(true));
}

function retryNaturePart(part: string): Promise<unknown> {
	return nature ? widenNature(new Set([part])) : (naturePromise ?? firstNature(true));
}

export function selectedNature(): Nature | null {
	if (ui.detail?.kind !== 'nature') {
		return null;
	}
	// Track every publish so the DetailPanel $derived re-runs once the dataset
	// lands, first load and late countries alike (natureIndex is a plain,
	// non-reactive ref).
	void dataState.revision.nature;
	return natureIndex?.get(ui.detail.id) ?? null;
}

export function natureById(id: string): Nature | null {
	void dataState.revision.nature;
	return natureIndex?.get(id) ?? null;
}

/* ---- SUP AIP ---- */

export function getSupaips(): SupAip[] | null {
	void dataState.revision.supaip;
	return supaips;
}

export function supaipById(id: string): SupAip | null {
	void dataState.revision.supaip;
	return supaipIndex?.get(id) ?? null;
}

/** Look up a SUP AIP by the number/year a NOTAM cites (e.g. "AIP SUP
 *  080/2026", or the bare "SUP 149/26" Spanish NOTAMs use). Returns null
 *  until the dataset loads.
 *
 *  Keyed by PUBLISHER because the citation namespaces collide: every
 *  publisher numbers its supplements NNN/YYYY from one, as do France's
 *  own overseas regions, so an index over all of them would answer a
 *  French NOTAM with a Spanish supplement. The default keeps every
 *  existing French call site unchanged. */
export function supaipByRef(
	number: number,
	year: number,
	publisher: SupAipPublisher = 'fr',
): SupAip | null {
	void dataState.revision.supaip;
	return supaipRefIndex?.get(`${publisher}:${year}/${number}`) ?? null;
}

export function selectedSupaip(): SupAip | null {
	if (ui.detail?.kind !== 'supaip') {
		return null;
	}
	void dataState.revision.supaip;
	return supaipIndex?.get(ui.detail.id) ?? null;
}

/** Lazily load the SUP AIP dataset: one plain file per publisher (no AIRAC
 *  slot), each supplement carrying its own validity window, filtered by
 *  visibleSupaips. A first load that failed answers its failure until its
 *  retry, as ensureAirports does. */
export function ensureSupaip(): Promise<SupAip[]> {
	if (supaips) {
		return Promise.resolve(supaips);
	}
	if (supaipPromise) {
		return supaipPromise;
	}
	const refused = retryRefusal('supaip');
	if (refused) {
		return Promise.reject(refused);
	}
	return firstSupaip(false);
}

/** Read each publisher whose file has not answered yet, alone: a fetch of
 *  one that was never cached (offline after an update added a publisher)
 *  must not sink the others. A failure, whatever it is, waits in
 *  supaipFailed for its retry (`reread`): never an empty list, which the
 *  briefing read as "no supplement in force". */
async function readSupaipSources(reread: Reread): Promise<boolean> {
	const pending = SUPAIP_SOURCES.filter(
		(s) => !supaipParts.has(s.url) && (!supaipFailed.has(s.url) || rereads(reread, s.publisher)),
	);
	const settled = await Promise.allSettled(pending.map((s) => loadSupAip(s.url)));
	let grew = false;
	pending.forEach((s, i) => {
		const r = settled[i];
		if (r.status === 'fulfilled') {
			supaipParts.set(s.url, r.value);
			supaipFailed.delete(s.url);
			grew = true;
		} else {
			supaipFailed.set(s.url, asError(r.reason));
		}
	});
	return grew;
}

/** The SUP AIP publishers still missing, each mattering where its own
 *  territory meets the coverage. */
function supaipGaps(): RetryPart[] {
	return SUPAIP_SOURCES.flatMap((s) => {
		const error = supaipFailed.get(s.url);
		return error
			? [
					{
						part: s.publisher,
						error,
						wanted: publisherInCoverage(s.publisher),
						judge: () => untrack(() => publisherInCoverage(s.publisher)),
					},
				]
			: [];
	});
}

function publishSupaips(): SupAip[] {
	const list = SUPAIP_SOURCES.flatMap((s) => supaipParts.get(s.url) ?? []);
	supaips = list;
	supaipIndex = new Map(list.map((s) => [s.id, s]));
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
	const refs = new Map<string, SupAip>();
	for (const s of list) {
		const pub = supaipPublisherOf(s);
		if (pub && Number.isFinite(s.number) && Number.isFinite(s.year)) {
			refs.set(`${pub}:${s.year}/${s.number}`, s);
		}
	}
	supaipRefIndex = refs;
	dataState.supaipLoaded = true;
	dataState.supaipLoading = false;
	dataState.supaipError = null;
	dataState.revision.supaip++;
	return list;
}

function firstSupaip(retrying: boolean): Promise<SupAip[]> {
	if (!retrying) {
		dataState.supaipLoading = true;
		dataState.supaipError = null;
	}
	supaipPromise = (async () => {
		// Meta is loaded for provenance (About panel); a failure is non-fatal.
		await Promise.all(SUPAIP_SOURCES.map((s) => s.meta().catch(() => null)));
		await readSupaipSources('all');
		// Only every publisher failing is the dataset failing, and then with
		// a failure that may pass when there is one, as firstVerdict rules
		// for the country datasets: the first in source order could be a
		// fact, holding the whole dataset for the longest wait and announcing
		// it at once while the others were due in seconds.
		const failures = [...supaipFailed.values()];
		if (supaipParts.size === 0 && failures.length > 0) {
			throw failures.find(isTransient) ?? failures[0];
		}
		reportGaps('supaip', supaipGaps(), retrySupaipPart);
		return publishSupaips();
	})().catch((e: unknown) => {
		reportFailure('supaip', e, retrySupaip);
		dataState.supaipError = message(e);
		dataState.supaipLoading = false;
		supaipPromise = null;
		throw e;
	});
	return supaipPromise;
}

/** Read the publishers that failed again, and republish what landed. */
async function widenSupaip(reread: Reread): Promise<void> {
	const grew = await readSupaipSources(reread);
	reportGaps('supaip', supaipGaps(), retrySupaipPart);
	if (grew) {
		publishSupaips();
	}
}

function retrySupaip(): Promise<unknown> {
	return supaips ? widenSupaip('all') : (supaipPromise ?? firstSupaip(true));
}

function retrySupaipPart(part: string): Promise<unknown> {
	return supaips ? widenSupaip(new Set([part])) : (supaipPromise ?? firstSupaip(true));
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
	ensureAipCharts,
	aipLinksForIdent,
} from './adCharts.svelte';
export {
	ensureAerodromeFuel,
	fuelForIdent,
	aerodromeFuelState,
} from './aerodromeFuel.svelte';
export {
	fuelNotamIdents,
	resolveAerodromeFuel,
	fuelNoteKey,
	fuelNoteText,
} from './fuelOverride.svelte';
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
	// Track every publish so the DetailPanel $derived re-runs once the airspace
	// dataset lands, first load and late countries alike (airspaceIndex is a
	// plain, non-reactive ref).
	void dataState.revision.airspaces;
	return airspaceIndex?.get(ui.detail.key) ?? null;
}

/** Airspace row by key (id|name; null before the dataset arrives). Tracks
 *  every publish like selectedAirspace so deriveds re-run on arrival, a late
 *  country's included. */
export function airspaceByKey(key: string): Airspace | null {
	void dataState.revision.airspaces;
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

/** The stores by dataset, for the heartbeat: which countries this session
 *  loaded, and where to read their next sidecar again. */
const STORES: Readonly<
	Record<
		AiracDataset,
		{
			rows: ReadonlyMap<AiracCountry, unknown>;
			sources: readonly { country: AiracCountry; nextMeta: CountrySource<unknown>['nextMeta'] }[];
		}
	>
> = {
	airports: airportStore,
	airspaces: airspaceStore,
	obstacles: obstacleStore,
	navaids: navaidStore,
	nature: natureStore,
};

/** Has this dataset been published? A first load that failed can leave
 *  countries in its store that nothing shows. */
function published(dataset: AiracDataset): boolean {
	switch (dataset) {
		case 'airports':
			return dataState.airportsLoaded;
		case 'airspaces':
			return dataState.airspacesLoaded;
		case 'obstacles':
			return dataState.obstaclesLoaded;
		case 'navaids':
			return dataState.navaidsLoaded;
		case 'nature':
			return dataState.natureLoaded;
	}
}

/** Would the slot picker now choose another file for a country this session
 *  LOADED, in a dataset it published? Only a file on screen can be
 *  superseded under the pilot: a country the coverage never wanted has a
 *  cell too (the About dialog reports the whole fleet), and when it is first
 *  wanted it loads whichever file is in force then, so a reload would change
 *  nothing for it. Reads the revisions, so a reactive caller also re-runs
 *  when a country is published. */
export function airacSwitchDue(now: Date): boolean {
	for (const dataset of AIRAC_DATASETS) {
		void dataState.revision[dataset];
		if (!published(dataset)) {
			continue;
		}
		for (const country of STORES[dataset].rows.keys()) {
			const cell = dataState.airac[dataset][country];
			if (cell && wouldSwitch(cell.effective, cell.nextEffective, cell.slot, now)) {
				return true;
			}
		}
	}
	return false;
}

/** Read again the next sidecar of a loaded country whose next sidecar did
 *  not answer when it was stamped: an unknown next cycle, where "none" never
 *  asked for the reload that cycle brings once in force. A few hundred
 *  bytes, once a minute, only while one is unknown. */
async function refreshUnreadNext(): Promise<void> {
	for (const cell of [...nextUnread]) {
		const [dataset, country] = cell.split(':') as [AiracDataset, AiracCountry];
		const store = STORES[dataset];
		const source = store.sources.find((s) => s.country === country);
		if (!source || !store.rows.has(country)) {
			continue;
		}
		const { meta, failed } = await readSidecar(source.nextMeta);
		const slot = dataState.airac[dataset][country];
		if (!failed && slot) {
			nextUnread.delete(cell);
			slot.nextEffective = meta?.effective ?? null;
		}
	}
}

$effect.root(() => {
	$effect(() => {
		// Track the tick so this effect re-runs once a minute.
		void notamState.tick;
		const now = new Date();
		if (nextUnread.size > 0) {
			untrack(() => {
				void refreshUnreadNext();
			});
		}
		// Any loaded file superseded flips airacSwitchPending; the banner
		// asks the user to reload.
		dataState.airacSwitchPending = airacSwitchDue(now);
		dataState.dataExpired = dataExpired(__DATA_VALID_UNTIL__, now.getTime());
	});
});
