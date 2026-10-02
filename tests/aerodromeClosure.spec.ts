/* The aerodrome-closure grammar ($lib/notam/aerodromeClosure.ts) against the
 * real E) texts of a French national corpus, in both languages.
 *
 * What is pinned here is as much what the grammar REFUSES as what it reads:
 * four of the lines below carry an aerodrome noun and a closure word and
 * close no aerodrome, and the whole mechanism rests on their staying notes
 * (docs/notam-relationships.md, mechanism 17).
 */

import { describe, it, expect } from 'vitest';
import { parseAerodromeClosure, closesAerodrome } from '$lib/notam/aerodromeClosure';
import { isAerodromeQCode } from '$lib/notam/qcode';

/** The verdict on a one-line text, the shape every case below is written in. */
function verdict(text: string, name?: string): 'closed' | 'note' | 'none' {
	const st = parseAerodromeClosure(text, name);
	if (st.length === 0) {
		return 'none';
	}
	return st.some((s) => s.kind === 'closed') ? 'closed' : 'note';
}

describe('the Q-code gate', () => {
	it('is the SUBJECT, not the condition', () => {
		// Every condition the corpus files an aerodrome closure under, and the
		// one it files a workshop under: the subject is what decides.
		for (const q of ['QFALC', 'QFALT', 'QFAXX', 'QFALB', 'QFATT', 'QFAAH']) {
			expect(isAerodromeQCode(q), q).toBe(true);
		}
		// A runway, a fuel outage and a frequency change are other mechanisms'.
		for (const q of ['QMRLC', 'QFULT', 'QCACF', 'QSFAU', '', 'QFA']) {
			expect(isAerodromeQCode(q), q).toBe(false);
		}
	});
});

describe('lines that close the field', () => {
	// Every QFALC standing over France on 2026-09-18, verbatim.
	const closed: [string, string][] = [
		['M3269/26 LFSX', 'AD CLOSED DUE TO WORKS.'],
		['D5526/26 LFBS', 'AD CLSD.'],
		['D5391/26 LFDC', 'AERODROME CLSD'],
		['C3366/26 LFLY', 'AERODROME CLSD FOR ANY AIR TRAFFIC EXC RESCUE HOME BASED HEL.'],
		['B4221/26 LFMK', 'AD CLOSED'],
		[
			'M2307/26 LFPV',
			'AD CLOSED TO ALL TRAFFIC DUE TO CONTROL RESTRICTIONS EXC EMERG, MEDEVAC, ORGAN TRANSPORT, FRENCH AND FOREIGN GOVERNMENT AUTHORITIES.',
		],
		['A5570/26 LFPB', 'AERODROME CLSD.'],
		['E4386/26 LFOR', 'AD CLSD DUE TO DRONE SHOW IN THE VICINITY OF AD'],
		['M3286/26 LFPV', 'AD CLOSED TO ALL TRAFIC EXC EMERG (MIL CEREMONY).'],
		['M1603/26 LFXQ', 'AD CLOSED DEFINITIVELY.'],
		// Filed QFALT, not QFALC. The one the condition gate would have lost,
		// and the reason isAerodromeQCode reads the subject alone.
		[
			'E4369/26 LFRW',
			'AD CLSD DUE TO EVENT EXC FOR THOSE WHO ARE TAKING PART TO THE EVENT AUTHORISED BY AD MANAGER .',
		],
		// The English twin of C3366/26, a cycle earlier: the SIA writes EVERY
		// and ANY for the same thing.
		['C2192/26 LFLY', 'AD CLSD TO EVERY AIR TRAFFIC, EXC FOR RESCUE HOME BASED HEL .'],
		['B2487/26 LFRH', 'AERODROME CLOSED FOR ALL TRAFFIC, EXC FOR OPERATIONAL FLIGHTS AND MILITARY.'],
		['C2205/26 LFMD', 'AD CLSD.'],
	];
	for (const [who, text] of closed) {
		it(`${who}: ${text.slice(0, 54)}`, () => {
			expect(verdict(text)).toBe('closed');
		});
	}
});

describe('French says it with a copula, and English with none', () => {
	// The bilingual halves of the world fixtures, which are independently
	// authored. An extractor that read one language would hide the other's
	// closure entirely (tests/bilingual.spec.ts' rule).
	const fr: [string, string][] = [
		['M3269/26 LFSX', 'LE TERRAIN SERA FERME CAUSE TRAVAUX.'],
		['D3224/26 LFHV', 'AD FERME.'],
		['E2831/26 LFON', 'AERODROME FERME.'],
		['M1603/26 LFXQ', 'AERODROME FERME DEFINITIVEMENT.'],
		['M1901/26 LFQP', 'AERODROME FERME CAUSE MAINTENANCE RADIO.'],
		[
			'M1049/26 LFPV',
			'AERODROME FERME A TOUT TRAFIC CAUSE RESTRICTION CONTROLE SAUF URGENCE, MEDEVAC.',
		],
		[
			'B2440/26 LFRH',
			'AERODROME FERME A TOUT TRAFIC SAUF VOLS OPERATIONNELS ET VOLS MILITAIRES.',
		],
	];
	for (const [who, text] of fr) {
		it(`${who}: ${text.slice(0, 50)}`, () => {
			expect(verdict(text)).toBe('closed');
		});
	}

	it('accented and unaccented spellings read alike', () => {
		expect(verdict('AÉRODROME FERMÉ.')).toBe('closed');
		expect(verdict('AERODROME FERME.')).toBe('closed');
	});
});

