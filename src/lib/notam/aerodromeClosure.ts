/* Read an AERODROME's operational state out of a NOTAM's E) text: whether the
 * field itself is closed, and what it says when it is not.
 *
 * The two decisions notam/fuelChange.ts and notam/runwayChange.ts are built
 * on, for the same reasons:
 *
 *  - THE CLAUSE IS THE LINE. The SIA writes one statement per line and
 *    cleanNotamContent keeps them, so M2599/26's "AD IN AUTO INFORMATION,
 *    RESERVED FOR BASED CREWS." and the "- AD CLOSED TO OUTSIDE ACFT" two
 *    lines below it are read apart rather than as one muddled sentence.
 *  - A LINE CLOSES THE FIELD ONLY WHEN IT IS CLOSED: an aerodrome noun, a
 *    closure word, an optional universal complement ("TO ALL TRAFFIC"), an
 *    optional stated cause, an optional exception clause, and nothing else.
 *    A closed grammar rather than a list of hedges, because the corpus's
 *    hedges are open-ended and every one of them is a different shape:
 *    "AD MAY BE CLOSED TO ALL OTHER TRAFFIC FOR SHORT PERIODS" (D4843/26
 *    LFDS) closes it unpredictably, "AD CLOSED TO OUTSIDE ACFT" (M2599/26
 *    LFOJ) closes it to visitors only, "AD RESERVED FOR HOME BASED ACFT"
 *    (D5612/26 LFKY) never says the word at all. Each of those is a NOTE
 *    beside the field, never a closure.
 *
 * The refusals are the point, and three of them are lines that carry both an
 * aerodrome noun and a closure word while closing no aerodrome:
 *
 *    PRESENCE OF A PRIVATE USE ULM PAVED RWY CLOSE TO THE AD    (E1395/25)
 *    AD2 LFGF TXT2 14 ITEM REPARATIONS : WORKSHOP ... CLOSED    (D5143/26)
 *    ... IN THE ABSENCE OF ATS SERVICES DUE TO CLOSURE OF
 *    RUNWAY 11L/29R FOR RENOVATION WORKS                        (E2484/26)
 *
 * the first because CLOSE is not CLOSED, the other two because what the line
 * closes is not the field. All three survive the grammar as notes, which is
 * what lets it refuse: the dangerous state, a field reading open with nothing
 * beside it, cannot occur while every line that named it is either read or
 * noted.
 *
 * Pure, no Svelte, no I/O; the resolution against the airports dataset and
 * the date and schedule gates live in state/aerodromeState.svelte.ts. Pinned
 * by tests/aerodromeClosure.spec.ts. */

/** One line's verdict about the aerodrome. */
export interface AerodromeStatement {
	/** 'closed': the line closes the field outright. 'note': it says
	 *  something else about it that the reader has to see. */
	kind: 'closed' | 'note';
	/** The line itself, folded and whitespace-collapsed, for the note. */
	line: string;
	/** What the closure grammar could not account for, folded to bare words.
	 *  Empty on a line that closes; on one that does not, it is exactly the
	 *  qualifier that stopped it, which is what lets a caller holding the
	 *  field's own NAME finish the job (see `name` below). */
	residue: string;
}

/** The aerodrome itself, as the SIA and the other publishers name it. The
 *  bare ICAO ident is deliberately NOT here: "AD2 LFGF TXT2 ... WORKSHOP
 *  CLOSED" names the field only to say where the workshop is. */
const AERODROME_RE =
	/\b(?:AD|ADS|AERODROME|AERODROMES|AIRPORT|AIRFIELD|ALTIPORT|ALTISURFACE|HELIPORT|HELISTATION|HYDROBASE|SEAPLANE\s+BASE|PLATEFORME|TERRAIN)\b/;

