/* The aerodrome fuel dataset: lazily loaded, slot-picked, fail-soft.
 *
 * FR-only, like the facilities dataset it half comes from, and gated on the
 * publisher for the same reason: opening a German aerodrome's panel must not
 * fetch a French dataset. The gate is the airport row's `source`, so a
 * French field the AIXM merge did not reach keeps its OurAirports row and no
 * fuel, which is the same answer the AD 2 directory gives it.
 *
 * The index is a plain non-reactive Map behind a reactive `loaded` flag, the
 * house idiom for a dataset whose rows never change after they arrive. */

import {
	FR_FUEL_NEXT_URL,
	FR_FUEL_URL,
	loadFrFuel,
	type AerodromeFuel,
} from '$lib/data/fuel';
import { loadActiveSlot, loadFrFuelMeta, loadFrFuelNextMeta } from '$lib/data/meta';
import { retryAfterFailure, retryCleared, retryRefusal } from '$lib/state/dataRetry.svelte';

export const aerodromeFuelState = $state<{
	loaded: boolean;
	loading: boolean;
	error: string | null;
}>({ loaded: false, loading: false, error: null });

let rows: AerodromeFuel[] | null = null;
// A plain index behind the reactive `loaded` flag, the house idiom for a
// dataset whose rows never change after they arrive.
let index: Map<string, AerodromeFuel> | null = null;
let promise: Promise<AerodromeFuel[]> | null = null;

function message(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** Whether this publisher has a fuel dataset at all. Only France publishes
 *  the AD 2.4 prose this is read from. */
function hasFuel(source: string | null | undefined): boolean {
	return source === 'fr';
}

/** Load the dataset once. Idempotent. A read that failed for a reason that
 *  may pass is read again by the retry schedule (state/dataRetry.svelte.ts)
 *  and, until then, answered with its failure whoever asks; an open panel
 *  fills in when the retry lands. */
export function ensureAerodromeFuel(
	source: string | null | undefined
): Promise<AerodromeFuel[]> {
	if (!hasFuel(source)) {
		return Promise.resolve([]);
	}
	if (rows) {
		return Promise.resolve(rows);
	}
	if (promise) {
		return promise;
	}
	const refused = retryRefusal('fuel');
	if (refused) {
		return Promise.reject(refused);
	}
	return startFuel(false);
}

function retryFuel(): Promise<unknown> {
	// Loaded, the retry clears its key (the chart sets' rule).
	if (rows) {
		retryCleared('fuel');
		return Promise.resolve();
	}
	return promise ?? startFuel(true);
}

function startFuel(retrying: boolean): Promise<AerodromeFuel[]> {
	if (!retrying) {
		aerodromeFuelState.loading = true;
		aerodromeFuelState.error = null;
	}
	promise = (async () => {
		const list = await loadActiveSlot(loadFrFuelMeta, loadFrFuelNextMeta, FR_FUEL_URL, FR_FUEL_NEXT_URL, (url) =>
			loadFrFuel(url),
		);
		const byIdent = new Map(list.map((f) => [f.ident.toUpperCase(), f]));
		retryCleared('fuel');
		rows = list;
		index = byIdent;
		aerodromeFuelState.loaded = true;
		aerodromeFuelState.loading = false;
		aerodromeFuelState.error = null;
		return list;
	})().catch((e: unknown) => {
		retryAfterFailure('fuel', 'fuel', e, retryFuel);
		aerodromeFuelState.error = message(e);
		aerodromeFuelState.loading = false;
		promise = null;
		throw e;
	});
	return promise;
}

/** One aerodrome's fuel entry, or null: a publisher with no dataset, an
 *  aerodrome the AIP says nothing about, or the dataset still loading. All
 *  three read the same to a caller, and all three mean 'show nothing'.
 *
 *  Reads `loaded` so a $derived re-runs when the rows arrive. */
export function fuelForIdent(
	ident: string,
	source: string | null | undefined
): AerodromeFuel | null {
	void aerodromeFuelState.loaded;
	if (!hasFuel(source)) {
		return null;
	}
	return index?.get(ident.toUpperCase()) ?? null;
}
