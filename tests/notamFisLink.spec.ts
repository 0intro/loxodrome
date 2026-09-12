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