/** A closure word, either language. CLOSE is excluded on purpose: it is the
 *  English preposition "close to", which E1395/25 writes twice. FERME agrees
 *  with its subject, so every ending is spelled out, as serviceStatus.ts
 *  spells its adjectives. */
const CLOSED_RE = /\b(?:CLOSED|CLSD|CLOSURE|FERME|FERMEE|FERMES|FERMEES|FERMETURE)\b/;

/** A hedge makes the closure conditional on something the app cannot see, so
 *  the line is a note however well the rest of it parses. Listed explicitly
 *  rather than left to the residue test, because each of these sits among
 *  words the residue test would otherwise forgive. */
const HEDGE_RE =
	/\b(?:MAY|MIGHT|POSSIBLE|POSSIBLY|SUSCEPTIBLE|POURRAIT|POURRA|PEUT\s+ETRE|EXPECT|PREVU|PREVUE|RISQUE|IF|SI|WHEN|LORSQUE|DURING|PENDANT|OCCASIONALLY|PONCTUELLEMENT)\b/;

/** The complement a closure may name and still be a closure: everyone. A
 *  complement naming anyone LESS than that ("TO OUTSIDE ACFT", "TO IFR")
 *  leaves the field open to somebody, and the app cannot know whether that
 *  somebody is this pilot, so it is a note. */
const UNIVERSAL_RE =
	/\b(?:TO|FOR|A|AU|AUX)\s+(?:ALL|ANY|EVERY|TOUT|TOUTE|TOUS|TOUTES|CHAQUE)\s+(?:THE\s+|LA\s+|LE\s+|LES\s+)?(?:AIR\s+)?(?:TRAFFIC|TRAFIC|CIRCULATION|ACFT|AIRCRAFT|AERONEFS?|MOVEMENTS?|MOUVEMENTS?|OPS|OPERATIONS?|USERS?|USAGERS?)\b/;

/** An exception clause runs to the end of its line. A closure with one is
 *  still a closure: "EXC RESCUE HOME BASED HEL" (C3366/26 LFLY), "EXC EMERG,
 *  MEDEVAC, ORGAN TRANSPORT" (M2307/26 LFPV) and "EXC FOR THOSE WHO ARE
 *  TAKING PART TO THE EVENT" (E4369/26 LFRW) all describe who may still land,
 *  and none of them is the pilot reading a flight-planning app. The clause is
 *  kept on the statement so the panel can print it verbatim. */
const EXCEPT_RE = /\b(?:EXC|EXCEPT|EXCEPTE|EXCEPTED?S?|SAUF|HORMIS)\b[\s\S]*$/;

/** A stated cause runs to the end of its line: the same rule fuelChange.ts
 *  uses, and the same vocabulary the corpus writes. */
const CAUSE_RE =
	/\b(?:CAUSE|DUE\s+TO|EN\s+RAISON\s+DE|EN\s+RAISON\s+D|POUR\s+CAUSE\s+DE|DUE|WIP|TRAVAUX)\b[\s\S]*$/;

/** What a closure line may carry besides its noun, its closure word and the
 *  clauses above: the ordinary connectives, the permanence adverbs and the
 *  "until further notice" formula. Anything else that survives is a
 *  qualifier, and a qualified line is a note. */
const FILLER_RE =
	/\b(?:AND|ET|OR|OU|THE|LA|LE|LES|DE|DU|DES|EN|AU|AUX|POUR|SUR|A|IS|ARE|WAS|WERE|WILL|BE|BEING|EST|SONT|SERA|SERONT|ETAIT|ETAIENT|RESTE|RESTERA|RESTERONT|DEMEURE|DEMEURERA|TO|FOR|ALL|ANY|TOUT|TOUTE|TOUS|TOUTES|TRAFFIC|TRAFIC|CIRCULATION|ACFT|AIRCRAFT|AERONEF|AERONEFS|AIR|DEFINITIVELY|DEFINITIVEMENT|PERMANENTLY|DEFINITIVE|TEMPO|TEMPORAIREMENT|TEMPORARILY|JUSQU|AVIS|NOUVEL|FURTHER|NOTICE|UNTIL|UFN)\b/g;

