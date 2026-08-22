/* Detect AIP SUP references inside NOTAM bodies and turn them into
 * deep links to the SIA PDF. France-only: the SIA URL pattern is
 *
 *   non-AIRAC: lf_sup_<YYYY>_<NNN>_<lang>.pdf
 *   AIRAC:     lf_sup_a_<YYYY>_<NNN>_<lang>.pdf
 *
 * (the `_a_` segment marks AIRAC-cycle SUPs; confirmed live for
 * `lf_sup_2024_096_en.pdf`, `lf_sup_2026_038_fr.pdf`,
 * `lf_sup_a_2025_041_en.pdf`).
 *
 * The IFR sub-series ("AIP SUP IFR 41/24") is recognised but no URL
 * is built: the IFR URL convention isn't confirmed against modern
 * SUPs, so we surface the reference without a link rather than
 * risking 404s.
 *
 * The caller is responsible for gating non-French NOTAMs via
 * isFrenchNotam(); the URL builder doesn't reach into the Notam.
 */

import type { Notam } from './types';
import { isReferenceContext } from './citationContext';

export type AipSupLang = 'fr' | 'en';

/** A detected AIP SUP reference inside a NOTAM body. `raw` is the
 *  exact substring matched (preserved so the inline tokenizer can
 *  splice text/link spans without losing characters); `display` is
 *  the canonical "AIP SUP NNN/YY" form used for the chip label. */
export interface AipSupRef {
	raw: string;
	display: string;
	number: number;
	year: number;        // 4-digit, normalised (25 → 2025)
	series: 'A' | 'IFR'; // 'A' = general; 'IFR' = "AIP SUP IFR N/Y"
	airac: boolean;      // true iff the source text said "AIRAC AIP SUP …"
	start: number;       // index in source text
	end: number;
}

// Optional leading "AIRAC " / "REF ". Then either "AIP SUP" or
// "SUP AIP". Then an optional postfix "AIRAC " (the French word order:
// "SUP AIP AIRAC 004/26", where English briefings write "AIRAC AIP SUP
// 004/26"). Then optional " IFR ". Then NNN/YY or NNN/YYYY.
// Groups: 1 = AIRAC|REF prefix (case-insensitive), 2 = postfix AIRAC,
// 3 = IFR, 4 = number, 5 = year (2 or 4 digits).
const AIP_SUP_RE =
	/\b(AIRAC\s+|REF\s+)?(?:AIP\s+SUP|SUP\s+AIP)\s+(AIRAC\s+)?(IFR\s+)?(\d{1,3})\/(\d{2}|\d{4})\b/gi;

const SIA_BASE =
	'https://www.sia.aviation-civile.gouv.fr/media/store/documents/file/l/f/';

function widenYear(y: number): number {
	return y < 100 ? 2000 + y : y;
}

/** Scan a body for every AIP SUP reference, in source order.
 *  Does not dedup; the caller may want all matches (for inline
 *  tokenisation) or unique displays (for the chip list).
 *
 *  `raw` covers ONLY the citation core ("AIP SUP 108/26" / "SUP AIP
 *  91/24" / "AIP SUP IFR 41/24") — the optional "AIRAC " or "REF "
 *  prefix is captured into `airac` but excluded from `raw`/`start`/
 *  `end`, so the inline tokenizer linkifies just the canonical
 *  citation and leaves the prefix as plain body text. */
export function extractAipSups(text: string): AipSupRef[] {
	if (!text) return [];
	const out: AipSupRef[] = [];
	AIP_SUP_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = AIP_SUP_RE.exec(text)) !== null) {
		const prefix = m[1] ?? '';
		const airac = /^AIRAC/i.test(prefix) || !!m[2];
		const series: 'A' | 'IFR' = m[3] ? 'IFR' : 'A';
		const number = parseInt(m[4], 10);
		const year = widenYear(parseInt(m[5], 10));
		if (!Number.isFinite(number) || !Number.isFinite(year)) continue;
		const display = `AIP SUP ${series === 'IFR' ? 'IFR ' : ''}${m[4]}/${m[5]}`;
		// Trim the AIRAC/REF prefix off the visible link substring; the
		// regex already captured it for the `airac` flag.
		const coreStart = m.index + prefix.length;
		const coreEnd = m.index + m[0].length;
		out.push({
			raw: text.slice(coreStart, coreEnd),
			display,
			number,
			year,
			series,
			airac,
			start: coreStart,
			end: coreEnd,
		});
	}
	return out;
}

/** The AIP SUP citations a NOTAM actually ACTIVATES: extractAipSups minus those
 *  in a reference / exclusion clause (see isReferenceContext). A NOTAM that
 *  creates an inline ZRT and merely cites the SUP it joins ("PUBLISHED BY AIP
 *  SUP 188/25") or excepts ("EXCEPT ... (SUP AIP 215/25)") activates none of
 *  them. The plain "Referenced AIP SUPs" chip list still uses extractAipSups, so
 *  references keep showing; only the activation links narrow to this subset. */
export function extractActivatedSups(text: string): AipSupRef[] {
	return extractAipSups(text).filter((r) => !isReferenceContext(text, r.start));
}

/** SIA PDF URL for an A-series SUP in the requested language.
 *  Returns null for IFR series (URL pattern unverified). The
 *  caller is responsible for gating non-French NOTAMs via
 *  isFrenchNotam. */
export function siaSupUrl(ref: AipSupRef, lang: AipSupLang): string | null {
	if (ref.series !== 'A') return null;
	const seg = ref.airac ? 'lf_sup_a_' : 'lf_sup_';
	return `${SIA_BASE}${seg}${ref.year}_${String(ref.number).padStart(3, '0')}_${lang}.pdf`;
}

/** True iff the NOTAM is published by the SIA. ICAO prefix LF is
 *  unambiguously French (metropolitan + DOM/TOM), so the gate is
 *  permissive: id starts with `LF` OR qualifier.fir starts with `LF`.
 *  The FIR check covers the headerless body form (e.g. R1507/26 with
 *  Q-line `LFXX/...`) where the parser doesn't see an LF prefix on the
 *  id but the qualifier line carries one (LFFF, LFEE, LFRR, LFBB,
 *  LFMM, or LFXX = multi-FIR France). */
export function isFrenchNotam(notam: Notam): boolean {
	if (notam.id && notam.id.startsWith('LF')) return true;
	const fir = notam.qualifier?.fir;
	return fir != null && fir.startsWith('LF');
}