describe('lines that name the field and close nothing', () => {
	it('CLOSE is a preposition, not a closure (E1395/25 LFAX)', () => {
		expect(
			verdict(
				"PRESENCE OF A PRIVATE USE ULM PAVED RWY CLOSE TO THE AD (LOCALITY 'SURMONT', 'COURGEOUT' TOWN).",
			),
		).toBe('note');
	});

	it('a hedge is not a closure (D4843/26 LFDS)', () => {
		expect(
			verdict('- DURING THESE FLIGHTS, AD MAY BE CLOSED TO ALL OTHER TRAFFIC FOR SHORT PERIODS,'),
		).toBe('note');
		expect(
			verdict("- PENDANT CES VOLS, AERODROME SUCEPTIBLE D'ETRE FERME A TOUT AUTRE TRAFIC,"),
		).toBe('note');
	});

	it('what closes is not always the field (D5143/26 LFGF, C1774/26 LFGA)', () => {
		// An AD 2 section reference is not the aerodrome noun: "AD2" carries
		// no word boundary before its digit, so this line never enters the
		// grammar, which is a stronger refusal than a note. The NOTAM is
		// still listed under the field's own "Affecting NOTAMs"; what it does
		// not do is say anything about the field's STATE.
		expect(
			verdict("AD2 LFGF TXT2 14 ITEM REPARATIONS/REPAIRS : WORKSHOP 'AIR SERVICES 21' CLOSED"),
		).toBe('none');
		// This one does name the aerodrome, and what it shuts is the office.
		expect(verdict('ADMINISTRATIVE DEPARTMENT OF AD ADMINISTRATION CLSD.', 'GRAY ST ADRIEN')).toBe(
			'note',
		);
	});

	it('a runway closure announced at an aerodrome is the runway mechanism (E2484/26 LFPZ)', () => {
		expect(
			verdict(
				"RESTRICTIONS ON USE OF AERODROME SAINT-CYR L'ECOLE (LFPZ) IN THE ABSENCE OF ATS SERVICES DUE TO CLOSURE OF RUNWAY 11L/29R FOR RENOVATION WORKS.",
			),
		).toBe('note');
	});

	it('closed to SOMEBODY leaves it open to somebody else (M2599/26 LFOJ, C2231/26 LFLP)', () => {
		// The app cannot know whether this pilot is based here or flying IFR,
		// so neither line closes the field; both are said beside it.
		expect(verdict('- AD CLOSED TO OUTSIDE ACFT')).toBe('note');
		expect(verdict('AERODROME CLSD TO VFR OPERATIONS EXC WITH AD ADMINISTRATOR AGREEMENT')).toBe(
			'note',
		);
	});

	it('an hour range inside E) is not a schedule this reads (D3366/26 LFCE)', () => {
		// D) is where a recurring window belongs, and the resolver reads it
		// there. A range written into the prose is refused rather than
		// half-read, which would close the field around the clock.
		expect(verdict('- AERODROME FERME A TOUS AERONEFS DE 0600 A 1600.')).toBe('note');
	});

	it('a field merely reserved is not a field closed (D5612/26 LFKY)', () => {
		expect(verdict('AD RESERVED FOR HOME BASED ACFT.')).toBe('note');
		expect(verdict('AD RESERVED FOR HOME BASED ACFT DUE TO WIP')).toBe('note');
	});
});

describe('the published name is what lets a line naming the field close it', () => {
	// M1799/26 LFSO. A proper noun is not something a grammar can forgive on
	// its own: the residue is matched against the field's OWN name, exactly.
	const line = 'TERRAIN NANCY-OCHEY FERME.';

	it('closes when the name is the aerodrome it is filed under', () => {
		expect(verdict(line, 'NANCY OCHEY')).toBe('closed');
	});

	it('stays a note without the name', () => {
		expect(verdict(line)).toBe('note');
	});

	it('stays a note under another field’s name', () => {
		expect(verdict(line, 'LYON BRON')).toBe('note');
	});

	it('does not forgive a word the name does not carry', () => {
		// The rule is exact or nothing: "AD ADMINISTRATION CLSD" must not
		// close Nancy Ochey just because a name was supplied.
		expect(verdict('AD ADMINISTRATION CLSD.', 'NANCY OCHEY')).toBe('note');
		expect(verdict('TERRAIN NANCY-OCHEY ET SES ABORDS FERMES.', 'NANCY OCHEY')).toBe('note');
	});
});

describe('the clause is the line', () => {
	it('reads a closure line apart from the prose around it (M2599/26 LFOJ)', () => {
		const text = [
			'AD IN AUTO INFORMATION, RESERVED FOR BASED CREWS.',
			'USE CONDITIONS :',
			'- AD CLOSED TO OUTSIDE ACFT',
			'- TKOF AND LDG ON FREQ 122.100MHZ',
		].join('\n');
		const st = parseAerodromeClosure(text);
		// Two lines name the aerodrome, neither closes it, and the frequency
		// line names none at all.
		expect(st.map((s) => s.kind)).toEqual(['note', 'note']);
		expect(closesAerodrome(text)).toBe(false);
	});

	it('one closed line closes the field however much prose follows', () => {
		const text = [
			'AD CLOSED DEFINITIVELY.',
			'REF : - AIP : GEN 2.4 AND AD 1.3 - MILAIP MIAM : AD1.3 AND AD2',
		].join('\n');
		expect(closesAerodrome(text)).toBe(true);
	});
});

describe('the degenerate inputs', () => {
	it('answer empty rather than throwing', () => {
		expect(parseAerodromeClosure('')).toEqual([]);
		expect(parseAerodromeClosure(null as unknown as string)).toEqual([]);
		expect(closesAerodrome('RWY 07/25 CLSD')).toBe(false);
		expect(closesAerodrome('AD CLSD', null)).toBe(true);
	});
});
