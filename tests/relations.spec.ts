import { describe, it, expect } from 'vitest';
import { parseNotams } from '$lib/notam';
import {
	hasRestrictedAreaSubject,
	isTriggerNotam,
	notamReferences,
	notamReplacement,
} from '$lib/notam/relations';

// Inline trimmed fixtures keep this spec self-explanatory and independent
// of the multi-MB briefing files in tests/fixtures/.

const TRIGGER_NOTAM = `LFFA-R2198/25
DU: 12 09 2025 14:29 AU: 25 11 2026 19:30
A) LFPK
Q) LFFF / QRTTT / IV / BO / AW / 000/017 / 4850N00259E002
E) TRIGGER NOTAM - AIP SUP 147/25 :
DRONE FLIGHTS AND PYROTECHNIC ACTIVITIES REQUIRING THE CREATION OF 2
TEMPORARY RESTRICTED AREAS AND AD USE RESTRICTIONS.
F) SFC
G) 1700FT AMSL
`;

const TRIGGER_NOTAM_FR = `R2198/25 NOTAMR R1978/25
Q) LFFF/QRTTT/IV/BO/AW/000/017/4851N00300E002
A) LFPK B) 2509121429 C) 2611251930
E) NOTAM TRIGGER - SUP AIP 147/25 :
ACTIVITES DRONES ET PYROTECHNIQUES.
F) SFC G) 1700FT AMSL
`;

const REPLACEMENT_NOTAM = `A0001/26 NOTAMR A0981/25
Q) LFFF / QXXLT / IV / NBO / AE / 000/999 / 4852N00220E002
A) LFPG B) 2601010000 C) PERM
E) RWY 27R CLSD FOR MAINT.
`;

const REFERRING_NOTAM = `W0107/26
Q) ZWWW / QARLC / IV / NBO / E / 000/999 / 4500N09000E020
A) ZWWW B) 2602011200 C) 2602021200
E) ATS RTE V604 NOZ/DEGDI CLSD DUE TO MIL EXER, REF NOTAM W0106/26
`;

const MULTI_REF_NOTAM = `B0521/25
Q) KZAK / QARLC / IV / NBO / E / 000/999 / 4500N07000W020
A) KZAK B) 2510010000 C) 2611011200
E) THREE RELATED NOTAMS REGARDING THE: DC FLIGHT RESTRICTED ZONE (FRZ),
REF NOTAM A3152/25.
REF NOTAM PERM P4307/25
`;

const PLAIN_NOTAM = `A1234/26
Q) LFFF / QOBCE / IV / M / A / 000/005 / 4900N00210E001
A) LFPG B) 2601010000 C) PERM
E) CRANE 45 M AGL ERECTED NEAR LFPG.
`;

describe('isTriggerNotam', () => {
	it('matches "TRIGGER NOTAM" English phrasing at the E-section head', () => {
		const [n] = parseNotams(TRIGGER_NOTAM);
		expect(isTriggerNotam(n)).toBe(true);
	});

	it('matches "NOTAM TRIGGER" French phrasing at the E-section head', () => {
		const [n] = parseNotams(TRIGGER_NOTAM_FR);
		expect(isTriggerNotam(n)).toBe(true);
	});

	it('is case-insensitive', () => {
		const [n] = parseNotams(TRIGGER_NOTAM.replace('TRIGGER NOTAM', 'trigger notam'));
		expect(isTriggerNotam(n)).toBe(true);
	});

	it('returns false for a non-trigger NOTAM', () => {
		const [n] = parseNotams(PLAIN_NOTAM);
		expect(isTriggerNotam(n)).toBe(false);
	});

	// Anchoring guard: a body that quotes the phrase in prose elsewhere
	// (not at the E-section head) must not false-positive.
	it('does not match when the phrase appears outside the E-section', () => {
		const text = `D0099/26
Q) LFFF/QOBCE/IV/M/A/000/005/4900N00210E001
A) LFFF B) 2605231300 C) 2605231430
E) NEW OBSTACLE NEAR LFPG. THE TRIGGER NOTAM PUBLISHED LAST WEEK
DEFINED A SEPARATE ZONE THAT THIS OBSTACLE DOES NOT AFFECT.
`;
		const [n] = parseNotams(text);
		expect(isTriggerNotam(n)).toBe(false);
	});
});

