/* What a NOTAM decides about an aerodrome (the field closed, a runway
 * closed, a fuel withdrawn) reads the RAW parsed NOTAMs, never the NOTAMs
 * tab's data filters: a search left in its box, the kind filter or the
 * flight rules choose what the lists show, and must not reopen a closed
 * field on the map, in the phone's Nearest list, in the panel or on the
 * performance grid. The NOTAM state and the filters are the real ones. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Airport, Runway } from '$lib/data/airports';
import type { AerodromeFuel } from '$lib/data/fuel';
import { parseNotams } from '$lib/notam/parser';

const m = vi.hoisted(() => ({ row: null as AerodromeFuel | null }));

vi.mock('$lib/state/aerodromeFuel.svelte', () => ({
	fuelForIdent: () => m.row,
	ensureAerodromeFuel: () => Promise.resolve([]),
	aerodromeFuelState: { loaded: true, loading: false, error: null },
}));

import { filter } from '$lib/state/filter.svelte';
import { filteredNotams, notamState } from '$lib/state/notam.svelte';
import { aerodromeClosedByNotam, aerodromeNotamIdents } from '$lib/state/aerodromeState.svelte';
import { resolveAerodromeRunways, runwayNotamIdents } from '$lib/state/runwayOverride.svelte';
import { fuelNotamIdents, resolveAerodromeFuel } from '$lib/state/fuelOverride.svelte';

// 1 October 2026, inside every NOTAM's B) to C).
const AT = { fromMs: Date.parse('2026-10-01T12:00:00Z'), toMs: Date.parse('2026-10-01T13:00:00Z') };

const notam = (id: string, qCode: string, e: string): string =>
	`${id} NOTAMN\nQ) LFFF/${qCode}/IV/NBO/A/000/999/4757N00146E005\nA) LFOR B) 2609010000 C) 2612312359\nE) ${e}`;

// E4386/26 verbatim, a runway closure and a fuel outage, all at LFOR.
const BRIEFING = [
	notam('E4386/26', 'QFALC', 'AD CLSD DUE TO DRONE SHOW IN THE VICINITY OF AD'),
	notam('E4272/26', 'QMRLC', 'RWY 05/23 CLOSED'),
	notam('A0001/26', 'QFUAU', 'AVGAS 100LL NOT AVBL.'),
].join('\n\n');

const LFOR = {
	ident: 'LFOR',
	name: 'ORLEANS SAINT DENIS DE L HOTEL',
	lat: 47.9,
	lon: 2.16,
	runways: [{ le: '05', he: '23' } as Runway],
	radios: [],
} as unknown as Airport;

/** Every verdict at LFOR, and how many NOTAMs the lists still show. */
function verdicts() {
	return {
		listed: filteredNotams().length,
		closed: aerodromeNotamIdents().has('LFOR') && aerodromeClosedByNotam(LFOR, AT),
		runway: runwayNotamIdents().has('LFOR') && resolveAerodromeRunways(LFOR, AT).closed.has('05'),
		fuel:
			fuelNotamIdents().has('LFOR') &&
			resolveAerodromeFuel('LFOR', 'fr', AT).fuel?.grades.every((g) => g.withdrawn) === true,
	};
}

beforeEach(() => {
	m.row = { ident: 'LFOR', avail: 'yes', grades: [{ grade: '100LL', scope: '' }], cond: [], src: 'vac', text: '', aipText: '' };
	notamState.notams = parseNotams(BRIEFING);
});

afterEach(() => {
	notamState.notams = [];
	filter.query = '';
	filter.kind = { area: true, position: true, qualifierLine: true };
});

describe('a NOTAM verdict ignores the list filters', () => {
	it('holds with every filter open', () => {
		expect(verdicts()).toEqual({ listed: 3, closed: true, runway: true, fuel: true });
	});

	it('holds under a search the NOTAMs do not match', () => {
		filter.query = 'nothing like it';
		expect(verdicts()).toEqual({ listed: 0, closed: true, runway: true, fuel: true });
	});

	it('holds with the kind filter hiding every kind', () => {
		filter.kind = { area: false, position: false, qualifierLine: false };
		expect(verdicts()).toEqual({ listed: 0, closed: true, runway: true, fuel: true });
	});
});
