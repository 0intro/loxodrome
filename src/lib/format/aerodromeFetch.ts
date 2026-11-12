/* How the app writes where an aerodrome's NOTAMs came from, once they were
 * fetched from its panel into the loaded briefing (state/aerodromeNotams.ts):
 * the airport panel, both apps' loader foot lines, the NOTAMs tab's section
 * heading and the printed bulletin print the same tokens. Locale-free: product
 * names and Zulu times, wrapped in each surface's own catalog sentence. */

import type { AerodromeFetch } from '$lib/state/notam.svelte';
import type { NotamSource } from '$lib/state/notamSource.svelte';
import { formatZuluNear } from './datetime';

/** A source's name as the app prints it, the same in every language. */
export function notamSourceName(source: NotamSource): string {
	return source === 'sofia' ? 'SOFIA' : 'autorouter';
}

/** The aerodromes fetched from their panel, in the order they were fetched:
 *  `LFPN 15:10Z (SOFIA), LFOB 15:20Z (autorouter)`. */
export function fetchedAerodromesList(
	fetches: Record<string, AerodromeFetch>,
	nowMs: number,
): string {
	return Object.entries(fetches)
		.map(([ident, f]) => `${ident} ${formatZuluNear(f.at, nowMs)} (${notamSourceName(f.source)})`)
		.join(', ');
}
