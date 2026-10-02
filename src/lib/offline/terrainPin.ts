/* Route-corridor terrain pins, the pure half (docs/offline-maps.md): which
 * terrain tiles a plan's corridors touch, at every level a read may ask for,
 * and how a new pin set reconciles against the one already stored. The
 * fetching and storage live in state/offlineTerrain.svelte.ts +
 * passiveStore.ts; everything here is arithmetic, node-tested.
 *
 * The tile enumeration itself lives in map/terrain.ts, because the corridor
 * REDUCTION reads the same set: what a plan pinned at the desk is exactly
 * what the min-alt corridor asks for in the air, by construction rather than
 * by two enumerations agreeing. The pin's radius is the wider of the user's
 * two corridor knobs, so it stays a superset of any single reduction. */

import { DEFAULT_TERRAIN_ZOOM, tilesCoveringCapsule, type TileCoord } from '$lib/map/terrain';

export type { TileCoord };

export interface LatLonPoint {
	lat: number;
	lon: number;
}

/** Every tile the capsule of radius `radiusNM` about any leg of any route
 *  touches, at each of `zs` (`tilesCoveringCapsule`, which rounds the ends
 *  the way the corridor itself does). Deduped across legs, routes and
 *  levels, deterministic order.
 *
 *  A LIST of levels, because the source publishes a pyramid and one plan is
 *  read at more than one: the deepest for every point query (the ground under
 *  the aircraft, the profile's own line) and whatever coarser level each
 *  corridor reduction picks. The dedupe key carries the zoom for the same
 *  reason: keyed on x/y alone, z8's (0,0) would silently swallow z14's. */
export function corridorTerrainTiles(
	routes: LatLonPoint[][],
	radiusNM: number,
	zs: readonly number[] = [DEFAULT_TERRAIN_ZOOM],
): TileCoord[] {
	const seen = new Set<string>();
	const out: TileCoord[] = [];
	for (const z of zs) {
		for (const route of routes) {
			for (let i = 0; i + 1 < route.length; i++) {
				for (const t of tilesCoveringCapsule(route[i], route[i + 1], radiusNM, z)) {
					const key = `${t.z}/${t.x}/${t.y}`;
					if (!seen.has(key)) {
						seen.add(key);
						out.push(t);
					}
				}
			}
		}
	}
	return out;
}

/** Reconcile a new target pin set against what is stored: fetch what is
 *  missing, drop pins no longer in any corridor. Replace semantics, so the
 *  pin set is always exactly the last prepared plan. */
export function computePinOps(
	existing: ReadonlySet<string>,
	target: readonly string[],
): { toFetch: string[]; toDrop: string[] } {
	const targetSet = new Set(target);
	return {
		toFetch: target.filter((u) => !existing.has(u)),
		toDrop: [...existing].filter((u) => !targetSet.has(u)),
	};
}

/** Pre-download size label. Measured over the built mosaic: a z12 tile
 *  averages 20.5 KB and a pooled z11/z10 about 55 KB, the worst on earth being
 *  216 KB over the Alps. A pin holds mostly its deepest level plus the coarse
 *  levels a corridor reads, so 50 KB errs HIGH against the mix and storage
 *  never surprises upward. The 100 KB this carried was a measurement of the
 *  terrain-RGB PNGs the mosaic replaced. */
export function estimateBytes(tileCount: number): number {
	return tileCount * 50_000;
}

/** UTC day of a pin write, for the Route tab's status line (plain .ts on
 *  purpose: Date stays out of the Svelte modules). */
export function isoDay(tsMs: number): string {
	return new Date(tsMs).toISOString().slice(0, 10);
}
