import { describe, it, expect } from 'vitest';
import { en } from '$lib/i18n/en';
import { fr } from '$lib/i18n/fr';
import { decodeQCode } from '$lib/notam';
import { decodeQCodeWith, groupNotamsBySubject, sortNotamsBySubject } from '$lib/notam/qcode';

// Unit tests for Q-code decoder

describe('decodeQCode', () => {
	it('should decode a known subject and condition', () => {
		expect(decodeQCode('QOBCE')).toBe('Obstacle, erected, exists');
	});

	it('should decode another known pair', () => {
		expect(decodeQCode('QWULW')).toBe('Unmanned aircraft, restricted area created');
	});

	it('should fall back to the raw condition when only the subject is known', () => {
		expect(decodeQCode('QOBZZ')).toBe('Obstacle, ZZ');
	});

	it('should fall back to the raw subject when only the condition is known', () => {
		expect(decodeQCode('QZZCE')).toBe('ZZ, erected, exists');
	});

	it('should return empty string when neither half is known', () => {
		expect(decodeQCode('QZZZZ')).toBe('');
	});

	it('should return empty string for invalid input', () => {
		expect(decodeQCode('')).toBe('');
		expect(decodeQCode('QOB')).toBe('');
		expect(decodeQCode('OBCEX')).toBe('');
		expect(decodeQCode(null as unknown as string)).toBe('');
		expect(decodeQCode(undefined as unknown as string)).toBe('');
	});
});

// The localized decode path: state/i18n's decodeQ is decodeQCodeWith over the
// t.qcode catalog tables. Pin the French output here so the mirror stays wired
// to the same assembly (decodeQCode above stays the canonical English).
describe('decodeQCodeWith over the French tables', () => {
	const decodeFr = (code: string): string =>
		decodeQCodeWith(fr.qcode.subjects, fr.qcode.conditions, code);

	it('decodes QOBCE in French', () => {
		expect(decodeFr('QOBCE')).toBe('Obstacle, érigé(e), existe');
	});

	it('decodes QMRLC in French', () => {
		expect(decodeFr('QMRLC')).toBe('Piste, fermé(e)');
	});
});

// The affecting-NOTAMs panel lists and the FIR briefing both order their rows
// through this helper, so pin the ICAO subject-family routing, the fixed
// briefing order + official labels, and the within-family stability.
describe('groupNotamsBySubject', () => {
	const familyOf = (q: string): string =>
		groupNotamsBySubject([{ q }], (it) => it.q)[0].group.key;

	it('routes each ICAO subject letter to its briefing family', () => {
		expect(familyOf('QRDCA')).toBe('restrictions'); // R*
		expect(familyOf('QWPLW')).toBe('warnings'); // W*
		expect(familyOf('QARCA')).toBe('organisation'); // A*
		expect(familyOf('QPICA')).toBe('procedures'); // P*
		for (const q of ['QCACA', 'QGADA', 'QICAS', 'QNVAS']) {
			expect(familyOf(q)).toBe('navcom'); // C / G / I / N
		}
		for (const q of ['QFAAH', 'QLCAS', 'QMRLC', 'QOACA', 'QSPCA']) {
			expect(familyOf(q)).toBe('services'); // F / L / M / O / S
		}
	});

	it('special-cases OB / OL to obstacles, but other O* stays services', () => {
		expect(familyOf('QOBCE')).toBe('obstacles');
		expect(familyOf('QOLAS')).toBe('obstacles');
		expect(familyOf('QOACA')).toBe('services');
	});

	it('files unparsed or unknown Q-codes under Other', () => {
		expect(familyOf('QZZZZ')).toBe('other'); // Z*, default branch
		expect(familyOf('')).toBe('other');
		expect(familyOf('QOB')).toBe('other'); // malformed, not five letters
		expect(familyOf('not a qcode')).toBe('other');
	});

	it('returns present families in fixed briefing order with official labels', () => {
		// The pure core carries keys + order; the headings live in the catalogs
		// (both languages pinned here so a rewording is a deliberate act).
		// One NOTAM per family, fed in scrambled order.
		const oneEach = [
			{ q: 'QSPCA' }, // services
			{ q: 'QRDCA' }, // restrictions
			{ q: 'QPICA' }, // procedures
			{ q: 'QOBCE' }, // obstacles
			{ q: 'QNVAS' }, // navcom
			{ q: 'QARCA' }, // organisation
			{ q: 'QWPLW' }, // warnings
			{ q: 'QZZZZ' }, // other
		];
		const groups = groupNotamsBySubject(oneEach, (it) => it.q);
		expect(groups.map((g) => g.group.key)).toEqual([
			'restrictions',
			'warnings',
			'organisation',
			'obstacles',
			'navcom',
			'procedures',
			'services',
			'other',
		]);
		expect(groups.map((g) => en.notam.firGroups[g.group.key])).toEqual([
			'Airspace restrictions',
			'Navigation warnings',
			'Airspace organisation',
			'Obstacles',
			'Navaids & communications',
			'Air traffic procedures',
			'Services & facilities',
			'Other',
		]);
		expect(groups.map((g) => fr.notam.firGroups[g.group.key])).toEqual([
			'Restrictions de l\u2019espace a\u00e9rien',
			'Avertissements de navigation',
			'Organisation de l\u2019espace a\u00e9rien',
			'Obstacles',
			'Radionavigation et communications',
			'Proc\u00e9dures de la circulation a\u00e9rienne',
			'Services et installations',
			'Autres',
		]);
		expect(groups.map((g) => g.group.order)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
	});

	it('keeps only present families and preserves input order within one', () => {
		const items = [
			{ q: 'QMRLC', id: 1 }, // services
			{ q: 'QMRLC', id: 2 }, // services
			{ q: 'QRDCA', id: 3 }, // restrictions
			{ q: 'QMRLC', id: 4 }, // services
		];
		const groups = groupNotamsBySubject(items, (it) => it.q);
		expect(groups.map((g) => g.group.key)).toEqual(['restrictions', 'services']);
		expect(groups[1].items.map((it) => it.id)).toEqual([1, 2, 4]);
	});

	it('returns an empty array for no items', () => {
		expect(groupNotamsBySubject([] as { q: string }[], (it) => it.q)).toEqual([]);
	});
});

// The single-group relationship lists (Activated by, Referenced by position,
// geometric, SUP AIP) order their rows through this flat variant.
describe('sortNotamsBySubject', () => {
	it('flattens the families into one briefing-ordered list, stable within one', () => {
		const items = [
			{ q: 'QMRLC', id: 1 }, // services
			{ q: 'QWPLW', id: 2 }, // warnings
			{ q: 'QRDCA', id: 3 }, // restrictions
			{ q: 'QMRLC', id: 4 }, // services
		];
		// restrictions(0) < warnings(1) < services(6); ids 1 before 4 within services.
		expect(sortNotamsBySubject(items, (it) => it.q).map((it) => it.id)).toEqual([3, 2, 1, 4]);
	});
});
