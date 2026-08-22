import { describe, it, expect } from 'vitest';
import {
	designatorKey,
	extractAirspaceIds,
	extractCitedDesignators,
	firToPublisher,
} from '$lib/notam/airspaceIds';

describe('firToPublisher', () => {
	it('maps FIR prefixes to the owning designator dataset', () => {
		expect(firToPublisher('LFFF')).toBe('fr');
		expect(firToPublisher('TFFF')).toBe('fr');
		expect(firToPublisher('EGTT')).toBe('uk');
		expect(firToPublisher('LECB')).toBe('es');
		expect(firToPublisher('GCCC')).toBe('es');
		expect(firToPublisher('EBBU')).toBe('be');
		expect(firToPublisher('ELLX')).toBe('be');
		expect(firToPublisher('EDGG')).toBe('de');
		expect(firToPublisher('EDWW')).toBe('de');
		expect(firToPublisher('LOVV')).toBe('at');
		expect(firToPublisher('')).toBe(null);
	});
});

describe('extractAirspaceIds (moved verbatim)', () => {
	it('normalises the hyphenated NOTAM form to the airspaces.json codeId', () => {
		expect(extractAirspaceIds("ZONE REGLEMENTEE LF-R262 'ENGHIEN'")).toEqual([
			'LFR262',
		]);
	});

	it('deduplicates repeated mentions, preserving first-mention order', () => {
		expect(extractAirspaceIds('LF-R45A active; see also LFR45A and LF-D75.')).toEqual([
			'LFR45A',
			'LFD75',
		]);
	});
});

describe('designatorKey', () => {
	it('keeps unpadded French designators as-is', () => {
		expect(designatorKey('LFR45C')).toBe('LFR45C');
		expect(designatorKey('LFP226L')).toBe('LFP226L');
		expect(designatorKey('LFD75')).toBe('LFD75');
	});

	it('unifies the zero-padded UK dataset ids with the cited forms', () => {
		expect(designatorKey('EGD006A')).toBe('EGD6A');
		expect(designatorKey('EG D6A')).toBe('EGD6A');
		expect(designatorKey('EG-D 6A')).toBe('EGD6A');
		expect(designatorKey('EGD298B')).toBe('EGD298B');
	});

	it('handles the unpadded Spanish ids', () => {
		expect(designatorKey('LER99A')).toBe('LER99A');
		expect(designatorKey('LED17C')).toBe('LED17C');
		expect(designatorKey('LED36')).toBe('LED36');
	});

	it('handles the compact Belgian / Luxembourg ids', () => {
		expect(designatorKey('EBR04')).toBe('EBR4');
		expect(designatorKey('EB R04')).toBe('EBR4');
		expect(designatorKey('EBD07A')).toBe('EBD7A');
		expect(designatorKey('EBR05F')).toBe('EBR5F');
	});

	it('handles the DFS German ED-R / ED-D ids', () => {
		expect(designatorKey('EDR32A')).toBe('EDR32A');
		expect(designatorKey('ED-R 32A')).toBe('EDR32A');
		expect(designatorKey('EDR032A')).toBe('EDR32A'); // leading zero stripped
		expect(designatorKey('EDD19AZ')).toBe('EDD19AZ');
		expect(designatorKey('EDDF')).toBe(null); // airport ident (no digit after letter)
		expect(designatorKey('EDDM')).toBe(null); // airport ident
	});

	it('returns null outside the designator grammar', () => {
		expect(designatorKey('LFFF')).toBe(null); // FIR id
		expect(designatorKey('OCA4521')).toBe(null); // synthetic fr OCA id
		expect(designatorKey('LFPG')).toBe(null); // airport ident
		expect(designatorKey('EGDL')).toBe(null); // airport ident in the EG-D shape
		expect(designatorKey('')).toBe(null);
	});

	it('canonicalises the Belgian / Luxembourg TSA-TRA dataset ids', () => {
		// Real be-airspaces.json id forms: bare Belgian designators, the
		// EL-prefixed Luxembourg ones, letter designators, and the compound
		// TRA/TSA rows (whose TRA/ half drops).
		expect(designatorKey('TSA26A')).toBe('TSA26A');
		expect(designatorKey('TSA28CZ')).toBe('TSA28CZ');
		expect(designatorKey('TRA23')).toBe('TRA23');
		expect(designatorKey('ELTSA7')).toBe('ELTSA7');
		expect(designatorKey('TRA NA')).toBe('TRANA');
		expect(designatorKey('TRA W')).toBe('TRAW');
		expect(designatorKey('TRA/TSA N1')).toBe('TSAN1');
		expect(designatorKey('TRA/TSA13A')).toBe('TSA13A');
	});

	it('unifies the cited TSA-TRA spellings with the dataset ids', () => {
		// An EB prefix drops (the dataset ids are bare), EL stays, numbers
		// unpad, separators vanish.
		expect(designatorKey('EB TSA 25')).toBe('TSA25');
		expect(designatorKey('EBTSA26A')).toBe('TSA26A');
		expect(designatorKey('EL TSA 7')).toBe('ELTSA7');
		expect(designatorKey('TSA 07')).toBe('TSA7');
		expect(designatorKey('TSA N1')).toBe('TSAN1');
	});

	it('rejects TSA-TRA look-alikes outside the grammar', () => {
		expect(designatorKey('BE-CBA1L-CROSS-BORDER-AREA-LOW')).toBe(null); // slug id
		expect(designatorKey('TRACY CLASS E5')).toBe(null); // FAA row
		expect(designatorKey('TSA')).toBe(null); // bare type word
	});
});

