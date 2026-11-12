/* RTBA link wiring at the state layer: activatedAirspaceIds is the single source
 * of truth for the id-based activation link in both directions (activatesAirspaces
 * forward, notamsForAirspace reverse). It must fold the RTBA zone ids in alongside
 * the by-code ids, stay deduped/ordered, and yield nothing for non-activation
 * NOTAMs. Pure-function coverage; the map overlay's per-zone time gating is
 * covered by rtba.spec.ts (rtbaActiveAt). */

import { describe, it, expect } from 'vitest';
import { parseNotams } from '$lib/notam';
import { activatedAirspaceIds } from '$lib/state/notamLinks.svelte';

const RTBA = `LFFA-Z0261/26
Q) LFXX/QRRCA/IV/BO/W/000/044/4855N00530E052
A) LFEE LFFF
B) 2606010730 C) 2606011000
E) ZONES AIRFORCE RTBA ACT
ZONE R45N2 ARDENNES
0730-1000:ACTIVE
ZONE R45N5.1 MEUSE NORD
0730-1000:ACTIVE
ZONE R69 CHAMPAGNE
0730-1000:ACTIVE
F) 800FT AGL
G) 2700FT AGL
`;

// A plain by-code activation: extractAirspaceIds path only.
const ENGHIEN = `LFFA-R2112/25
DU: 13 09 2025 00:00 AU: 15 04 2026 23:59
A) LFFE
Q) LFFF / QRRCA / IV / BO / AW / 000/015 / 4904N00220E003
E) ZONE REGLEMENTEE LF-R262 'ENGHIEN' MODIFIEE
F) SFC
G) 1500FT AMSL
`;

// Non-activation (obstacle), even though it mentions a code-like token.
const OBSTACLE = `LFFA-Z9999/26
Q) LFFF / QOBCE / IV / M / A / 000/005 / 4900N00210E001
A) LFPG
B) 2606010000 C) 2606012359
E) CRANE 45 M AGL ERECTED NEAR LF-R262.
F) SFC
G) 150FT AGL
`;

describe('activatedAirspaceIds (RTBA + by-code union)', () => {
	it('extracts the RTBA zone ids, LF-prefixed and in body order', () => {
		const n = parseNotams(RTBA)[0];
		expect(n.qCode).toBe('QRRCA');
		expect(activatedAirspaceIds(n)).toEqual([
			'LFR45N2', 'LFR45N5.1', 'LFR69',
		]);
	});

	it('keeps the by-code path for a plain activation', () => {
		const n = parseNotams(ENGHIEN)[0];
		expect(activatedAirspaceIds(n)).toEqual(['LFR262']);
	});

	it('returns nothing for a non-activation NOTAM', () => {
		const n = parseNotams(OBSTACLE)[0];
		expect(activatedAirspaceIds(n)).toEqual([]);
	});
});
