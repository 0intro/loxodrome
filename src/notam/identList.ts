/* The aerodrome box's text, as a list of ICAO idents.
 *
 * The one input this app asks for beyond a pasted briefing: "LFPL LFPK LFFZ LFQB" and
 * every reasonable spelling of it. Separators are whatever a pilot types
 * between two idents, which in practice is a space, a comma, a slash, a dash
 * or a newline copied out of something else.
 *
 * Deliberately strict on the SHAPE: exactly four letters. A three-letter IATA
 * code or a typo would be sent to a briefing service that answers nothing for
 * it, and silently briefing one aerodrome when two were asked for is the
 * failure worth refusing. What is dropped is reported, so the caller can say
 * which word it did not understand.
 */

const ICAO = /^[A-Z]{4}$/;

export interface IdentList {
	/** The valid idents, upper-cased, in the order typed, deduplicated. */
	idents: string[];
	/** The words that were not idents, verbatim, for the caller to name. */
	rejected: string[];
}

export function parseIdentList(text: string): IdentList {
	const idents: string[] = [];
	const rejected: string[] = [];
	// A local dedup index, not reactive state.
	const seen = new Set<string>();
	for (const word of text.split(/[\s,;/]+/)) {
		if (word === '') {
			continue;
		}
		const up = word.toUpperCase();
		if (!ICAO.test(up)) {
			rejected.push(word);
			continue;
		}
		if (!seen.has(up)) {
			seen.add(up);
			idents.push(up);
		}
	}
	return { idents, rejected };
}
