/* The declared-distance grammar ($lib/notam/declaredDistance.ts) against the
 * real E) texts of a French national corpus.
 *
 * Every case below is verbatim. The refusals matter more here than in the
 * other three grammars of this family, and for the opposite reason: those
 * withdraw something, so a refusal leaves the panel exactly as it was, while
 * these REPLACE a figure a take-off calculation reads. A wrong pairing here
 * hands one runway another's landing distance, which is why a scope whose
 * labels and values do not line up is dropped whole
 * (docs/notam-relationships.md, mechanism 18).
 */

import { describe, it, expect } from 'vitest';
import { parseDeclaredDistances, statesDeclaredDistances } from '$lib/notam/declaredDistance';
import { isDeclaredDistanceQCode } from '$lib/notam/qcode';

/** The values one text states for one runway end, or null when it states
 *  none (the end is then contested, never silently published). */
function forEnd(text: string, end: string): Partial<Record<string, number>> | null {
	for (const s of parseDeclaredDistances(text)) {
		if (s.kind === 'declared' && s.designators.includes(end)) {
			return s.values;
		}
	}
	return null;
}

describe('the Q-code gate', () => {
	it('is the subject, and only this subject', () => {
		expect(isDeclaredDistanceQCode('QMDCH')).toBe(true);
		expect(isDeclaredDistanceQCode('QMDXX')).toBe(true);
		for (const q of ['QMRLC', 'QFALC', 'QFULT', 'QCACF', 'QMD', '']) {
			expect(isDeclaredDistanceQCode(q), q).toBe(false);
		}
	});
});

