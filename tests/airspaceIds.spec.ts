import { describe, it, expect } from 'vitest';
import {
	designatorKey,
	extractAirspaceIds,
	extractCitedDesignators,
	extractBareDesignatorIds,
	extractSpacedSubZoneIds,
	firToPublisher,
	notamPublisher,
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

describe('notamPublisher', () => {
	it('reads the FIR, else the A) locations where no dataset belongs to the FIR', () => {
		expect(notamPublisher('LFFF', ['LFPG'])).toBe('fr');
		// The SIA files the Antilles under Piarco's FIR.
		expect(notamPublisher('TTZP', ['TFFF'])).toBe('fr');
		expect(notamPublisher('TTZP', ['TTPP'])).toBeNull();
		expect(notamPublisher('KZNY', ['KZNY'])).toBeNull();
		// The FIR wins where it names a dataset: a location never overrides it.
		expect(notamPublisher('EGTT', ['LFPG'])).toBe('uk');
		expect(notamPublisher('TTZP')).toBeNull();
	});

	it('scopes the citation family the same way', () => {
		expect(extractCitedDesignators('ZONE TF-R5 ACTIVE', 'TTZP').map((c) => c.key)).toEqual([]);
		expect(extractCitedDesignators('ZONE TF-R5 ACTIVE', 'TTZP', ['TFFF']).map((c) => c.key)).not.toEqual([]);
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

/* The SIA detaches a zone's sub-lettering from its number and hangs several
 * off one designator. Verbatim from the France corpus of 2026-09-18, where
 * seven activation NOTAMs in one day's briefing named 15 sub-zones this way
 * and every one of them went unactivated. */
describe('extractSpacedSubZoneIds', () => {
	it('reads a run of suffixes off one designator', () => {
		// R2617/26 LFMM, R2771/26 LFBB.
		expect(extractSpacedSubZoneIds('LF-R368 A B C1 C2 ACTIVATED.').map((c) => c.id)).toEqual([
			'LFR368A',
			'LFR368B',
			'LFR368C1',
			'LFR368C2',
		]);
		expect(extractSpacedSubZoneIds('AREAS LF-R68 A B C ACTIVATED').map((c) => c.id)).toEqual([
			'LFR68A',
			'LFR68B',
			'LFR68C',
		]);
	});

	it('reads the slashed and repeated forms', () => {
		// R1522/26 LFMM; R2696/26 LFEE.
		expect(extractSpacedSubZoneIds('LF-D596 A/B/C ACTIVATED').map((c) => c.id)).toEqual([
			'LFD596A',
			'LFD596B',
			'LFD596C',
		]);
		expect(
			extractSpacedSubZoneIds("AREAS LF-R6 B, LF-R6 C, LF-R6 D, LF-R6 E 'MAILLY' ACT").map(
				(c) => c.id,
			),
		).toEqual(['LFR6B', 'LFR6C', 'LFR6D', 'LFR6E']);
	});

	it('reads a parenthesised run', () => {
		// M3249/26 LFBB (Avord), M3260/26 (Mont-de-Marsan).
		expect(
			extractSpacedSubZoneIds('AFFECTED AREAS : LF-R20 (B1, B2, B5, H1, H3, H4)').map((c) => c.id),
		).toEqual(['LFR20B1', 'LFR20B2', 'LFR20B5', 'LFR20H1', 'LFR20H3', 'LFR20H4']);
	});

	it('stops at the activation verb and at a number', () => {
		// The suffix token is one letter plus an optional digit, so a word
		// cannot be one; and a letter followed by a number is prose ("up to").
		expect(extractSpacedSubZoneIds('LF-R45 ACTIVATED').map((c) => c.id)).toEqual([]);
		expect(extractSpacedSubZoneIds('LF-R45 A 3000FT AMSL').map((c) => c.id)).toEqual([]);
		expect(extractSpacedSubZoneIds('LF-D54 EST ACTIVE').map((c) => c.id)).toEqual([]);
	});

	it('keeps the glued form working and reports the designator index', () => {
		const got = extractSpacedSubZoneIds('ZONE LF-R45A ACTIVE');
		expect(got.map((c) => c.id)).toEqual(['LFR45A']);
		expect(got[0].index).toBe('ZONE '.length);
	});
});

/* The French half drops the prefix once it has written it, and sometimes
 * never writes it: the English "LF-R65, LF-R66 AND LF-D67" is
 * "LF-R65-R66 ET D67" in French (M2542/26), and "LF-R20 (B1, B2, ...)" is
 * "ZONES CONCERNEES : R20 (B1, B2, ...)" (M3249/26). R2613/26 writes
 * "AREAS R368 A B C1 C2 E1 E2 ACTIVATED" in both. */
describe('extractBareDesignatorIds', () => {
	it('reads a continuation of a designator already written in full', () => {
		expect(
			extractBareDesignatorIds('VOLS DANS LES ZONES DE SOLENZARA LF-R65-R66 ET D67 SOUMIS A AUTORISATION').map(
				(c) => c.id,
			).sort(),
		).toEqual(['LFD67', 'LFR65', 'LFR66']);
		expect(extractBareDesignatorIds('LF-R45 ET R46 ACTIVES').map((c) => c.id)).toEqual(['LFR46']);
	});

	it('reads a bare designator after a ZONE or AREA anchor, with its suffixes', () => {
		expect(
			extractBareDesignatorIds('ZONES CONCERNEES : R20 (B1, B2, H1), TMA 1.1').map((c) => c.id),
		).toEqual(['LFR20', 'LFR20B1', 'LFR20B2', 'LFR20H1']);
		expect(
			extractBareDesignatorIds('AREAS R368 A B C1 C2 E1 E2 ACTIVATED.').map((c) => c.id),
		).toEqual(['LFR368', 'LFR368A', 'LFR368B', 'LFR368C1', 'LFR368C2', 'LFR368E1', 'LFR368E2']);
	});

	it('reads nothing out of prose that only looks like one', () => {
		// The caller confirms every candidate against the loaded rows, but the
		// grammar still refuses what is plainly not a designator.
		expect(extractBareDesignatorIds('LF-R45A ACTIVE, CONTACT 04.95.56.85.96')).toEqual([]);
		expect(extractBareDesignatorIds('SUP AIP 174/26 REFERS')).toEqual([]);
		expect(extractBareDesignatorIds('CRANE 45 M AGL NEAR LFPG')).toEqual([]);
	});
});
