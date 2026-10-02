/* Names a document answers to inside an AIP pack.
 *
 * The pack is built by cmd/aipdocs from the SAME committed datasets the
 * panels read, so both sides derive an entry name from the same row by the
 * same rule and cannot disagree about what the pack holds. These functions
 * are that rule on the app's side; cmd/aipdocs/enumerate.go is its twin, and
 * tests/aipDocs.spec.ts pins them against the shapes it produces.
 *
 * Pure and locale-free. */

import type { SupAip } from '$lib/data/supaip';
import type { VacAtlas } from '$lib/data/airports';

/** Atlas VAC sections: 2 is the aerodrome product (keyed by ICAO), 3 the
 *  helistation one (keyed by the SIA codeId). A membership of "both" means
 *  the ident has a plate in each. */
export type VacSection = 2 | 3;

/** The sections one membership token covers. */
export function vacSections(vac: VacAtlas | null): VacSection[] {
	switch (vac) {
		case 'ad':
			return [2];
		case 'hel':
			return [3];
		case 'both':
			return [2, 3];
		default:
			return [];
	}
}

/** Entry name of one Atlas VAC plate. Mirrors aip.SIAVacPlateName. */
export function vacDocName(code: string, section: VacSection): string {
	return `AD-${section}.${code.toUpperCase()}.pdf`;
}

/** The plate a panel should offer for an ident, given its membership and
 *  whether the row is a helistation. Null when the atlas carries neither. */
export function vacDocNameFor(
	code: string,
	vac: VacAtlas | null,
	heliport: boolean,
): string | null {
	const sections = vacSections(vac);
	if (sections.length === 0) {
		return null;
	}
	// "both" offers the product matching the row's own kind, which is what
	// the panel's primary chart link already picks.
	const section = sections.includes(heliport ? 3 : 2) ? (heliport ? 3 : 2) : sections[0];
	return vacDocName(code, section);
}

/** Entry name of one AIP supplement in the wanted language.
 *
 * A row with no PDF in that language falls back to the other, exactly as
 * cmd/aipdocs does when it packs them: seven metropolitan supplements have
 * no English translation, and dropping them from an English pack would omit
 * restrictions that are in force. Null when the row has no PDF at all. */
export function supDocName(sup: Pick<SupAip, 'urlPdf' | 'urlPdfEn'>, lang: 'fr' | 'en'): string | null {
	const primary = lang === 'en' ? sup.urlPdfEn : sup.urlPdf;
	const fallback = lang === 'en' ? sup.urlPdf : sup.urlPdfEn;
	const url = primary || fallback;
	if (!url) {
		return null;
	}
	const base = url.split('/').pop() ?? '';
	return base || null;
}
