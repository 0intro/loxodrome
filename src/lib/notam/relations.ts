/* Cross-NOTAM relations: trigger detection, NOTAMR replacement, REF NOTAM
 * body cross-references. The three pure extractors here run over a parsed
 * Notam's fullContent and return the structural relations to other NOTAMs
 * by id; the calling code (notamLinks.svelte.ts) joins those ids against
 * the loaded NOTAM set to produce live navigation links.
 *
 * Centralising the regex source here keeps the id grammar consistent across
 * the three extractors: any id format added to NOTAM_ID is picked up by all
 * three at once.
 */

import type { Notam } from './types';

/** Match a NOTAM id: optional 4-letter ICAO + hyphen prefix, then a single
 *  letter + 4-or-5 digits + "/" + 2-digit year. Covers the id formats the
 *  fixture corpus uses: A0001/26, R2198/25, LFFA-R2198/25, CYHQ-J0146/26,
 *  P4307/25, etc. */
const NOTAM_ID_SRC = String.raw`(?:[A-Z]{4}-)?[A-Z]\d{4,5}/\d{2}`;

/** A self-identifying trigger phrase only counts as one when it appears at
 *  the head of the E-section (per ICAO convention; e.g. `E) TRIGGER
 *  NOTAM - AIP SUP 147/25 : DRONE FLIGHTS …`). Without this anchor a body
 *  that merely quotes the phrase in prose would false-positive; no
 *  examples in the current corpus, but a permissive `\b…\b` match would
 *  silently misclassify them. The leading `(?:^|\n)` allows the parser's
 *  line-trimmed `fullContent` regardless of preceding sections. */
const TRIGGER_RE = /(?:^|\n)\s*E\)\s*(?:TRIGGER NOTAM|NOTAM TRIGGER)\b/i;

/** NOTAM-id references in the body. The introducer is any of the phrasings
 *  the corpus uses to point at another NOTAM:
 *
 *  - `REF NOTAM <id>`, `REF NOTAM PERM <id>`, `REF : NOTAM PERM <id>`,
 *    `REF PERM NOTAM <id>`, `REF (B) TURKISH NOTAM(S) <id>`; REF with
 *    an optional parenthesised letter and optional country modifier.
 *  - `(ANNOUNCED )?BY NOTAM <id>`; Italian air-display style.
 *  - `SEE NOTAM <id>`, `SEE NOTAM: <id>`, `SEE NEWLY ISSUED NOTAM: <id>`.
 *  - `AS PER NOTAM <id>`; common European inline citation.
 *  - `(PERM NOTAM <id> CHANGED)`; bare PERM NOTAM cross-reference.
 *
 *  After the prefix the regex matches `NOTAM(S)?`, optionally `PERM` /
 *  `:`, then captures the first id. List continuations of the form
 *  `<id>, <id> AND <id>` are picked up by notamReferences' scan loop, so
 *  multi-id references like "REF (B) TURKISH NOTAMS A5935/25, A5936/25
 *  AND A5937/25" all resolve. */
const REF_INTRO_RE = new RegExp(
	String.raw`\b(?:REF(?:\s*\([A-Z]\))?\s*[A-Z]*\s*:?\s*(?:PERM\s+)?|BY\s+|SEE\s+(?:NEWLY\s+ISSUED\s+)?|AS\s+PER\s+|PERM\s+)NOTAMS?(?:\s*:\s*|(?:\s+PERM)?\s+)(${NOTAM_ID_SRC})`,
	'g',
);

/** Continuation pattern after a captured id: `, <id>` or ` AND <id>` or
 *  `, AND <id>`. Used to walk the comma-and-AND list that follows the
 *  initial REF / SEE / AS PER capture. */
const REF_CONT_RE = new RegExp(
	String.raw`^(?:\s*,\s*(?:AND\s+)?|\s+AND\s+)(${NOTAM_ID_SRC})`,
);

/** Walks every introducer match, captures its first id, then sweeps any
 *  comma-and-AND continuation list immediately after. De-duplicates,
 *  preserves first-mention order. */
function collectReferencedIds(text: string, intro: RegExp): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const add = (id: string): void => {
		if (!seen.has(id)) {
			seen.add(id);
			out.push(id);
		}
	};
	for (const m of text.matchAll(intro)) {
		if (m.index === undefined) {
			continue;
		}
		add(m[1]);
		let cursor = m.index + m[0].length;
		while (true) {
			const cont = text.slice(cursor).match(REF_CONT_RE);
			if (!cont) {
				break;
			}
			add(cont[1]);
			cursor += cont[0].length;
		}
	}
	return out;
}

/** True when the NOTAM self-identifies as a trigger NOTAM (English or French
 *  phrasing). Triggers define a framework that later activation NOTAMs
 *  enable; see TRIGGER NOTAM / NOTAM TRIGGER references to "AIP SUP <n>"
 *  in the fixture corpus (e.g. LFFA-R2198/25 → AIP SUP 147/25). */
export function isTriggerNotam(notam: Notam): boolean {
	return TRIGGER_RE.test(notam.fullContent);
}

/** qCode subjects in the airspace-restriction family; restricted (RR),
 *  temporary restricted (RT), danger (RD), prohibited (RP), airspace
 *  reservation (RA), military operating area (RM). A trigger NOTAM with
 *  any of these is genuinely about an activatable restricted area; one
 *  with a different subject (lighting QLETT, friction QFATT, snow QSTTT,
 *  IFR procedure QPITT, obstacle QOBTT, …) is a procedural amendment
 *  template and its trigger semantics don't map to an on-map stripe. */
const RESTRICTED_AREA_SUBJECTS = new Set([
	'RR', 'RT', 'RD', 'RP', 'RA', 'RM',
]);

/** True iff the NOTAM's qCode subject (chars 1–3 after the leading Q) is
 *  in the restricted-area family. Used together with isTriggerNotam to
 *  qualify a NOTAM for the map's diagonal-hatch overlay; both signals
 *  must hold so non-airspace triggers (procedural amendments) don't
 *  stripe. */
export function hasRestrictedAreaSubject(notam: Notam): boolean {
	if (notam.qCode.length < 3 || notam.qCode[0] !== 'Q') {
		return false;
	}
	return RESTRICTED_AREA_SUBJECTS.has(notam.qCode.slice(1, 3));
}

/** Returns the id of the NOTAM this one replaces (from the NOTAMR header),
 *  or null. Reads parseNotams' structured `replaces` field; no peeking
 *  at fullContent, so this is robust to future changes in how the parser
 *  preserves (or doesn't) the predecessor token in the body text. */
export function notamReplacement(notam: Notam): string | null {
	return notam.replaces;
}

/** Every NOTAM id referenced in the body via any of the introducers in
 *  REF_INTRO_RE; broad: catches REF, SEE, AS PER, BY, PERM and the
 *  parenthesised letter / country variants. Suitable for the detail
 *  panel's "References" / "Referenced by" lists. */
export function notamReferences(notam: Notam): string[] {
	return collectReferencedIds(notam.fullContent, REF_INTRO_RE);
}
