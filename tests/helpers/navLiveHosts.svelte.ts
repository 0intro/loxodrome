/* The live-navigation selectors' stand-ins and readers, for
 * tests/navLiveShared.client.spec.ts. `fake` is the state navLiveFor, the
 * flown route and the active route read (the spec mocks the three modules
 * onto it); navLiveFor counts its evaluations per route id. A reader is a
 * host effect, the way the band or the nav log reads the live state. */
import type { NavLiveInfo } from '$lib/state/navLive.svelte';

export const fake = $state({ flownId: 'r1', activeId: 'r1', tick: 0 });

/** Evaluations of navLiveFor, per route id. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a counter the spec reads, never tracked
export const evaluations = new Map<string, number>();

export function fakeNavLiveFor(routeId: string): NavLiveInfo | null {
	evaluations.set(routeId, (evaluations.get(routeId) ?? 0) + 1);
	return { routeId, tick: fake.tick } as unknown as NavLiveInfo;
}

/** What a reader last saw: the route id and tick of the answer. */
export interface Seen {
	routeId: string;
	tick: number;
}

export interface Reader {
	seen: () => Seen | null;
	runs: () => number;
	stop: () => void;
}

export function mountReader(read: () => NavLiveInfo | null): Reader {
	let runs = 0;
	let seen: Seen | null = null;
	const stop = $effect.root(() => {
		$effect(() => {
			runs++;
			seen = read() as unknown as Seen | null;
		});
	});
	return { seen: () => seen, runs: () => runs, stop };
}
