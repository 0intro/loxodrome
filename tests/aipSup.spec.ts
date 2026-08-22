import { describe, it, expect } from 'vitest';
import { parseNotams } from '$lib/notam';
import type { Notam } from '$lib/notam/types';
import {
	extractAipSups,
	siaSupUrl,
	isFrenchNotam,
} from '$lib/notam/aipSup';

describe('extractAipSups', () => {
	it('matches the canonical "AIP SUP NNN/YY" form', () => {
		const r = extractAipSups('TRIGGER NOTAM - AIP SUP 147/25 :');
		expect(r).toHaveLength(1);
		expect(r[0].number).toBe(147);
		expect(r[0].year).toBe(2025);
		expect(r[0].series).toBe('A');
		expect(r[0].airac).toBe(false);
		expect(r[0].raw).toBe('AIP SUP 147/25');
		expect(r[0].display).toBe('AIP SUP 147/25');
	});

	it('matches the reverse "SUP AIP NNN/YY" form', () => {
		const r = extractAipSups('NOTAM TRIGGER - SUP AIP 091/24 MODIFIE :');
		expect(r).toHaveLength(1);
		expect(r[0].number).toBe(91);
		expect(r[0].year).toBe(2024);
		expect(r[0].series).toBe('A');
		expect(r[0].airac).toBe(false);
	});

	it('captures the REF prefix without setting airac', () => {
		const r = extractAipSups('OPERATIONS IAW REF AIP SUP 064/2025.');
		expect(r).toHaveLength(1);
		expect(r[0].number).toBe(64);
		expect(r[0].year).toBe(2025);
		expect(r[0].airac).toBe(false);
	});

	it('flags AIRAC variants', () => {
		const r = extractAipSups('SEE AIRAC AIP SUP 06/23.');
		expect(r).toHaveLength(1);
		expect(r[0].number).toBe(6);
		expect(r[0].year).toBe(2023);
		expect(r[0].airac).toBe(true);
	});

	it('flags the French postfix order "SUP AIP AIRAC NNN/YY"', () => {
		// French briefings write the AIRAC word after the series ("NOTAM
		// TRIGGER - SUP AIP AIRAC 004/26."); English ones write "AIRAC AIP
		// SUP 004/26". Both must parse to the same reference.
		const r = extractAipSups('NOTAM TRIGGER - SUP AIP AIRAC 004/26.');
		expect(r).toHaveLength(1);
		expect(r[0].number).toBe(4);
		expect(r[0].year).toBe(2026);
		expect(r[0].airac).toBe(true);
		expect(r[0].display).toBe('AIP SUP 004/26');
		// The postfix AIRAC is part of the citation core, so the inline
		// linkifier covers it.
		expect(r[0].raw).toBe('SUP AIP AIRAC 004/26');
	});

	it('strips the AIRAC / REF prefix from raw + start/end', () => {
		// Inline linkifier slices text using raw / start / end; the
		// "AIRAC " or "REF " word should remain as plain body text and
		// NOT be part of the visible link substring.
		const text = 'SEE AIRAC AIP SUP 06/23 AND REF AIP SUP 064/2025.';
		const r = extractAipSups(text);
		expect(r).toHaveLength(2);
		expect(r[0].raw).toBe('AIP SUP 06/23');
		expect(text.slice(r[0].start, r[0].end)).toBe('AIP SUP 06/23');
		expect(r[1].raw).toBe('AIP SUP 064/2025');
		expect(text.slice(r[1].start, r[1].end)).toBe('AIP SUP 064/2025');
	});

	it('flags IFR variants', () => {
		const r = extractAipSups('AS PER AIP SUP IFR 41/24,');
		expect(r).toHaveLength(1);
		expect(r[0].number).toBe(41);
		expect(r[0].year).toBe(2024);
		expect(r[0].series).toBe('IFR');
		expect(r[0].display).toBe('AIP SUP IFR 41/24');
	});

	it('handles 4-digit years', () => {
		const r = extractAipSups('REF AIP SUP 001/2024');
		expect(r).toHaveLength(1);
		expect(r[0].year).toBe(2024);
	});

	it('returns multiple matches in source order, without dedup', () => {
		const text = 'AS PER AIP SUP 33/23, AIP SUP 10/23, AIP SUP 33/23.';
		const r = extractAipSups(text);
		expect(r.map((x) => x.display)).toEqual([
			'AIP SUP 33/23',
			'AIP SUP 10/23',
			'AIP SUP 33/23',
		]);
		// Positions are strictly increasing.
		expect(r[1].start).toBeGreaterThan(r[0].end);
		expect(r[2].start).toBeGreaterThan(r[1].end);
	});

	it('rejects strings that look like SUPs but are not', () => {
		expect(extractAipSups('AIP-SUP 147/25')).toEqual([]);   // hyphen
		expect(extractAipSups('SUPER 22/25 IS FUN')).toEqual([]); // SUPER
		expect(extractAipSups('AIP SUP IS ACTIVE')).toEqual([]); // no number
		expect(extractAipSups('SEE 147/25 FOR DETAILS')).toEqual([]); // bare digits
		expect(extractAipSups('')).toEqual([]);
	});
});

