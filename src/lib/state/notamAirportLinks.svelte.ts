/* NOTAM <-> airport links by ARP citation.
 *
 * French P-series obstacle NOTAMs file under the FIR in Item A) yet anchor
 * their position to an aerodrome reference point ("RDL 194/0.25NM ARP
 * LFPZ"), so the aerodrome's own panel never saw them through the A)
 * ownership link. The ARP ident is an explicit reference; surface it both
 * ways: the airport panel lists the NOTAMs citing it by position, the NOTAM
 * panel chips the cited aerodromes. Both directions read filteredNotams(),
 * so every data filter composes. */

import type { Airport } from '$lib/data/airports';
import { extractArpIdents } from '$lib/notam/airportRefs';
import { parseSections } from '$lib/notam/parser';
import type { Notam } from '$lib/notam/types';
import { airportByIdent, dataState } from './data.svelte';
import { filteredNotams, type IndexedNotam } from './notam.svelte';

// Per-Notam cache; the notams array is replaced wholesale on re-parse, so
// entries age out with their keys.
const arpCache = new WeakMap<Notam, string[]>();

/** Distinct ARP-cited idents in the NOTAM's E) text, minus its own A)
 *  codes: a NOTAM filed under LFML citing "ARP LFML" adds nothing (the A)
 *  ownership already lists it on that panel). No Q-code gate; the corpus is
 *  P-series-heavy but the "ARP <ident>" form is explicit on its own. */
export function arpCitedIdents(notam: Notam): string[] {
	let idents = arpCache.get(notam);
	if (!idents) {
		if (!notam.fullContent.includes('ARP')) {
			idents = [];
		} else {
			const own = notam.icaoCodes.map((c) => c.toUpperCase());
			idents = extractArpIdents(
				parseSections(notam.fullContent).E ?? '',
			).filter((i) => !own.includes(i));
		}
		arpCache.set(notam, idents);
	}
	return idents;
}

/** Forward link: the cited aerodromes resolved against the loaded airport
 *  dataset. Unresolved idents are dropped, not rendered muted: a chip that
 *  cannot navigate is noise, and the extractor's prose-word blocklist is
 *  best-effort, so resolution is the real false-positive gate. Reading
 *  dataState.airportsLoaded compensates for the non-reactive airport
 *  index (the ownerResolvers precedent). */
export function arpAirportsForNotam(notam: Notam): Airport[] {
	void dataState.airportsLoaded;
	const out: Airport[] = [];
	for (const ident of arpCitedIdents(notam)) {
		const a = airportByIdent(ident);
		if (a) {
			out.push(a);
		}
	}
	return out;
}

/** Reverse link: ident -> visible NOTAMs citing it by ARP position. Feeds
 *  the airport panel's "Referenced by position" list. */
export function arpNotamsByIdent(): Map<string, IndexedNotam[]> {
	// Local, non-reactive index returned to the caller.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
	const m = new Map<string, IndexedNotam[]>();
	for (const item of filteredNotams()) {
		for (const ident of arpCitedIdents(item.notam)) {
			const arr = m.get(ident);
			if (arr) {
				arr.push(item);
			} else {
				m.set(ident, [item]);
			}
		}
	}
	return m;
}
