/* Aerodrome references cited in a NOTAM body by ARP anchor.
 *
 * French P-series obstacle NOTAMs file under the FIR (Item A) = LFFF ...)
 * yet pinpoint their position against an aerodrome reference point: "GRUE A
 * TOUR ERIGEE PROCHE AD 'SAINT CYR L'ECOLE' - RDL 194/0.25NM ARP LFPZ". The
 * ARP ident is the one explicit machine-readable aerodrome reference in
 * those bodies (the quoted AD name occurs alone exactly once in the corpus),
 * so the airport link extracts idents only, in both observed orders:
 * "ARP LFPZ" and "LFGH ARP". Pure; notamAirportLinks.svelte.ts resolves the
 * idents against the loaded airport dataset.
 */

/** Four-letter prose words adjacent to "ARP" in real or plausible briefing
 *  text that are not idents: "0.4NM FROM ARP", "ARP WITH ...", "ARP ELEV
 *  351FT", "ARP WIND TURBINES", "ALSO ARP ...". Longer words (TOWARDS) are
 *  already excluded by the word boundary, and the UI only links idents that
 *  resolve against the airport dataset, so this list just keeps extraction
 *  counts honest. */
const ARP_BLOCKLIST = new Set([
	'FROM', 'WITH', 'ELEV', 'WIND', 'OBST', 'AXIS', 'ALSO', 'NEAR', 'THEN',
	'THIS', 'THAT', 'AREA', 'ZONE', 'DANS', 'AVEC', 'SANS', 'POUR', 'VERS',
	'DONT',
]);

const ARP_AFTER_RE = /\bARP\s+([A-Z]{4})\b/g;
const ARP_BEFORE_RE = /\b([A-Z]{4})\s+ARP\b/g;
// The English word order spells the aerodrome name out between the ident
// and "ARP" ("RDL 102/1.63NM LFSB BALE MULHOUSE ARP", "LFRZ 'SAINT NAZAIRE
// MONTOIR' ARP"); the distance unit anchors the ident so prose words can't
// pose as one. No \b before NM: it follows the distance digits directly.
const ARP_NM_GAP_RE =
	/NM\s+([A-Z]{4})(?:\s+['(]?[A-Z][A-Z'()-]*){1,5}\s+ARP\b/g;

/** Distinct 4-letter idents cited as an ARP anchor in an E) text, in
 *  first-mention order across the observed phrasings: "ARP LFPZ",
 *  "LFGH ARP", and the named English form "...NM LFSB BALE MULHOUSE ARP".
 *  A name tail inside a named anchor ("SAINT-MALO ARP") never reads as an
 *  ident of its own: the simple adjacency forms are suppressed inside any
 *  named-anchor span. */
export function extractArpIdents(eText: string): string[] {
	const text = eText.toUpperCase();
	const found: { ident: string; index: number }[] = [];
	const spans: { start: number; end: number }[] = [];
	for (const m of text.matchAll(ARP_NM_GAP_RE)) {
		const start = m.index ?? 0;
		spans.push({ start, end: start + m[0].length });
		if (!ARP_BLOCKLIST.has(m[1])) {
			found.push({ ident: m[1], index: start });
		}
	}
	for (const re of [ARP_AFTER_RE, ARP_BEFORE_RE]) {
		for (const m of text.matchAll(re)) {
			const index = m.index ?? 0;
			if (ARP_BLOCKLIST.has(m[1])) {
				continue;
			}
			if (spans.some((s) => index >= s.start && index < s.end)) {
				continue;
			}
			found.push({ ident: m[1], index });
		}
	}
	found.sort((a, b) => a.index - b.index);
	const out: string[] = [];
	const seen = new Set<string>();
	for (const f of found) {
		if (!seen.has(f.ident)) {
			seen.add(f.ident);
			out.push(f.ident);
		}
	}
	return out;
}
