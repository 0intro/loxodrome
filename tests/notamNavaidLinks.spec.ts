import { describe, it, expect } from 'vitest';
import { parseNotams } from '$lib/notam';
import type { Notam } from '$lib/notam/types';
import type { Navaid } from '$lib/data/navaids';
import {
	extractNavaidIdents,
	isNavaidQCode,
	matchNavaidsToNotam,
} from '$lib/state/notamNavaidLinks.svelte';

// Tiny synthetic navaid fixture covering both matching tiers (Q-code is
// enforced by the caller, not by matchNavaidsToNotam). Coordinates are
// loosely around LFPG so the proximity examples fall inside / outside the
// 1500 m radius as labelled. Two navaids share the ident DUP to exercise
// the nearest-instance tie-break.
function nav(
	id: string,
	type: Navaid['type'],
	ident: string,
	lat: number,
	lon: number,
	overrides: Partial<Navaid> = {},
): Navaid {
	return {
		id,
		type,
		ident,
		name: ident,
		lat,
		lon,
		freq: '',
		channel: '',
		elev: null,
		source: 'fr',
		...overrides,
	};
}

const NAVAIDS: Navaid[] = [
	nav('VOR:CGN', 'VOR-DME', 'CGN', 49.0, 2.0), // at the NEAR coord
	nav('DME:CGE', 'DME', 'CGE', 49.0, 2.0005), // ~37 m from CGN (co-located neighbour)
	nav('DME:ABC', 'DME', 'ABC', 49.0, 2.0027), // ~197 m east (inside 1500 m)
	nav('NDB:FAR', 'NDB', 'FAR', 49.03, 2.0), // ~3.3 km N (outside)
	nav('VOR:DUP1', 'VOR', 'DUP', 49.02, 2.0), // ~2.2 km N (outside); first dup
	nav('VOR:DUP2', 'VOR', 'DUP', 40.0, -3.0), // far dup
	nav('NDB:XYZ', 'NDB', 'XYZ', 39.0, -77.0), // distant; text-only
];

const NEAR_COORDS = [{ lat: 49.0, lon: 2.0 } as const];

describe('isNavaidQCode', () => {
	it('accepts N-series (radio navaid) subjects', () => {
		expect(isNavaidQCode('QNVAS')).toBe(true); // VOR unserviceable
		expect(isNavaidQCode('QNBAS')).toBe(true); // NDB
		expect(isNavaidQCode('QNNAS')).toBe(true); // TACAN
		expect(isNavaidQCode('QNMAS')).toBe(true); // VOR/DME
	});

	it('accepts I-series (ILS / MLS) subjects', () => {
		expect(isNavaidQCode('QICAS')).toBe(true); // ILS
		expect(isNavaidQCode('QIDAS')).toBe(true); // ILS DME
		expect(isNavaidQCode('QILAS')).toBe(true); // localizer
	});

	it('rejects non-navaid subjects and malformed input', () => {
		expect(isNavaidQCode('QOBCE')).toBe(false); // obstacle
		expect(isNavaidQCode('QMRLC')).toBe(false); // runway
		expect(isNavaidQCode('')).toBe(false);
		expect(isNavaidQCode('QN')).toBe(false);
	});
});

describe('extractNavaidIdents', () => {
	it('matches a quoted ident', () => {
		expect(extractNavaidIdents("VOR 'CGN' 115.15MHZ U/S")).toContain('CGN');
	});

	it('matches an ident next to a type word, both orders', () => {
		expect(extractNavaidIdents('ILS IRW U/S')).toContain('IRW');
		expect(extractNavaidIdents('CGN VOR UNSERVICEABLE')).toContain('CGN');
	});

	it('drops the bare type words themselves', () => {
		const ids = extractNavaidIdents('VOR DME NDB ILS LOC TACAN');
		expect(ids).not.toContain('VOR');
		expect(ids).not.toContain('DME');
		expect(ids).not.toContain('NDB');
	});

	it('returns nothing for empty / ident-free text', () => {
		expect(extractNavaidIdents('')).toEqual([]);
		expect(extractNavaidIdents('RWY 27 CLOSED')).toEqual([]);
	});
});

