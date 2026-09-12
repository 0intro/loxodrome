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
import {
	loadFrFuelMeta,
	loadFrFuelNextMeta,
	pickActiveDataset,
} from '$lib/data/meta';

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

/** Load the dataset once. Idempotent; a failure clears the promise so a
 *  later panel retries rather than leaving every aerodrome blank. */
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
	aerodromeFuelState.loading = true;
	aerodromeFuelState.error = null;
	promise = (async () => {
		const [meta, nextMeta] = await Promise.all([
			loadFrFuelMeta().catch(() => null),
			loadFrFuelNextMeta().catch(() => null),
		]);
		const { url } = pickActiveDataset(
			meta?.effective ?? null,
			nextMeta?.effective ?? null,
			FR_FUEL_URL,
			FR_FUEL_NEXT_URL,
			// A one-shot timestamp passed by value, the chartSet idiom.
			// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
			new Date(),
		);
		const list = await loadFrFuel(url);
		rows = list;
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a plain index, see above
		index = new Map(list.map((f) => [f.ident.toUpperCase(), f]));
		aerodromeFuelState.loaded = true;
		aerodromeFuelState.loading = false;
		return list;
	})().catch((e: unknown) => {
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
