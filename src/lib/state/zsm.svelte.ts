/* The raptor zones (ZSM) as the app holds them: the sidecar first, then the
 * zones while the areas the app is asked about meet the sidecar's envelope
 * (the coverage gate, datasets.md), lazily loaded and fail-soft. The rows
 * never change once they arrive: a plain index behind a reactive `loaded`
 * flag, the house idiom. */

import { loadZsm, zsmActiveIn, type Zsm } from '$lib/data/zsm';
import { loadZsmMeta, type ZsmMeta } from '$lib/data/meta';
import { pointInRing } from '$lib/data/airspaces';
import { coverageReaches, coverageStamp } from './coverage.svelte';
import { retryAfterFailure, retryCleared, retryRefusal } from './dataRetry.svelte';

export const zsmState = $state<{
	meta: ZsmMeta | null;
	loaded: boolean;
	loading: boolean;
	error: string | null;
}>({ meta: null, loaded: false, loading: false, error: null });

let rows: Zsm[] | null = null;
let index: Map<string, Zsm> | null = null;
let promise: Promise<Zsm[]> | null = null;
let metaAsked = false;

function message(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** Read the sidecar once. A sidecar that fails reads as none. */
export function ensureZsmMeta(): void {
	if (metaAsked) {
		return;
	}
	metaAsked = true;
	void loadZsmMeta()
		.then((m) => {
			zsmState.meta = m;
		})
		.catch(() => {
			zsmState.meta = null;
		});
}

/** Whether the areas the app is asked about reach the zones' envelope.
 *  Tracked: it reads the coverage's stamp and the sidecar. */
export function zsmWanted(): boolean {
	void coverageStamp();
	const m = zsmState.meta;
	return m !== null && coverageReaches(m.bbox);
}

/** Load the zones once. A read that failed for a reason that may pass is
 *  read again by the retry schedule, and until then answered with its
 *  failure whoever asks. */
export function ensureZsm(): Promise<Zsm[]> {
	if (rows) {
		return Promise.resolve(rows);
	}
	if (promise) {
		return promise;
	}
	const refused = retryRefusal('zsm');
	if (refused) {
		return Promise.reject(refused);
	}
	return start(false);
}

function retryZsm(): Promise<unknown> {
	if (rows) {
		retryCleared('zsm');
		return Promise.resolve();
	}
	return promise ?? start(true);
}

function start(retrying: boolean): Promise<Zsm[]> {
	if (!retrying) {
		zsmState.loading = true;
		zsmState.error = null;
	}
	promise = (async () => {
		const list = await loadZsm();
		retryCleared('zsm');
		rows = list;
		index = new Map(list.map((z) => [z.id, z]));
		zsmState.loaded = true;
		zsmState.loading = false;
		zsmState.error = null;
		return list;
	})().catch((e: unknown) => {
		retryAfterFailure('zsm', 'nature', e, retryZsm);
		zsmState.error = message(e);
		zsmState.loading = false;
		promise = null;
		throw e;
	});
	return promise;
}

/** Every zone, or null before they load. Tracked on `loaded`. */
export function zsmZones(): readonly Zsm[] | null {
	void zsmState.loaded;
	return rows;
}

export function zsmById(id: string): Zsm | null {
	void zsmState.loaded;
	return index?.get(id) ?? null;
}

/** The zones over a point, whatever the layer shows: the right-click
 *  menu's "what's here" list (links-and-toggles.md). */
export function zsmZonesAt(lat: number, lon: number): Zsm[] {
	void zsmState.loaded;
	return (rows ?? []).filter(
		(z) => lat >= z.bbox.minLat && lat <= z.bbox.maxLat && lon >= z.bbox.minLon && lon <= z.bbox.maxLon && pointInRing(lat, lon, z.ring),
	);
}

/** The zones active over a range: what the map draws. */
export function zsmActiveZones(fromMs: number, toMs: number): Zsm[] {
	void zsmState.loaded;
	return (rows ?? []).filter((z) => zsmActiveIn(z, fromMs, toMs));
}