describe('matchNavaidsToNotam', () => {
	// Build a Notam-shaped fixture with whatever coords / body the test needs.
	// We only fill the fields the matcher reads (coordinates + fullContent).
	function makeNotam(
		fullContent: string,
		coords: { lat: number; lon: number }[] = NEAR_COORDS,
	): Notam {
		return {
			id: 'SYNTH-1/26',
			fullContent,
			coordinates: coords.map((c) => ({
				lat: c.lat,
				lon: c.lon,
				original: '',
				type: 'psn',
			})),
			icaoCodes: [],
			isPolygon: false,
			startDate: null,
			endDate: null,
			permanent: false,
			estimated: false,
			qCode: 'QNVAS',
			obstacleType: '',
			serviceStatus: '',
			qualifier: null,
			fgLower: null,
			fgUpper: null,
			replaces: null,
		};
	}

	it('falls back to proximity when the text names no ident (step 3)', () => {
		const n = makeNotam('VORTAC U/S.');
		const ids = matchNavaidsToNotam(n, NAVAIDS).map((x) => x.id).sort();
		expect(ids).toEqual(['DME:ABC', 'DME:CGE', 'VOR:CGN']);
	});

	it('excludes navaids outside the 1500 m proximity radius', () => {
		const ids = matchNavaidsToNotam(makeNotam('VORTAC U/S.'), NAVAIDS).map((x) => x.id);
		expect(ids).not.toContain('NDB:FAR');
		expect(ids).not.toContain('VOR:DUP1');
		expect(ids).not.toContain('NDB:XYZ');
	});

	it('matches via ident text-mention even when no coord is close (step 2)', () => {
		const n = makeNotam("NDB 'XYZ' 350KHZ U/S.", [{ lat: 10, lon: 10 }]);
		const ids = matchNavaidsToNotam(n, NAVAIDS).map((x) => x.id);
		expect(ids).toEqual(['NDB:XYZ']);
	});

	it('resolves a duplicate ident to the instance nearest the NOTAM', () => {
		// Coords at the far dup; ident "DUP" must pick DUP2, not DUP1.
		const n = makeNotam("VOR 'DUP' U/S", [{ lat: 40.0, lon: -3.0 }]);
		const ids = matchNavaidsToNotam(n, NAVAIDS).map((x) => x.id);
		expect(ids).toEqual(['VOR:DUP2']);
	});

	it('a named navaid wins outright and does not link co-located neighbours', () => {
		// Regression for "DME 'CGN' CH100Y U/S": must link only CGN, not the
		// co-located CGE ~37 m away nor ABC ~197 m away that the loose
		// proximity window would otherwise pull in.
		const n = makeNotam("DME 'CGN' CH100Y U/S.");
		const ids = matchNavaidsToNotam(n, NAVAIDS).map((x) => x.id);
		expect(ids).toEqual(['VOR:CGN']);
		expect(ids).not.toContain('DME:CGE');
		expect(ids).not.toContain('DME:ABC');
	});

	it('returns nothing for a NOTAM with no coords and no ident', () => {
		expect(matchNavaidsToNotam(makeNotam('RWY 27 CLOSED', []), NAVAIDS)).toEqual([]);
	});
});

describe('parse → navaid Q-code', () => {
	it('flags a QNVAS NOTAM as navaid-related', () => {
		const text = `LFFA-Z9999/25
DU: 01 01 2026 00:00 AU: 31 12 2026 23:59
A) LFPG
Q) LFFF / QNVAS / IV / M / AE / 000/999 / 4900N00210E025
E) VOR 'CGN' 115.15MHZ U/S.
`;
		const notams = parseNotams(text);
		expect(notams).toHaveLength(1);
		expect(isNavaidQCode(notams[0].qCode)).toBe(true);
	});
});
