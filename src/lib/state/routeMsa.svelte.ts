/* Shared per-leg minimum safe altitudes (the routeTerrain.svelte.ts pattern).
 *
 * One MSA vector per route, computed once per (coordinates, corridor width,
 * flight rules) signature by the nav log's own recipe (computeMinAltitudes
 * over the corridor ground and the obstacles), and shared by every consumer
 * that prints or shows the figure: the nav log sheet's MSA column and the
 * in-flight band's "MSA leg" reading. Sharing one cache is what makes the
 * band and the sheet agree by construction; the print flows keep passing
 * their own prefetched vector (NavLogModal / PrintDoc's legMinFt), which
 * short-circuits this memo exactly as it short-circuited the sheet's effect,
 * so paper is untouched.
 *
 * Reactivity contract (routeTerrain's): `routeMsa.byRoute` is written only
 * here and only from settles or inside untrack(), so a host $effect calling
 * ensureRouteMsa never subscribes through the call; consumers read
 * routeMsaLegs() inside their own deriveds and re-run once per completed
 * computation. Altitude edits never recompute: the key is coordinates-only
 * plus the two inputs the margin depends on. */

import { untrack } from 'svelte';
import { isFresh, settleGuard } from './asyncCache';
import { terrainCoordsKey } from './routeTerrain.svelte';
import { ensureObstacles } from './data.svelte';
import { computeMinAltitudes } from '$lib/route/minAltitude';

export interface RouteMsaOpts {
	/** The min-altitude corridor half-width (NM), routeSettings.minAltCorridorRadiusNM. */
	halfWidthNM: number;
	/** VFR sets the 500 ft terrain margin, IFR 1000 / 2000 ft. */
	vfr: boolean;
}

export interface RouteMsaEntry {
	key: string;
	legs: (number | null)[];
	status: 'loading' | 'ready' | 'error';
}

export const routeMsa = $state<{ byRoute: Record<string, RouteMsaEntry> }>({ byRoute: {} });

function routeMsaKey(waypoints: { lat: number; lon: number }[], opts: RouteMsaOpts): string {
	return `${terrainCoordsKey(waypoints)}|${opts.halfWidthNM}|${opts.vfr ? 'vfr' : 'ifr'}`;
}

// Plain (non-reactive) bookkeeping; see the reactivity contract above.
const lastKey: Record<string, string> = {};
const aborts: Record<string, AbortController> = {};
const failedAtMs: Record<string, number> = {};
const FAIL_RETRY_MS = 60_000;

/** Start (or keep) the MSA computation for a route's current signature.
 *  Cheap when nothing changed; a change aborts the run in flight and
 *  restarts. Safe to call from host effects on every re-run. */
export function ensureRouteMsa(
	routeId: string,
	waypoints: { lat: number; lon: number }[],
	opts: RouteMsaOpts,
): void {
	if (waypoints.length < 2) {
		// A route cut back to one waypoint has no corridor left to read, and
		// the run in flight is over dead geometry: it would otherwise finish
		// the whole terrain pass and settle `ready` under a key no consumer
		// matches, leaving the sheet's spinner up for a route that is gone.
		aborts[routeId]?.abort();
		delete aborts[routeId];
		delete lastKey[routeId];
		delete failedAtMs[routeId];
		// untrack, like every other write to byRoute: a host $effect calls
		// this, and a bare delete would subscribe it to the very record the
		// call just changed (the contract at the head of this file).
		untrack(() => {
			delete routeMsa.byRoute[routeId];
		});
		return;
	}
	const key = routeMsaKey(waypoints, opts);
	if (lastKey[routeId] === key) {
		const failedAt = failedAtMs[routeId];
		if (failedAt === undefined || isFresh(failedAt, FAIL_RETRY_MS)) {
			return;
		}
	}
	lastKey[routeId] = key;
	delete failedAtMs[routeId];
	aborts[routeId]?.abort();
	const ctrl = new AbortController();
	aborts[routeId] = ctrl;
	const current = settleGuard(ctrl.signal, () => lastKey[routeId] === key);
	const pts = waypoints.map((w) => ({ lat: w.lat, lon: w.lon }));
	untrack(() => {
		// A retry of the same signature keeps its answer on show until the
		// new one lands: blanked each minute while a tile stays unreadable
		// (offline), the column would flicker rather than wait.
		const prev = routeMsa.byRoute[routeId];
		if (!(prev?.key === key && prev.status === 'ready')) {
			routeMsa.byRoute[routeId] = { key, legs: [], status: 'loading' };
		}
	});
	void ensureObstacles()
		.then((obstacles) =>
			computeMinAltitudes(pts, obstacles, {
				signal: ctrl.signal,
				halfWidthNM: opts.halfWidthNM,
				vfr: opts.vfr,
			}),
		)
		.then((legs) => {
			if (!current()) {
				return;
			}
			// A null leg lost a tile (a leg across the sea reads sea level): the
			// corridor settles rather than throws, so the failure retry is armed
			// here, and the next ensure past the cooldown asks the tile again
			// (the cache retries a failed tile after TILE_RETRY_MS). Settled
			// ready without it, the column stayed blank for the session.
			if (legs.some((l) => l == null)) {
				failedAtMs[routeId] = Date.now();
			}
			routeMsa.byRoute[routeId] = { key, legs, status: 'ready' };
		})
		.catch(() => {
			if (!current()) {
				return;
			}
			failedAtMs[routeId] = Date.now();
			routeMsa.byRoute[routeId] = { key, legs: [], status: 'error' };
		});
}

/** The route's per-leg MSAs (ft; null per leg where the corridor has no
 *  answer) when ready AND computed for the route's current signature; null
 *  otherwise. Reading this inside a $derived tracks the cache. */
export function routeMsaLegs(
	routeId: string,
	waypoints: { lat: number; lon: number }[],
	opts: RouteMsaOpts,
): (number | null)[] | null {
	const e = routeMsa.byRoute[routeId];
	if (!e || e.status !== 'ready') {
		return null;
	}
	return e.key === routeMsaKey(waypoints, opts) ? e.legs : null;
}

/** True while a computation for this route is running. */
export function routeMsaLoading(routeId: string): boolean {
	return routeMsa.byRoute[routeId]?.status === 'loading';
}

/** Drop the entries (and abort the runs) of routes that no longer exist.
 *  Takes the live id LIST, like its terrain sibling, so the one MapView
 *  effect that prunes both reads the same expression twice. */
export function pruneRouteMsa(liveIds: readonly string[]): void {
	// The key list is read untracked, and so are the deletes: the one MapView
	// effect that prunes both this and its terrain sibling would otherwise
	// subscribe to the record it is pruning and wake itself on its own write.
	// It converges (the second pass finds nothing left to delete), which is
	// what has kept it quiet; the sibling has always done it this way.
	for (const id of untrack(() => Object.keys(routeMsa.byRoute))) {
		if (!liveIds.includes(id)) {
			aborts[id]?.abort();
			delete aborts[id];
			delete lastKey[id];
			delete failedAtMs[id];
			untrack(() => {
				delete routeMsa.byRoute[id];
			});
		}
	}
}