describe('notamReplacement', () => {
	it('extracts the predecessor id from a NOTAMR header', () => {
		const [n] = parseNotams(REPLACEMENT_NOTAM);
		expect(n.id).toBe('A0001/26');
		expect(notamReplacement(n)).toBe('A0981/25');
	});

	it('extracts the predecessor for a French trigger replacement', () => {
		const [n] = parseNotams(TRIGGER_NOTAM_FR);
		expect(n.id).toBe('R2198/25');
		expect(notamReplacement(n)).toBe('R1978/25');
	});

	it('returns null for a plain non-NOTAMR NOTAM', () => {
		const [n] = parseNotams(PLAIN_NOTAM);
		expect(notamReplacement(n)).toBeNull();
	});

	it('returns null when the body starts with the validity line', () => {
		const [n] = parseNotams(TRIGGER_NOTAM);
		expect(notamReplacement(n)).toBeNull();
	});

	// Reads the structural `replaces` field the parser populates from
	// the NOTAMR header, not from peeking at fullContent. The bare
	// predecessor id is also stripped from fullContent so the raw body
	// view stays clean.
	it('reads the parser-populated structural field', () => {
		const [n] = parseNotams(REPLACEMENT_NOTAM);
		expect(n.replaces).toBe('A0981/25');
		expect(n.fullContent.startsWith('A0981/25')).toBe(false);
	});

	it('leaves replaces null on non-NOTAMR NOTAMs', () => {
		const [n] = parseNotams(PLAIN_NOTAM);
		expect(n.replaces).toBeNull();
	});
});

describe('notamReferences', () => {
	it('pulls a single REF NOTAM out of the body', () => {
		const [n] = parseNotams(REFERRING_NOTAM);
		expect(notamReferences(n)).toEqual(['W0106/26']);
	});

	it('handles REF NOTAM PERM and multi-reference bodies', () => {
		const [n] = parseNotams(MULTI_REF_NOTAM);
		expect(notamReferences(n)).toEqual(['A3152/25', 'P4307/25']);
	});

	it('returns [] for bodies without a REF NOTAM clause', () => {
		const [n] = parseNotams(PLAIN_NOTAM);
		expect(notamReferences(n)).toEqual([]);
	});

	it('dedupes repeated references', () => {
		const text = MULTI_REF_NOTAM.replace(
			'REF NOTAM PERM P4307/25',
			'REF NOTAM A3152/25\nREF NOTAM PERM P4307/25',
		);
		const [n] = parseNotams(text);
		expect(notamReferences(n)).toEqual(['A3152/25', 'P4307/25']);
	});

	it('catches "BY NOTAM <id>" and "ANNOUNCED BY NOTAM <id>" phrasings', () => {
		// Real shape from notam1.txt line 24862; Italian air-display
		// consequences referring back to the primary restricted-area NOTAM.
		const text = `A2429/26
Q) LIMM/QPIAU/I/NBO/A/000/999/4512N00739E005
A) LIMF B) 2605231300 C) 2605231430
E) ALL INSTRUMENT APPROACH PROCEDURES AND CIRCLING NOT AVBL
DUE TO AIR DISPLAY ANNOUNCED BY NOTAM W1633/26
`;
		const [n] = parseNotams(text);
		expect(notamReferences(n)).toEqual(['W1633/26']);
	});

	it('catches the "REF : NOTAM" and "REF PERM NOTAM" REF variants', () => {
		const text = `B1774/26
Q) LFFF/QPIAU/I/NBO/A/000/999/4300N00500E001
A) LFCR B) 2605231300 C) 2605231430
E) - REF : NOTAM PERM B0997/26 AMENDING AD2 LFCR IAC RWY 13 RNP.
REF PERM NOTAM LFFA-C0991/26.
`;
		const [n] = parseNotams(text);
		expect(notamReferences(n)).toEqual(['B0997/26', 'LFFA-C0991/26']);
	});

	it('does not false-match "BY NOTAM" without a following id', () => {
		const text = `C0001/26
Q) LFFF/QPIAU/I/NBO/A/000/999/4300N00500E001
A) LFFF B) 2605231300 C) 2605231430
E) ACTIVITY ANNOUNCED BY NOTAM WITH 48HR NOTICE. NO ID HERE.
`;
		const [n] = parseNotams(text);
		expect(notamReferences(n)).toEqual([]);
	});

	it('catches "SEE NOTAM <id>" and "SEE NOTAM: <id>" phrasings', () => {
		const text = `D0001/26
Q) LFFF/QPIAU/I/NBO/A/000/999/4300N00500E001
A) LFFF B) 2605231300 C) 2605231430
E) DUE MOBILE CRANES (SEE NOTAM B0365/26) CHANGE OF PROCEDURES.
SEE NOTAM: A0762/26
`;
		const [n] = parseNotams(text);
		expect(notamReferences(n)).toEqual(['B0365/26', 'A0762/26']);
	});

	it('catches "AS PER NOTAM <id>"', () => {
		const text = `D0002/26
Q) LFFF/QPIAU/I/NBO/A/000/999/4300N00500E001
A) LFFF B) 2605231300 C) 2605231430
E) AIRSPACE, AS PER NOTAM A4031/25, ARRANGED AS FOLLOWS.
`;
		const [n] = parseNotams(text);
		expect(notamReferences(n)).toEqual(['A4031/25']);
	});

	it('catches "REF (B) TURKISH NOTAM <id>" with country modifier', () => {
		const text = `D0003/26
Q) LFFF/QPIAU/I/NBO/A/000/999/4300N00500E001
A) LFFF B) 2605231300 C) 2605231430
E) REF (A) TURKISH NOTAM A5935/25 (301053 EUECYIYN DEC 2025).
`;
		const [n] = parseNotams(text);
		expect(notamReferences(n)).toEqual(['A5935/25']);
	});

	it('extends multi-id lists with comma + AND continuation', () => {
		const text = `D0004/26
Q) LFFF/QPIAU/I/NBO/A/000/999/4300N00500E001
A) LFFF B) 2605231300 C) 2605231430
E) REF (B) TURKISH NOTAMS A5935/25, A5936/25 AND A5937/25.
SEE NEWLY ISSUED NOTAM: A4043/25, A4044/25, A4045/25 AND A4046/25.
`;
		const [n] = parseNotams(text);
		expect(notamReferences(n)).toEqual([
			'A5935/25', 'A5936/25', 'A5937/25',
			'A4043/25', 'A4044/25', 'A4045/25', 'A4046/25',
		]);
	});

	it('catches bare "PERM NOTAM <id>" cross-references', () => {
		const text = `D0005/26
Q) LFFF/QPIAU/I/NBO/A/000/999/4300N00500E001
A) LFFF B) 2605231300 C) 2605231430
E) CHANGED AS FOLLOWS (PERM NOTAM C0964/26 CHANGED):
`;
		const [n] = parseNotams(text);
		expect(notamReferences(n)).toEqual(['C0964/26']);
	});
});

