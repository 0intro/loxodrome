/* The zone NOTAMs of the five French FIRs, series R and Z (the restricted,
 * danger and temporary zones, and the RTBA), which the proxy answers every
 * client with (/notam/fr-zones, workers.md). The flight app asks for them
 * while its map lies over France outside the loaded briefing, behind Fetch
 * NOTAMs for the planned flight (MapView), and holds the answer in memory
 * with its age, live data never stored (offline.md).
 *
 * The answer stays out of the loaded briefing and its list. It joins the
 * activation periods every zone state reads (notam.svelte.ts joinNotams), so
 * it adds the activations it holds, and a zone's silence stays the loaded
 * briefing's to judge: the query holds what is filed under the five FIRs,
 * while a third of France's activation NOTAMs are filed under an aerodrome
 * (R3249/26 activates LF-R 185 under LFLP). A NOTAM of it creating a zone
 * of its own is drawn with the briefing's (notam.svelte.ts drawnNotams),
 * addressed by a negative index (answerIndex), its panel opened from the
 * map and from an alert. docs/zone-activity.md. */

import { proxyBase } from '$lib/autorouter/state.svelte';
import { rowToIcaoText, type AutorouterRow } from '$lib/autorouter/client';
import { parseNotams } from '$lib/notam';
import type { Notam } from '$lib/notam/types';
import type { Bbox } from '$lib/notam/geometry';
import { closeDetail, ui } from './ui.svelte';

export const zoneNotamState = $state<{ at: number | null; notams: Notam[]; error: string | null }>({
	at: null,
	notams: [],
	error: null,
});

/** How often the map asks again while it wants them: the proxy's edge
 *  keeps an answer five minutes. */
export const ZONE_REFRESH_MS = 5 * 60_000;
/** Metropolitan France and its coasts: the five FIRs the answer covers. */
export const METRO_FRANCE: Bbox = { minLat: 41.2, maxLat: 51.2, minLon: -5.6, maxLon: 9.8 };

let inflight: Promise<void> | null = null;
let askedAt = Number.NEGATIVE_INFINITY;

/** Ask the proxy again, once per ZONE_REFRESH_MS. */
export function refreshZoneNotams(nowMs = Date.now()): Promise<void> | null {
	if (inflight || nowMs - askedAt < ZONE_REFRESH_MS) {
		return inflight;
	}
	askedAt = nowMs;
	inflight = (async () => {
		try {
			const res = await fetch(`${proxyBase()}/notam/fr-zones`, { cache: 'no-store' });
			if (!res.ok) {
				throw new Error(`HTTP ${res.status}`);
			}
			const body = (await res.json()) as { at: number; rows: AutorouterRow[] };
			applyZoneAnswer(body.at, body.rows);
		} catch (e) {
			zoneNotamState.error = e instanceof Error ? e.message : String(e);
		} finally {
			inflight = null;
		}
	})();
	return inflight;
}

/** The index the answer's `i`th NOTAM takes beside the loaded briefing's:
 *  -1 for its first, so the map, the panel and a selection address it apart
 *  (notam.svelte.ts notamAt). */
export function answerIndex(i: number): number {
	return -1 - i;
}

/** The answer's position a negative index names (answerIndex's inverse). */
export function answerSlot(index: number): number {
	return -1 - index;
}

/** Hold an answer: its rows read as the NOTAMs they are. A panel open on one
 *  of its NOTAMs follows that NOTAM's entry into the new answer, and closes
 *  where it is gone. */
export function applyZoneAnswer(at: number, rows: readonly AutorouterRow[]): void {
	const d = ui.detail;
	const old = zoneNotamState.notams;
	const open = d?.kind === 'notam' && d.index < 0 ? old[answerSlot(d.index)] : undefined;
	const rank = open && d?.kind === 'notam' ? old.slice(0, answerSlot(d.index)).filter((n) => n.id === open.id).length : 0;
	zoneNotamState.notams = rows.length > 0 ? parseNotams(rows.map(rowToIcaoText).join('\n\n')) : [];
	zoneNotamState.at = at;
	zoneNotamState.error = null;
	if (!open || d?.kind !== 'notam') {
		return;
	}
	const same = zoneNotamState.notams.flatMap((n, i) => (n.id === open.id ? [i] : []));
	const i = same[rank];
	if (i === undefined) {
		closeDetail();
	} else if (answerIndex(i) !== d.index) {
		ui.detail = { ...d, index: answerIndex(i) };
	}
}
