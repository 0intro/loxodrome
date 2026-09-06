/* One parse of a NOTAM's ICAO sections per NOTAM, for the callers that hold
 * the parsed object rather than the raw text.
 *
 * parseSections() is a pure function of a string and stays that way (the
 * parser calls it while building each Notam, and tests call it directly with
 * raw text). The problem it does not solve is repetition: a dozen link
 * modules, the RTBA reader and four detail components each re-ran the whole
 * section scan over the same fullContent, and isRtbaActivationNotam() does it
 * once per activation NOTAM inside a selector that used to run on every
 * mouse move. Profiled at 347 ms of a 120-move sweep, more than any other
 * single function.
 *
 * A WeakMap keyed on the Notam rather than a field on the type: the Notam
 * interface has no optional fields and several specs build one as a complete
 * literal, so an added field would break them, while others omit fullContent
 * entirely (hence the ?? ''). Keying on the object also means a re-parse of
 * the same briefing hands out fresh Notams and therefore a fresh cache, with
 * the old entries collectable.
 *
 * A multi-area NOTAM is several Notam objects sharing one id and one text, so
 * each parses once; that is a handful of extra parses per briefing against a
 * per-call scan of every one of them. */

import { parseSections } from './parser';
import type { Notam, NotamSections } from './types';

const cache = new WeakMap<Notam, NotamSections>();

/** This NOTAM's ICAO sections, parsed once and remembered. */
export function notamSections(notam: Notam): NotamSections {
	let s = cache.get(notam);
	if (!s) {
		s = parseSections(notam.fullContent ?? '');
		cache.set(notam, s);
	}
	return s;
}

/** The E) free text, the section nearly every caller wants; '' when absent. */
export function notamEText(notam: Notam): string {
	return notamSections(notam).E ?? '';
}
