/* The aerodrome box's text, as a list of ICAO idents, and the SOFIA routes
 * that brief them.
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

import type { NarrowRoutePoint } from '$lib/sofia/client';
import type { SofiaTrack } from '$lib/sofia/fetch';
import type { LatLon } from '$lib/notam/types';

const ICAO = /^[A-Z]{4}$/;

export interface IdentList {
	/** The valid idents, upper-cased, in the order typed: a chain, so an
	 *  ident repeated after another stays (a circuit's return), and only one
	 *  repeating itself is dropped. */
	idents: string[];
	/** The words that were not idents, verbatim, for the caller to name. */
	rejected: string[];
}

export function parseIdentList(text: string): IdentList {
	const idents: string[] = [];
	const rejected: string[] = [];
	for (const word of text.split(/[\s,;/-]+/)) {
		if (word === '') {
			continue;
		}
		const up = word.toUpperCase();
		if (!ICAO.test(up)) {
			rejected.push(word);
			continue;
		}
		if (idents[idents.length - 1] !== up) {
			idents.push(up);
		}
	}
	return { idents, rejected };
}

/** The SOFIA routes that brief `idents`: one per consecutive pair, labelled
 *  by its two ends, so every named aerodrome is an END of a narrow-route PIB.
 *  A pair already asked, either way round (an out-and-back), is asked once:
 *  the corridor is the same.
 *
 *  SOFIA briefs the first and last aerodromes of `route[]` fully and the ones
 *  between about six times more thinly (docs/notam-audit-2026-09.md section
 *  5: 175 of 1,010 NOTAMs filed under an intermediate aerodrome came back,
 *  262 of 266 under an end). The pairs corridor the same legs as the chain
 *  sent whole, and briefFromSofia merges them, a NOTAM two pairs share
 *  counted once.
 *
 *  A single ident goes out at both ends, [A, A]: SOFIA reads the first and
 *  last tokens as the departure and destination, and a one-token route is
 *  not a PIB.
 *
 *  Each track carries its drawn path where `place` places both ends, the
 *  record of what was asked, by which the airport panel tells a field
 *  outside the corridors. */
export function sofiaTracks(idents: readonly string[], place: (ident: string) => LatLon | null): SofiaTrack[] {
	const point = (token: string): NarrowRoutePoint => ({ token, aerodrome: true });
	const track = (label: string, from: string, to: string): SofiaTrack => {
		const a = place(from);
		const b = place(to);
		return { label, points: [point(from), point(to)], ...(a && b ? { path: [a, b] } : {}) };
	};
	if (idents.length === 1) {
		return [track(idents[0], idents[0], idents[0])];
	}
	const out: SofiaTrack[] = [];
	// A local dedup index, not reactive state.
	const asked = new Set<string>();
	for (let i = 1; i < idents.length; i++) {
		const from = idents[i - 1];
		const to = idents[i];
		if (asked.has(`${from}-${to}`) || asked.has(`${to}-${from}`)) {
			continue;
		}
		asked.add(`${from}-${to}`);
		out.push(track(`${from}-${to}`, from, to));
	}
	return out;
}
