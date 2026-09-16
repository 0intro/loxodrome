/**
 * Read a fuel NOTAM's E-text: which grades it withdraws, and which of its
 * statements are too qualified to act on.
 *
 * The subject gate is `isFuelQCode` and the tier gate is the NOTAM's own
 * `serviceStatus`; both are decided before this module is called. What is
 * left is the question those two cannot answer: an aerodrome's fuel NOTAM
 * that says something IS out may be saying it about the whole supply, about
 * one grade, or about one pump on a Tuesday, and the panel must not strike a
 * chip for the third.
 *
 * Two decisions carry the whole grammar.
 *
 * ONE: the clause is the LINE. The SIA writes one statement per line and
 * `cleanNotamContent` keeps the line structure, so D2159/26 LFLJ
 *
 *     FUELLING RESTRICTIONS :
 *     - JET A1 AVBL FOR HEL ONLY UPON 24HR PPR : ...
 *     - AVGAS 100LL NOT AVBL
 *
 * says Jet A-1 is available on request and 100LL is not. Any rule over the
 * whole E-text gets one of the two wrong; per line, both come out right with
 * no case for either.
 *
 * TWO: a line withdraws only when it is CLOSED - when it consists of a fuel
 * noun, a grade list, the outage phrase, an optional cause, and nothing else.
 * This is a closed grammar rather than a list of hedges to refuse, because
 * the hedges are open: the corpus shows SELF DISPENSER, AUTOMATIC
 * DISTRIBUTION, CAMION AVITAILLEUR, EN POSTE FIXE, FOR NON-BASED ACFT, and
 * the next cycle will show one nobody has written down. Under a blocklist
 * that one silently strikes a chip; here it simply leaves a word the grammar
 * cannot account for, and the statement becomes a note instead.
 *
 * Pure, and parser-core: no state, no datasets. Which published grade a
 * stated one covers is the caller's business (the AVGAS family is a fact
 * about the fuel vocabulary, and lives with it), so `applyFuelChange` takes
 * that predicate as a parameter, the way ownership.ts takes its resolvers.
 */

/** What one line of a fuel NOTAM says is out. */
export interface FuelStatement {
	/** `grades`: the named ones. `all`: the whole supply, no grade named. */
	scope: 'grades' | 'all';
	/** Vocabulary codes, bare strings: this module does not import the fuel
	 *  data layer and does not know what an aerodrome publishes. */
	grades: string[];
	/** The line is a closed statement and may be acted on. False where the
	 *  line carries anything the grammar cannot account for. */
	bare: boolean;
	/** The line itself, for the note that quotes it. */
	text: string;
}

/* ---- the vocabulary, ported from internal/fuel/grades.go ---- */

interface Token {
	grade: string;
	re: RegExp;
}

/** Order matters: SUPER AERO+ before UL91 (both open "UL"), 100LL before the
 *  bare AVGAS. Mirrors gradePatterns in internal/fuel/grades.go; the AIP-side
 *  clause rules there have no counterpart here, NOTAM E-text carrying none of
 *  the labelled lubricant / payment columns they exist for. */
const TOKENS: Token[] = [
	// LFPE writes UL 'AERO SUPER PLUS', the quote between the two words, so
	// the UL prefix has to be optional rather than merely spaced.
	{ grade: 'SUPER AERO+', re: /\b(?:UL\s*)?A[EÉ]RO\s*SUPER(?:\s*PLUS|\s*\+)?/g },
	{ grade: 'UL91', re: /\bUL\s*-?\s*91\b|\b91\s*UL\b/g },
	{ grade: '100LL', re: /\b(?:AVGAS\s*)?100\s*-?\s*LL\b/g },
	{ grade: 'AVGAS', re: /\b100\s*\/\s*130\b/g },
	{ grade: 'JET A-1', re: /\bJET\s*-?\s*A\s*-?\s*1\b|\bTRO\b/g },
	{ grade: 'MOGAS', re: /\bSP\s*-?\s*9[58]\b|\b9[58]\s*SP\b|\bMOGAS\b|\bSANS\s+PLOMB\b/g },
	{ grade: 'AVGAS', re: /\bAVGAS\b/g },
];

/** The NATO codes, by their two digits. A code outside the list is not a
 *  fuel: "F 15" in a remark about the traffic must not read as one. */
const NATO: Record<string, string> = {
	'18': 'F-18',
	'34': 'F-34',
	'35': 'F-35',
	'40': 'F-40',
	'44': 'F-44',
	'54': 'F-54',
	'63': 'F-63',
};
const NATO_RE = /\bF\s*-?\s*(\d{2})\b/g;

/** The French services' own designations. TR.0 is the civil kerosene the AIP
 *  itself writes that way at Roissy and Le Bourget. */
const TR: Record<string, string> = { '0': 'JET A-1', '4': 'F-34', '5': 'F-44' };
const TR_RE = /\bTR\s*[.-]?\s*(\d)\b/g;

/** A NATO code the AIP glosses with its civil product: "100LL (F18)" at
 *  Solenzara, "F35 (JetA1)" at Istres. The gloss names the same fuel, and
 *  reading it as a second one would strike a civil Jet A-1 chip at an air
 *  base. Ported from internal/fuel/parse.go. */
