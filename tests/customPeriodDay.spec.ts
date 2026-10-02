/* The Custom period's pre-fill is the current UTC day, today 00:00 to 23:59
 * (state/filter.svelte.ts setWindowMode). It ended at TOMORROW 00:00, and
 * drawnStateAt() hands the range to resolvers comparing both ends
 * inclusively: a Tuesday was charged with an aerodrome closure starting
 * Wednesday 0000Z, a runway shut "WED H24" was struck, and the panel printed
 * the channel effective Wednesday's first minute. The flight's own day had the
 * same boundary fixed (timeWindow.svelte.ts dayRange). */

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
const { drawnStateAt } = await import('$lib/state/notam.svelte');
const { filter, setWindowMode } = await import('$lib/state/filter.svelte');

const NOON_TUE = Date.UTC(2026, 8, 22, 12, 0); // Tuesday 22 Sep 2026

const lszh = {
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
	vi.setSystemTime(NOON_TUE);
	filter.window.fromDate = '';
	filter.window.fromTime = '';
	filter.window.toDate = '';
	filter.window.toTime = '';
	setWindowMode('custom'); // the pre-fill: "the current UTC day"
});

afterEach(() => {
	setWindowMode('now');
	vi.useRealTimers();
	m.items = [];
});

describe("the Custom period's default day", () => {
	it('is the current UTC day', () => {
		expect(filter.window.fromDate).toBe('2026-09-22');
		expect(filter.window.fromTime).toBe('00:00');
		expect(filter.window.toDate).toBe('2026-09-22');
		expect(filter.window.toTime).toBe('23:59');
	});

	it('is not charged with an aerodrome closure starting Wednesday 0000Z', () => {
		load('QFALC', 'AD CLSD', 'B) 2609230000 C) 2609252359');
		expect(resolveAerodromeState(lszh, drawnStateAt()).closed).toBeNull();
	});

	it('does not strike a runway closed "WED H24"', () => {
		load('QMRLC', 'RWY 10/28 CLSD', 'B) 2609010000 C) 2612312359\nD) WED H24');
		expect(resolveAerodromeRunways(lszh, drawnStateAt()).closed.size).toBe(0);
	});

	it('prints the channel in force on Tuesday, not one effective Wednesday 0000Z', () => {
		m.items = parseNotams(`B0367/26 NOTAMN
Q) LSAS/QCACS/IV/NBO/A/000/999/4728N00833E005
A) LSZH B) 2609230000 C) 2612312359
E) TWR ZURICH MODIFIED : READ 118.105MHZ INSTEAD OF 118.100MHZ`).map((notam, index) => ({
			notam,
			index,
		}));
		expect(resolveAirportRadios(lszh, drawnStateAt()).radios.map((r) => r.freq)).toEqual([
			'118.100',
		]);
	});
});
