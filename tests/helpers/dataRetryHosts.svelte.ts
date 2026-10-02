/* A host mirroring MapView's alert effect (the one that asks for the
 * airspaces, SUP AIP, obstacles and airports on every GPS fix): an effect
 * re-run by a $state counter standing in for the pose, calling the four
 * ensures and swallowing their rejections the way the map does. */
import { ensureAirports, ensureAirspaces, ensureObstacles, ensureSupaip } from '$lib/state/data.svelte';

export function mountAlertEnsures(): { bump: () => void; runs: () => number; stop: () => void } {
	const pose = $state({ n: 0 });
	let runs = 0;
	const stop = $effect.root(() => {
		$effect(() => {
			void pose.n;
			runs++;
			void ensureAirspaces().catch(() => {});
			void ensureSupaip().catch(() => {});
			void ensureObstacles().catch(() => {});
			void ensureAirports().catch(() => {});
		});
	});
	return {
		bump: () => {
			pose.n++;
		},
		runs: () => runs,
		stop,
	};
}
