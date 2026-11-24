/* The temporary zones of the viewing period, by state, for the Zones list
 * (components/ZoneList.svelte, docs/zone-activity.md "The zones list"): the
 * supplements' zones the window and the level band keep
 * (visibleSupaipZones) and the zones the map draws for the listed NOTAMs
 * and the France-wide zone answer's (drawnNotams), each in its state at
 * the viewed time as the map draws
 * it (state/zoneStates.svelte.ts), and the supplements in force with no
 * zone to draw, which have to be read all the same. */

import type { SupAip } from '$lib/data/supaip';
import { drawnNotams } from './notam.svelte';
import { supaipsInForce, visibleSupaipZones } from './supaip.svelte';
import { supZoneKey } from './supaipLinks.svelte';
import { notamStates, supStates, type ZoneDrawState } from './zoneStates.svelte';

/** One temporary zone of the period. */
export interface ListedZone {
	/** Unique in the list: `sup:<supId>#<zone>` or `notam:<id>`. */
	key: string;
	state: ZoneDrawState;
	family: 'sup' | 'notam';
	name: string;
	/** The supplement's title, or the NOTAM's id. */
	source: string;
	/** What the list opens: the supplement on its zone, or the NOTAM. */
	opens: { kind: 'sup'; id: string; zone: number } | { kind: 'notam'; index: number };
}

/** A zone a NOTAM creates, named by the name its text quotes
 *  ("ZRT 'ZRT SOMME 2'"), else by its id. */
function notamZoneName(text: string, id: string): string {
	return /'([^']{2,40})'/.exec(text)?.[1] ?? id;
}

/** The period's temporary zones, the supplements' first, each once. */
export function periodZones(): ListedZone[] {
	const sup = supStates();
	const out: ListedZone[] = [];
	for (const it of visibleSupaipZones()) {
		const s = sup.get(supZoneKey(it.sup.id, it.zoneIndex));
		if (!s) {
			continue;
		}
		out.push({
			key: `sup:${it.sup.id}#${it.zoneIndex}`,
			state: s === 'activated' ? 'active' : s,
			family: 'sup',
			name: it.zone.name || it.sup.title,
			source: it.sup.title,
			opens: { kind: 'sup', id: it.sup.id, zone: it.zoneIndex },
		});
	}
	const notam = notamStates();
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- build-local dedup
	const seen = new Set<string>();
	for (const { notam: n, index } of drawnNotams()) {
		const s = notam.get(n.id);
		if (!s || seen.has(n.id)) {
			continue;
		}
		seen.add(n.id);
		out.push({
			key: `notam:${n.id}`,
			state: s,
			family: 'notam',
			name: notamZoneName(n.fullContent, n.id),
			source: n.id,
			opens: { kind: 'notam', index },
		});
	}
	return out;
}

/** The supplements in force over the period that no listed zone draws:
 *  their text is the whole of them. */
export function otherSupplements(listed: readonly ListedZone[]): SupAip[] {
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- build-local index
	const drawn = new Set(listed.flatMap((z) => (z.opens.kind === 'sup' ? [z.opens.id] : [])));
	return supaipsInForce()
		.filter((s) => !drawn.has(s.id))
		.sort((a, b) => a.region.localeCompare(b.region) || b.year - a.year || b.number - a.number);
}
