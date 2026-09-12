/* Shared loader for the bilingual world briefing fixtures. */

import { readFileSync } from 'node:fs';
import { parseNotams } from '$lib/notam';
import type { Notam } from '$lib/notam';

/** The France-area blocks (Q) FIR LF*) of a world briefing fixture, parsed.
 *  Pre-filtering the RAW text is mandatory: parseNotams keeps only the first
 *  occurrence of each bare NOTAM id, and ids collide across states in a
 *  world file (A0188/26 exists at KJAX and at LFPG; a Polish E1767/26
 *  shadows the French one). Splitting on the NOTAM HEADER, not on blank
 *  lines, keeps consecutive entries apart even when the briefing omits the
 *  separator line; within the France subset ids are then unique. */
export function parseFranceSubset(fixture: string): Notam[] {
	const text = readFileSync(
		new URL(`./fixtures/${fixture}`, import.meta.url),
		'utf-8',
	);
	const blocks = text
		.split(/\n(?=[A-Z]\d{4}\/\d{2} NOTAM[NRC]\b)/)
		.filter((b) => /(^|\n)Q\)\s*LF/.test(b));
	return parseNotams(blocks.join('\n\n'));
}

/** The France entries of ANY briefing layout, selected by the PARSED Q-line
 *  FIR: the 20260207 / 20260512 fixtures carry prefixed ids
 *  ("LFFA-W2578/25") that parseFranceSubset's bare-id splitter cannot cut,
 *  and the LFRR FIR legitimately contains Channel Islands NOTAMs issued
 *  under EG series. Returns EVERY entry (multi-area NOTAMs keep their
 *  sibling entries); dedupe with byId where one row per source is wanted. */
const franceByFirCache = new Map<string, Notam[]>();
export function parseFranceByFir(fixture: string): Notam[] {
	let list = franceByFirCache.get(fixture);
	if (!list) {
		const text = readFileSync(
			new URL(`./fixtures/${fixture}`, import.meta.url),
			'utf-8',
		);
		list = parseNotams(text).filter((n) =>
			(n.qualifier?.fir ?? '').startsWith('LF'),
		);
		franceByFirCache.set(fixture, list);
	}
	return list;
}

/** One representative entry per source NOTAM id (multi-area NOTAMs emit
 *  several entries sharing an id; the first carries the same header data). */
export function byId(notams: Notam[]): Map<string, Notam> {
	const m = new Map<string, Notam>();
	for (const n of notams) {
		if (!m.has(n.id)) {
			m.set(n.id, n);
		}
	}
	return m;
}
