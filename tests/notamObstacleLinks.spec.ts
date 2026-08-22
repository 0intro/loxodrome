import { describe, it, expect } from 'vitest';
import { parseNotams } from '$lib/notam';
import type { Notam } from '$lib/notam/types';
import type { Obstacle } from '$lib/data/obstacles';
import {
	extractObstacleRefs,
	isObstacleQCode,
	matchObstaclesToNotam,
} from '$lib/state/notamObstacleLinks.svelte';

// Tiny synthetic obstacle fixture covering all three matching tiers
// (Q-code is enforced by the caller, not by matchObstaclesToNotam).
// Coordinates are loosely around LFPG so the proximity examples below
// fall inside / outside the 300 m radius as labelled.
function ob(
	id: string,
	name: string,
	lat: number,
	lon: number,
	overrides: Partial<Obstacle> = {},
): Obstacle {
	return {
		id,
		type: 'mast',
		name,
		lat,
		lon,
		elev: null,
		hgt: 60,
		lit: false,
		group: false,
		rmk: '',
		source: 'fr',
		...overrides,
	};
}

const OBSTACLES: Obstacle[] = [
	ob('FR_77009', '77009', 49.000_0, 2.000_0),
	// ~200 m east of FR_77009 (inside the 300 m radius).
	ob('FR_NEAR',  '12345', 49.000_0, 2.002_7),
	// ~600 m south (outside the 300 m radius).
	ob('FR_FAR',   '99999', 48.994_6, 2.000_0),
	// Distant but referenced by FAA ASR id; tests tier-3 text mention.
	ob('US_TOWER', '1208783', 39.000_0, -77.000_0),
];

const NEAR_COORDS = [{ lat: 49.000_0, lon: 2.000_0 } as const];

describe('isObstacleQCode', () => {
	it('accepts the three obstacle subjects (OB, OL, PO)', () => {
		expect(isObstacleQCode('QOBCE')).toBe(true); // obstacle erected
		expect(isObstacleQCode('QOLAS')).toBe(true); // obstacle light
		expect(isObstacleQCode('QPOCH')).toBe(true); // clearance height
	});

	it('rejects non-obstacle subjects and malformed input', () => {
		expect(isObstacleQCode('QRRCA')).toBe(false); // activation
		expect(isObstacleQCode('QMRLT')).toBe(false); // runway
		expect(isObstacleQCode('')).toBe(false);
		expect(isObstacleQCode('QR')).toBe(false);
	});
});

describe('extractObstacleRefs', () => {
	it('matches FAA ASR forms (plain, with hash, in parens)', () => {
		expect(extractObstacleRefs('OBST TOWER LGT (ASR 1208783) U/S'))
			.toEqual(['1208783']);
		expect(extractObstacleRefs('ASR# 1234567 LIGHTING U/S'))
			.toEqual(['1234567']);
		expect(extractObstacleRefs('ASR(987654) OUT'))
			.toEqual(['987654']);
	});

	it('matches French OBST NR and bare OBST forms', () => {
		expect(extractObstacleRefs('OBST MAST NR 80137 LIGHTING U/S'))
			.toEqual(['80137']);
		expect(extractObstacleRefs('OBST NR 77009 ERECTED'))
			.toEqual(['77009']);
		expect(extractObstacleRefs('OBST 22033 LIT U/S'))
			.toEqual(['22033']);
	});

	it('deduplicates while preserving order', () => {
		const refs = extractObstacleRefs(
			'OBST NR 77009 LGT U/S. SEE ALSO ASR 1208783 AND OBST 77009 AGAIN.',
		);
		expect(refs).toEqual(['1208783', '77009']);
	});

	it('rejects unrelated short digits (RWY, FREQ)', () => {
		expect(extractObstacleRefs('RWY 27 CLOSED, FREQ 121.500 U/S')).toEqual([]);
		expect(extractObstacleRefs('')).toEqual([]);
	});
});

describe('matchObstaclesToNotam', () => {
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
			qCode: 'QOBCE',
			obstacleType: '',
			serviceStatus: '',
			qualifier: null,
			fgLower: null,
			fgUpper: null,
			replaces: null,
		};
	}

	it('matches an obstacle inside the proximity radius (tier 2)', () => {
		const n = makeNotam('CRANE 45 M AGL ERECTED.');
		const ids = matchObstaclesToNotam(n, OBSTACLES).map((o) => o.id).sort();
		expect(ids).toEqual(['FR_77009', 'FR_NEAR']);
	});

	it('excludes obstacles outside the 300 m proximity radius', () => {
		const n = makeNotam('CRANE 45 M AGL ERECTED.');
		const ids = matchObstaclesToNotam(n, OBSTACLES).map((o) => o.id);
		expect(ids).not.toContain('FR_FAR');
		expect(ids).not.toContain('US_TOWER');
	});

	it('matches via text-mention even when no coord is close (tier 3)', () => {
		// Far-away coord; only the FAA ASR id should link the US tower.
		const n = makeNotam(
			'OBST TOWER LGT (ASR 1208783) U/S.',
			[{ lat: 10, lon: 10 }],
		);
		const ids = matchObstaclesToNotam(n, OBSTACLES).map((o) => o.id);
		expect(ids).toEqual(['US_TOWER']);
	});

	it('unions tier 2 and tier 3 hits without duplication', () => {
		const n = makeNotam('OBST NR 77009 LIGHTING U/S.');
		const ids = matchObstaclesToNotam(n, OBSTACLES).map((o) => o.id).sort();
		// FR_77009 from both proximity AND text mention; counted once.
		expect(ids).toEqual(['FR_77009', 'FR_NEAR']);
	});

	it('returns nothing for a NOTAM with no coords and no obstacle ref', () => {
		const n = makeNotam('RWY 27 CLOSED', []);
		expect(matchObstaclesToNotam(n, OBSTACLES)).toEqual([]);
	});
});

describe('parse → obstacle Q-code', () => {
	// Sanity-check that the parser's qCode field plays nicely with
	// isObstacleQCode; the activation suite already covers QRRCA / QOBCE.
	it('flags a QOBCE NOTAM as obstacle-related', () => {
		const text = `LFFA-Z9999/25
DU: 01 01 2026 00:00 AU: 31 12 2026 23:59
A) LFPG
Q) LFFF / QOBCE / IV / M / A / 000/005 / 4900N00210E001
E) CRANE 45 M AGL ERECTED NEAR LFPG.
F) SFC
G) 150FT AGL
`;
		const notams = parseNotams(text);
		expect(notams).toHaveLength(1);
		expect(isObstacleQCode(notams[0].qCode)).toBe(true);
	});
});
