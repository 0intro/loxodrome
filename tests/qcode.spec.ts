import { describe, it, expect } from 'vitest';
import { en } from '$lib/i18n/en';
import { fr } from '$lib/i18n/fr';
import { decodeQCode } from '$lib/notam';
import {
	decodeQCodeWith,
	groupNotamsBySubject,
	isFuelQCode,
	Q_CONDITIONS,
	Q_SUBJECTS,
	sortNotamsBySubject,
} from '$lib/notam/qcode';

// Unit tests for Q-code decoder

describe('decodeQCode', () => {
	it('should decode a known subject and condition', () => {
		expect(decodeQCode('QOBCE')).toBe('Obstacle, erected');
	});

	it('should decode another known pair', () => {
		expect(decodeQCode('QWULW')).toBe('Unmanned aircraft, will take place');
	});

	it('should fall back to the raw condition when only the subject is known', () => {
		expect(decodeQCode('QOBZZ')).toBe('Obstacle, ZZ');
	});

	it('should fall back to the raw subject when only the condition is known', () => {
		expect(decodeQCode('QZZCE')).toBe('ZZ, erected');
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

// The ICAO NOTAM Code as FAA Order JO 7930.2U Appendix B reproduces it (the
// archive's 2026-11-13 snapshot), plus XX for a subject no code covers and
// TT for a trigger NOTAM (EASA NPA 2016-02, Appendix 2 to Part-AIS).
const ICAO_SUBJECTS =
	'AA AC AD AE AF AH AL AN AO AP AR AT AU AV AX AZ CA CB CC CD CE CG CL CM CP CR CS CT ' +
	'FA FB FC FD FE FF FG FH FI FJ FL FM FO FP FS FT FU FW FZ GA GW ' +
	'IC ID IG II IL IM IN IO IS IT IU IW IX IY ' +
	'LA LB LC LD LE LF LG LH LI LJ LK LL LM LP LR LS LT LU LV LW LX LY LZ ' +
	'MA MB MC MD MG MH MK MM MN MO MP MR MS MT MU MW MX MY ' +
	'NA NB NC ND NF NL NM NN NO NT NV OA OB OE OL OR ' +
	'PA PB PC PD PE PF PH PI PK PL PM PN PO PR PT PU PX PZ RA RD RM RO RP RR RT ' +
	'SA SB SC SE SF SL SO SP SS ST SU SV SY ' +
	'WA WB WC WD WE WF WG WH WJ WL WM WP WR WS WT WU WV WW WY WZ XX';
const ICAO_CONDITIONS =
	'AC AD AF AG AH AK AL AM AN AO AP AR AS AU AW AX ' +
	'CA CC CD CE CF CG CH CI CL CM CN CO CP CR CS CT ' +
	'HA HB HC HD HE HF HG HH HI HJ HK HL HM HN HO HP HQ HR HS HT HU HV HW HX HY HZ ' +
	'LA LB LC LD LE LF LG LH LI LK LL LN LP LR LS LT LV LW LX TT XX';

describe('the decode tables are the ICAO NOTAM Code', () => {
	it('hold its codes and no other', () => {
		expect(Object.keys(Q_SUBJECTS).sort()).toEqual(ICAO_SUBJECTS.split(' ').sort());
		expect(Object.keys(Q_CONDITIONS).sort()).toEqual(ICAO_CONDITIONS.split(' ').sort());
	});

	it.each([
		['QMRLN', 'Runway, closed to all night operations'],
		['QFALN', 'Aerodrome, closed to all night operations'],
		['QWELW', 'Exercises, will take place'],
		['QMXHW', 'Taxiway(s), work in progress'],
		['QMAHG', 'Movement area, grass cutting in progress'],
		['QFAHX', 'Aerodrome, concentration of birds'],
		['QMRLH', 'Runway, unserviceable for aircraft heavier than'],
		['QFALT', 'Aerodrome, limited to'],
		['QNVCL', 'VOR, realigned'],
		['QNBCP', 'Non-directional radio beacon, operating on reduced power'],
		['QAXCH', 'Significant point, changed'],
		['QICAS', 'Instrument landing system, unserviceable'],
		['QILAS', 'Localizer (ILS), unserviceable'],
		['QIOAS', 'Outer marker (ILS), unserviceable'],
		['QISAS', 'ILS Category I, unserviceable'],
		['QITAS', 'ILS Category II, unserviceable'],
		['QIUAS', 'ILS Category III, unserviceable'],
		['QIWAS', 'Microwave landing system (MLS), unserviceable'],
		['QLKAS', 'Category II components of approach lighting system, unserviceable'],
		['QMRHA', 'Runway, braking action is'],
		['QMRLV', 'Runway, closed to VFR operations'],
		['QOBLK', 'Obstacle, operating as a fixed light'],
	])('%s decodes as "%s"', (code, text) => {
		expect(decodeQCode(code)).toBe(text);
	});

	it('decodes a code outside the table as itself', () => {
		// NX is filed for a VDF in the fixtures (LFFF, EBBU, ESAA) and WO for a
		// laser emission; Appendix B carries neither.
		expect(decodeQCode('QNXAS')).toBe('NX, unserviceable');
		expect(decodeQCode('QWOLW')).toBe('WO, will take place');
	});
});

// The localized decode path: state/i18n's decodeQ is decodeQCodeWith over the
// t.qcode catalog tables. Pin the French output here so the mirror stays wired
// to the same assembly (decodeQCode above stays the canonical English).
describe('decodeQCodeWith over the French tables', () => {
	const decodeFr = (code: string): string =>
		decodeQCodeWith(fr.qcode.subjects, fr.qcode.conditions, code);

	it('decodes QOBCE in French', () => {
		expect(decodeFr('QOBCE')).toBe('Obstacle, érigé(e)');
	});

	it('decodes the ICAO meanings in French', () => {
		expect(decodeFr('QWULW')).toBe('Aéronef sans pilote, aura lieu');
		expect(decodeFr('QMRLN')).toBe('Piste, fermé(e) à toutes les opérations de nuit');
		expect(decodeFr('QISAS')).toBe('ILS de catégorie I, inutilisable');
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

describe('isFuelQCode', () => {
	it('accepts the fuel-availability subject whatever the condition says', () => {
		// The condition does not classify these: QFULT ("limited to") carries
		// seven outright withdrawals in the current French corpus, QFUAH an
		// eighth. The subject is the gate; the text decides the rest.
		expect(isFuelQCode('QFUAU')).toBe(true); // not available
		expect(isFuelQCode('QFULT')).toBe(true); // LFQF "100LL NOT AVBL"
		expect(isFuelQCode('QFUAH')).toBe(true); // LFLB "AVGAS 100LL : NOT AVBL"
		expect(isFuelQCode('QFUXX')).toBe(true); // plain language
	});

	it('refuses the oils subject', () => {
		// An oil grade looks like a fuel grade; admitting FJ would reproduce
		// at the NOTAM tier the confusion the AIP clause grammar prevents.
		expect(isFuelQCode('QFJAU')).toBe(false);
	});

	it('refuses anything that is not a Q-code', () => {
		expect(isFuelQCode('QFAAU')).toBe(false); // aerodrome, not fuel
		expect(isFuelQCode('QFUAU ')).toBe(false);
		expect(isFuelQCode('FUAU')).toBe(false);
		expect(isFuelQCode('')).toBe(false);
	});
});
