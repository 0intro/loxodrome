/* Tell an ACTIVATION citation apart from a REFERENCE / EXCLUSION one.
 *
 * An activation NOTAM that creates a new inline temporary zone (ZRT) routinely
 * names pre-existing areas it does NOT activate: the airspaces it replaces
 * "except" some, or the SUP that publishes a neighbouring zone it joins:
 *
 *   "...REPLACES THE OVERLAPPING AIRSPACE PARTS, EXCEPT RESTRICTED AREAS
 *    LF-R400E ... AND LF-R400D ... (SUP AIP 215/25)."          (R0566/26)
 *   "...JOINING THE 'ZRT CESA NORD ETE' PUBLISHED BY AIP SUP 188/25."
 *    "...EXC THE LF-D 18 A4 ... (REF AIP SUP188/25)"            (R1552/26)
 *
 * Those LF-R / AIP SUP citations are references, not things the NOTAM
 * activates; reading them as activation targets falsely lights up the trigger
 * badge and hatches unrelated areas. This module flags such citations so the
 * activation links can drop them while the plain "referenced AIP SUPs" / raw
 * extraction keep listing them. */

// Reference / exclusion keywords that, when they head a citation's clause, mark
// it as something the NOTAM points at rather than activates. English and
// French for the SIA's NOTAMs; Spanish EXCLUSIONS for ENAIRE's ("EXCEPTO",
// "SALVO"). Deliberately NOT "SEGUN": "TRA ... ACTIVADA SEGUN SUP 093/26" is
// how a Spanish NOTAM ACTIVATES a supplement's zone (pinned by
// tests/supaipActivation.spec.ts), the very citation this must keep.
const REFERENCE_RE = /\b(?:EXCEPT(?:ED)?|EXCL\w*|EXC|SAUF|REF|PUBLISHED|PUBLIE\w*|EXCEPTO|SALVO)\b/i;

/** True when the citation starting at `citationStart` sits in a reference or
 *  exclusion clause. Scans back only to the nearest clause boundary (a sentence
 *  period, a label colon, or a numbered section marker like "3-"), so a keyword
 *  in one clause can't bleed into an unrelated citation in the next. */
export function isReferenceContext(text: string, citationStart: number): boolean {
	const before = text.slice(0, citationStart);
	let boundary = before.lastIndexOf(':');
	// A '.' directly followed by a digit is a decimal point ("1.5NM",
	// "RDL 102/1.63NM"), not a sentence boundary; skipping it keeps an
	// EXCEPT/REF keyword earlier in the same clause visible.
	for (const m of before.matchAll(/\.(?!\d)/g)) {
		boundary = Math.max(boundary, m.index);
	}
	for (const m of before.matchAll(/\n\s*\d+\s*[-)]/g)) {
		boundary = Math.max(boundary, (m.index ?? 0) + m[0].length - 1);
	}
	return REFERENCE_RE.test(before.slice(boundary + 1));
}
