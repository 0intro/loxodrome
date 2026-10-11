/* Specs for the by-name FIS -> SIV affecting link: the CA / SE / UE subject
 * gate (isFlightInfoServiceQCode), the FIS-callsign guard that keeps a generic
 * air/ground NOTAM off a same-named SIV (fisServiceNamed), and the cited
 * sector-number narrowing ("FIS 4 AND 5" -> SEINE 4 + SEINE 5; bare "SEINE
 * INFO" -> the whole base). notamNamesAirspace is the shared predicate behind
 * both link directions, so asserting it covers NOTAM -> SIV and SIV -> NOTAM.
 * Pure-function coverage; no map or state. */

import { describe, it, expect } from 'vitest';
import { parseNotams } from '$lib/notam';
import { isFlightInfoServiceQCode } from '$lib/notam/qcode';
import type { Notam } from '$lib/notam/types';
import type { Airspace } from '$lib/data/airspaces';
import type { Publisher } from '$lib/state/layers.svelte';
import {
	notamNamesAirspace,
	fisServiceNamed,
	citedSectors,
	fisSectorDesignator,
	fisSubstituteOnly,
} from '$lib/state/notamLinks.svelte';

/* Minimal Airspace stub: the matcher only reads type, name, source. */
function mk(name: string, type = 'SIV', source: Publisher = 'fr'): Airspace {
	return { id: name, key: `${name}|${name}`, type, name, source } as unknown as Airspace;
}

/* Build a NOTAM via the real parser so qCode + qualifier.fir are populated.
 * Needs the id header line for parseNotams to recognise the block; Q-line
 * mirrors the real E1868/26 (LFFF / QCACF / AE / 000-115). */
function notam(qCode: string, fir: string, eText: string): Notam {
	const text = [
		'LFFA-E1868/26',
		`A) ${fir}`,
		`Q) ${fir} / ${qCode} / IV / BO / AE / 000/115 / 4822N00403E059`,
		'B) 2605281200 C) 3801190314',
		`E) ${eText}`,
	].join('\n');
	return parseNotams(text)[0];
}

const SEINE_FIS = 'FIS SEINE INFORMATION (FIS 4 AND 5) FREQ : 120.330MHZ';

describe('isFlightInfoServiceQCode', () => {
	it('accepts the FIS subjects CA / SE / UE', () => {
		expect(isFlightInfoServiceQCode('QCACF')).toBe(true);
		expect(isFlightInfoServiceQCode('QSEAS')).toBe(true);
		expect(isFlightInfoServiceQCode('QUEAU')).toBe(true);
	});
	it('rejects non-FIS subjects (aerodrome, TMA, AFIS)', () => {
		expect(isFlightInfoServiceQCode('QFALC')).toBe(false);
		expect(isFlightInfoServiceQCode('QATCA')).toBe(false);
		expect(isFlightInfoServiceQCode('QSFAS')).toBe(false);
	});
});

describe('fisServiceNamed', () => {
	it('matches a callsign after or before the name', () => {
		expect(fisServiceNamed('SEINE', SEINE_FIS)).toBe(true);
		expect(fisServiceNamed('LILLE', "FIS 2 'LILLE INFO' FREQ 127.015MHZ U/S")).toBe(true);
		expect(fisServiceNamed('BASTIA SUD', "FIS AREA 'BASTIA SUD' FREQ 135.135MHZ U/S")).toBe(true);
	});
	it('rejects a name with no FIS callsign (aerodrome radio)', () => {
		expect(fisServiceNamed('TOULOUSE', 'TOULOUSE TWR FREQ 118.500MHZ')).toBe(false);
	});
});

describe('citedSectors', () => {
	it('parses an AND list near the base', () => {
		expect(citedSectors('SEINE', SEINE_FIS)).toEqual(new Set(['4', '5']));
	});
	it('parses a single sector introduced by FIS', () => {
		expect(citedSectors('LILLE', "FIS 2 'LILLE INFO'")).toEqual(new Set(['2']));
	});
	it('returns null when no sector is named, and never reads a frequency', () => {
		expect(citedSectors('SEINE', 'SEINE INFO 127.815MHZ')).toBeNull();
	});
});

