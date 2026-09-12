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

/** A frequency with either decimal separator, normalised at capture. */
const FREQ = String.raw`(\d{3}(?:[.,]\d{1,3})?)\s*MHZ`;

/** The withdrawn frequency: "<freq>MHZ [hedge] <unavailable-word>". Both real
 *  texts put the word right after the value; keeping the adjacency strict is
 *  what stops a substitute's frequency ("CONTACT ... 125.700MHZ") from
 *  reading as the withdrawn one. A hedging adverb between the two
 *  ("POTENTIALLY NOT AVBL", the Toulouse QSELT family) is tolerated so the
 *  FLAG can still name the value; the hedge itself never reaches this
 *  module, the tier gate is the Q-code condition. */
const UNAVAILABLE_RE = new RegExp(
	`${FREQ}\\s+(?:(?:POTENTIALLY|POSSIBLY|POTENTIELLEMENT|EVENTUELLEMENT|PEUT\\s+ETRE)\\s+)?` +
		'(?:NOT\\s+(?:AVBL|AVAILABLE)|UNAVAILABLE|U\\s*/\\s*S\\b|UNSERVICEABLE|INDISPONIBLE|HORS\\s+(?:SERVICE|SVC))',
	'i',
);

/** A designated substitute: "CONTACT[ER|EZ] '<unit>' <freq>MHZ". The label
 *  runs to the frequency; quotes are the EN corpus's decoration. */
const SUBSTITUTE_RE = new RegExp(
	String.raw`\bCONTACT(?:ER|EZ)?\s+'?([A-Z][A-Z0-9 .'-]*?)'?\s+${FREQ}`,
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

/** Extract the closure statement of an E) text (whitespace-normalised by the
 *  parser). Always returns a value; `freq: null` marks an unusable one. */
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
			if (!r.closed && closureFreqKey(r.freq) === key) {
				out[i] = {
					...r,
					closed: true,
					closedBy: { source: c.source, substitutes: c.closure.substitutes },
				};
				matched = true;
			}
		});
		if (!matched) {
			flags.push({ source: c.source, freq: c.closure.freq });
		}
	}
	return { radios: out, flags };
}
