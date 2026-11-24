/* What a pack print's prefetch was computed for (PackPrintHost.printPack):
 * the printed routes in order, each with its role, its waypoints' positions
 * and its aerodromes, and the two settings the minimum safe altitude folds,
 * the corridor's half-width and the flight rules' margin. The MSA, terrain
 * and corridor ground are prefetched per route and per leg, and the sheets
 * read them by leg INDEX: a waypoint inserted while the run holds in review
 * would shift every later leg's MSA by one. The annex's aerodromes come from
 * the same chain. A run whose key moved starts again on the plan as it stands.
 * Levels, names, notes and leg winds stay out of the key, as they stay out of
 * what was fetched. Pure. */

import type { Route } from '$lib/state/route.svelte';

export function printPlanKey(
	printableRoutes: readonly Route[],
	settings: { minAltCorridorRadiusNM: number; vfr: boolean },
): string {
	const lines = printableRoutes.map((r) =>
		[
			r.id,
			r.alternate ? 'alternate' : 'trip',
			...r.waypoints.map((w) => `${w.lat},${w.lon},${w.kind === 'airport' ? (w.ident ?? '') : ''}`),
		].join(' '),
	);
	lines.push(`${settings.minAltCorridorRadiusNM} ${settings.vfr ? 'vfr' : 'ifr'}`);
	return lines.join('\n');
}