describe('extractCitedDesignators', () => {
	it('extracts French designators under a French FIR only', () => {
		const text = "ZONE REGLEMENTEE LF-R262 'ENGHIEN' MODIFIEE";
		expect(extractCitedDesignators(text, 'LFFF').map((m) => m.key)).toEqual([
			'LFR262',
		]);
		expect(extractCitedDesignators(text, 'EDGG')).toEqual([]);
	});

	it('extracts UK designators in cited, spaced, and padded forms', () => {
		const text = 'DANGER AREA EG D129 AND EGD006A ACTIVE, SEE ALSO EGD298B.';
		expect(extractCitedDesignators(text, 'EGTT').map((m) => m.key)).toEqual([
			'EGD129',
			'EGD6A',
			'EGD298B',
		]);
	});

	it('extracts Belgian designators under the Brussels FIR', () => {
		const text = 'EBR04 ELSENBORN ACTIVE. AVOID EB D26 AND EBR05A.';
		expect(extractCitedDesignators(text, 'EBBU').map((m) => m.key)).toEqual([
			'EBR4',
			'EBD26',
			'EBR5A',
		]);
		expect(extractCitedDesignators(text, 'LFFF')).toEqual([]);
	});

	it('extracts Spanish designators only under an ES FIR', () => {
		const text = 'AREA LED36 ACT. LATERAL LIMITS COINCIDENTAL WITH LED 36.';
		expect(extractCitedDesignators(text, 'LECB').map((m) => m.key)).toEqual([
			'LED36',
		]);
		// The same letters under a German FIR are plain English ("LED" lights).
		expect(extractCitedDesignators(text, 'EDGG')).toEqual([]);
	});

	it('reports match indexes for reference-context filtering', () => {
		const text = 'ACTIVATION ZRT EXCEPT LF-R400E.';
		const [m] = extractCitedDesignators(text, 'LFFF');
		expect(m.key).toBe('LFR400E');
		expect(text.slice(m.index, m.index + 2)).toBe('LF');
	});

	it('dedupes by canonical key across citation spellings', () => {
		const text = 'EGD6A ACT, EG D6A ACT AGAIN.';
		expect(extractCitedDesignators(text, 'EGTT').map((m) => m.key)).toEqual([
			'EGD6A',
		]);
	});

	it('extracts Belgian TSA / TRA citations under the Brussels FIR', () => {
		// Real fixture forms: "TSA22-BERTRIX-JEHONVILLE ACT",
		// "TSA26A - ARDENNES 01 AND TSA26B - ARDENNES 04 ACT",
		// "ELTSA6-DIEKIRCH NORTH ACT" (QRACA activations, Q) EBBU).
		expect(
			extractCitedDesignators('TSA22-BERTRIX-JEHONVILLE ACT', 'EBBU').map((m) => m.key),
		).toEqual(['TSA22']);
		expect(
			extractCitedDesignators(
				'TSA26A - ARDENNES 01 AND TSA26B - ARDENNES 04 ACT',
				'EBBU',
			).map((m) => m.key),
		).toEqual(['TSA26A', 'TSA26B']);
		expect(
			extractCitedDesignators('ELTSA6-DIEKIRCH NORTH ACT', 'ELLX').map((m) => m.key),
		).toEqual(['ELTSA6']);
		expect(
			extractCitedDesignators('EB TSA 25 AND TRA/TSA N1 ACT', 'EBBU').map((m) => m.key),
		).toEqual(['TSA25', 'TSAN1']);
		// The same text under a non-be FIR extracts nothing.
		expect(extractCitedDesignators('TSA26A ACT', 'LFFF')).toEqual([]);
	});

	it('keeps the be R/D/P and TSA patterns in document order, deduped', () => {
		const text = 'TSA26A ACT WHEN EBR04 ACT, TSA26A REMAINS ACT.';
		expect(extractCitedDesignators(text, 'EBBU').map((m) => m.key)).toEqual([
			'TSA26A',
			'EBR4',
		]);
	});

	it('never reads a foreign TSA designator out of a longer token', () => {
		// The Estonian "EETSA21" (a real world-fixture form) must not yield a
		// Belgian TSA21 even inside an EBBU-family NOTAM body.
		expect(
			extractCitedDesignators('TEMPORARY SEGREGATED AREA EETSA21 NURMSI ACT', 'EBBU'),
		).toEqual([]);
	});

	it('lets prose after TRA fall through to the loaded-id gate only', () => {
		// "TRACK" cannot parse (no separator before the letters), and a
		// separated short word yields a key no dataset row carries.
		expect(
			extractCitedDesignators('GAT ALLOWED TO CROSS TRACK MATIX-MMD', 'EBBU'),
		).toEqual([]);
		expect(extractCitedDesignators('THE TRA AND TSA26B ACT', 'EBBU').map((m) => m.key)).toEqual([
			'TRAAND',
			'TSA26B',
		]);
	});
});
