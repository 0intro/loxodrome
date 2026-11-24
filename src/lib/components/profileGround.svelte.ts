/* The terrain under a column profile's point (the detail panel's chart, the
 * map's altitude profile), read through elevationFtAt and held with the key
 * of the point it was read for. A read belongs to its point: another point
 * reads no ground until its own read lands, since every AGL limit of its
 * stack and its airspace-above figure would otherwise rest on the old
 * ground. A caller that keeps the key while the point moves (the map
 * marker's drag) keeps the last ground through the reads, so a drag never
 * flickers through nothing.
 *
 * Called during a component's initialisation: it creates the read's effect
 * in that component's context. Null while there is no point. */

import { elevationFtAt } from '$lib/map/terrain';

export interface GroundPoint {
	lat: number;
	lon: number;
	/** What a read is held for: a new key drops the ground until the new
	 *  point is read, the same key keeps it. */
	key: string | number;
}

export function useProfileGround(at: () => GroundPoint | null): { readonly ft: number | null } {
	let read = $state<{ key: string | number; ft: number | null } | null>(null);
	$effect(() => {
		const p = at();
		if (!p) {
			return;
		}
		const { lat, lon, key } = p;
		let stale = false;
		void elevationFtAt(lat, lon)
			.then((ft) => {
				if (!stale) read = { key, ft };
			})
			.catch(() => {
				if (!stale) read = { key, ft: null };
			});
		return () => {
			stale = true;
		};
	});
	const ft = $derived.by(() => {
		const p = at();
		return p && read && read.key === p.key ? read.ft : null;
	});
	return {
		get ft() {
			return ft;
		},
	};
}