const GLOSS_RE = /(\b(?:F\s*-?\s*\d{2}|100\s*-?\s*LL|JET\s*-?\s*A\s*-?\s*1)\b)\s*\([^)]*\)/g;

/* ---- what a closed line may contain besides its grades ---- */

/** The whole supply. A line with no grade withdraws everything only if it
 *  names one of these: "AVIATION ELECTRIC CHARGING STATION U/S" (LFSM) names
 *  none, and must not empty an aerodrome that sells 100LL and Jet A-1. */
const SUPPLY_RE =
	/\b(?:REFUEL(?:L)?ING|FUEL(?:L)?ING|FUEL|AVITAILLEMENT|RAVITAILLEMENT|CARBURANTS?)\b/;

/** Words a closed line may carry around its subject: the supply nouns above,
 *  the SIA's "AVAILABILITY" / "STATION" heads, the prepositions it writes
 *  between them, and the connectors between two grades. Anything else is a
 *  qualifier, and a qualifier is what makes the line a note.
 *
 *  UL is here because LFPE writes UL 'AERO SUPER PLUS' with the quote in the
 *  middle: the grade token reads from AERO, and the orphaned UL is part of
 *  the designation rather than something said about it. */
const FILLER_RE =
	/\b(?:REFUEL(?:L)?ING|FUEL(?:L)?ING|FUEL|AVAILABILITY|STATION|AVITAILLEMENT|RAVITAILLEMENT|CARBURANTS?|DISPONIBILITE|UL|EN|IN|OF|DE|DU|AND|ET|OR|OU)\b/g;

/** The outage itself. The same phrases serviceStatus.ts classifies on, which
 *  is the tier gate: this module only has to find WHERE one sits in the line. */
const OUTAGE_RE =
	/\bU\s*\/\s*S\b|\bUNSERVICEABLE\b|\bUNUSABLE\b|\bNOT\s+(?:AVAILABLE|AVBL|USABLE)\b|\bUNAVAILABLE\b|\bWITHDRAWN\b|\bHORS\s+(?:SERVICE|SVC)\b|\bINDISPONIBLES?\b|\bINUTILISABLES?\b|\bNONS?\s+DISPONIBLES?\b/;

/** The same phrases, consumed rather than located. `isClosed` has to strike
 *  out EVERY outage phrase in the line: one stating two of them ("100LL NOT
 *  AVBL AND JET A1 NOT AVBL") is closed, and a second phrase left standing
 *  reads as a qualifier and turns a withdrawal into a note. A separate global
 *  twin rather than a flag on OUTAGE_RE itself, whose `.test` runs per line
 *  in parseFuelChange and would carry lastIndex from one line to the next. */
const OUTAGE_ALL_RE = new RegExp(OUTAGE_RE.source, 'g');

/** Read as part of the outage phrase, not as a qualifier of it. */
const INTENSIFIER_RE = /\b(?:COMPLETELY|TOTALEMENT|ENTIEREMENT)\b/g;

/** Everything from a stated cause to the end of the line. Why a pump is out
 *  does not narrow what is out. */
const CAUSE_RE = /\b(?:DUE\s+TO|CAUSE|BECAUSE\s+OF|EN\s+RAISON\s+DE|POUR\s+CAUSE\s+DE)\b.*$/;

/** Accent-fold and upper-case, so one set of patterns reads the French half
 *  and the English half alike (the AERO / AÉRO pair, and CAUSE / RAISON). */
function fold(s: string): string {
	return s
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toUpperCase();
}

/** The grades a line names, gloss removed, in vocabulary order of first
 *  appearance. */
function gradesIn(line: string): string[] {
	const text = line.replace(GLOSS_RE, '$1');
	const out: string[] = [];
	const add = (g: string): void => {
		if (!out.includes(g)) {
			out.push(g);
		}
	};
	for (const t of TOKENS) {
		t.re.lastIndex = 0;
		if (t.re.test(text)) {
			add(t.grade);
		}
	}
	for (const m of text.matchAll(NATO_RE)) {
		const g = NATO[m[1]];
		if (g) {
			add(g);
		}
	}
	for (const m of text.matchAll(TR_RE)) {
		const g = TR[m[1]];
		if (g) {
			add(g);
		}
	}
	// "AVGAS 100LL" is one grade named twice, not two on offer.
	return out.includes('AVGAS') && out.some((g) => g === '100LL' || g === 'UL91' || g === 'SUPER AERO+')
		? out.filter((g) => g !== 'AVGAS')
		: out;
}

/** Whether the line is nothing but its subject and its outage.
 *
 *  Decided by consumption rather than by inspection: strike out the outage,
 *  the cause, the grades and the filler, and see whether any word survives.
 *  A word that does is a qualifier the grammar cannot account for, whatever
 *  it happens to be. */
