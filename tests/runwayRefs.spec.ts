import { describe, it, expect } from 'vitest';
import {
	extractRunwayDesignators,
	normalizeRunwayDesignator,
	parseSections,
} from '$lib/notam';
import { parseFranceSubset, byId } from './worldFixtures';

describe('normalizeRunwayDesignator', () => {
	it('zero-pads and upper-cases', () => {
		expect(normalizeRunwayDesignator('4L')).toBe('04L');
		expect(normalizeRunwayDesignator('9')).toBe('09');
		expect(normalizeRunwayDesignator('27')).toBe('27');
		expect(normalizeRunwayDesignator(' 22r ')).toBe('22R');
	});

	it('passes through out-of-shape values unchanged', () => {
		expect(normalizeRunwayDesignator('H')).toBe('H');
		expect(normalizeRunwayDesignator('16G')).toBe('16G');
	});
});

describe('extractRunwayDesignators', () => {
	it('reads the English forms', () => {
		expect(extractRunwayDesignators('RWY 03/21 PCR 850/F/C/X/T')).toEqual(['03', '21']);
		expect(extractRunwayDesignators('RWY04L CLSD')).toEqual(['04L']);
		expect(extractRunwayDesignators('RWY 22L/22R RNAV')).toEqual(['22L', '22R']);
		expect(extractRunwayDesignators('RWY 18/36 AND 09/27 WIP')).toEqual([
			'18', '36', '09', '27',
		]);
		expect(extractRunwayDesignators('THR 27 DISPLACED')).toEqual(['27']);
		expect(extractRunwayDesignators('DTHR 09 MARKING')).toEqual(['09']);
	});

	it('reads the French forms', () => {
		expect(extractRunwayDesignators('PISTES 23 ET 29 FERMEES')).toEqual(['23', '29']);
		expect(extractRunwayDesignators('PISTE 09 REVETUE')).toEqual(['09']);
		expect(extractRunwayDesignators('SEUIL 32 DECALE')).toEqual(['32']);
		expect(extractRunwayDesignators('PISTES 04/22 ET 12/30')).toEqual([
			'04', '22', '12', '30',
		]);
	});

	it('reads surface adjectives, dash lists, PAPI, and the reversed order', () => {
		expect(extractRunwayDesignators('PISTE NON REVETUE 03R/21L FERMEE')).toEqual([
			'03R', '21L',
		]);
		expect(extractRunwayDesignators('PISTE EN HERBE 05L/23R FERMEE')).toEqual([
			'05L', '23R',
		]);
		expect(extractRunwayDesignators('PISTE NON REVETUE AVION 03R/21L')).toEqual([
			'03R', '21L',
		]);
		expect(extractRunwayDesignators('RWY 12-30 DEVIENT 11-29')).toEqual(['12', '30']);
		expect(extractRunwayDesignators('LONGUEUR DE PISTE 11-29')).toEqual(['11', '29']);
		expect(extractRunwayDesignators('MISE EN SERVICE PAPI 27')).toEqual(['27']);
		expect(extractRunwayDesignators('UNPAVED 08L/26R RWY RESERVED')).toEqual([
			'08L', '26R',
		]);
	});

	it('dedupes across mentions, keeps document order', () => {
		expect(
			extractRunwayDesignators('RWY 09 CLSD. SEUIL 27 DECALE. RWY 09 AGAIN'),
		).toEqual(['09', '27']);
	});

	it('never matches without a keyword anchor or past a designator', () => {
		expect(extractRunwayDesignators('FL 100 TO FL 150')).toEqual([]);
		expect(extractRunwayDesignators('FREQ 121.105MHZ')).toEqual([]);
		expect(extractRunwayDesignators('TWY N CLSD')).toEqual([]);
		expect(extractRunwayDesignators('RWY 100M FROM THR')).toEqual([]);
		expect(extractRunwayDesignators('OVERTHROW 12')).toEqual([]);
		expect(extractRunwayDesignators('')).toEqual([]);
	});

	it('does not read a bare count before RWY(S) as a designator', () => {
		expect(extractRunwayDesignators('WORK IN PROGRESS ON 2 RWYS')).toEqual([]);
		expect(extractRunwayDesignators('AT LEAST 2 RWY INSPECTIONS DAILY')).toEqual([]);
		// A suffixed single designator before the keyword still reads.
		expect(extractRunwayDesignators('UNPAVED 26R RWY RESERVED')).toEqual(['26R']);
	});

	it('does not let ET swallow a following word', () => {
		expect(extractRunwayDesignators('PISTE 09 ET TWY A FERMES')).toEqual(['09']);
	});
});

describe('extractRunwayDesignators over the France world subset', () => {
	const FIRS = new Set(['LFFF', 'LFRR', 'LFBB', 'LFMM', 'LFEE', 'LFXX']);
	const unique = [...byId(parseFranceSubset('world-en-20260610.txt')).values()];

	it('finds a stable number of aerodrome NOTAMs citing runways', () => {
		let count = 0;
		for (const n of unique) {
			const codes = n.icaoCodes.map((c) => c.toUpperCase());
			if (codes.length !== 1 || FIRS.has(codes[0])) {
				continue;
			}
			if (extractRunwayDesignators(parseSections(n.fullContent).E ?? '').length > 0) {
				count += 1;
			}
		}
		expect(count).toBe(396);
	});
});
