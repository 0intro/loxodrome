/* What the route and the trace profiles share about a band, and the nav
 * log's schedule about a zone row: its way to its detail panel, an
 * airspace band opening its airspace, a supplement band
 * (`sup:<supId>#<zone>`) its supplement on that zone, a raptor zone's
 * (`zsm:<id>`) its zone and a NOTAM's area its NOTAM, each keeping the way
 * back (navigateTo*), the hatch the chart draws on it while its zone is
 * active, the dossier's included, and the word an active crossing wears. */

import type { ActivityAnswer } from '$lib/data/activity';
import { zsmFeet } from '$lib/data/zsm';
import type { Bbox } from '$lib/notam/geometry';
import { bandActivationInfo } from '$lib/route/notamProfile';
import { supBandRef } from '$lib/route/supProfile';
import { isZsmBandKey } from '$lib/route/zsmProfile';
import { airspaceByKey, getSupaips } from '$lib/state/data.svelte';
import { t } from '$lib/state/i18n.svelte';
import { notamIndexById, type IndexedNotam } from '$lib/state/notam.svelte';
import { navigateToAirspace, navigateToNotam, navigateToSupaip, navigateToZsm } from '$lib/state/ui.svelte';
import { zsmById } from '$lib/state/zsm.svelte';
import { zoneStateLines, type ZoneSpan } from './zoneStateText';

/** Open the panel a band's key names, and answer the box to fly the map
 *  to, null where there is none. A NOTAM's area (`notam:<id>`, a row of
 *  the nav log's schedule) opens its NOTAM and flies nowhere. */
export function navigateToBand(key: string): Bbox | null {
	if (key.startsWith('notam:')) {
		const id = key.slice('notam:'.length);
		const index = notamIndexById(id);
		if (index !== null) {
			navigateToNotam(index);
		}
		return null;
	}
	if (isZsmBandKey(key)) {
		navigateToZsm(key);
		return zsmById(key)?.bbox ?? null;
	}
	const sup = supBandRef(key);
	if (sup) {
		navigateToSupaip(sup.supId, sup.zoneIndex);
		const s = (getSupaips() ?? []).find((x) => x.id === sup.supId);
		return s?.zones[sup.zoneIndex]?.bbox ?? s?.bbox ?? null;
	}
	navigateToAirspace(key);
	return airspaceByKey(key)?.bbox ?? null;
}

/** The hatch the chart draws, by band key with its tooltip line: each band
 *  whose zone is active in `states` (state/activity.svelte.ts bandStates),
 *  at the time the flight crosses it on a planned route. A zone in force at
 *  all times keeps its chart look, a NOTAM band its own hatch, and a raptor
 *  zone its crimson, the chart drawing it only while it is active. The line
 *  names the NOTAMs that activate the zone over its active period and their
 *  windows, through `links` (the raw activation join, by airspace id, `ids`
 *  giving each band key's), and otherwise says the state as the zone's
 *  panel does. `at` is the range the states were read over, `span` what it
 *  stands for. */
export function bandHatch(
	states: ReadonlyMap<string, ActivityAnswer>,
	ids: ReadonlyMap<string, string>,
	links: ReadonlyMap<string, IndexedNotam[]>,
	span: ZoneSpan,
	at: { fromMs: number; toMs: number },
): Map<string, string> | null {
	const out = new Map<string, string>();
	for (const [key, a] of states) {
		if (a.state !== 'active' || a.reason === 'permanent' || key.startsWith('notam:') || isZsmBandKey(key)) {
			continue;
		}
		out.set(key, hatchLine(a, ids.get(key), links, span, at));
	}
	return out.size > 0 ? out : null;
}

function hatchLine(
	a: ActivityAnswer,
	id: string | undefined,
	links: ReadonlyMap<string, IndexedNotam[]>,
	span: ZoneSpan,
	at: { fromMs: number; toMs: number },
): string {
	const p = a.period ?? { startMs: at.fromMs, endMs: at.toMs };
	const reaching = (id ? (links.get(id) ?? []) : []).filter(
		({ notam: n }) => (n.startDate?.getTime() ?? -Infinity) <= p.endMs && (n.endDate?.getTime() ?? Infinity) >= p.startMs,
	);
	if (id && reaching.length > 0) {
		const info = bandActivationInfo(id, reaching, p.startMs, p.endMs);
		const w = info.windows.length > 0 ? ` (${info.windows.join(', ')})` : '';
		return `${t.route.bandActivatedBy} ${info.notamIds.join(', ')}${w}`;
	}
	const lines = zoneStateLines({ answer: a, next: null, noticeMin: null, briefedAtMs: undefined, note: null }, span, at);
	return lines.reason ? `${lines.state} ${lines.reason}` : lines.state;
}

/** The word a crossing of an active zone wears, on the profile's strip and
 *  the nav log's schedule: ACTIVE, or for a raptor zone the height ENR
 *  5.6-1 asks it be overflown at, a caution. */
export function activeWord(key: string): { text: string; caution: boolean } {
	const z = isZsmBandKey(key) ? zsmById(key) : null;
	return z ? { text: t.route.zsmOverfly(zsmFeet(z.overflyM)), caution: true } : { text: t.route.activeWord, caution: false };
}
