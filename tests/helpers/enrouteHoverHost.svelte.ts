/* The nav log's enroute-line hover, for tests/enrouteFreqHover.client.spec.ts:
 * the hook mounted in a host effect the way NavLogSheet mounts it, over the
 * per-leg lines the spec swaps whole (a recomputed nav log). */
import { useEnrouteFreqHover } from '$lib/components/featureHover.svelte';
import type { EnrouteFreqLine } from '$lib/route/airspaces';

export const legs = $state<{ byFromId: ReadonlyMap<string, readonly EnrouteFreqLine[]> }>({
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- replaced whole by the spec, never mutated
	byFromId: new Map(),
});

export function mountEnrouteHover(): {
	hover: ReturnType<typeof useEnrouteFreqHover>;
	stop: () => void;
} {
	let hover!: ReturnType<typeof useEnrouteFreqHover>;
	const stop = $effect.root(() => {
		hover = useEnrouteFreqHover(() => legs.byFromId);
	});
	return { hover, stop };
}
