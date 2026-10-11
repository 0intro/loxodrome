/* Parse and apply FIS service-closure NOTAMs.
 *
 * A NOTAM whose Q-subject is a flight information service and whose condition
 * is an unserviceability (QSEAU: "FIS not available") CLOSES a sector and
 * withdraws its frequency; it does not reassign one, so the frequency-change
 * grammar (freqChange.ts) cannot express it. The real family, in both
 * languages (tests/fixtures/world-{fr,en}-20260610.txt, A3345/26; the live
 * A4694/26 is the same text plus a D) day schedule):
 *
 *   FR  FREQUENCE BEAUVAIS INFO 119,800MHZ INDISPONIBLE :
 *       - SIV 2 BEAUVAIS FERME,
 *       - CONTACTER PARIS INFO 125.700MHZ, OU SI VOUS EVOLUE EN IFR OU VFR
 *       DE NUIT CONTACTEZ PARIS CONTROLE 128.275MHZ.
 *   EN  'BEAUVAIS' INFO FREQ 119.800MHZ NOT AVBL :
 *       - 'BEAUVAIS' FIS AREA 2 CLOSED
 *       - CONTACT 'PARIS INFO' 125.700MHZ, OR IF IFR OR NGT VFR FLT CONTACT
 *       'PARIS CTL' 128.275MHZ.
 *
 * Note the French half's COMMA decimal on the withdrawn frequency: the SOFIA
 * FR corpus really prints both separators in one NOTAM, so every captured
 * value is normalised to the dot form here.
 *
 * The application rule mirrors the resolver doctrine ("override when sure,
 * else flag", state/freqOverride.svelte.ts): the stated frequency is the
 * selector, and ONLY rows publishing it close; the stated substitutes are
 * provenance for the UI, NEVER injected into a row, because the correct
 * substitute is already the published data underneath (dropping the closed
 * sector's contact span makes the resolution fall back to the FIC blanket,
 * route/airspaces.ts buildContactSpans). Pure, no Svelte, no I/O; pinned by
 * tests/serviceClosure.spec.ts and the bilingual matrix. */

/** A frequency with either decimal separator, normalised at capture.
 *
 *  The MHZ unit is required of a WHOLE number and optional after a decimal
 *  one, because a publisher may leave it off and a decimal three-digit value
 *  in this position is not anything else: "LUEBECK GROUND FREQ 121.78 U/S."
 *  (C3443/26 EDHL) stated no frequency at all while the unit was mandatory,
 *  so the closure could only be flagged. A bare "121" still needs its unit,
 *  and a trailing distance unit is refused outright, so "WITHIN 100.5 NM NOT
 *  AVBL" cannot read as a withdrawn channel. The LEFT guard matters just as
 *  much once the unit is optional: without it the tail of a longer number is
 *  a frequency, and "AD ELEV 1132.5 NOT AVBL" was read as a withdrawal of
 *  132.5 -- which would then select whichever published row carries it. */
const FREQ = String.raw`(?<![\d.])(\d{3}[.,]\d{1,3}|\d{3}(?=\s*MHZ))\s*(?:MHZ)?(?!\s*(?:NM|KM|FT|SM|DEG))`;

/** The withdrawn frequency: "<freq>MHZ [hedge] <unavailable-word>". Both real
 *  texts put the word right after the value; keeping the adjacency strict is
 *  what stops a substitute's frequency ("CONTACT ... 125.700MHZ") from
 *  reading as the withdrawn one. A hedging adverb between the two
 *  ("POTENTIALLY NOT AVBL", the Toulouse QSELT family) is tolerated so the
 *  FLAG can still name the value; the hedge itself never reaches this
 *  module, the tier gate is the Q-code condition. The English half of that
 *  same family writes MAY BE where the French writes POTENTIELLEMENT
 *  (F1698/26 LFBO), so the two lists have to cover each other or the flag
 *  names the frequency in one language and not the other. */
const UNAVAILABLE_RE = new RegExp(
	`${FREQ}\\s+(?:(?:POTENTIALLY|POSSIBLY|POTENTIELLEMENT|EVENTUELLEMENT|PEUT\\s+ETRE|MAY\\s+BE|MIGHT\\s+BE)\\s+)?` +
		'(?:NOT\\s+(?:AVBL|AVAILABLE)|UNAVAILABLE|U\\s*/\\s*S\\b|UNSERVICEABLE|INDISPONIBLE|HORS\\s+(?:SERVICE|SVC))',
	'i',
);

/** A designated substitute: "CONTACT[ER|EZ] '<unit>' <freq>MHZ". The label
 *  runs to the frequency, across a line break like every other gap (its
 *  class once held a literal space, so "PARIS\nINFO" named no substitute);
 *  quotes are the EN corpus's decoration. */
const SUBSTITUTE_RE = new RegExp(
	String.raw`\bCONTACT(?:ER|EZ)?\s+'?([A-Z][A-Z0-9\s.'-]*?)'?\s+${FREQ}`,
	'gi',
);

/** Normalise a captured frequency to the dot-decimal form. */
function dotFreq(raw: string): string {
	return raw.replace(',', '.');
}

