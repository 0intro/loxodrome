/* Special-use airspace designator grammar: extraction and canonical keys.
 *
 * Home of every NOTAM-body designator pattern, so the activation link
 * (extractAirspaceIds, FR-only by design) and the broader citation link
 * (extractCitedDesignators, FR / UK / ES) share one module. Pure; the
 * state layer in notamLinks.svelte.ts wires the results to loaded rows.
 */

import { PUBLISHER_TABLE, firPublisher, type NotamPublisher } from '$lib/data/publishers';

/** French SIA prefixes (LF mainland + DOM/TOM); add more if other AIPs land in
 *  airspaces.json with the same R/D/P/A/M letter convention. Optional hyphen
 *  between the prefix and the subject letter; NOTAM text typically has
 *  "LF-R45A" while the JSON's codeId is "LFR45A". */
export const AIRSPACE_ID_RE = /\b(LF|TF|NT|NW|SO|FM)[\s-]?([RPDMA])[\s-]?(\d{1,4}[A-Z]*)\b/g;

/** Pulls every special-use airspace code mentioned in `text` (typically a
 *  NOTAM's fullContent), normalised to the codeId convention used by
 *  airspaces.json. Returns the codes in first-mention order, de-duplicated.
 *  Exported for the activation spec; not part of the public state API. */
export function extractAirspaceIds(text: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const m of text.matchAll(AIRSPACE_ID_RE)) {
		const id = m[1] + m[2] + m[3];
		if (!seen.has(id)) {
			seen.add(id);
			out.push(id);
		}
	}
	return out;
}

/** The SIA also writes a zone's sub-lettering DETACHED from its number, one
 *  designator carrying several: "LF-R368 A B C1 C2 ACTIVATED",
 *  "LF-D596 A/B/C ACTIVATED", "AREAS LF-R6 B, LF-R6 C, LF-R6 D". The codeId
 *  convention glues the suffix to the digits, so AIRSPACE_ID_RE reads the
 *  whole run as the suffix-less parent, which is not a row of its own: the
 *  sub-zones are never activated at all.
 *
 *  These are CANDIDATES, not ids. A lone letter after a number is ordinary
 *  prose too, so the caller confirms each against the loaded dataset before
 *  acting on it, the way a route file's identifiers stay candidates until the
 *  app's own data agrees they name a place. The suffix token is one letter
 *  plus an optional digit and is never one followed by a number, which is what
 *  keeps a vertical limit ("LF-R45 A 3000FT AMSL", "up to") from reading as a
 *  sub-zone. The run may also be parenthesised, which is how the same lists
 *  are printed at Avord and Mont-de-Marsan ("LF-R20 (B1, B2, B3, B4, B5, H1,
 *  H3, H4)", "LF-R31 (A1, A2, A3, A4, A5, A6 ,A7, H)"). */