function isClosed(line: string): boolean {
	let rest = line.replace(CAUSE_RE, ' ').replace(GLOSS_RE, '$1');
	rest = rest.replace(OUTAGE_ALL_RE, ' ').replace(INTENSIFIER_RE, ' ');
	for (const t of TOKENS) {
		rest = rest.replace(t.re, ' ');
	}
	rest = rest.replace(NATO_RE, ' ').replace(TR_RE, ' ').replace(FILLER_RE, ' ');
	// Punctuation, the SIA's bullet dashes and its quotes are not words.
	return !/[A-Z0-9]/.test(rest.replace(/[\s.,:;'"()/+-]/g, ''));
}

/**
 * Read one fuel NOTAM's E-text into one statement per line that states an
 * outage. A line naming neither a grade nor the supply is dropped: at LFRH
 * the outage line is "- DE NUIT : INDISPONIBLE.", which is about the night
 * and not about a fuel.
 */
export function parseFuelChange(eText: string | null | undefined): FuelStatement[] {
	if (typeof eText !== 'string' || eText === '') {
		return [];
	}
	const out: FuelStatement[] = [];
	for (const raw of eText.split('\n')) {
		const line = fold(raw).trim();
		if (line === '' || !OUTAGE_RE.test(line)) {
			continue;
		}
		const grades = gradesIn(line);
		if (grades.length === 0 && !SUPPLY_RE.test(line)) {
			continue;
		}
		out.push({
			scope: grades.length > 0 ? 'grades' : 'all',
			grades,
			bare: isClosed(line),
			text: raw.trim(),
		});
	}
	return out;
}

/* ---- applying them ---- */

/** Why a statement was not acted on. Data, not wording: the caller renders
 *  it in the reading locale. */
export type FuelNoteKind =
	/** The line carries a qualifier, so what it withdraws is narrower than a
	 *  grade: one pump, one apron, one operator, one part of the day. */
	| 'partial'
	/** The grades it names are none that this aerodrome publishes. Usually
	 *  the AIP being behind the NOTAM, which is exactly when it is worth
	 *  reading. */
	| 'unmatched'
	/** Its D) schedule could not be read, so whether it is in force now is
	 *  unknown. Never withdraw on a guess. */
	| 'schedule';

export interface FuelNote<S> {
	source: S;
	kind: FuelNoteKind;
	/** The grades the statement named, for the wording. Empty for `all`. */
	grades: string[];
	text: string;
}

/** One NOTAM's statements, with the answer to "is it in force over the range
 *  the caller is asking about". `null` is unknown, the unparseable-D) case. */
export interface FuelCandidate<S> {
	source: S;
	statements: FuelStatement[];
	active: boolean | null;
}

export interface FuelApplication<O, S> {
	offers: (O & { withdrawn?: S })[];
	/** Every published grade withdrawn, or the whole supply withdrawn on a
	 *  row whose prose named no grade at all. */
	withdrawnAll: S | null;
	notes: FuelNote<S>[];
}

/**
 * Apply the statements to an aerodrome's published grades.
 *
 * The ladder mirrors applyClosures in serviceClosure.ts, and refuses in the
 * same three places: a qualified statement, a statement matching nothing
 * published, and a schedule that could not be read all become notes rather
 * than silent changes. `covers` decides whether a published grade is the one
 * a statement names; the AVGAS family lives with the vocabulary, not here.
 */
export function applyFuelChange<G extends string, O extends { grade: G }, S>(
	offers: readonly O[],
	candidates: readonly FuelCandidate<S>[],
	covers: (published: G, stated: string) => boolean,
): FuelApplication<O, S> {
	const out: (O & { withdrawn?: S })[] = offers.map((o) => ({ ...o }));
	const notes: FuelNote<S>[] = [];
	let withdrawnAll: S | null = null;

	for (const c of candidates) {
		// One NOTAM saying the same thing twice is one note. The SIA's
		// hours-of-service NOTAMs restate an exception line verbatim
		// (A0703/26 LFBH lists its closed days twice), and two identical rows
		// under the chips are noise to read and a duplicate key in the list
		// that renders them, which is a thrown error and not a cosmetic one.
		const said = new Set<string>();
		const note = (kind: FuelNoteKind, st: FuelStatement): void => {
			const key = `${kind}|${st.grades.join(',')}`;
			if (said.has(key)) {
				return;
			}
			said.add(key);
			notes.push({ source: c.source, kind, grades: st.grades, text: st.text });
		};
		for (const st of c.statements) {
			if (!st.bare) {
				note('partial', st);
				continue;
			}
			if (c.active === null) {
				note('schedule', st);
				continue;
			}
			if (c.active === false) {
				continue;
			}
			if (st.scope === 'all') {
				// First to withdraw it wins, here as on the offers: the line
				// naming the whole supply and the marks on the grades must
				// cite the same NOTAM, or the panel's heading and its chips
				// blame two different ones for one fact.
				withdrawnAll ??= c.source;
				for (const o of out) {
					o.withdrawn ??= c.source;
				}
				continue;
			}
			let hit = false;
			for (const o of out) {
				if (st.grades.some((g) => covers(o.grade, g))) {
					hit = true;
					o.withdrawn ??= c.source;
				}
			}
			if (!hit) {
				note('unmatched', st);
			}
		}
	}
	return { offers: out, withdrawnAll, notes };
}
