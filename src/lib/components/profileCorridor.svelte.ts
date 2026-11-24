/* The minimum-altitude corridor's terrain under the route profile
 * (route/minAltitude.ts computeCorridorGround), the one pass the profile's
 * MSA line and its drawn ground both fold, held with the geometry it was
 * computed for: the route's coordinates and the corridor's half-width. A
 * pass belongs to its geometry. While the pass for another one runs (a
 * route switch, a waypoint moved or inserted, a wider corridor), the old
 * ground is no answer: folded by leg index onto the new legs, it would draw
 * the old geometry's MSA, and a leg past its end an MSA of the obstacles
 * alone. The same coordinates handed back as new waypoints (an undo) keep
 * their ground through the pass, so the line never flickers through
 * nothing.
 *
 * Called during a component's initialisation: it creates the pass's effect
 * in that component's context. Null while there is no route to read, and
 * `settled` false while a pass runs. */

import { computeCorridorGround, type CorridorGround } from '$lib/route/minAltitude';
import { terrainCoordsKey } from '$lib/state/routeTerrain.svelte';
import type { LatLon } from '$lib/notam/types';

export interface CorridorAsk {
	pts: LatLon[];
	halfWidthNM: number;
}

function askKey(a: CorridorAsk): string {
	return `${terrainCoordsKey(a.pts)}|${a.halfWidthNM}`;
}

export function useCorridorGround(ask: () => CorridorAsk | null): {
	readonly ground: CorridorGround | null;
	readonly settled: boolean;
} {
	let held = $state<{ key: string; ground: CorridorGround } | null>(null);
	let settled = $state(true);
	$effect(() => {
		const a = ask();
		if (!a) {
			held = null;
			settled = true;
			return;
		}
		const key = askKey(a);
		settled = false;
		const ctrl = new AbortController();
		void computeCorridorGround(a.pts, { signal: ctrl.signal, halfWidthNM: a.halfWidthNM })
			.then((ground) => {
				if (!ctrl.signal.aborted) {
					held = { key, ground };
					settled = true;
				}
			})
			.catch(() => {
				if (!ctrl.signal.aborted) {
					held = null;
					settled = true;
				}
			});
		return () => ctrl.abort();
	});
	const ground = $derived.by(() => {
		const a = ask();
		return a && held && held.key === askKey(a) ? held.ground : null;
	});
	return {
		get ground() {
			return ground;
		},
		get settled() {
			return settled;
		},
	};
}
