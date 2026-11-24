/* The notice's clock mounted as a component reads it: `now` copied out by
 * an effect, so a spec sees each wake. */
import { noticeClock } from '$lib/state/briefing.svelte';

export function mountNoticeClock(): { now: () => number; stop: () => void } {
	let now = 0;
	const stop = $effect.root(() => {
		const clock = noticeClock();
		$effect(() => {
			now = clock.now;
		});
	});
	return { now: () => now, stop };
}
