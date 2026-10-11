/* WHICH instant a NOTAM's operational state is judged at, per surface.
 *
 * The runway, declared-distance and aerodrome resolvers used to default to
 * activeEvalWindow(), the BRIEFING filter, whose look-ahead is unbounded by
 * default (DEFAULT_HORIZON_H). So out of the box the airport panel, the
 * performance page and the in-flight nearest-aerodrome list treated every
 * future-dated closure as in force today, and a nightly works closure as shut
 * at noon, while the map, which reads drawnStateAt(), drew the field open.
 *
 * Now: the resolvers default to drawnStateAt() (the map's own instant, which
 * the panel shares; the diversion list passes the pose's instant, pinned in
 * nearestAerodromesInstant.spec), and the performance page passes
 * plannedFlightAt(), the planned flight's span whatever the viewing mode
 * (state/timeWindow.svelte.ts, the range the nav log's frequencies read too;
 * the page's own call is pinned in closureInstantSurfaces.spec).
 *
 * The NOTAM associations are mocked (the runwayOverride.spec idiom); the
 * windows are the REAL ones, over the real filter defaults, at a fixed noon. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseNotams } from '$lib/notam/parser';
import type { Notam } from '$lib/notam/types';
import type { Airport, Runway } from '$lib/data/airports';

const m = vi.hoisted(() => ({ items: [] as { notam: Notam; index: number }[] }));

vi.mock('$lib/state/notam.svelte', async () => {
	const real =
		await vi.importActual<typeof import('$lib/state/notam.svelte')>('$lib/state/notam.svelte');
	return {
		...real,
		filteredNotams: () => m.items,
		notamsByIdent: () => {
			const map = new Map<string, { notam: Notam; index: number }[]>();
			for (const it of m.items) {
				for (const code of it.notam.icaoCodes) {
					const k = code.toUpperCase();
					map.set(k, [...(map.get(k) ?? []), it]);
				}
			}
			return map;
		},
	};
});

const { resolveAerodromeState, aerodromeClosedByNotam } = await import(
	'$lib/state/aerodromeState.svelte'
);
const { resolveAerodromeRunways } = await import('$lib/state/runwayOverride.svelte');
const { activeEvalWindow, drawnStateAt } = await import('$lib/state/notam.svelte');
const { plannedFlightAt } = await import('$lib/state/timeWindow.svelte');
const { flightPrep } = await import('$lib/state/flightPrep.svelte');

const NOON = Date.UTC(2026, 8, 22, 12, 0);
const TONIGHT = { fromMs: Date.UTC(2026, 8, 22, 22, 0), toMs: Date.UTC(2026, 8, 22, 22, 0) };

const lszh = {
	ident: 'LSZH',
	name: 'ZURICH',
	lat: 47.46,
	lon: 8.55,
	runways: [{ le: '10', he: '28' } as Runway],
	radios: [],
} as unknown as Airport;

function load(qCode: string, e: string, bcd: string): void {
	m.items = parseNotams(`A1234/26 NOTAMN
Q) LSAS/${qCode}/IV/NBO/A/000/999/4728N00833E005
A) LSZH ${bcd}
E) ${e}`).map((notam, index) => ({ notam, index }));
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOON);
});

afterEach(() => {
	vi.useRealTimers();
	m.items = [];
	flightPrep.dossier.flightDate = null;
});

describe('the resolvers judge at the drawn instant by default', () => {
	it('the briefing window really is unbounded out of the box', () => {
		// Why the default had to move: judged over this, "in force" means "at
		// any point from now on".
		expect(activeEvalWindow().to).toBe(Infinity);
		expect(drawnStateAt()).toEqual({ fromMs: NOON, toMs: NOON });
	});

	it('an aerodrome shut tonight 2100-0400 reads open at noon', () => {
		load('QFALC', 'AD CLSD', 'B) 2609222100 C) 2609230400');
		expect(resolveAerodromeState(lszh).closed).toBe(null);
		expect(aerodromeClosedByNotam(lszh)).toBe(false);
		// ...and shut at the hour it is shut.
		expect(resolveAerodromeState(lszh, TONIGHT).closed?.notam.id).toBe('A1234/26');
	});

	it('a nightly runway closure strikes nothing at noon', () => {
		load('QMRLC', 'RWY 10/28 CLSD', 'B) 2609010000 C) 2612312359\nD) DAILY 2100-0400');
		expect(resolveAerodromeRunways(lszh).closed.size).toBe(0);
		expect([...resolveAerodromeRunways(lszh, TONIGHT).closed.keys()].sort()).toEqual([
			'10',
			'28',
		]);
	});

	it('next month’s shorter declared distance does not reach today', () => {
		load('QMDCH', 'RWY 10 : TORA = 900M', 'B) 2610150000 C) 2611150000');
		const r = resolveAerodromeRunways(lszh);
		expect(r.distances.size).toBe(0);
		expect(r.contested.size).toBe(0);
	});
});

describe('plannedFlightAt(), the range the performance page passes, judges over the planned flight', () => {
	// No route here, so the plan has no span and plannedFlightAt() reads the
	// flight's own DAY (the dossier flight date), exactly as the nav log does:
	// a flight whose departure is not stated is somewhere in that day.
	const day = (iso: string): void => {
		flightPrep.dossier.flightDate = iso;
	};

	it('a flight today is charged with tonight’s closure while the map, read now, is not', () => {
		load('QFALC', 'AD CLSD', 'B) 2609222100 C) 2609230400');
		day('2026-09-22');
		expect(plannedFlightAt()).toEqual({
			fromMs: Date.UTC(2026, 8, 22),
			toMs: Date.UTC(2026, 8, 23) - 1,
		});
		expect(resolveAerodromeState(lszh, plannedFlightAt()).closed?.notam.id).toBe('A1234/26');
		expect(resolveAerodromeState(lszh).closed).toBe(null);
	});

	it('a flight next month is not charged with tonight’s closure', () => {
		load('QFALC', 'AD CLSD', 'B) 2609222100 C) 2609230400');
		day('2026-10-22');
		expect(resolveAerodromeState(lszh, plannedFlightAt()).closed).toBe(null);
	});

	it('and it IS charged with next month’s shorter declared distance', () => {
		load('QMDCH', 'RWY 10 : TORA = 900M', 'B) 2610150000 C) 2611150000');
		day('2026-10-22');
		expect(resolveAerodromeRunways(lszh, plannedFlightAt()).distances.get('10')?.values).toEqual({
			tora: 900,
		});
		// Undated, the flight is today.
		day('');
		expect(resolveAerodromeRunways(lszh, plannedFlightAt()).distances.size).toBe(0);
	});
});

describe('a frequency change is judged at the same instants', () => {
	// B0367/26's shape, dated next month: the new channel must not reach the
	// panel (or the in-flight band, which passes its display instant) before
	// the tower moves to it. It used to, under the unbounded briefing window,
	// in the default app state.
	const vatry = {
		ident: 'LFOK',
		name: 'VATRY',
		lat: 48.77,
		lon: 4.2,
		runways: [],
		radios: [{ unit: 'TWR', call: 'VATRY', freq: '129.400' }],
	} as unknown as Airport;
	const loadConversion = (): void => {
		m.items = parseNotams(`B0367/26 NOTAMN
Q) LFFF/QCACS/IV/NBO/A/000/999/4846N00406E005
A) LFOK B) 2610150600 C) 2612312359
E) TWR VATRY MODIFIED : READ 129.405MHZ INSTEAD OF 129.400MHZ`).map((notam, index) => ({
			notam,
			index,
		}));
	};

	it('the panel keeps today’s channel until the conversion date', async () => {
		const { resolveAirportRadios } = await import('$lib/state/freqOverride.svelte');
		loadConversion();
		expect(resolveAirportRadios(vatry).radios.map((r) => r.freq)).toEqual(['129.400']);
		const after = { fromMs: Date.UTC(2026, 9, 16, 10), toMs: Date.UTC(2026, 9, 16, 10) };
		expect(resolveAirportRadios(vatry, after).radios.map((r) => r.freq)).toEqual(['129.405']);
	});

	it('the nav log for a flight on the conversion date sets the new channel', async () => {
		const { resolveAirportRadios } = await import('$lib/state/freqOverride.svelte');
		loadConversion();
		flightPrep.dossier.flightDate = '2026-10-16';
		expect(resolveAirportRadios(vatry, plannedFlightAt()).radios.map((r) => r.freq)).toEqual([
			'129.405',
		]);
		flightPrep.dossier.flightDate = '2026-09-22';
		expect(resolveAirportRadios(vatry, plannedFlightAt()).radios.map((r) => r.freq)).toEqual([
			'129.400',
		]);
	});
});
