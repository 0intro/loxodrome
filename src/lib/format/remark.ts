/* Present a SIA AIP free-text remark for one UI locale. The SIA AIXM export
 * encodes a bilingual remark as "French version\\English version" (two
 * backslashes, per the export readme, BMJ 08/2025) and uses '#' for
 * intra-language line breaks. This is the single chokepoint that picks the
 * language side and normalises the breaks for the detail panels: pure and
 * locale-free (it takes the resolved language as a parameter, so vitest pins
 * both sides). */

import type { Locale } from '$lib/i18n/locale';

/** The FR/EN separator: two backslashes, absorbing any surrounding whitespace
 *  (some source strings write it spaced as " \\ "). In a JS regexp `\\\\` is
 *  two literal backslash characters. */
const SEPARATOR = /\s*\\\\\s*/;

/** Render a possibly-bilingual AIP remark in `lang`.
 *
 *  A remark carrying the "French\\English" separator is split and the side
 *  matching `lang` is kept (falling back to the other side when the chosen one
 *  is empty, as `SupAipDetail` falls back for a missing subject). A remark
 *  without the separator is single-language and returned unchanged. In both
 *  cases '#' becomes a newline for the `white-space: pre-line` block that
 *  renders it, a '#' against a line break being ONE break (the export writes
 *  "#\n" in 975 obstacle and airspace remarks, and "\n#" too); the result is
 *  trimmed so a '#' sitting against the separator (`...DIZIER.#\\SR-...`)
 *  leaves no trailing blank line. */
export function formatAipRemark(raw: string, lang: Locale): string {
	const parts = raw.split(SEPARATOR);
	let text = raw;
	if (parts.length >= 2) {
		const fr = parts[0].trim();
		const en = parts.slice(1).join(' ').trim();
		text = lang === 'fr' ? fr || en : en || fr;
	}
	return text.replace(/\r\n?/g, '\n').replace(/#\n|\n#|#/g, '\n').trim();
}

// How the SIA opens a reporting point's remark: "VRP-", at times "VRP - ".
const VRP_PREFIX = /^\s*VRP\s*-\s*/i;
// A sentence's end: a period after two characters at least, so an initial
// ("G. Roussy Hospital") ends none.
const SENTENCE_END = /(?<=\S{2})\.(?:\s|$)/;

/** A French VFR reporting point's landmark, from its remark: what follows
 *  "VRP-" up to the first '#' break (a bare newline being the export's soft
 *  wrap), its first sentence, without a final period. "VRP-Pointe au
 *  Sel.#Max ALT 2000 ft AMSL when IFR present." is "Pointe au Sel"; ''
 *  when the remark names none ("VRP-", or no "VRP-" at all). */
export function vrpLandmark(rmk: string): string {
	const m = VRP_PREFIX.exec(rmk);
	if (!m) {
		return '';
	}
	const line = rmk.slice(m[0].length).split('#', 1)[0].replace(/\s+/g, ' ');
	const end = SENTENCE_END.exec(line);
	return (end ? line.slice(0, end.index) : line).trim().replace(/\.$/, '');
}
