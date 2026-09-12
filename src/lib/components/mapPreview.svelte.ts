/* The Flights surface's hover-preview hooks (the featureHover
 * discipline over the previewLayer ghost): a row under the pointer
 * ghosts its trace / plan on the map, cleared on leave. The key is HELD
 * in $state and asserted from an $effect, because rows vanish under a
 * still pointer (a delete, a re-match, the view switching) and a
 * removed element fires no mouseleave; every gated early-return NULLS
 * the held key, so a placement change later can never resurrect a
 * preview nobody is pointing at (FlightsModal never unmounts, so its
 * effects live forever). Gates, read inside the effect so they track:
 * desktop only (hover is a pointer concept), and only while the
 * surface placement keeps the map visible (the flights surface
 * defaults to `page`, which covers it; the gate also skips the
 * IndexedDB fetch). The trace fetch is debounced and generation
 * -guarded: the generation bumps in the CLEANUP, so a fetch resolving
 * after leave (its timer already fired) can never draw a ghost with no
 * further run pending to clear it. */

import type L from 'leaflet';
import { downsample } from '$lib/nav/trace';
import { showPreviewGhost } from '$lib/map/previewLayer';
import { dataState } from '$lib/state/data.svelte';
import { outingPoints } from '$lib/state/flightLibrary.svelte';
import { planPreviewLines } from '$lib/state/planRows';
import { resolveWaypointToken } from '$lib/state/waypointSearch.svelte';
import { surfaceKeepsMapVisible } from '$lib/state/workspace.svelte';
import { ui } from '$lib/state/ui.svelte';

const FETCH_DEBOUNCE_MS = 120;
/** The ghost needs shape, not fidelity; a 2 h 1 Hz trace draws fine at
 *  this stride. */
const TRACE_PREVIEW_POINTS = 1500;
const TRACE_CACHE_MAX = 6;

// Post-downsample lines keyed `${id}:${savedAtMs}`: a Continue-extend
// re-archives the SAME outing id with more points (savedAtMs bumps), so
// the id alone would serve a truncated ghost.
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local cache, not state
const traceCache = new Map<string, L.LatLngTuple[][]>();
let traceGen = 0;

// Plan lines per catalog id, invalidated on yaml change; populated only
// while BOTH datasets are loaded (the planCatalog cacheable gate: a
// pre-dataset hover must not pin an empty derivation for the session).
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local cache, not state
const planCache = new Map<string, { yaml: string; lines: [number, number][][] }>();

function gatesPass(): boolean {
	return !ui.isMobile && surfaceKeepsMapVisible('flights');
}

/** Hover hook for the flight rows. `active` is the surface-side
 *  liveness (open AND the Flights view showing), read inside the effect
 *  so a view switch under a resting pointer clears the ghost. */
export function useTracePreview(active: () => boolean): {
	set: (key: { id: number; savedAtMs: number } | null) => void;
} {
	let held = $state<{ id: number; savedAtMs: number } | null>(null);
	$effect(() => {
		const key = held;
		if (key === null) {
			return;
		}
		if (!active() || !gatesPass()) {
			held = null;
			return;
		}
		const cacheKey = `${key.id}:${key.savedAtMs}`;
		const hit = traceCache.get(cacheKey);
		if (hit) {
			traceCache.delete(cacheKey);
			traceCache.set(cacheKey, hit); // MRU refresh
			showPreviewGhost(hit);
		} else {
			const gen = traceGen;
			const timer = setTimeout(() => {
				void outingPoints(key.id).then((pts) => {
					if (gen !== traceGen) {
						return; // left / superseded while fetching
					}
					if (!pts) {
						showPreviewGhost(null);
						return;
					}
					const lines: L.LatLngTuple[][] = [
						downsample(pts, TRACE_PREVIEW_POINTS).map(
							(p) => [p.lat, p.lon] as L.LatLngTuple,
						),
					];
					traceCache.set(cacheKey, lines);
					while (traceCache.size > TRACE_CACHE_MAX) {
						const oldest = traceCache.keys().next().value;
						if (oldest === undefined) {
							break;
						}
						traceCache.delete(oldest);
					}
					showPreviewGhost(lines);
				});
			}, FETCH_DEBOUNCE_MS);
			return () => {
				clearTimeout(timer);
				traceGen++;
				showPreviewGhost(null);
			};
		}
		return () => {
			traceGen++;
			showPreviewGhost(null);
		};
	});
	return {
		set: (key): void => {
			held = key;
		},
	};
}

/** Hover hook for the catalog rows. No liveness thunk: PlansView
 *  unmounts on the view switch, so the effect's destroy teardown
 *  covers the modal's permanence. */
export function usePlanPreview(): {
	set: (row: { id: string; yaml: string } | null) => void;
} {
	let held = $state<{ id: string; yaml: string } | null>(null);
	$effect(() => {
		const row = held;
		if (row === null) {
			return;
		}
		if (!gatesPass()) {
			held = null;
			return;
		}
		const hit = planCache.get(row.id);
		let lines: [number, number][][];
		if (hit && hit.yaml === row.yaml) {
			lines = hit.lines;
		} else {
			lines = planPreviewLines(row.yaml, resolveWaypointToken);
			if (dataState.airportsLoaded && dataState.navaidsLoaded) {
				planCache.set(row.id, { yaml: row.yaml, lines });
			}
		}
		showPreviewGhost(lines);
		return () => {
			showPreviewGhost(null);
		};
	});
	return {
		set: (row): void => {
			held = row;
		},
	};
}
