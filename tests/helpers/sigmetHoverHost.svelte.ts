/* The SIGMET row hover, for tests/sigmetHover.client.spec.ts: the hook
 * mounted in a host effect the way WeatherTab and ContextMenu mount it, over
 * the rows the spec swaps whole (a refetch, an expiry). */
import { useSigmetHover } from '$lib/components/sigmetHover.svelte';
import type { Sigmet } from '$lib/weather/sigmet';

export const rows = $state<{ list: readonly Sigmet[] }>({ list: [] });

export function mountSigmetHover(): {
	hover: ReturnType<typeof useSigmetHover>;
	stop: () => void;
} {
	let hover!: ReturnType<typeof useSigmetHover>;
	const stop = $effect.root(() => {
		hover = useSigmetHover(() => rows.list);
	});
	return { hover, stop };
}
