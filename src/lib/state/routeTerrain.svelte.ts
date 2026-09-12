/* Shared per-route terrain samples (the data.svelte.ts ensure-pattern).
 *
 * One centerline elevation profile per route, fetched once per coordinate
 * signature and shared by every consumer that wants exact AGL/ASFC
 * evaluation along the route: the nav-log airspace schedule, the "show
 * only route airspaces" map filter, the route vertical profile and the
 * flight-dossier print. Sharing one cache is what makes the schedule and
 * the profile agree by construction.
 *
 * Reactivity contract: `routeTerrain.byRoute` is written ONLY here, and
 * only inside untrack(), so a host $effect that calls ensureRouteTerrain
 * never subscribes to the cache through the call (the effect-writes-
 * subscribe footgun); consumers read it through routeTerrainSamples()
 * inside their own deriveds and re-run once per completed fetch. The
 * freshness / abort bookkeeping lives in plain module records, not in
 * reactive state, for the same reason.
 *
 * Altitude edits must not refetch: the key is coordinates-only (the same
 * signature RouteProfileModal and MapView already use). Pre-fetch, abort
 * and tile failure all surface as "no samples" (null), which the vertical
 * predicates treat conservatively, so terrain can only ever tighten the
 * result, never hide a zone. */

import { untrack } from 'svelte';
import { isFresh, settleGuard } from './asyncCache';
import { minGroundPerLeg, sampleProfile, type TerrainSample } from '$lib/map/terrain';
import { equirectangularDistanceM } from '$lib/notam/geometry';
import { NM_TO_METERS } from '$lib/notam/units';

export interface RouteTerrainEntry {
	/** Coordinate signature the samples belong to. */
	key: string;
	samples: TerrainSample[];
	status: 'loading' | 'ready' | 'error';
}

export const routeTerrain = $state<{
	byRoute: Record<string, RouteTerrainEntry>;
}>({ byRoute: {} });

/** Coordinates-only signature: altitude edits never refetch terrain. */
export function terrainCoordsKey(waypoints: { lat: number; lon: number }[]): string {
	return waypoints.map((w) => `${w.lat.toFixed(5)},${w.lon.toFixed(5)}`).join('|');
}

// Plain (non-reactive) bookkeeping; see the reactivity contract above.
const lastKey: Record<string, string> = {};
const aborts: Record<string, AbortController> = {};
// When a route's fetch failed (transient offline, one bad tile), so a later
// ensure pass retries instead of treating the error entry as terminal for
// the session. Cooldown-paced rather than key-cleared: some host effects
// both call ensure and read the cache, so an immediate-retry key clear
// would loop fetch -> error write -> effect re-run -> fetch while offline.
const failedAtMs: Record<string, number> = {};
const FAIL_RETRY_MS = 60_000;

/** Start (or keep) the terrain fetch for a route's current coordinates.
 *  Cheap when nothing changed; a coordinate change aborts the in-flight
 *  run and refetches. Safe to call from host effects on every re-run. */
export function ensureRouteTerrain(
	routeId: string,
	waypoints: { lat: number; lon: number }[],
): void {
	if (waypoints.length < 2) {
		return;
	}
	const key = terrainCoordsKey(waypoints);
	if (lastKey[routeId] === key) {
		const failedAt = failedAtMs[routeId];
		if (failedAt === undefined || isFresh(failedAt, FAIL_RETRY_MS)) {
			return; // settled entry, or a failure still inside its cooldown
		}
		// Cooldown passed: fall through and retry the failed fetch.
	}
	lastKey[routeId] = key;
	delete failedAtMs[routeId];
	aborts[routeId]?.abort();
	const ctrl = new AbortController();
	aborts[routeId] = ctrl;
	const current = settleGuard(ctrl.signal, () => lastKey[routeId] === key);
	untrack(() => {
		routeTerrain.byRoute[routeId] = { key, samples: [], status: 'loading' };
	});
	void sampleProfile(waypoints, { signal: ctrl.signal })
		.then((samples) => {
			if (!current()) {
				return;
			}
			routeTerrain.byRoute[routeId] = { key, samples, status: 'ready' };
		})
		.catch(() => {
			if (!current()) {
				return;
			}
			failedAtMs[routeId] = Date.now();
			routeTerrain.byRoute[routeId] = { key, samples: [], status: 'error' };
		});
}

/** The route's terrain samples when they are ready AND belong to the
 *  route's current coordinates; null otherwise (conservative fallback).
 *  Reading this inside a $derived tracks the cache. */
export function routeTerrainSamples(
	routeId: string,
	waypoints: { lat: number; lon: number }[],
): TerrainSample[] | null {
	const e = routeTerrain.byRoute[routeId];
	if (!e || e.status !== 'ready' || e.samples.length === 0) {
		return null;
	}
	return e.key === terrainCoordsKey(waypoints) ? e.samples : null;
}

/** Per-leg minimum ground elevation (ft) for the semicircular applicability
 *  floor, from the same shared samples the schedule and the profile read.
 *  All-null (length legs) until the samples are ready: the floor falls back
 *  to sea level, the conservative side. Tracked like routeTerrainSamples. */
export function legMinGroundElevFt(
	routeId: string,
	waypoints: { lat: number; lon: number }[],
): (number | null)[] {
	const legs = Math.max(0, waypoints.length - 1);
	const samples = routeTerrainSamples(routeId, waypoints);
	if (!samples) {
		return new Array<number | null>(legs).fill(null);
	}
	// Per-leg cumulative distances with the exact partial sums sampleProfile
	// and computeNavLog use, so the leg spans match the samples bit-for-bit.
	const cumNM: number[] = [];
	let cum = 0;
	for (let i = 0; i + 1 < waypoints.length; i++) {
		const a = waypoints[i];
		const b = waypoints[i + 1];
		cum += equirectangularDistanceM(a.lat, a.lon, b.lat, b.lon) / NM_TO_METERS;
		cumNM.push(cum);
	}
	return minGroundPerLeg(samples, cumNM);
}

/** Drop cache entries (and abort fetches) for deleted routes. The caller
 *  passes the live id list (a tracked read of routes.list stays in the
 *  caller, keeping this module read-free). */
export function pruneRouteTerrain(liveIds: string[]): void {
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- transient membership probe, not state
	const live = new Set(liveIds);
	for (const id of Object.keys(lastKey)) {
		if (!live.has(id)) {
			aborts[id]?.abort();
			delete aborts[id];
			delete lastKey[id];
			delete failedAtMs[id];
			untrack(() => {
				delete routeTerrain.byRoute[id];
			});
		}
	}
}
