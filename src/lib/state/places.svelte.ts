/* The place names the search and the position reading read
 * (docs/places.md, docs/search.md "Towns"), loaded per country by area as
 * the national datasets are: the index (places.meta.json) is every country
 * file's sidecar, its boxes what the coverage gate judges
 * (coverageReaches), and "Search all countries" wants every file. A country
 * that fails is retried on the one schedule (group `places`), the others
 * published around it; an index the deployment does not hold is no places.
 * Nothing in the NOTAM Viewer asks for them. */

import { untrack } from 'svelte';
import { isTransient } from '$lib/data/fetchData';
import { loadPlacesMeta } from '$lib/data/meta';
import { loadPlaces, type Place, type PlacesIndex } from '$lib/data/places';
import { coverage, coverageReaches, coverageStamp } from './coverage.svelte';
import type { PlaceTarget } from './ui.svelte';
import { retryAfterFailure, retryCleared, retryParts, retryRefusal, type RetryPart } from './dataRetry.svelte';

export const placesState = $state<{ loading: boolean; error: string | null; revision: number }>({
	loading: false,
	error: null,
	revision: 0,
});

let index: PlacesIndex | null = null;
// Per country, plain: the revision above is what readers track.
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- plain store, published through placesState.revision
const rows = new Map<string, Place[]>();
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- plain bookkeeping, reported to the retry schedule
const failed = new Map<string, Error>();
let places: Place[] | null = null;
let first: Promise<Place[]> | null = null;
let inflight: Promise<void> | null = null;
// The coverage stamp the last pass judged at: a pass over an unchanged
// coverage costs nothing.
let judged: number | null = null;

/** Every loaded country's places, in the index's order; null before the
 *  first load answered. */
export function getPlaces(): Place[] | null {
	void placesState.revision;
	return places;
}

/** The countries whose places are loaded, in the index's order. */
export function loadedPlaceCountries(): string[] {
	void placesState.revision;
	return Object.keys(index?.countries ?? {}).filter((iso) => rows.has(iso));
}

/** Does a country's failure matter to the pilot: do the areas reach it?
 *  Never "Search all countries", which only widens what is read, so a far
 *  country that does not answer is retried quietly (docs/data-coverage.md). */
function matters(iso: string): boolean {
	const c = index?.countries[iso];
	return coverageReaches(c?.bbox, c?.bboxes);
}

/** Is a country's file to be read now? */
function wanted(iso: string): boolean {
	return coverage.searchAll || matters(iso);
}

/** Read every country the coverage wants and the store lacks: a failed one
 *  only when its retry asks (`reread`, 'all' for the first load). Serialised
 *  like the national stores' fillStore; says whether anything landed. */
async function fill(reread: 'all' | ReadonlySet<string> | null): Promise<boolean> {
	while (inflight) {
		await inflight.catch(() => {});
	}
	// Untracked: an ensure called from an effect runs this far
	// synchronously, and the stamp reads the coverage areas.
	if (reread === null && judged !== null && judged === untrack(coverageStamp)) {
		return false;
	}
	const before = rows.size;
	const run = (async () => {
		const stamp = untrack(coverageStamp);
		const countries = index?.countries ?? {};
		const todo = Object.keys(countries).filter(
			(iso) =>
				!rows.has(iso) &&
				untrack(() => wanted(iso)) &&
				(!failed.has(iso) || reread === 'all' || (reread !== null && reread.has(iso))),
		);
		const settled = await Promise.allSettled(todo.map((iso) => loadPlaces(iso, countries[iso].source === 'ign')));
		todo.forEach((iso, i) => {
			const r = settled[i];
			if (r.status === 'fulfilled') {
				rows.set(iso, r.value);
				failed.delete(iso);
			} else {
				failed.set(iso, r.reason instanceof Error ? r.reason : new Error(String(r.reason)));
			}
		});
		judged = stamp;
	})();
	inflight = run;
	try {
		await run;
	} finally {
		inflight = null;
	}
	return rows.size !== before;
}

function gaps(): RetryPart[] {
	return [...failed].map(([iso, error]) => ({
		part: iso,
		error,
		wanted: matters(iso),
		judge: () => untrack(() => matters(iso)),
	}));
}

/* Before the publish that follows, as the national stores report: an
 * effect the publish wakes must already find the refusal. */
function report(): void {
	retryCleared('places');
	retryParts('places', gaps(), retryPart);
}

function publish(): Place[] {
	const out: Place[] = [];
	for (const iso of Object.keys(index?.countries ?? {})) {
		for (const p of rows.get(iso) ?? []) {
			out.push(p);
		}
	}
	places = out;
	placesState.loading = false;
	placesState.error = null;
	placesState.revision++;
	return out;
}

/** The places, loading the countries the coverage wants if nothing has yet;
 *  a failed first load answers its failure until its retry. */
export function ensurePlaces(): Promise<Place[]> {
	if (places) {
		return Promise.resolve(places);
	}
	if (first) {
		return first;
	}
	const refused = retryRefusal('places');
	if (refused) {
		return Promise.reject(refused);
	}
	return firstPlaces(false);
}

function firstPlaces(retrying: boolean): Promise<Place[]> {
	if (!retrying) {
		placesState.loading = true;
		placesState.error = null;
	}
	first = (async () => {
		index = await loadPlacesMeta();
		await fill('all');
		const g = gaps();
		// Nothing answered at all: the whole load fails, soon retried when
		// the failure may pass (the national stores' first verdict).
		if (g.length > 0 && rows.size === 0) {
			throw (g.find((x) => isTransient(x.error)) ?? g[0]).error;
		}
		report();
		return publish();
	})().catch((e: unknown) => {
		retryAfterFailure('places', 'places', e, retryPlaces);
		placesState.error = e instanceof Error ? e.message : String(e);
		placesState.loading = false;
		first = null;
		throw e;
	});
	return first;
}

async function widen(reread: 'all' | ReadonlySet<string> | null): Promise<void> {
	const grew = await fill(reread);
	report();
	if (grew) {
		publish();
	}
}

function retryPlaces(): Promise<unknown> {
	return places ? widen('all') : (first ?? firstPlaces(true));
}

function retryPart(iso: string): Promise<unknown> {
	return places ? widen(new Set([iso])) : (first ?? firstPlaces(true));
}

/** Widen the loaded places to the coverage as it is now: behind the first
 *  load, never instead of one, and nothing when nothing asked for them
 *  (state/data.svelte.ts extendCoverage). */
export async function extendPlaces(): Promise<void> {
	if (!first) {
		return;
	}
	try {
		await first;
	} catch {
		return;
	}
	await widen(null);
}

/** A place as the detail's target (`selectPlace`). */
export function placeTarget(p: Place): Omit<PlaceTarget, 'kind'> {
	return {
		id: p.id,
		lat: p.lat,
		lon: p.lon,
		name: p.name,
		admin: p.admin || undefined,
		country: p.country,
		pop: p.pop,
		commune: p.commune,
	};
}