const SPACED_SUBZONE_RE =
	/\b(LF|TF|NT|NW|SO|FM)-?([RPDMA])\s?(\d{1,4})\s*\(?((?:\s*(?:,|\/|ET|AND)?\s*[A-Z][0-9]?\b(?!\s*\d))+)/g;

/** Every detached sub-zone candidate in `text`, with the index its
 *  designator started at so the caller can apply the reference-clause test.
 *  De-duplicated, first-mention order. */
export function extractSpacedSubZoneIds(text: string): { id: string; index: number }[] {
	const out: { id: string; index: number }[] = [];
	const seen = new Set<string>();
	for (const m of text.matchAll(SPACED_SUBZONE_RE)) {
		for (const token of m[4].split(/[^A-Z0-9]+/)) {
			if (!token || token === 'ET' || token === 'AND') {
				continue;
			}
			const id = m[1] + m[2] + m[3] + token;
			if (!seen.has(id)) {
				seen.add(id);
				out.push({ id, index: m.index ?? 0 });
			}
		}
	}
	return out;
}

/** The French half of a NOTAM drops the prefix once it has written it, and
 *  sometimes never writes it at all: "LF-R65-R66 ET D67" where the English
 *  half writes "LF-R65, LF-R66 AND LF-D67" (M2542/26), and "ZONES CONCERNEES
 *  : R20 (B1, B2, B3, B4, B5, H1, H3, H4)" where the English writes "LF-R20
 *  (...)" (M3249/26). A prefix-less designator is collision-prone on its own,
 *  which is why this returns CANDIDATES: the caller confirms each against the
 *  loaded rows, and a bare one is only read after a ZONE / AREA anchor or as
 *  the continuation of a designator already written in full.
 *
 *  The suffix run of each head is read too, so "R20 (B1, B2)" yields the
 *  sub-zones and not just the parent. */
const CONTINUATION_RE =
	/\b(?:LF|TF|NT|NW|SO|FM)[\s-]?([RPDMA])[\s-]?\d{1,4}[A-Z]*((?:(?:\s*[-,/]\s*|\s+(?:ET|AND)\s+)(?:[RPDMA][\s-]?)?\d{1,4}[A-Z]{0,3})+)/g;
const CONTINUATION_ITEM_RE = /(?:\s*[-,/]\s*|\s+(?:ET|AND)\s+)(?:([RPDMA])[\s-]?)?(\d{1,4}[A-Z]{0,3})/g;
const BARE_AFTER_ANCHOR_RE =
	/\b(?:ZONES?|AREAS?)\b[^.\n]{0,40}?\b([RPDMA])\s?(\d{1,4})\b/g;
/** A run of detached sub-zone letters, as SPACED_SUBZONE_RE reads it. */
const SUFFIX_RUN_RE = /^\s*\(?((?:\s*(?:,|\/|ET|AND)?\s*[A-Z][0-9]?\b(?!\s*\d))+)/;

function suffixIds(text: string, from: number, head: string, out: { id: string; index: number }[], seen: Set<string>): void {
	const run = SUFFIX_RUN_RE.exec(text.slice(from));
	if (!run) {
		return;
	}
	for (const token of run[1].split(/[^A-Z0-9]+/)) {
		if (!token || token === 'ET' || token === 'AND') {
			continue;
		}
		const id = head + token;
		if (!seen.has(id)) {
			seen.add(id);
			out.push({ id, index: from });
		}
	}
}

/** Prefix-less designator candidates: continuations of a written designator,
 *  and bare ones after a ZONE / AREA anchor. Each with the index it was
 *  found at, so the caller can apply the reference-clause test. */
export function extractBareDesignatorIds(text: string): { id: string; index: number }[] {
	const out: { id: string; index: number }[] = [];
	const seen = new Set<string>();
	for (const m of text.matchAll(CONTINUATION_RE)) {
		const headLetter = m[1];
		const tailAt = (m.index ?? 0) + m[0].length - m[2].length;
		CONTINUATION_ITEM_RE.lastIndex = 0;
		for (const item of m[2].matchAll(CONTINUATION_ITEM_RE)) {
			const id = `LF${item[1] ?? headLetter}${item[2]}`;
			if (!seen.has(id)) {
				seen.add(id);
				out.push({ id, index: tailAt });
			}
		}
	}
	for (const m of text.matchAll(BARE_AFTER_ANCHOR_RE)) {
		const head = `LF${m[1]}${m[2]}`;
		if (!seen.has(head)) {
			seen.add(head);
			out.push({ id: head, index: m.index ?? 0 });
		}
		suffixIds(text, (m.index ?? 0) + m[0].length, head, out, seen);
	}
	return out;
}

/** Map a NOTAM Q-line FIR (ICAO) to the airspace dataset publisher whose rows
 *  it may concern, so a French "SEINE" can never match a UK / ES row. FR
 *  covers mainland LF* plus the DOM / TOM FIRs shipped in fr-airspaces.json
 *  (TF*, SO*, NT*, NW*, FM*). Returns null for FIRs we carry no organisation
 *  dataset for (FAA / pruatlas use different nomenclature) → no name link.
 *  Each publisher's FIR prefixes are its row in the publisher registry
 *  ($lib/data/publishers, pure, so the parser core imports no state). */
export function firToPublisher(fir: string): NotamPublisher | null {
	return firPublisher(fir);
}

/** The publisher a NOTAM's text is read against: its Q-line FIR's, else,
 *  where that FIR is one no dataset here belongs to, its A) location
 *  indicators'. The SIA files the French Antilles under Q) TTZP, the Piarco
 *  FIR their airspace lies in, with A) TFFF, and read by the FIR alone every
 *  Antilles zone went unread: TF-R5 activated nothing. A NOTAM whose FIR and
 *  locations both belong to another State (a US TFR, the Trinidad half of
 *  Piarco) stays unread, which is what the FIR gate is for. */
export function notamPublisher(fir: string, locations: readonly string[] = []): ReturnType<typeof firToPublisher> {
	const own = firToPublisher(fir);
	if (own) {
		return own;
	}
	for (const loc of locations) {
		const p = firToPublisher(loc);
		if (p) {
			return p;
		}
	}
	return null;
}

/* Designator grammar per publisher. The dataset ids and the NOTAM citations
 * disagree on padding and spacing (uk-airspaces.json has "EGD006A" where the
 * NOTAM cites "EGD6A" or "EG D298B"; es rows are unpadded "LED36"), so both
 * sides reduce to a canonical key before comparing. */
const DESIGNATOR_PREFIXES = [
	...new Set(PUBLISHER_TABLE.flatMap((p): readonly string[] => (p.id === 'fr' ? p.firs : p.cites))),
];
const DESIGNATOR_KEY_RE = new RegExp(
	`^(${DESIGNATOR_PREFIXES.join('|')})[\\s-]?([RPDMA])[\\s-]?(\\d{1,4})([A-Z]*(?:\\.\\d+)?|[A-Z]+\\d)$`,
);

/* A temporary area designated after the State's prefix: ROMATSA's "LRTRA27L"
 * and "LRTSA1", LPS SR's "LZTSA1Z", LVNL's "EHTRA12", LFV's "ESTRA80".
 * Belgium and Luxembourg keep their own convention (the be family below, the
 * dataset writing Belgium's bare), so their prefixes stay out of this one. */
const TSA_PREFIXES = DESIGNATOR_PREFIXES.filter((p) => p !== 'EB' && p !== 'EL');
const PREFIXED_TSA_KEY_RE = new RegExp(
	`^(${TSA_PREFIXES.join('|')})[\\s-]?(TRA|TSA)[\\s-]?(\\d{1,3})([A-Z]{0,3}\\d?)$`,
);

/* Belgium & Luxembourg TSA / TRA (skeyes joint AIP ENR 5.2). The dataset ids
 * are the AIP's own designators: bare for Belgium ("TSA26A", "TSA28CZ",
 * "TRA23", the letter forms "TRA NA" / "TRA SBZ", the compound
 * "TRA/TSA N1" / "TRA/TSA13A") and EL-prefixed for Luxembourg ("ELTSA7").
 * NOTAMs cite them bare and compact ("TSA22-BERTRIX-JEHONVILLE ACT",
 * "TSA26A - ARDENNES 01"), spaced, optionally EB/EL-prefixed ("EB TSA 25",
 * "ELTSA6") or with the compound half ("TRA/TSA N2"). Canonical form
 * follows the dataset convention: an EB prefix drops, EL stays, the "TRA/"
 * half of a compound drops, numbers unpad, separators vanish. Letters-only
 * designators require a separator ("TRA W", never "TRAW"), so prose words
 * like TRACK can't parse; a false key is still harmless, the citation link
 * requires a loaded airspace id with the same key (the triple gate). */
const BE_TSA_KEY_RE =
	/^(?:(EB|EL)[\s-]?)?(?:TRA\/)?(TSA|TRA)(?:[\s-]?(\d{1,3})([A-Z]{0,2})|[\s-]?([A-Z]\d{1,2})|[\s-]([A-Z]{1,3}))$/;

function beTsaKey(m: RegExpExecArray | RegExpMatchArray): string {
	const prefix = m[1] === 'EL' ? 'EL' : '';
	const designator =
		m[3] != null ? String(parseInt(m[3], 10)) + (m[4] ?? '') : (m[5] ?? m[6] ?? '');
	return prefix + m[2] + designator;
}

/** Canonical comparison key for a special-use designator: prefix + letter +
 *  unpadded number + suffix ("EGD006A" and "EG D6A" both yield "EGD6A"),
 *  plus the Belgian / Luxembourg TSA-TRA convention above ("EB TSA 25" and
 *  "TSA25" both yield "TSA25", "TRA/TSA N1" yields "TSAN1");
 *  null when the id is not in any known national grammar (FIR ids
 *  like "LFFF", synthetic ids like "OCA4521", airport idents). */
export function designatorKey(id: string): string | null {
	const norm = id.trim().toUpperCase();
	const m = DESIGNATOR_KEY_RE.exec(norm) ?? PREFIXED_TSA_KEY_RE.exec(norm);
	if (m) {
		return m[1] + m[2] + String(parseInt(m[3], 10)) + m[4];
	}
	const be = BE_TSA_KEY_RE.exec(norm);
	if (be) {
		return beTsaKey(be);
	}
	return null;
}

/* Citation patterns. FR reuses the activation grammar verbatim. UK and ES
 * NOTAMs cite their zones with optional spacing ("EG D129", "LED 36") and the
 * ES letters collide with English words ("LED 36 LIGHTS"), which is why a
 * citation only ever links through three gates: the family is selected by the
 * NOTAM's own Q-line FIR, the caller applies a Q-code subject gate, and the
 * canonical key must equal a loaded airspace id's key. */
const CITATION_RE = Object.fromEntries(
	PUBLISHER_TABLE.filter((p) => p.firs.length > 0).map((p) => [
		p.id,
		p.id === 'fr' ? AIRSPACE_ID_RE : standardCitationRe(p.cites, p.id !== 'be'),
	]),
) as Record<NotamPublisher, RegExp>;

/** The common citation grammar, "<prefix>[DRP]<number>[suffix]": "EG D129",
 *  "LED36", "ED-R 146", "EBR04", "LZR 51", and Iceland's "BID9NW" and
 *  "BID8NV1", whose suffix runs to three letters and a digit. The digit
 *  after the [DRP] letter keeps the aerodrome idents out (EDDF, LOWW,
 *  EHAM), and the prefix list is the publisher's own, so the letters of one
 *  State's grammar cannot match another's rows. With `tsa`, a TRA or TSA
 *  after the prefix too ("LRTRA2", "LZ TSA 1Z"): every family but
 *  Belgium's, which cites its own way. */
function standardCitationRe(prefixes: readonly string[], tsa: boolean): RegExp {
	const kind = tsa ? '(TRA|TSA|[DRP])' : '([DRP])';
	return new RegExp(
		`\\b(${prefixes.join('|')})[\\s-]?${kind}[\\s-]?(\\d{1,3})([A-Z]{0,3}\\d?)(?:\\.\\d+)?\\b`,
		'g',
	);
}

/* The be family's second pattern: TSA / TRA citations (see BE_TSA_KEY_RE for
 * the grammar and the canonical form). Same group layout as the key regex so
 * beTsaKey serves both. */
const BE_TSA_CITE_RE =
	/\b(?:(EB|EL)[\s-]?)?(?:TRA\/)?(TSA|TRA)(?:[\s-]?(\d{1,3})([A-Z]{0,2})|[\s-]?([A-Z]\d{1,2})|[\s-]([A-Z]{1,3}))\b/g;

/** Designators cited in `text` under the conventions of the AIP owning `fir`
 *  (or, where no dataset here belongs to that FIR, owning the A) `locations`:
 *  notamPublisher), as canonical keys plus the match index (for
 *  reference-context filtering), deduped by key in first-mention order. Empty
 *  when neither maps to a designator dataset. The be family also speaks the TSA / TRA grammar
 *  ("TSA26A", "ELTSA7", "EB TSA 25", "TRA/TSA N1"), whose keys only ever
 *  link through the loaded-id gate. Dotted RTBA sub-ids ("LFR45S6.1") do not
 *  canonicalise from citations (the FR grammar stops at the dot); they stay
 *  linked through the dedicated RTBA activation path, a safe miss for the
 *  citation tier. */
export function extractCitedDesignators(
	text: string,
	fir: string,
	locations: readonly string[] = [],
): { key: string; index: number }[] {
	const family = notamPublisher(fir, locations);
	if (!family) {
		return [];
	}
	const found: { key: string; index: number }[] = [];
	for (const m of text.matchAll(CITATION_RE[family])) {
		const key = designatorKey(m[1] + m[2] + m[3] + (m[4] ?? ''));
		if (key) {
			found.push({ key, index: m.index ?? 0 });
		}
	}
	if (family === 'be') {
		for (const m of text.matchAll(BE_TSA_CITE_RE)) {
			found.push({ key: beTsaKey(m), index: m.index ?? 0 });
		}
		// Restore document order across the two patterns so the first-mention
		// dedup below stays honest.
		found.sort((a, b) => a.index - b.index);
	}
	const out: { key: string; index: number }[] = [];
	const seen = new Set<string>();
	for (const f of found) {
		if (!seen.has(f.key)) {
			seen.add(f.key);
			out.push(f);
		}
	}
	return out;
}
