/* The coverage watcher and a performance-page reading, for
 * tests/coverageWatch.client.spec.ts: watchCoverage mounted in a host effect
 * the way MapView mounts it, beside a derived reading an aerodrome's runway
 * count the way the performance grid reads its aerodromes. */
import { airportByIdent, watchCoverage } from '$lib/state/data.svelte';

export function mountCoverageWatch(): () => void {
	return $effect.root(() => {
		watchCoverage();
	});
}

export function mountRunwayCount(ident: string): { value: () => number | null; stop: () => void } {
	let value: number | null = null;
	const stop = $effect.root(() => {
		const count = $derived(airportByIdent(ident)?.runways.length ?? null);
		$effect(() => {
			value = count;
		});
	});
	return { value: () => value, stop };
}
