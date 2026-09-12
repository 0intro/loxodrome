/* Special-use airspace designator grammar: extraction and canonical keys.
 *
 * Home of every NOTAM-body designator pattern, so the activation link
 * (extractAirspaceIds, FR-only by design) and the broader citation link
 * (extractCitedDesignators, FR / UK / ES) share one module. Pure; the
 * state layer in notamLinks.svelte.ts wires the results to loaded rows.
 */

/** French SIA prefixes (LF mainland + DOM/TOM); add more if other AIPs land in
 *  airspaces.json with the same R/D/P/A/M letter convention. Optional hyphen
 *  between the prefix and the subject letter; NOTAM text typically has
 *  "LF-R45A" while the JSON's codeId is "LFR45A". */
export const AIRSPACE_ID_RE = /\b(LF|TF|NT|NW|SO|FM)-?([RPDMA])(\d{1,4}[A-Z]*)\b/g;

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

/** Map a NOTAM Q-line FIR (ICAO) to the airspace dataset publisher whose rows
 *  it may concern, so a French "SEINE" can never match a UK / ES row. FR
 *  covers mainland LF* plus the DOM / TOM FIRs shipped in fr-airspaces.json
 *  (TF*, SO*, NT*, NW*, FM*). Returns null for FIRs we carry no organisation
 *  dataset for (FAA / pruatlas use different nomenclature) → no name link.
 *  The literal union is a subset of the state Publisher type, kept structural
 *  so the parser core does not import state typing. */
export function firToPublisher(
	fir: string,
): 'fr' | 'uk' | 'es' | 'be' | 'de' | 'at' | 'ge' | 'nl' | 'sk' | 'ie' | 'rs' | 'xk' | null {
	if (/^(LF|TF|SO|NT|NW|FM)/.test(fir)) {
		return 'fr';
	}
	if (/^EG/.test(fir)) {
		return 'uk';
	}
	if (/^(LE|GC)/.test(fir)) {
		return 'es';
	}
	// Brussels FIR (EBBU) owns Belgium AND Luxembourg (the joint AIP).
	if (/^E[BL]/.test(fir)) {
		return 'be';
	}
	// German FIRs (EDGG Langen, EDWW Bremen, EDUU / EDVV upper).
	if (/^ED/.test(fir)) {
		return 'de';
	}
	// Wien FIR (LOVV).
	if (/^LO/.test(fir)) {
		return 'at';
	}
	// Tbilisi FIR (UGGG).
	if (/^UG/.test(fir)) {
		return 'ge';
	}
	// Amsterdam FIR (EHAA).
	if (/^EH/.test(fir)) {
		return 'nl';
	}
	// The eAIP cohort, one FIR each: Bratislava (LZBB) and Shannon
	// (EISN). Hungary, Portugal, Bosnia and Slovenia are absent because
	// their AIPs forbid re-serving and this repo ships no rows for them
	// (cmd/eaip Consent, docs/eaip-states.md).
	if (/^LZ/.test(fir)) {
		return 'sk';
	}
	if (/^EI/.test(fir)) {
		return 'ie';
	}
	if (/^LY/.test(fir)) {
		return 'rs';
	}
	if (/^BK/.test(fir)) {
		return 'xk';
	}
	return null;
}

/* Designator grammar per publisher. The dataset ids and the NOTAM citations
 * disagree on padding and spacing (uk-airspaces.json has "EGD006A" where the
 * NOTAM cites "EGD6A" or "EG D298B"; es rows are unpadded "LED36"), so both
 * sides reduce to a canonical key before comparing. */