describe('the printed forms', () => {
	it('C3695/26 LFRK: chained equals give every label one value', () => {
		expect(
			forEnd(
				'DECLARED DISTANCES CHANGED : RWY 30 REVISED DECLARED DISTANCES (OBST WI RESA) : TORA = TODA = ASDA = LDA = 1888M.',
				'30',
			),
		).toEqual({ tora: 1888, toda: 1888, asda: 1888, lda: 1888 });
	});

	it('E3881/26 LFOU: label then its own value', () => {
		expect(
			forEnd('DECLARED DISTANCES CHANGED : RWY 20 : TORA 1290M TODA 1350M ASDA 1290M LDA 1290M.', '20'),
		).toEqual({ tora: 1290, toda: 1350, asda: 1290, lda: 1290 });
	});

	it('D3109/26 LFSM: the POSITIONAL table, four labels then four values', () => {
		const text =
			'PAVED RWY 08/26 REVISED DECLARED DISTANCES : - RWY 08 : . TORA TODA ASDA LDA 1404 1404 1404 1145 . BEGINNING OF TODA TORA ASDA : TWY A - RWY 26 : . TORA TODA ASDA LDA 1404 1404 1404 1150';
		expect(forEnd(text, '08')).toEqual({ tora: 1404, toda: 1404, asda: 1404, lda: 1145 });
		expect(forEnd(text, '26')).toEqual({ tora: 1404, toda: 1404, asda: 1404, lda: 1150 });
	});

	it('B1026/26 LFMV: a pair scope, then one end refining it', () => {
		const text = 'REVISED DECLARED DISTANCES : - RWY 17/35 : TORA = TODA = ASDA = 1875M - RWY 35 : LDA = 1565M.';
		expect(forEnd(text, '17')).toEqual({ tora: 1875, toda: 1875, asda: 1875 });
		const st = parseDeclaredDistances(text).filter((s) => s.kind === 'declared');
		expect(st[1].designators).toEqual(['35']);
		expect(st[1].values).toEqual({ lda: 1565 });
	});

	it('E0479/26 LFAU: the runway cut to 320 m, both ends', () => {
		// The case the audit ranked first: the AIP publishes a longer runway
		// and the performance page was computing on it.
		const text =
			'RWY 07/25 REVISED DECLARED DISTANCES : - RWY 07/25 DIMENSIONS REDUCED TO 320M X 60M - NEW THR 25 : 493724.5N 0014939.49W (REPLACING THE FORMER DTHR 25) - RWY 25 : TODA = 320M, ASDA = 320M, LDA = 320M - RWY 07 : TODA = 320M, ASDA = 320M, LDA = 320M.';
		expect(forEnd(text, '25')).toEqual({ toda: 320, asda: 320, lda: 320 });
		expect(forEnd(text, '07')).toEqual({ toda: 320, asda: 320, lda: 320 });
	});

	it('D1882/26 LFET: a heading written without its space still heads a scope', () => {
		// The SIA writes "RWY01 :" and "RWY19 :". Missing those two headings
		// let the pair scope swallow both, and runway 19 was given runway
		// 01's landing distance.
		const text =
			'NEW DECLARED DISTANCES RWY 01/19 DUE TO NEW DTHR QFU19 : RWY01 : TODA 1020 - ASDA 1050 - LDA 1050 RWY19 : TODA 1050 - ASDA 1050 - LDA 1020';
		expect(forEnd(text, '01')).toEqual({ toda: 1020, asda: 1050, lda: 1050 });
		expect(forEnd(text, '19')).toEqual({ toda: 1050, asda: 1050, lda: 1020 });
	});

	it('D5111/26 LFHX: a number written after the last value is somebody else’s', () => {
		// The scope closes with "TKOF REFERENCE DISTANCE ... 1200M", which is
		// a limitation and not a declared distance. A single label takes the
		// value that follows it and leaves the rest of the run alone.
		const text =
			'RWY 05/23 REVISED DECLARED DISTANCES AND USE RESTRICTION : - RWY 05: TODA = 1300M LDA = 971M ASDA = 1250M - RWY 23: TODA = 1300M LDA = 1250M ASDA = 1300M - RUNWAY FORBIDDEN TO ACFT WITH TKOF REFERENCE DISTANCE IS GREATER OR EQUAL TO 1200M.';
		expect(forEnd(text, '05')).toEqual({ toda: 1300, lda: 971, asda: 1250 });
		expect(forEnd(text, '23')).toEqual({ toda: 1300, lda: 1250, asda: 1300 });
	});

	it('D3971/26 LFQM: trailing prose does not become a distance', () => {
		const text =
			'RWY 05/23 DECLARED DISTANCES CHANGED FOR VFR : - RWY 23 : TODA 1090 ASDA 1400 LDA 1330 LDA STARTS 70M AFTER THE PHYSICAL START OF RWY. END OF TODA IS LOCATED AT 310M BFR PHYSICAL END OF RWY - RWY 05 : TODA 1210 ASDA 1400 LDA 1090 END OF TODA IS LOCATED AT 190M BFR PHYSICAL END OF RWY';
		expect(forEnd(text, '23')).toEqual({ toda: 1090, asda: 1400, lda: 1330 });
		expect(forEnd(text, '05')).toEqual({ toda: 1210, asda: 1400, lda: 1090 });
	});

	it('the French half reads the same', () => {
		expect(
			forEnd(
				'DISTANCES DECLAREES MODIFIEES : DISTANCES PISTE 30 CHANGEES : (OBSTACLE DANS RESA) : TORA = TODA = ASDA = LDA = 1888M.',
				'30',
			),
		).toEqual({ tora: 1888, toda: 1888, asda: 1888, lda: 1888 });
		expect(
			forEnd('PISTE REVETUE 08 : . TORA TODA ASDA LDA 1404 1404 1404 1145', '08'),
		).toEqual({ tora: 1404, toda: 1404, asda: 1404, lda: 1145 });
	});
});

