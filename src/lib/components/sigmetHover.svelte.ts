/* sigmetHover.svelte.ts: hovering a SIGMET row (the Weather tab's list, the
 * map's context menu) draws the advisory's highlight clone over the map, its
 * layer off or not. It is the featureHover machine over the SIGMET clone, in
 * a module of its own, out of the NOTAM Viewer's bundle: SIGMETs are the main
 * app's alone. */

import { hoverSigmet } from '$lib/map/sigmetLayer';
import { sigmetRings } from '$lib/state/sigmets.svelte';
import type { Sigmet } from '$lib/weather/sigmet';

/** Call during component init (the $effect needs the component's context).
 *  The hovered advisory is held as an id and resolved by an effect against
 *  the rows `list` shows: a row removed under a still pointer (its advisory
 *  expired on the minute tick, replaced by a refetch, the menu closed) fires
 *  no mouseleave, and the clone goes with the row instead. The teardown
 *  clears it, the host unmounting included. */
export function useSigmetHover(list: () => readonly Sigmet[]): {
	set: (s: Sigmet | null) => void;
} {
	let hoverId = $state<string | null>(null);
	$effect(() => {
		const id = hoverId;
		if (id === null) {
			return;
		}
		const s = list().find((x) => x.id === id);
		if (!s) {
			hoverId = null;
			return;
		}
		hoverSigmet({ sigmet: s, rings: sigmetRings(s) });
		return () => hoverSigmet(null);
	});
	return {
		set: (s: Sigmet | null): void => {
			hoverId = s?.id ?? null;
		},
	};
}
