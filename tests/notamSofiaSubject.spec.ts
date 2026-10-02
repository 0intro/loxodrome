import { describe, it, expect } from 'vitest';
import { sofiaSubjectCategory, SOFIA_SUBJECT_ORDER, type SofiaScope } from '$lib/notam/sofiaSubject';
import { fr } from '$lib/i18n/fr';
import { en } from '$lib/i18n/en';
import fixture from './fixtures/sofiaSubject.json';

// Straight vs typographic apostrophe: the extracted fixture uses ', the FR
// catalog uses the required typographic quote. Compare apostrophe-insensitively.
const apos = (s: string): string => s.replace(/’/g, "'");

const buckets: Record<string, SofiaScope> = { aero: 'aerodrome', enr: 'enroute' };
const fx = fixture as Record<string, Record<string, string>>;

describe('sofiaSubjectCategory pinned to a real SOFIA-Briefing PIB', () => {
	// Every (Q-code, printed heading) pair extracted from the reference PDF
	// (docs/sofia-briefing.md; tests/fixtures/sofiaSubject.json) must be
	// reproduced by the mapping + the French catalog wording.
	for (const [bucket, scope] of Object.entries(buckets)) {
		for (const [qcode, heading] of Object.entries(fx[bucket])) {
			it(`${scope}: ${qcode} -> ${heading}`, () => {
				const key = sofiaSubjectCategory(qcode, scope);
				expect(apos(fr.notam.sofiaGroups[key])).toBe(apos(heading));
			});
		}
	}
});

describe('sofiaSubjectCategory rule', () => {
	it('splits the QM movement area into manoeuvring vs traffic area', () => {
		expect(sofiaSubjectCategory('QMRLC', 'aerodrome')).toBe('adManoeuvring'); // runway
		expect(sofiaSubjectCategory('QMXLC', 'aerodrome')).toBe('adManoeuvring'); // taxiway
		expect(sofiaSubjectCategory('QMPLT', 'aerodrome')).toBe('adApron'); // apron
		expect(sofiaSubjectCategory('QMKLT', 'aerodrome')).toBe('adApron'); // stands
	});

	it('is context-dependent for airspace / procedures / comms subjects', () => {
		expect(sofiaSubjectCategory('QANLT', 'aerodrome')).toBe('adAirspaceAts');
		expect(sofiaSubjectCategory('QANLT', 'enroute')).toBe('enrAirspaceProc');
		expect(sofiaSubjectCategory('QCACF', 'aerodrome')).toBe('adAirspaceAts');
		expect(sofiaSubjectCategory('QCACF', 'enroute')).toBe('enrCom');
		expect(sofiaSubjectCategory('QSELT', 'aerodrome')).toBe('adAirspaceAts');
		expect(sofiaSubjectCategory('QSELT', 'enroute')).toBe('enrAtsVolmet');
	});

	it('routes RVR / transmissometer (QFT) to meteorology, other QF to facilities', () => {
		expect(sofiaSubjectCategory('QFTAS', 'aerodrome')).toBe('adMeteo');
		expect(sofiaSubjectCategory('QFUAU', 'aerodrome')).toBe('adFacilities');
	});

	it('falls back to other for malformed Q-codes', () => {
		expect(sofiaSubjectCategory('', 'aerodrome')).toBe('other');
		expect(sofiaSubjectCategory('QKKKK', 'enroute')).toBe('other');
		expect(sofiaSubjectCategory('nonsense', 'enroute')).toBe('other');
	});

	it('every mapped key is present in both catalogs and both orders', () => {
		for (const scope of ['aerodrome', 'enroute'] as const) {
			for (const key of SOFIA_SUBJECT_ORDER[scope]) {
				expect(fr.notam.sofiaGroups[key]).toBeTruthy();
				expect(en.notam.sofiaGroups[key]).toBeTruthy();
			}
		}
	});
});