describe('fisSectorDesignator', () => {
	it('returns the trailing number, integer or decimal', () => {
		expect(fisSectorDesignator('SEINE 4')).toBe('4');
		expect(fisSectorDesignator('IROISE 4.2')).toBe('4.2');
	});
	it('is null for a letter or bare name', () => {
		expect(fisSectorDesignator('RENNES COTENTIN B')).toBeNull();
		expect(fisSectorDesignator('TOULOUSE')).toBeNull();
	});
});

describe('notamNamesAirspace (FIS -> SIV)', () => {
	it('links a QCACF SEINE NOTAM to the cited sectors only', () => {
		const n = notam('QCACF', 'LFFF', SEINE_FIS);
		expect(notamNamesAirspace(n, mk('SEINE 4'))).toBe(true);
		expect(notamNamesAirspace(n, mk('SEINE 5'))).toBe(true);
		expect(notamNamesAirspace(n, mk('SEINE 3'))).toBe(false);
		expect(notamNamesAirspace(n, mk('SEINE 6'))).toBe(false);
	});
	it('does not cross from a SIV NOTAM to a same-named TMA', () => {
		const n = notam('QCACF', 'LFFF', SEINE_FIS);
		expect(notamNamesAirspace(n, mk('SEINE 2', 'TMA'))).toBe(false);
	});
	it('reaches the FIR-level FIC sectors: PARIS INFO names PARIS OUEST', () => {
		const n = notam('QCACF', 'LFFF', 'PARIS INFO 129.625MHZ NOT AVBL');
		expect(notamNamesAirspace(n, mk('PARIS OUEST', 'FIC'))).toBe(true);
		expect(notamNamesAirspace(n, mk('PARIS NORD', 'FIC'))).toBe(true);
		// Still never a same-named TMA, and never a non-FIS type.
		expect(notamNamesAirspace(n, mk('PARIS OUEST', 'TMA'))).toBe(false);
	});
	it('narrows FIC by cited sector numbers like any FIS base', () => {
		const n = notam('QCACF', 'LFMM', 'FIS MARSEILLE INFORMATION (FIS 1) 124.500MHZ U/S');
		expect(notamNamesAirspace(n, mk('MARSEILLE NORD 1', 'FIC'))).toBe(true);
		expect(notamNamesAirspace(n, mk('MARSEILLE SUD', 'FIC'))).toBe(false);
	});
	it('matches the whole base when no sector is named', () => {
		const n = notam('QCACF', 'LFFF', 'SEINE INFO 127.815MHZ (ABSENCE ATS)');
		expect(notamNamesAirspace(n, mk('SEINE 1'))).toBe(true);
		expect(notamNamesAirspace(n, mk('SEINE 8'))).toBe(true);
	});
	it('lets a cited integer cover its decimal sub-sectors', () => {
		const n = notam('QCACF', 'LFFF', "FIS 'IROISE INFO' (FIS 4) U/S");
		expect(notamNamesAirspace(n, mk('IROISE 4.1'))).toBe(true);
		expect(notamNamesAirspace(n, mk('IROISE 4.2'))).toBe(true);
		expect(notamNamesAirspace(n, mk('IROISE 1'))).toBe(false);
	});
	it('does not match a generic CA aerodrome-radio NOTAM', () => {
		const n = notam('QCACF', 'LFFF', 'TOULOUSE TWR FREQ 118.500MHZ');
		expect(notamNamesAirspace(n, mk('TOULOUSE'))).toBe(false);
	});
	it('respects the subject gate (non-FIS subject)', () => {
		const n = notam('QFALC', 'LFFF', SEINE_FIS);
		expect(notamNamesAirspace(n, mk('SEINE 4'))).toBe(false);
	});
	it('respects the publisher gate (non-FR FIR)', () => {
		const n = notam('QCACF', 'CZUL', 'FIS SEINE INFORMATION (FIS 4 AND 5)');
		expect(notamNamesAirspace(n, mk('SEINE 4'))).toBe(false);
	});
});

/* The corpus forms that used to link nothing, or the wrong thing. Each is a
 * real NOTAM's own wording; the id is named beside it. */