describe('what states a distance and is not one', () => {
	it('B1384/26 LFTW: the intersection figures do not touch the runway’s own', () => {
		// The NOTAM states the full runway and then three taxiway entries.
		// Reading those as declared distances would SHORTEN the runway by
		// 500 m, which is conservative, and then lengthen it again on the
		// other end, which is not.
		const text =
			'DECLARED DISTANCES MODIFIED : .RWY 18 : TORA 2443, TODA 2743, ASDA 2443, LDA 2443 -FROM TWY D TORA 1934, TODA 2234, ASDA 1934 -FROM TWY J TORA 1937, TODA 2237, ASDA 1937 .RWY 36 : TORA 2443, TODA 2743, ASDA 2443, LDA 2443 -FROM TWY B TORA 1893, TODA 2193, ASDA 1893';
		expect(forEnd(text, '18')).toEqual({ tora: 2443, toda: 2743, asda: 2443, lda: 2443 });
		expect(forEnd(text, '36')).toEqual({ tora: 2443, toda: 2743, asda: 2443, lda: 2443 });
	});

	it('B1025/26 LFMV: REMAINING DISTANCES FROM a taxiway are not declared distances', () => {
		const text =
			'RWY 35 : NEW REMAINING DISTANCES FROM : - B = 1320M - C = 1025M - E = 630M RWY 17 : NEW REMAINING DISTANCES FROM : - B = 560M - C = 865M';
		expect(statesDeclaredDistances(text)).toBe(false);
		// And the ends are still NAMED, so the resolver can contest them.
		expect(parseDeclaredDistances(text).map((s) => s.designators[0])).toEqual(['35', '17']);
	});

	it('M2828/26 LFMY: an LDA quoted to explain a slope declares nothing', () => {
		expect(
			statesDeclaredDistances(
				'RWY16 : LDA OF 1951M MEANS A FINAL APP SLOPE OF 5.1 PER CENT. - PRESENCE OF TREES BETWEEN 200 AND 860M FROM THR16.',
			),
		).toBe(false);
	});

	it('D4889/26 LFMA: a remark being amended is not a distance', () => {
		expect(
			statesDeclaredDistances(
				"DECLARED DISTANCES RWY 32 - REMARKS MODIFIED : READ : 'BETWEEN RWY END AND THR14 : 123M LONG STRIP AVAILABLE FOR TAKEOFF' INSTEAD OF : 'BETWEEN RWY END AND THR14 : 125M LONG STRIP AVAILABLE FOR TAKEOFF'",
			),
		).toBe(false);
	});

	it('E4355/26 LFPT: a taxiway name correction states no figure', () => {
		const text = "DECLARED DISTANCES RWY 12 READ : 'TWY H' INSTEAD OF : 'TWY G' REF AD 2 LFPT.13";
		expect(statesDeclaredDistances(text)).toBe(false);
		expect(parseDeclaredDistances(text)[0].designators).toEqual(['12']);
	});

	it('E4399/26 LFOO: the ROW table is refused, and names all four ends', () => {
		// "RWY TODA ASDA LDA 06 547 700 597 24 597 700 547": the values belong
		// to the designator opening each row, not to the scope's heading.
		const text =
			'RUNWAYS 06/24 AND 06L/24R REVISED DECLARED DISTANCES : - PAVED RWY 06/24 : RWY TODA ASDA LDA 06 547 700 597 24 597 700 547 - UNPAVED RWY 06L/24R : RWY TODA ASDA LDA 06L 585 725 647 24R 647 725 585';
		expect(statesDeclaredDistances(text)).toBe(false);
		expect(parseDeclaredDistances(text)[0].designators).toEqual(['06', '24', '06L', '24R']);
	});

	it('D3879/26 LFNF: the LABEL-FIRST form is refused', () => {
		// "TODA 02 : 1055M ASDA 20 : 1195M" nests the other way round, and the
		// RWY 02/20 heading earlier in the text would have scoped runway 02's
		// take-off distance onto runway 20 as well.
		expect(
			statesDeclaredDistances(
				'DUE TO SOUTHERN END OF RWY 02 MOVEMENT : RWY 02/20 LENGTH : 1195M TODA 02 : 1055M ASDA 02 : 1195M ASDA 20 : 1195M LDA 20 : 1055M DTHR 02 : 90M',
			),
		).toBe(false);
	});

	it('D0033/26 LFCN: a text heading no runway at all yields nothing to scope', () => {
		// Which the resolver turns into a whole-aerodrome contest rather than
		// silence, since the NOTAM plainly says the figures changed.
		expect(
			parseDeclaredDistances(
				'UNPAVED RWY DIMENSION REDUCED ON THE WEST SIDE : -DIMENSIONS : 450M X 65M -TODA : 32L 450M 14R 450M -ASDA : 32L 450M 14R 450M -LDA : 32L 370M 14R 450M.',
			),
		).toEqual([]);
	});
});

describe('the degenerate inputs', () => {
	it('answer empty rather than throwing', () => {
		expect(parseDeclaredDistances('')).toEqual([]);
		expect(parseDeclaredDistances(null as unknown as string)).toEqual([]);
		expect(statesDeclaredDistances('RWY 07/25 CLSD DUE TO WIP')).toBe(false);
	});

	it('an implausible bare number is not a distance', () => {
		// Bare numbers are everywhere in these texts; only a plausible runway
		// length is believed without its unit.
		expect(forEnd('RWY 07 : TORA 12', '07')).toBeNull();
		expect(forEnd('RWY 07 : TORA 9999', '07')).toBeNull();
		expect(forEnd('RWY 07 : TORA 1200', '07')).toEqual({ tora: 1200 });
	});
});
