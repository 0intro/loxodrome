/* The flight's day ends on its last millisecond, not on the next midnight
 * (state/timeWindow.svelte.ts dayRange).
 *
 * A flight dated but not timed is judged over its whole day, and every gate
 * over that range compares both ends INCLUSIVELY (validIn: start <= toMs; the
 * D) walk: dayStart <= to). A day closed on the next midnight therefore
 * charged a Tuesday flight with a closure starting Wednesday 0000Z, a runway
 * shut "WED H24" and a channel changing at Wednesday's first minute. */

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

const { resolveAerodromeState } = await import('$lib/state/aerodromeState.svelte');
const { resolveAerodromeRunways } = await import('$lib/state/runwayOverride.svelte');
const { resolveAirportRadios } = await import('$lib/state/freqOverride.svelte');
const { plannedFlightAt } = await import('$lib/state/timeWindow.svelte');
const { flightPrep } = await import('$lib/state/flightPrep.svelte');

const NOON = Date.UTC(2026, 8, 22, 12, 0); // Tuesday 22 Sep 2026

const lfxx = {
	ident: 'LSZH',
	name: 'ZURICH',
	lat: 47.46,
	lon: 8.55,
	runways: [{ le: '10', he: '28' } as Runway],
	radios: [{ unit: 'TWR', call: 'ZURICH', freq: '118.100' }],
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
	flightPrep.dossier.flightDate = '2026-09-22';
	flightPrep.dossier.departureTime = null;
});

afterEach(() => {
	vi.useRealTimers();
	m.items = [];
	flightPrep.dossier.flightDate = null;
});

describe('a flight dated Tue 22 Sep with no ETD', () => {
	it('closes on its last millisecond', () => {
		expect(plannedFlightAt()).toEqual({
			fromMs: Date.UTC(2026, 8, 22),
			toMs: Date.UTC(2026, 8, 23) - 1,
		});
	});

	it('is not charged with an aerodrome closure starting Wednesday 0000Z', () => {
		load('QFALC', 'AD CLSD', 'B) 2609230000 C) 2609252359');
		expect(resolveAerodromeState(lfxx, plannedFlightAt()).closed).toBeNull();
		// Its last minute still is: a closure from 2359 is the flight's.
		load('QFALC', 'AD CLSD', 'B) 2609222359 C) 2609252359');
		expect(resolveAerodromeState(lfxx, plannedFlightAt()).closed?.notam.id).toBe('A1234/26');
	});

	it('does not strike a runway closed "WED H24"', () => {
		load('QMRLC', 'RWY 10/28 CLSD', 'B) 2609010000 C) 2612312359\nD) WED H24');
		expect(resolveAerodromeRunways(lfxx, plannedFlightAt()).closed.size).toBe(0);
		// The Wednesday flight's is.
		flightPrep.dossier.flightDate = '2026-09-23';
		expect([...resolveAerodromeRunways(lfxx, plannedFlightAt()).closed.keys()].sort()).toEqual([
			'10',
			'28',
		]);
	});

	it('prints the channel in force on Tuesday, not one effective Wednesday 0000Z', () => {
		m.items = parseNotams(`B0367/26 NOTAMN
Q) LSAS/QCACS/IV/NBO/A/000/999/4728N00833E005
A) LSZH B) 2609230000 C) 2612312359
E) TWR ZURICH MODIFIED : READ 118.105MHZ INSTEAD OF 118.100MHZ`).map((notam, index) => ({
			notam,
			index,
		}));
		expect(resolveAirportRadios(lfxx, plannedFlightAt()).radios.map((r) => r.freq)).toEqual([
			'118.100',
		]);
	});
});