describe('the two halves of a bilingual FIS NOTAM', () => {
	// A6001/26's shape: the SIA names the sector's cardinal in each language.
	it('link the same sector whichever language names its cardinal', () => {
		const sud = mk('BASTIA SUD');
		const en = notam('QSEAU', 'LFMM', "FIS AREA 'BASTIA SOUTH' FREQ 135.135MHZ U/S");
		const fr = notam('QSEAU', 'LFMM', 'FREQUENCE SIV BASTIA SUD 135.135MHZ HORS SERVICE.');
		expect(notamNamesAirspace(en, sud, true)).toBe(true);
		expect(notamNamesAirspace(fr, sud, true)).toBe(true);
		expect(notamNamesAirspace(en, mk('BASTIA NORD'), true)).toBe(false);
	});

	// The E) text keeps its line breaks; one inside a two-word name is a
	// wrap, which the name, a single-spaced token, must still be read across.
	it('read a name wrapped over a line break', () => {
		const n = notam('QSEAU', 'LFMM', "FIS AREA 'BASTIA\nSUD' FREQ 135.135MHZ U/S");
		expect(notamNamesAirspace(n, mk('BASTIA SUD'), true)).toBe(true);
		expect(notamNamesAirspace(n, mk('BASTIA NORD'), true)).toBe(false);
	});
});

