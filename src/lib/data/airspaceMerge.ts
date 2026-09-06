/* airspaceMerge.ts merges the per-source airspace datasets into the one
 * list the app renders. Pure; unit-tested in tests/airspaceMerge.spec.ts. */

import { firIdent, type Airspace } from './airspaces';

/** Merge the per-source airspace lists with per-source precedence: the
 *  caller passes them highest priority first (France > UK > Spain >
 *  Belgium > Germany > pruatlas > FAA). A row is dropped iff its dedup
 *  key already appears in a HIGHER-priority source: such a collision is
 *  a republication of the same volume set (the pruatlas LFFF ring vs
 *  the SIA's, the Belgian AIP's copy of LFR616L), and the
 *  higher-resolution local AIP wins.
 *
 *  The key is the raw id, EXCEPT for FIR-family rows (category 'fir'),
 *  which dedupe by their ICAO indicator via `firIdent`: NATS files the
 *  London / Scottish FIRs under suffixed ids (EGTT001), so a raw-id
 *  match would never connect them to pruatlas's bare EGTT ring and the
 *  boundary would draw twice. A FIR-family row with no four-letter head
 *  (fr OCA4521) falls back to its raw id.
 *
 *  Same-id siblings WITHIN one source are never dropped: publishers file
 *  distinct volumes and multi-piece rings under one designator (ENAIRE's
 *  FIR + UIR + TMA all under LECM / LECB / GCCC, the two UIR CANARIAS
 *  parts, ELMIRA TRSA's three altitude-banded rings, KZNY's sub-pieces),
 *  so each source's own ids gate only the sources BELOW it, snapshot
 *  semantics: the ids join the seen-set after the whole source is
 *  filtered, never while it is being scanned.
 *
 *  `Airspace.key` defaults to `id|name`, which still collides for the
 *  several-rings-per-name rows above; duplicates get a `#N` suffix so
 *  each ring addresses its own panel entry (selection, highlight,
 *  ui.detail). The first occurrence keeps the clean key. Key mutation
 *  happens here so every consumer sees the final keys. */
export function mergeAirspaces(sources: Airspace[][]): Airspace[] {
	const dedupKey = (sp: Airspace): string =>
		sp.category === 'fir' ? (firIdent(sp) ?? sp.id) : sp.id;
	const merged: Airspace[] = [];
	const seenIds = new Set<string>();
	for (const source of sources) {
		const kept = source.filter((sp) => !seenIds.has(dedupKey(sp)));
		for (const sp of kept) {
			merged.push(sp);
		}
		for (const sp of kept) {
			seenIds.add(dedupKey(sp));
		}
	}
	const keyCounts = new Map<string, number>();
	for (const sp of merged) {
		const n = (keyCounts.get(sp.key) ?? 0) + 1;
		keyCounts.set(sp.key, n);
		if (n > 1) {
			sp.key = `${sp.key}#${n}`;
		}
	}
	return merged;
}
