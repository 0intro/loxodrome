/* A host for the route profile's corridor pass, keyed the way
 * RouteProfileModal keys it, in its own root so its effect runs. */
import { useCorridorGround, type CorridorAsk } from '$lib/components/profileCorridor.svelte';
import type { CorridorGround } from '$lib/route/minAltitude';

export interface CorridorHost {
	s: { ask: CorridorAsk | null };
	ground: () => CorridorGround | null;
	settled: () => boolean;
	stop: () => void;
}

export function mountCorridor(ask: CorridorAsk): CorridorHost {
	const s = $state<{ ask: CorridorAsk | null }>({ ask });
	let pass: ReturnType<typeof useCorridorGround> | null = null;
	const stop = $effect.root(() => {
		pass = useCorridorGround(() => s.ask);
	});
	return {
		s,
		ground: () => pass?.ground ?? null,
		settled: () => pass?.settled ?? true,
		stop,
	};
}
