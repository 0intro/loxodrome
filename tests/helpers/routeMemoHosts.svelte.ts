/* The route memos' hosts, reduced to what they track: NavLogSheet's MSA
 * effect (`ensureRouteMsa(route.id, route.waypoints, msaOpts)`, msaOpts a
 * derived of two settings) and its terrain one (`ensureRouteTerrain(route.id,
 * route.waypoints)`), each re-run only by what it reads. */
import { ensureRouteMsa, routeMsaLegs, type RouteMsaOpts } from '$lib/state/routeMsa.svelte';
import { ensureRouteTerrain, routeTerrainSamples } from '$lib/state/routeTerrain.svelte';
import type { TerrainSample } from '$lib/map/terrain';

export interface MemoHost<T> {
	value: () => T | null;
	runs: () => number;
	stop: () => void;
}

export function mountMsaHost(
	id: string,
	waypoints: { lat: number; lon: number }[],
	opts: RouteMsaOpts,
): MemoHost<(number | null)[]> {
	let runs = 0;
	let value: (number | null)[] | null = null;
	const stop = $effect.root(() => {
		$effect(() => {
			runs++;
			ensureRouteMsa(id, waypoints, opts);
		});
		const shown = $derived(routeMsaLegs(id, waypoints, opts));
		$effect(() => {
			value = shown;
		});
	});
	return { value: () => value, runs: () => runs, stop };
}

export function mountTerrainHost(id: string, waypoints: { lat: number; lon: number }[]): MemoHost<TerrainSample[]> {
	let runs = 0;
	let value: TerrainSample[] | null = null;
	const stop = $effect.root(() => {
		$effect(() => {
			runs++;
			ensureRouteTerrain(id, waypoints);
		});
		const shown = $derived(routeTerrainSamples(id, waypoints));
		$effect(() => {
			value = shown;
		});
	});
	return { value: () => value, runs: () => runs, stop };
}
