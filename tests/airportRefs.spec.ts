import { describe, it, expect } from 'vitest';
import { extractArpIdents, parseNotams, parseSections } from '$lib/notam';
import { arpCitedIdents } from '$lib/state/notamAirportLinks.svelte';
import { parseFranceSubset, byId } from './worldFixtures';

describe('extractArpIdents', () => {
	it('extracts the ident from every observed RDL/ARP shape', () => {
		expect(extractArpIdents('RDL 194/0.25NM ARP LFPZ')).toEqual(['LFPZ']);
		expect(extractArpIdents('(RDL080/0.78NM ARP LFML)')).toEqual(['LFML']);
		expect(extractArpIdents('RDL : 268DEG/1.24NM ARP LFDB MONTAUBAN')).toEqual(['LFDB']);
		expect(extractArpIdents('RDL220DE/0.22NM ARP LFBJ')).toEqual(['LFBJ']);
		expect(extractArpIdents('DANS UN RAYON DE 25NM/FL100 ARP LFOE')).toEqual(['LFOE']);
	});

	it('accepts the ident-before form', () => {
		expect(extractArpIdents('RDL 360/0.15NM LFGH ARP')).toEqual(['LFGH']);
	});

	it('accepts the named English order without reading the name tail as an ident', () => {
		expect(extractArpIdents('RDL 102 1.63NM LFSB BALE MULHOUSE ARP')).toEqual(['LFSB']);
		expect(
			extractArpIdents("RDL 079/2.55NM LFRZ 'SAINT NAZAIRE MONTOIR' ARP"),
		).toEqual(['LFRZ']);
		// SAINT-MALO's four-letter tail sits right before ARP; the named
		// anchor's span suppresses it.
		expect(
			extractArpIdents('RDL128DEG/0.77NM LFRD DINARD-PLEURTUIT SAINT-MALO ARP'),
		).toEqual(['LFRD']);
	});

	it('ignores prose words around ARP', () => {
		expect(extractArpIdents('CRANE 0.4NM FROM ARP')).toEqual([]);
		expect(extractArpIdents('ARP WITH NEW COORDINATES')).toEqual([]);
		expect(extractArpIdents('ARP ELEV 351FT')).toEqual([]);
		// Longer words never match: the boundary excludes the TOWARDS tail.
		expect(extractArpIdents('CRANE MOVING TOWARDS ARP')).toEqual([]);
	});

	it('dedupes in first-mention order across both phrasings', () => {
		expect(
			extractArpIdents('PSN RDL 100/1NM ARP LFAA AND LFBB ARP, ALSO ARP LFAA'),
		).toEqual(['LFAA', 'LFBB']);
		// 'ALSO' itself sits in the prose blocklist for the before-form.
		expect(extractArpIdents('SEE ALSO ARP LFCC')).toEqual(['LFCC']);
	});

	it('returns nothing for ARP-free text', () => {
		expect(extractArpIdents('CRANE 45 M AGL ERECTED NEAR LFPG.')).toEqual([]);
		expect(extractArpIdents('')).toEqual([]);
	});
});

describe('arpCitedIdents', () => {
	it("drops self-references to the NOTAM's own A) idents", () => {
		const [n] = parseNotams(`P1757/26 NOTAMN
Q) LFMM/QOBCE/IV/M/A/000/999/4326N00513E005
A) LFML B) 2605110600 C) 2605141500
E) GRUE MOBILE ERIGEE DANS RAYON 50M (RDL080/0.78NM ARP LFML)
`);
		expect(arpCitedIdents(n)).toEqual([]);
	});

	it('keeps cross-references from FIR-filed NOTAMs', () => {
		const [n] = parseNotams(`P1261/26 NOTAMN
Q) LFFF/QOBCE/IV/M/E/000/999/4848N00202E002
A) LFFF B) 2605110600 C) 2605141500
E) GRUE A TOUR ERIGEE PROCHE AD 'SAINT CYR L'ECOLE' - RDL 194/0.25NM ARP LFPZ
`);
		expect(arpCitedIdents(n)).toEqual(['LFPZ']);
	});
});

describe('extractArpIdents over the France world subset', () => {
	const unique = [...byId(parseFranceSubset('world-en-20260610.txt')).values()];

	it('finds a stable number of ARP-citing NOTAMs', () => {
		let cited = 0;
		let crossRef = 0;
		for (const n of unique) {
			const idents = extractArpIdents(parseSections(n.fullContent).E ?? '');
			if (idents.length === 0) {
				continue;
			}
			cited += 1;
			const own = n.icaoCodes.map((c) => c.toUpperCase());
			if (idents.some((i) => !own.includes(i))) {
				crossRef += 1;
			}
		}
		// 285 NOTAMs anchor a position to an ARP; 137 of them cite an
		// aerodrome OTHER than their own A) idents (mostly FIR-filed
		// P-series obstacles), which is what the airport link surfaces.
		expect(cited).toBe(285);
		expect(crossRef).toBe(137);
	});
});
