/* Route-corridor terrain pins: the reactive face over the pure enumeration
 * (offline/terrainPin.ts) and the pinned tile store (offline/passiveStore.ts);
 * contract in docs/offline-maps.md. One action pins every terrain tile
 * inside the PLAN's corridors (all routes, the NOTAM-corridor union grammar)
 * so the vertical profile, min-alt, MSA, AGL limits and the alerts' terrain
 * clamp keep answering offline. Replace semantics: a completed download
 * leaves the pin set exactly equal to the current plan's corridor (old pins
 * outside it are dropped ONLY on success; a cancel keeps everything pinned
 * so far). Errors are CODES for the catalogs. */

import { routes, routeSettings } from '$lib/state/route.svelte';
import { ensureTerrainRegions, terrainLevels, tileUrl } from '$lib/map/terrain';
import { corridorTerrainLevels } from '$lib/route/minAltitude';
import {
	computePinOps,
	corridorTerrainTiles,
	type LatLonPoint,
} from '$lib/offline/terrainPin';
import { lruPeek, pinnedDrop, pinnedKeys, pinnedPut, pinnedStats } from '$lib/offline/passiveStore';

export type TerrainPinError = 'download' | 'unsupported';

export const offlineTerrain = $state<{
	status: 'idle' | 'downloading' | 'ready' | 'error';
	/** 0..1 while downloading. */
	progress: number;
	count: number;
	bytes: number;
	/** Newest pin write, ms epoch; 0 when none. */
	newestTs: number;
	error: TerrainPinError | null;
}>({
	status: 'idle',
	progress: 0,
	count: 0,
	bytes: 0,
	newestTs: 0,
	error: null,
});

const FETCH_CONCURRENCY = 6;

let controller: AbortController | null = null;

function supported(): boolean {
	return typeof indexedDB !== 'undefined';
}

/** The plan's routes as bare point lists (legs need two waypoints). */
export function planRoutePoints(): LatLonPoint[][] {
	return routes.list
		.map((r) => r.waypoints.map((w) => ({ lat: w.lat, lon: w.lon })))
		.filter((pts) => pts.length >= 2);
}

/** The pin radius: the wider of the user's two corridor knobs, so the pin
 *  set covers both the NOTAM-relevance corridor and the min-alt swath. */
export function pinRadiusNM(): number {
	return Math.max(routeSettings.corridorRadiusNM, routeSettings.minAltCorridorRadiusNM);
}

/** The terrain LEVELS this plan will be read at, which is what the pin must
 *  hold: the deepest, for every point query (the ground under the aircraft,
 *  the profile's own line, an airspace floor), plus whatever coarser level
 *  each route's corridor reduction picks for its bins. Derived from
 *  `corridorPlan`, the same description the reduction runs on, so the two
 *  cannot drift into a pinned plan that answers "no data" in the air. */
export function pinLevels(): number[] {
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- transient level set, not state
	const zs = new Set<number>([terrainLevels().deepest]);
	for (const pts of planRoutePoints()) {
		for (const z of corridorTerrainLevels(pts, {
			halfWidthNM: routeSettings.minAltCorridorRadiusNM,
		})) {
			zs.add(z);
		}
	}
	return [...zs].sort((a, b) => a - b);
}

async function refreshStats(): Promise<void> {
	const s = await pinnedStats();
	offlineTerrain.count = s.count;
	offlineTerrain.bytes = s.bytes;
	offlineTerrain.newestTs = s.newestTs;
	if (offlineTerrain.status !== 'downloading') {
		offlineTerrain.status = s.count > 0 ? 'ready' : 'idle';
	}
}

let statsPromise: Promise<void> | null = null;

/** Boot reconcile: the status line is derived from the store itself (no
 *  localStorage; pins survive "Reset application" like the other offline
 *  stores). */
export function ensureTerrainPinStats(): Promise<void> {
	if (!supported()) {
		return Promise.resolve();
	}
	statsPromise ??= refreshStats();
	return statsPromise;
}

export async function downloadTerrainPins(): Promise<void> {
	if (offlineTerrain.status === 'downloading') {
		return;
	}
	if (!supported()) {
		offlineTerrain.status = 'error';
		offlineTerrain.error = 'unsupported';
		return;
	}
	// The pin must name the urls the reader will ask for, so the source has
	// to be resolved before they are built.
	await ensureTerrainRegions();
	const tiles = corridorTerrainTiles(planRoutePoints(), pinRadiusNM(), pinLevels());
	if (tiles.length === 0) {
		return;
	}
	const target = tiles.map((t) => tileUrl(t.z, t.x, t.y));
	const existing = await pinnedKeys();
	const { toFetch, toDrop } = computePinOps(existing, target);

	controller = new AbortController();
	const signal = controller.signal;
	offlineTerrain.status = 'downloading';
	offlineTerrain.error = null;
	offlineTerrain.progress = toFetch.length === 0 ? 1 : 0;

	let done = 0;
	let failed = 0;
	const queue = [...toFetch];
	const worker = async (): Promise<void> => {
		for (;;) {
			const url = queue.shift();
			if (url === undefined || signal.aborted) {
				return;
			}
			try {
				// The passive LRU may already hold the tile: promote without
				// a refetch.
				let blob = await lruPeek(url);
				if (!blob) {
					const res = await fetch(url, { signal });
					if (!res.ok) {
						failed++;
						continue;
					}
					blob = await res.blob();
				}
				await pinnedPut(url, blob);
			} catch {
				if (!signal.aborted) {
					failed++;
				}
			} finally {
				done++;
				offlineTerrain.progress = toFetch.length ? done / toFetch.length : 1;
			}
		}
	};
	await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, worker));

	const completed = !signal.aborted && failed === 0;
	if (completed) {
		// Replace semantics only on full success: a cancelled or degraded run
		// never drops the previous plan's pins.
		await pinnedDrop(toDrop);
	}
	controller = null;
	offlineTerrain.status = 'idle';
	await refreshStats();
	if (!completed && !signal.aborted) {
		offlineTerrain.status = 'error';
		offlineTerrain.error = 'download';
	}
}

export function cancelTerrainPins(): void {
	controller?.abort();
}

export async function removeTerrainPins(): Promise<void> {
	cancelTerrainPins();
	const keys = await pinnedKeys();
	await pinnedDrop([...keys]);
	offlineTerrain.error = null;
	await refreshStats();
}