// hasRestrictedAreaSubject is the second gate on the map-stripe filter:
// only trigger NOTAMs whose qCode subject is in the airspace-restriction
// family (RR/RT/RD/RP/RA/RM) qualify. Triggers for lighting, snow, IFR
// procedures, obstacles, etc. share the same TRIGGER NOTAM body keyword
// but their geometry doesn't represent an activatable airspace zone.
describe('hasRestrictedAreaSubject', () => {
	it('matches every restricted-area subject', () => {
		for (const subj of ['RR', 'RT', 'RD', 'RP', 'RA', 'RM']) {
			const text = `D0010/26
Q) LFFF/Q${subj}TT/IV/M/A/000/050/4900N00210E005
A) LFFF B) 2605010000 C) 2606010000
E) TRIGGER NOTAM - AIP SUP 999/26.
`;
			const [n] = parseNotams(text);
			expect(hasRestrictedAreaSubject(n), `subject ${subj}`).toBe(true);
		}
	});

	it('rejects other qCode subjects', () => {
		// All real trigger qCodes seen in the corpus that aren't airspace-
		// restrictions: lighting / friction / snow / IFR proc / obstacle.
		for (const subj of ['LE', 'FA', 'ST', 'SP', 'PI', 'PD', 'PA', 'OB', 'OA', 'MX']) {
			const text = `D0011/26
Q) LFFF/Q${subj}TT/IV/M/A/000/050/4900N00210E005
A) LFFF B) 2605010000 C) 2606010000
E) TRIGGER NOTAM - AIP SUP 999/26.
`;
			const [n] = parseNotams(text);
			expect(hasRestrictedAreaSubject(n), `subject ${subj}`).toBe(false);
		}
	});

	it('rejects malformed / missing qCodes', () => {
		const text = `D0012/26
Q) LFFF / / IV / M / A / 000/050 / 4900N00210E005
A) LFFF B) 2605010000 C) 2606010000
E) TRIGGER NOTAM.
`;
		const [n] = parseNotams(text);
		expect(hasRestrictedAreaSubject(n)).toBe(false);
	});
});

// A trigger NOTAM's body almost always references an AIP SUP rather
// than another NOTAM in the same briefing. The framework <-> activation
// pairing is bridged by shared airspace ids (LF-R302 -> LFR302) via
// notamTriggers / notamTriggeredBy in notamLinks.svelte.ts, not by the
// REF / SEE / AS PER primitives tested above.
describe('trigger body references', () => {
	it('a TRIGGER NOTAM that points at an AIP SUP has no NOTAM-id refs', () => {
		const [trigger] = parseNotams(TRIGGER_NOTAM);
		expect(isTriggerNotam(trigger)).toBe(true);
		expect(notamReferences(trigger)).toEqual([]);
	});
});
