/* A search query prepared once for every candidate it is matched against
 * (src/lib/search/match.ts). Pure and locale-free. */

import { foldText, foldWords, wordAlternatives } from './fold';

export interface PreparedQuery {
	/** As typed, trimmed. */
	readonly raw: string;
	/** Upper-cased, for identifiers ("LFPN", "BAILY LIGHTHOUSE"). */
	readonly upper: string;
	/** Upper-cased letters, digits and dots alone, for designators: "LF-R 45 A"
	 *  and "LFR45A" are one; a dataset id may carry a dot (LFR45S6.1). */
	readonly compact: string;
	/** The fold, for substrings ("saint et" inside "saint etienne"). */
	readonly words: string;
	/** The fold with Saint written out, for a whole name. */
	readonly exact: string;
	/** Per word, the words it may stand for; every word must match. */
	readonly tokens: readonly (readonly string[])[];
}

export function prepareQuery(raw: string): PreparedQuery {
	const r = raw.trim();
	const upper = r.toUpperCase();
	const words = foldWords(r);
	return {
		raw: r,
		upper,
		compact: upper.replace(/[^A-Z0-9.]/g, ''),
		words,
		exact: foldText(r),
		tokens: words ? words.split(' ').map(wordAlternatives) : [],
	};
}