describe('siaSupUrl', () => {
	const base = 'https://www.sia.aviation-civile.gouv.fr/media/store/documents/file/l/f/';

	function ref(overrides: Partial<ReturnType<typeof extractAipSups>[number]>) {
		return {
			raw: '',
			display: '',
			number: 38,
			year: 2026,
			series: 'A' as const,
			airac: false,
			start: 0,
			end: 0,
			...overrides,
		};
	}

	it('builds A-series, non-AIRAC, French URL', () => {
		expect(siaSupUrl(ref({ number: 38, year: 2026 }), 'fr'))
			.toBe(base + 'lf_sup_2026_038_fr.pdf');
	});

	it('builds A-series, non-AIRAC, English URL', () => {
		expect(siaSupUrl(ref({ number: 38, year: 2026 }), 'en'))
			.toBe(base + 'lf_sup_2026_038_en.pdf');
	});

	it('pads single-digit numbers to three digits', () => {
		expect(siaSupUrl(ref({ number: 1, year: 2026 }), 'en'))
			.toBe(base + 'lf_sup_2026_001_en.pdf');
	});

	it('preserves three-digit numbers', () => {
		expect(siaSupUrl(ref({ number: 147, year: 2025 }), 'fr'))
			.toBe(base + 'lf_sup_2025_147_fr.pdf');
	});

	it('inserts _a_ segment for AIRAC SUPs', () => {
		expect(siaSupUrl(ref({ number: 41, year: 2025, airac: true }), 'en'))
			.toBe(base + 'lf_sup_a_2025_041_en.pdf');
	});

	it('returns null for IFR-series SUPs in either language', () => {
		expect(siaSupUrl(ref({ series: 'IFR' }), 'fr')).toBeNull();
		expect(siaSupUrl(ref({ series: 'IFR' }), 'en')).toBeNull();
	});
});

describe('isFrenchNotam', () => {
	const noQual = {
		id: '',
		fullContent: '',
		coordinates: [],
		icaoCodes: [],
		isPolygon: false,
		startDate: null,
		endDate: null,
		permanent: false,
		estimated: false,
		qCode: '',
		obstacleType: '',
		serviceStatus: '',
		qualifier: null,
		fgLower: null,
		fgUpper: null,
		replaces: null,
	} as Notam;

	it('accepts ids that start with LF', () => {
		expect(isFrenchNotam({ ...noQual, id: 'LFFA-R2112/25' })).toBe(true);
		expect(isFrenchNotam({ ...noQual, id: 'LFXX-A0042/26' })).toBe(true);
	});

	it('rejects non-French ids even when the body mentions an AIP SUP', () => {
		const n: Notam = {
			...noQual,
			id: 'EGGY-A0042/26',
			fullContent: 'AS PER AIP SUP 22/2024',
		};
		expect(isFrenchNotam(n)).toBe(false);
	});

	it('falls back to qualifier.fir when the id is unusual', () => {
		const n: Notam = {
			...noQual,
			id: 'X9999/25',
			qualifier: {
				fir: 'LFFF',
				code: 'QXXXX',
				traffic: 'IV',
				purpose: 'BO',
				scope: 'AE',
				lower: 0,
				upper: 999,
				lat: 49,
				lon: 2,
				radius: null,
			},
		};
		expect(isFrenchNotam(n)).toBe(true);
	});

	it('accepts the multi-FIR France LFXX code (real R1507/26-style)', () => {
		// R1507/26 has id "R1507/26" (no LF prefix) and Q-line "LFXX/...".
		// Both LFXX and any other LF... FIR are unambiguously French.
		const text = `R1507/26
Q) LFXX/QRTTT/IV/BO/W/000/110/4909N00107W042
A) LFFF LFRR
B) 2606010600 C) 2606092259
E) TRIGGER NOTAM - AIP SUP 108/26.
CREATION OF 3 TEMPORARY RESTRICTED AREAS FOR THE 82ND DDAY IN
NORMANDY.
F) SFC
G) FL110
`;
		const [n] = parseNotams(text);
		expect(n.id).toBe('R1507/26');
		expect(n.qualifier?.fir).toBe('LFXX');
		expect(isFrenchNotam(n)).toBe(true);
	});
});

describe('parse → AIP SUP pipeline', () => {
	// Sanity check: parser output flows cleanly into the extractor.
	it('finds the SUP reference in a parsed French trigger NOTAM', () => {
		const text = `LFFA-R2198/25
DU: 01 06 2025 00:00 AU: 31 12 2025 23:59
A) LFFF
Q) LFFF / QRRCA / IV / BO / AW / 000/050 / 4900N00200E010
E) TRIGGER NOTAM - AIP SUP 147/25 :
DRONE FLIGHTS AND PYROTECHNIC ACTIVITIES.
F) SFC
G) 5000FT AMSL
`;
		const notams = parseNotams(text);
		expect(notams).toHaveLength(1);
		const n = notams[0];
		expect(isFrenchNotam(n)).toBe(true);
		const refs = extractAipSups(n.fullContent);
		expect(refs.map((r) => r.display)).toEqual(['AIP SUP 147/25']);
		expect(siaSupUrl(refs[0], 'en'))
			.toBe('https://www.sia.aviation-civile.gouv.fr/media/store/documents/file/l/f/lf_sup_2025_147_en.pdf');
	});

	it('flags an IFR variant without producing a URL', () => {
		const text = `LFFA-Z9998/24
DU: 01 01 2024 00:00 AU: 31 12 2024 23:59
A) LFFF
Q) LFFF / QXXAA / IV / BO / AE / 000/999 / 4900N00200E010
E) AS PER AIP SUP IFR 41/24, ROUTES MODIFIED.
F) SFC
G) UNL
`;
		const notams = parseNotams(text);
		const n = notams[0];
		const refs = extractAipSups(n.fullContent);
		expect(refs).toHaveLength(1);
		expect(refs[0].series).toBe('IFR');
		expect(siaSupUrl(refs[0], 'en')).toBeNull();
		expect(siaSupUrl(refs[0], 'fr')).toBeNull();
	});
});