/** 3-decimal comparison key, so "119,800", "119.8" and "119.800" are one
 *  value. Mirrors format/radio.ts formatFreqMHz without the dependency (this
 *  module stays parser-core pure); the spec pins the equivalence. */
export function closureFreqKey(raw: string): string {
	if (typeof raw !== 'string' || raw.trim() === '') {
		return '';
	}
	const n = Number(dotFreq(raw));
	return Number.isFinite(n) ? n.toFixed(3) : '';
}

export interface ServiceClosure {
	/** The withdrawn frequency (dot-decimal), or null when the text states
	 *  none: the caller then flags, since without a value there is nothing to
	 *  narrow the closure to. */
	freq: string | null;
	/** The substitutes the NOTAM designates, in order ("PARIS INFO" 125.700,
	 *  then the IFR / night-VFR alternative "PARIS CTL" 128.275). Display
	 *  provenance only. */
	substitutes: { label: string; freq: string }[];
}

/** Extract the closure statement of an E) text. The text keeps its LINE
 *  BREAKS (the clause-is-the-line doctrine), and every gap in the patterns
 *  above is `\\s`, which spans one: a statement wrapped mid-clause still
 *  reads. Always returns a value; `freq: null` marks an unusable one. */
export function parseServiceClosure(eText: string): ServiceClosure {
	if (typeof eText !== 'string' || eText === '') {
		return { freq: null, substitutes: [] };
	}
	const un = UNAVAILABLE_RE.exec(eText);
	const substitutes: { label: string; freq: string }[] = [];
	for (const m of eText.matchAll(SUBSTITUTE_RE)) {
		// The quotes are decoration around the unit name ("'TOULOUSE' APP"),
		// not part of it; published call signs carry none.
		const label = m[1].replace(/'/g, ' ').replace(/\s+/g, ' ').trim();
		substitutes.push({ label, freq: dotFreq(m[2]) });
	}
	return { freq: un ? dotFreq(un[1]) : null, substitutes };
}

/** One closure candidate, resolved by the state layer against a named
 *  airspace: the parsed statement, whether the schedule says it is in force
 *  over the evaluation range (null = unknown, an unparseable D) item), and
 *  whether the Q-code CONDITION asserts the unserviceability. The source is
 *  opaque so this module never imports the state types. */
export interface ClosureCandidate<S> {
	source: S;
	closure: ServiceClosure;
	active: boolean | null;
	/** True when the Q-code condition (AU family) states the outage; false for
	 *  a text-only match ("POTENTIALLY NOT AVBL" under QSELT), which must
	 *  never close a live frequency. */
	authoritative: boolean;
}

/** A closure that could not be applied: surfaced beside the radios with a
 *  link to the NOTAM, never guessed at. */
export interface ClosureFlag<S> {
	source: S;
	/** The withdrawn frequency when one was stated (dot-decimal), else null. */
	freq: string | null;
}

/** Apply closure candidates to radio rows. The ladder, in order per
 *  candidate; every non-closing outcome that still asserts an outage becomes
 *  a flag:
 *
 *  - text-only (not authoritative) -> flag (hedged wording, "POTENTIALLY");
 *  - no stated frequency -> flag (nothing to narrow to);
 *  - schedule unknown (unparseable D)) -> flag (never silence a live
 *    frequency on a guess);
 *  - schedule says not in force over the range -> nothing;
 *  - in force -> every row publishing the stated frequency is marked
 *    `closed` with `closedBy` provenance; if none matches (stale data), flag.
 *
 *  Rows are returned as shallow copies only where marked. Pure. */
export function applyClosures<R extends { freq: string }, S>(
	radios: R[],
	candidates: readonly ClosureCandidate<S>[],
): {
	radios: (R & { closed?: boolean; closedBy?: { source: S; substitutes: ServiceClosure['substitutes'] } })[];
	flags: ClosureFlag<S>[];
} {
	const out: (R & {
		closed?: boolean;
		closedBy?: { source: S; substitutes: ServiceClosure['substitutes'] };
	})[] = radios.slice();
	const flags: ClosureFlag<S>[] = [];
	for (const c of candidates) {
		if (!c.authoritative || c.closure.freq == null || c.active === null) {
			flags.push({ source: c.source, freq: c.closure.freq });
			continue;
		}
		if (c.active === false) {
			continue;
		}
		const key = closureFreqKey(c.closure.freq);
		let matched = false;
		out.forEach((r, i) => {
			if (closureFreqKey(r.freq) !== key) {
				return;
			}
			// A row an earlier closure in force already closed is this one's
			// match too: the withdrawal IS applied, and "could not be
			// applied" would be false (the frequency side's rule: what is
			// already true is silent). The first closure keeps the credit.
			matched = true;
			if (!r.closed) {
				out[i] = {
					...r,
					closed: true,
					closedBy: { source: c.source, substitutes: c.closure.substitutes },
				};
			}
		});
		if (!matched) {
			flags.push({ source: c.source, freq: c.closure.freq });
		}
	}
	return { radios: out, flags };
}
