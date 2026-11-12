/* Read a runway's OPERATIONAL STATE out of a NOTAM's E) text: which runway
 * ends it closes, and what it says about the ones it does not.
 *
 * Two decisions carried over from notam/fuelChange.ts, for the same reason:
 *
 *  - THE CLAUSE IS THE LINE. The SIA writes one statement per line and
 *    cleanNotamContent keeps them, so "PISTE 20 FERMEE" and a second line
 *    about the taxiway are read apart.
 *  - A LINE CLOSES A RUNWAY ONLY WHEN IT IS CLOSED: a runway keyword, its
 *    designators, a closure word, an optional surface adjective and an
 *    optional stated cause, and nothing else. That is a closed grammar
 *    rather than a list of hedges, because the hedges are open-ended and
 *    the corpus is full of them: "PISTE NON REVETUE 22 : APPROCHE ET
 *    ATTERRISSAGE INTERDITS" closes the runway to landings only, "PISTE NON
 *    REVETUE 08L/26R RESERVEE AUX ULM BASES" closes it to everyone else,
 *    "RWY 29 LIMITED" closes it at night. Each of those is a NOTE beside the
 *    runway, never a closure, which is what lets the grammar refuse: the
 *    dangerous state, a runway reading open with nothing beside it, cannot
 *    occur while every line that named it is either read or noted.
 *
 * Pure, no Svelte, no I/O; the resolution against published runways and the
 * date and schedule gates live in state/runwayOverride.svelte.ts. Pinned by
 * tests/runwayChange.spec.ts. */

import { extractRunwayDesignators } from './runwayRefs';

/** One line's verdict about the runway ends it names. */
export interface RunwayStatement {
	/** Normalised ends ('07', '25', '03R'), in the order the line names them. */
	designators: string[];
	/** 'closed': the line closes them. 'note': it says something else about
	 *  them that the reader has to see. */
	kind: 'closed' | 'note';
	/** The line itself, whitespace-collapsed, for the note's text. */
	line: string;
}

/** A closure word, either language. FERME agrees with its subject, so every
 *  ending is spelled out, the way serviceStatus.ts spells its adjectives. */
const CLOSED_RE = /\b(?:FERMEES?|FERMES?|CLOSED|CLSD)\b/;

/** What a closure line may carry besides its designators and its closure
 *  word: the runway noun, the surface adjectives the SIA puts between the
 *  noun and the numbers, and the ordinary connectives. Anything else that
 *  survives is a qualifier, and a qualified line is a note. */
const FILLER_RE =
	/\b(?:RWY|RUNWAY|RUNWAYS|PISTE|PISTES|THR|SEUIL|AND|ET|OR|OU|THE|LA|LE|LES|DE|DU|DES|EN|AU|AUX|POUR|SUR|NON|REVETUE|REVETUES|REVETU|REVETUS|PAVED|UNPAVED|GRASS|HERBE|GAZONNEE|GAZONNEES|AVION|AVIONS|ACFT|TEMPO|TEMPORAIREMENT|TEMPORARILY|JUSQU|AVIS|NOUVEL|FURTHER|NOTICE|UNTIL)\b/g;

/** A stated cause runs to the end of its line: the same rule fuelChange.ts
 *  uses, and the same vocabulary the corpus writes. */
const CAUSE_RE =
	/\b(?:CAUSE|DUE\s+TO|EN\s+RAISON\s+DE|EN\s+RAISON\s+D|POUR\s+CAUSE\s+DE|DUE|WIP|TRAVAUX)\b[\s\S]*$/;

/** Fold accents and collapse whitespace, so AERO reads like AÉRO and the
 *  line is comparable however the source spaced it. */
function fold(text: string): string {
	return text
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toUpperCase()
		.replace(/\s+/g, ' ')
		.trim();
}

/** Is this line CLOSED, in the sense above: everything it carries is
 *  accounted for by the closure, the designators, the fillers and the cause. */
function isClosed(line: string, designators: string[]): boolean {
	let rest = line.replace(CAUSE_RE, ' ');
	if (!CLOSED_RE.test(rest)) {
		return false;
	}
	rest = rest.replace(CLOSED_RE, ' ');
	// The designators the line named, and the separators between them.
	for (const d of designators) {
		rest = rest.replace(new RegExp(`\\b0?${d.replace(/^0/, '')}\\b`, 'g'), ' ');
	}
	rest = rest.replace(FILLER_RE, ' ');
	// Bare numbers left over are the unpadded halves of a pair ("08L/26R"
	// leaves nothing, "07/25" may leave a bare 7).
	rest = rest.replace(/\b\d{1,2}[LRC]?\b/g, ' ');
	return !/[A-Z0-9]/.test(rest.replace(/[^A-Z0-9]/g, ''));
}

/** Read each line of an E) text as a statement about the runway ends it
 *  names. Lines naming no runway are skipped entirely. */
export function parseRunwayChange(eText: string): RunwayStatement[] {
	const out: RunwayStatement[] = [];
	for (const raw of eText.split('\n')) {
		const line = fold(raw);
		if (line === '') {
			continue;
		}
		const designators = extractRunwayDesignators(line);
		if (designators.length === 0) {
			continue;
		}
		out.push({
			designators,
			kind: isClosed(line, designators) ? 'closed' : 'note',
			line,
		});
	}
	return out;
}

/** The ends a text closes, deduplicated, in first-mention order. Empty when
 *  it closes none, which is the common case even for a QMR NOTAM. */
export function closedRunwayEnds(eText: string): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const s of parseRunwayChange(eText)) {
		if (s.kind !== 'closed') {
			continue;
		}
		for (const d of s.designators) {
			if (!seen.has(d)) {
				seen.add(d);
				out.push(d);
			}
		}
	}
	return out;
}