describe('FIS citations the corpus actually prints', () => {
	it('never reads a frequency as a sector number', () => {
		// A6001/26's French half: the value follows the name directly, and the
		// 1-2 digit shape used to take its head ("13"), narrowing the link to a
		// sector no row carries and so linking NOTHING.
		expect(citedSectors('BASTIA SUD', 'FREQUENCE SIV BASTIA SUD 135.135MHZ HORS SERVICE.')).toBe(null);
		// A6090/26 / F1936/26, the English half of the same failure.
		expect(
			citedSectors('STRASBOURG', "FREQ 'STRASBOURG' FIS 119.450MHZ U/S : FLIGHT INFORMATION ON 'STRASBOURG' APP 134.575MHZ"),
		).toBe(null);
		// French decimal commas are also the list connector, so this one used
		// to yield two sectors, 11 and 80.
		expect(citedSectors('BEAUVAIS', 'FREQUENCE BEAUVAIS INFO 119,800MHZ INDISPONIBLE')).toBe(null);
		// A whole number is not a sector either.
		expect(citedSectors('SEINE', 'SEINE INFO 127.815MHZ')).toBe(null);
	});

	it('still reads the sector numbers a NOTAM does cite', () => {
		expect([...(citedSectors('SEINE', 'FIS SEINE INFORMATION (FIS 4 AND 5) NOT AVBL') ?? [])].sort()).toEqual(['4', '5']);
		// A5453/26 EN: the AREA word sits between the marker and the number.
		expect([...(citedSectors('BEAUVAIS', "'BEAUVAIS' FIS AREA 2 CLOSED") ?? [])]).toEqual(['2']);
		// A5453/26 FR: the SIA's own marker, number before the name.
		expect([...(citedSectors('BEAUVAIS', 'SIV 2 BEAUVAIS FERME') ?? [])]).toEqual(['2']);
		// A4367/26 FR: a list under the French marker.
		expect([...(citedSectors('PROVENCE', 'PROVENCE INFO - SIV 1 ET 4 : LIRE 132.955MHZ') ?? [])].sort()).toEqual(['1', '4']);
		// A1649/26 FR: decimal sector designators survive the guard, and the
		// frequency that follows them on the same line still does not.
		expect(
			[...(citedSectors('MONTPELLIER', 'MONTPELLIER INFO - SIV 1, 1.1 ET 1.2 : LIRE 134.380MHZ') ?? [])].sort(),
		).toEqual(['1', '1.1', '1.2']);
	});

	it('accepts SIV as the service marker, the SIA French spelling', () => {
		expect(fisServiceNamed('PROVENCE', 'FREQ INFO SIV PROVENCE 5, LIRE : 126.260MHZ')).toBe(true);
		expect(fisServiceNamed('BASTIA SUD', 'FREQUENCE SIV BASTIA SUD 135.135MHZ HORS SERVICE.')).toBe(true);
	});

	it('tells a service the NOTAM DESIGNATES from one it is about', () => {
		const e =
			"'BEAUVAIS' INFO FREQ 119.800MHZ NOT AVBL : - 'BEAUVAIS' FIS AREA 2 CLOSED " +
			"- CONTACT 'PARIS INFO' 125.700MHZ, OR IF IFR OR NGT VFR FLT CONTACT 'PARIS CTL' 128.275MHZ";
		// PARIS is named only as the unit to call instead.
		expect(fisServiceNamed('PARIS', e)).toBe(true);
		expect(fisSubstituteOnly('PARIS', e)).toBe(true);
		// BEAUVAIS is the subject, named outside any contact clause.
		expect(fisSubstituteOnly('BEAUVAIS', e)).toBe(false);
		// The French half says the same thing with its own verb.
		const fr =
			'FREQUENCE BEAUVAIS INFO 119,8MHZ INDISPONIBLE : - SIV 2 BEAUVAIS FERME, ' +
			'- CONTACTER PARIS INFO 125.7MHZ, OU SI VOUS EVOLUEZ EN IFR OU VFR DE NUIT CONTACTEZ PARIS CONTROLE 128.275MHZ.';
		expect(fisSubstituteOnly('PARIS', fr)).toBe(true);
		expect(fisSubstituteOnly('BEAUVAIS', fr)).toBe(false);
	});

	it('a service both reported and designated still links', () => {
		const e = "'LILLE' INFO 126.480MHZ NOT AVBL, CONTACT 'LILLE' INFO 132.540MHZ";
		expect(fisSubstituteOnly('LILLE', e)).toBe(false);
	});

	it('reads the substitute clause the same way in both languages', () => {
		// The comma is a clause fence AND the French decimal separator, so a
		// NOTAM that names its substitute BEFORE its subject used to read the
		// subject as substitute-only in French and not in English: the sector
		// then linked nothing at all, and the nav log went on handing out the
		// withdrawn frequency.
		const fr = 'FREQUENCE 119,800MHZ INDISPONIBLE, CONTACTER PARIS INFO 125,700MHZ, SIV 2 BEAUVAIS FERME';
		const en = "FREQ 119.800MHZ NOT AVBL, CONTACT 'PARIS INFO' 125.700MHZ, 'BEAUVAIS' FIS AREA 2 CLOSED";
		for (const e of [fr, en]) {
			expect(fisSubstituteOnly('BEAUVAIS', e)).toBe(false);
			expect(fisSubstituteOnly('PARIS', e)).toBe(true);
		}
	});

	it('takes a sector number that ends a sentence', () => {
		// The guard refuses a digit or a decimal-with-digits after the number,
		// never a bare full stop: "5." is sector 5, and "AREA 2." citing
		// NOTHING would mean "the whole base" and link every sector of it.
		expect([...(citedSectors('SEINE', 'SIV SEINE 4 ET 5.') ?? [])].sort()).toEqual(['4', '5']);
		expect([...(citedSectors('BEAUVAIS', "'BEAUVAIS' FIS AREA 2.") ?? [])]).toEqual(['2']);
	});

	it('reads a compact French comma as the list it always was', () => {
		// "4,5" with no space is a list or a decimal, and the SIA dots its
		// sector designators in both languages ("SIV 1, 1.1, 1.2"), so the
		// list is the reading. Refusing it cited NOTHING, which is the whole
		// base: every SEINE sector linked for a NOTAM about two of them.
		expect([...(citedSectors('SEINE', 'SIV SEINE 4,5 FERMES') ?? [])].sort()).toEqual(['4', '5']);
		expect([...(citedSectors('SEINE', 'SIV SEINE 4,5.') ?? [])].sort()).toEqual(['4', '5']);
		// A comma carrying two digits continues a number, never a list.
		expect(citedSectors('SEINE', 'SIV SEINE 0,16NM')).toBe(null);
		// And a dotted designator still reads whole, not as two sectors.
		expect([...(citedSectors('LILLE', 'SIV LILLE 6.1 FERME') ?? [])]).toEqual(['6.1']);
		expect(citedSectors('LILLE', 'SIV LILLE 6.12')).toBe(null);
	});
});
