/* Route-corridor terrain pins: the reactive face over the pure enumeration
 * (offline/terrainPin.ts) and the pinned tile store (offline/passiveStore.ts);
 * contract in docs/offline-maps.md. One action pins every terrain tile
 * inside the PLAN's corridors (all routes, the NOTAM-corridor union grammar)
 * so the vertical profile, min-alt, MSA, AGL limits and the alerts' terrain
 * clamp keep answering offline. Replace semantics: a completed download
 * leaves the pin set exactly equal to the current plan's corridor (old pins
 * outside it are dropped ONLY on success; a cancel keeps everything pinned
 * so far). The sweep is a job on the one offline queue
 * (state/offlineQueue.svelte.ts), so it no longer runs six tile fetches
 * alongside a gigabyte archive stream the way it used to. Errors are CODES
 * for the catalogs. */

import { routes, routeSettings } from '$lib/state/route.svelte';
import { ensureTerrainRegions, terrainLevels, tileUrl } from '$lib/map/terrain';
import { corridorTerrainLevels } from '$lib/route/minAltitude';
import {
	computePinOps,
	corridorTerrainTiles,
	estimateBytes,
	type LatLonPoint,
} from '$lib/offline/terrainPin';
import { TERRAIN_JOB_ID, type JobRef } from '$lib/offline/downloadQueue';
import {
	cancelDownload,
	enqueueDownload,
	isQueued,
	isRunning,
	queuedAt,
} from '$lib/state/offlineQueue.svelte';
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

/** The terrain pin's job on the offline queue. One plan, one pin set, so one
 *  id: a second tap while it waits folds into the job already queued. */
const JOB: JobRef = { kind: 'terrain', id: TERRAIN_JOB_ID };

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

/** INTERNAL: the pin sweep itself, run by the offline queue's drain.
 *
 *  The payload is enumerated HERE, when the job runs, and deliberately not
 *  captured when it was queued. The mechanism's contract is that a completed
 *  run leaves the pin set exactly equal to the CURRENT plan's corridors,
 *  stale pins dropped; a job that had snapshotted its tiles behind a 25 GB
 *  chart would pin a route the pilot has since abandoned and then drop the
 *  pins of the one they are actually flying. That is not a stale download,
 *  it is an active deletion of the right data. */
async function runTerrainPins(
	signal: AbortSignal,
	onProgress: (fraction: number) => void,
): Promise<void> {
	// The pin must name the urls the reader will ask for, so the source has
	// to be resolved before they are built.
	await ensureTerrainRegions();
	const tiles = corridorTerrainTiles(planRoutePoints(), pinRadiusNM(), pinLevels());
	if (tiles.length === 0) {
		// The route was cleared while the job waited its turn. Nothing to
		// pin, and nothing to drop: the correct answer, not a failure.
		return;
	}
	const target = tiles.map((t) => tileUrl(t.z, t.x, t.y));
	const existing = await pinnedKeys();
	const { toFetch, toDrop } = computePinOps(existing, target);

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
				onProgress(offlineTerrain.progress);
			}
		}
	};
	// The queue serialises JOBS, not the fetches within one: six tile
	// requests are not the harm the sequencing rule exists to prevent, which
	// is two multi-gigabyte streams competing for one link.
	await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, worker));

	const completed = !signal.aborted && failed === 0;
	if (completed) {
		// Replace semantics only on full success: a cancelled or degraded run
		// never drops the previous plan's pins.
		await pinnedDrop(toDrop);
	}
	offlineTerrain.status = 'idle';
	await refreshStats();
	if (!completed && !signal.aborted) {
		offlineTerrain.status = 'error';
		offlineTerrain.error = 'download';
	}
}

/** Ask for this plan's terrain. Enqueues and returns at once, so it can be
 *  asked for beside a chart pack rather than racing one, which is what it
 *  did before the queue existed. */
export function downloadTerrainPins(): void {
	if (!supported()) {
		offlineTerrain.status = 'error';
		offlineTerrain.error = 'unsupported';
		return;
	}
	offlineTerrain.error = null;
	enqueueDownload(JOB, {
		// Provisional, and re-derived live by the rows: the plan may be
		// edited while the job waits, and the enumeration above is what
		// finally decides. estimateBytes is a 50 kB/tile figure, so it feeds
		// the queue's total and nothing that could refuse.
		sizeBytes: estimateBytes(plannedTileCount()),
		localBytes: 0,
		run: runTerrainPins,
	});
}

/** Tiles this plan would pin right now, for the button's own estimate. */
export function plannedTileCount(): number {
	return corridorTerrainTiles(planRoutePoints(), pinRadiusNM(), pinLevels()).length;
}

export function terrainPinQueued(): boolean {
	return isQueued(JOB);
}

export function terrainPinRunning(): boolean {
	return isRunning(JOB);
}

export function terrainPinQueuePosition(): number {
	return queuedAt(JOB);
}

/** Stop the pin sweep: an abort while it runs, a plain removal while it
 *  waits. */
export function cancelTerrainPins(): void {
	cancelDownload(JOB);
}

export async function removeTerrainPins(): Promise<void> {
	cancelTerrainPins();
	const keys = await pinnedKeys();
	await pinnedDrop([...keys]);
	offlineTerrain.error = null;
	await refreshStats();
}