/** Fold accents and collapse whitespace, so AERODROME reads like AÉRODROME
 *  and the line is comparable however the source spaced it. */
function fold(text: string): string {
	return text
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toUpperCase()
		.replace(/\s+/g, ' ')
		.trim();
}

/** Bare words, for comparing a residue against a published name. */
function words(text: string): string[] {
	return fold(text)
		.replace(/[^A-Z0-9]+/g, ' ')
		.split(' ')
		.filter((w) => w !== '');
}

/** What a line leaves unaccounted for once the closure, the noun, the
 *  universal complement, the cause, the exception and the fillers are taken
 *  out of it. '' means the line closes the field on its own. `null` means it
 *  is not a closure statement at all, whatever is left over. */
function closureResidue(line: string): string | null {
	if (HEDGE_RE.test(line) || !CLOSED_RE.test(line) || !AERODROME_RE.test(line)) {
		return null;
	}
	// The closure word must come after the noun it closes. "CLOSURE OF RUNWAY
	// 11L/29R" preceded by the word AERODROME earlier in the sentence is a
	// runway's closure announced at an aerodrome, not the aerodrome's own, and
	// the residue test alone would forgive a short enough sentence.
	if (line.search(CLOSED_RE) < line.search(AERODROME_RE)) {
		return null;
	}
	let rest = line.replace(EXCEPT_RE, ' ').replace(CAUSE_RE, ' ');
	// Re-test after the tails are cut: a closure word that lived only inside
	// the cause ("DUE TO CLOSURE OF RWY 11") closes nothing here.
	if (!CLOSED_RE.test(rest) || !AERODROME_RE.test(rest)) {
		return null;
	}
	rest = rest.replace(CLOSED_RE, ' ').replace(AERODROME_RE, ' ').replace(UNIVERSAL_RE, ' ');
	return words(rest.replace(FILLER_RE, ' ')).join(' ');
}

/** Read each line of an E) text as a statement about the aerodrome. Lines
 *  naming no aerodrome are skipped entirely.
 *
 *  `name` is the field's PUBLISHED name, and passing it is what lets a line
 *  that names the field close it: the SIA writes "TERRAIN NANCY-OCHEY FERME"
 *  (M1799/26 LFSO) as readily as "AERODROME FERME", and a proper noun is not
 *  something a grammar can forgive on its own. Forgiving ANY word between
 *  the noun and the closure would close a field on "AD ADMINISTRATION CLSD",
 *  which shuts an office; matching the residue against the published name is
 *  exact or nothing, and no aerodrome is named ADMINISTRATION. */
export function parseAerodromeClosure(
	eText: string,
	name?: string | null,
): AerodromeStatement[] {
	if (typeof eText !== 'string' || eText === '') {
		return [];
	}
	const own = new Set(words(name ?? ''));
	const out: AerodromeStatement[] = [];
	for (const raw of eText.split('\n')) {
		const line = fold(raw);
		if (line === '' || !AERODROME_RE.test(line)) {
			continue;
		}
		const residue = closureResidue(line);
		// Every leftover word has to be one of the field's own name words: a
		// residue naming the field and something else has not been explained.
		const named =
			residue !== null &&
			residue !== '' &&
			own.size > 0 &&
			residue.split(' ').every((w) => own.has(w));
		out.push({
			kind: residue === '' || named ? 'closed' : 'note',
			line,
			residue: residue ?? '',
		});
	}
	return out;
}

/** Does this text close the aerodrome outright? True as soon as one line
 *  does, which is the shape the corpus writes: a closure is its own line. */
export function closesAerodrome(eText: string, name?: string | null): boolean {
	return parseAerodromeClosure(eText, name).some((s) => s.kind === 'closed');
}