const DESIGNATOR_KEY_RE = /^(LF|TF|NT|NW|SO|FM|EG|LE|GC|EB|EL|ED|LO|UG|EH|LZ|EI|LY|BK)[\s-]?([RPDMA])[\s-]?(\d{1,4})([A-Z]*(?:\.\d+)?)$/;

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
	const m = DESIGNATOR_KEY_RE.exec(norm);
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
const CITATION_RE: Record<'fr' | 'uk' | 'es' | 'be' | 'de' | 'at' | 'ge' | 'nl' | 'sk' | 'ie' | 'rs' | 'xk', RegExp> = {
	fr: AIRSPACE_ID_RE,
	uk: /\b(EG)[\s-]?([DRP])[\s-]?(\d{1,3})([A-Z]?)(?:\.\d+)?\b/g,
	es: /\b(LE|GC)[\s-]?([DRP])[\s-]?(\d{1,3})([A-Z]?)(?:\.\d+)?\b/g,
	// Belgium & Luxembourg: compact "EBR04" / spaced "EB R04" / "EBD26 A".
	be: /\b(EB|EL)[\s-]?([DRP])[\s-]?(\d{1,3})([A-Z]?)(?:\.\d+)?\b/g,
	// Germany: "ED-R 146", "EDR146", "ED R 32A" (DFS ED-R / ED-D SUA). The
	// digit after the [DRP] letter keeps airport idents (EDDF, EDDM) out.
	de: /\b(ED)[\s-]?([DRP])[\s-]?(\d{1,3})([A-Z]?)(?:\.\d+)?\b/g,
	// Austria: "LO-R 1", "LOR1", "LO D 25A" (Austro Control LO-R / LO-D
	// areas). The digit after the [DRP] letter keeps aerodrome idents
	// (LOWW, LOWI) and the LOTRA / LOHPG zone ids out.
	at: /\b(LO)[\s-]?([DRP])[\s-]?(\d{1,3})([A-Z]?)(?:\.\d+)?\b/g,
	// Georgia: "UGR 12", "UG-R12". Same shape and the same reason for the
	// digit: it keeps the UGGG / UGTB idents out.
	ge: /\b(UG)[\s-]?([DRP])[\s-]?(\d{1,3})([A-Z]?)(?:\.\d+)?\b/g,
	// Netherlands: "EHR3", "EH R 3", "EHD41". Same shape; the digit keeps
	// the EHAM / EHRD aerodrome idents out.
	nl: /\b(EH)[\s-]?([DRP])[\s-]?(\d{1,3})([A-Z]?)(?:\.\d+)?\b/g,
	// The eAIP cohort: same shape, and the same reason for the digit,
	// which keeps the aerodrome idents (LZIB, EIDW) out.
	sk: /\b(LZ)[\s-]?([DRP])[\s-]?(\d{1,3})([A-Z]?)(?:\.\d+)?\b/g,
	ie: /\b(EI)[\s-]?([DRP])[\s-]?(\d{1,3})([A-Z]?)(?:\.\d+)?\b/g,
	rs: /\b(LY)[\s-]?([DRP])[\s-]?(\d{1,3})([A-Z]?)(?:\.\d+)?\b/g,
	xk: /\b(BK)[\s-]?([DRP])[\s-]?(\d{1,3})([A-Z]?)(?:\.\d+)?\b/g,
};

/* The be family's second pattern: TSA / TRA citations (see BE_TSA_KEY_RE for
 * the grammar and the canonical form). Same group layout as the key regex so
 * beTsaKey serves both. */
const BE_TSA_CITE_RE =
	/\b(?:(EB|EL)[\s-]?)?(?:TRA\/)?(TSA|TRA)(?:[\s-]?(\d{1,3})([A-Z]{0,2})|[\s-]?([A-Z]\d{1,2})|[\s-]([A-Z]{1,3}))\b/g;

/** Designators cited in `text` under the conventions of the AIP owning `fir`,
 *  as canonical keys plus the match index (for reference-context filtering),
 *  deduped by key in first-mention order. Empty when the FIR maps to no
 *  designator dataset. The be family also speaks the TSA / TRA grammar
 *  ("TSA26A", "ELTSA7", "EB TSA 25", "TRA/TSA N1"), whose keys only ever
 *  link through the loaded-id gate. Dotted RTBA sub-ids ("LFR45S6.1") do not
 *  canonicalise from citations (the FR grammar stops at the dot); they stay
 *  linked through the dedicated RTBA activation path, a safe miss for the
 *  citation tier. */
export function extractCitedDesignators(
	text: string,
	fir: string,
): { key: string; index: number }[] {
	const family = firToPublisher(fir);
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
