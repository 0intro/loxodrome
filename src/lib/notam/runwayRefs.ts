/* Runway designators cited in a NOTAM body.
 *
 * Aerodrome NOTAMs routinely scope themselves to runways ("RWY04L",
 * "RWY 03/21", "PISTES 23 ET 29", "THR 27", "SEUIL 09"); extracting the
 * designators lets the airport panel badge the affected runway rows.
 * Keyword-anchored, English and French forms, so bare numbers, flight
 * levels, frequencies and dates can never match. Pure; matching against an
 * airport's runway table is component-local in AirportDetail. */

// French surface and traffic adjectives sit between the keyword and the
// designator: "PISTE NON REVETUE 03R/21L", "PISTES REVETUES 07/25 ET
// 15/33", "PISTE EN HERBE 05L/23R", "PISTE NON REVETUE AVION 03R/21L".
// PAPI is anchored too: it is always a runway-end aid ("MISE EN SERVICE
// PAPI 27" / "PAPI RWY 27").
const KEYWORD = String.raw`(?:RWY|RUNWAY|PISTE|DTHR|THR|SEUIL|PAPI)S?(?:\s+NON)?(?:\s+REVETUES?)?(?:\s+EN\s+HERBE)?(?:\s+AVIONS?)?`;
// A designator never borrows the first letter of a following word and never
// extends into more digits ("RWY 100M" must not yield "10"). The dash
// separator covers the French AMDT phrasing "RWY 12-30 DEVIENT 11-29".
const DESIG = String.raw`\d{1,2}[LRC]?(?![A-Z0-9])`;
const SEP = String.raw`\s*(?:\/|,|-|ET|AND|&)\s*`;
const RUNWAY_RE = new RegExp(
	String.raw`\b${KEYWORD}\s*:?\s*(${DESIG}(?:${SEP}${DESIG})*)`,
	'g',
);
// The reversed English form puts the list before the keyword:
// "UNPAVED 08L/26R RWY RESERVED ...". A lone bare number is NOT accepted
// here: an English count phrase ("WORK ON 2 RWYS") would read as runway 02,
// so the designator must carry a parallel suffix or sit in a list
// ("exact or nothing", docs/notam-relationships.md).
const DESIG_SUFFIXED = String.raw`\d{1,2}[LRC](?![A-Z0-9])`;
const RUNWAY_PRE_RE = new RegExp(
	String.raw`\b(${DESIG}(?:${SEP}${DESIG})+|${DESIG_SUFFIXED})\s+(?:RWY|RUNWAY|PISTE)S?\b`,
	'g',
);
const SPLIT_RE = /\s*(?:\/|,|-|ET|AND|&)\s*/;

/** Canonical runway designator: zero-padded two digits + optional upper
 *  L/R/C suffix ("4L" -> "04L", "9" -> "09"). Inputs outside that shape
 *  come back trimmed and upper-cased unchanged. */
export function normalizeRunwayDesignator(raw: string): string {
	const t = raw.trim().toUpperCase();
	const m = /^(\d{1,2})([LRC]?)$/.exec(t);
	if (!m) {
		return t;
	}
	return m[1].padStart(2, '0') + m[2];
}

/** Distinct normalised runway designators cited in an E) text, in document
 *  order. List continuations expand ("PISTES 23 ET 29", "RWY 22L/22R",
 *  "RWY 18/36 AND 09/27"). */
export function extractRunwayDesignators(eText: string): string[] {
	const text = eText.toUpperCase();
	const found: { d: string; index: number }[] = [];
	for (const re of [RUNWAY_RE, RUNWAY_PRE_RE]) {
		for (const m of text.matchAll(re)) {
			for (const part of m[1].split(SPLIT_RE)) {
				const d = normalizeRunwayDesignator(part);
				if (d) {
					found.push({ d, index: m.index ?? 0 });
				}
			}
		}
	}
	found.sort((a, b) => a.index - b.index);
	const out: string[] = [];
	const seen = new Set<string>();
	for (const f of found) {
		if (!seen.has(f.d)) {
			seen.add(f.d);
			out.push(f.d);
		}
	}
	return out;
}
