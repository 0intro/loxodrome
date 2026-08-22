/* Route-corridor terrain pins, the pure half (docs/offline-maps.md): which
 * z12 Terrarium tiles a plan's corridors touch, and how a new pin set
 * reconciles against the one already stored. The fetching and storage live
 * in state/offlineTerrain.svelte.ts + passiveStore.ts; everything here is
 * arithmetic, node-tested. */

import { DEFAULT_TERRAIN_ZOOM, lngLatToTile } from '$lib/map/terrain';

export interface TileCoord {
	z: number;
	x: number;
	y: number;
}

export interface LatLonPoint {
	lat: number;
	lon: number;
}

const EARTH_CIRC_KM = 40075.0167;
const KM_PER_NM = 1.852;

/** Ground size of one tile edge at this latitude/zoom, km (Web Mercator is
 *  locally isotropic, so one figure serves both axes). */
function tileGroundKm(lat: number, z: number): number {
	return (EARTH_CIRC_KM * Math.cos((lat * Math.PI) / 180)) / (1 << z);
}

/** Every z-level tile whose centre lies within radiusNM (+ half a tile
 *  diagonal of slop, so edge tiles are never missed) of any leg of any
 *  route. Legs are sampled every half tile; x wraps, y clamps to the
 *  Mercator grid. Deduped, deterministic order. */
export function corridorTerrainTiles(
	routes: LatLonPoint[][],
	radiusNM: number,
	z: number = DEFAULT_TERRAIN_ZOOM,
): TileCoord[] {
	const n = 1 << z;
	const seen = new Set<string>();
	const out: TileCoord[] = [];

	const addDisc = (lat: number, lon: number): void => {
		const groundKm = tileGroundKm(lat, z);
		if (groundKm <= 0) {
			return;
		}
		const c = lngLatToTile(lat, lon, z);
		// Radius in tile units + half the tile diagonal, so a tile whose
		// centre sits just outside still pins when the corridor clips it.
		const r = (radiusNM * KM_PER_NM) / groundKm + Math.SQRT1_2;
		const span = Math.ceil(r);
		for (let dy = -span; dy <= span; dy++) {
			const y = Math.floor(c.y) + dy;
			if (y < 0 || y >= n) {
				continue;
			}
			for (let dx = -span; dx <= span; dx++) {
				const x = (((Math.floor(c.x) + dx) % n) + n) % n;
				const cx = Math.floor(c.x) + dx + 0.5;
				const cy = y + 0.5;
				if (Math.hypot(cx - c.x, cy - c.y) > r) {
					continue;
				}
				const key = `${x}/${y}`;
				if (!seen.has(key)) {
					seen.add(key);
					out.push({ z, x, y });
				}
			}
		}
	};

	for (const route of routes) {
		for (let i = 0; i + 1 < route.length; i++) {
			const a = route[i];
			const b = route[i + 1];
			const midLat = (a.lat + b.lat) / 2;
			const groundKm = tileGroundKm(midLat, z);
			// Step every half tile along the leg (linear lat/lon, the
			// sampleRoute convention; legs are short at these scales).
			const legKm = Math.hypot(
				(b.lat - a.lat) * 111.2,
				(b.lon - a.lon) * 111.2 * Math.cos((midLat * Math.PI) / 180),
			);
			const steps = Math.max(1, Math.ceil(legKm / Math.max(1e-6, groundKm / 2)));
			for (let s = 0; s <= steps; s++) {
				const f = s / steps;
				addDisc(a.lat + (b.lat - a.lat) * f, a.lon + (b.lon - a.lon) * f);
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

/** Pre-download size label. Terrarium z12 tiles run ~15 KB over plains to
 *  ~150 KB in the Alps (measured: a Paris-Alps corridor averaged ~115 KB);
 *  the label errs HIGH so storage never surprises upward. */
export function estimateBytes(tileCount: number): number {
	return tileCount * 100_000;
}

/** UTC day of a pin write, for the Route tab's status line (plain .ts on
 *  purpose: Date stays out of the Svelte modules). */
export function isoDay(tsMs: number): string {
	return new Date(tsMs).toISOString().slice(0, 10);
}
