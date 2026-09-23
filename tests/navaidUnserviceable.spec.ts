/* The navaid "unserviceable" state the map DRAWS (the dim in navaidLayer via
 * MapView's setUnserviceableNavaids) and the navaid panel's U/S tag are
 * judged at drawnStateAt(), with the NOTAM's B)/C) and D) (state/notamActive).
 * They were judged over activeEvalWindow(), the unbounded briefing window,
 * with no D): a VOR outage dated next month greyed the VOR today, and one
 * scheduled MON-FRI greyed it on a Sunday. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseNotams } from '$lib/notam/parser';
import type { Notam } from '$lib/notam/types';
import type { Navaid } from '$lib/data/navaids';

const m = vi.hoisted(() => ({
	items: [] as { notam: Notam; index: number }[],
	navaids: [] as Navaid[],
}));

vi.mock('$lib/state/notam.svelte', async () => {
	const real =
		await vi.importActual<typeof import('$lib/state/notam.svelte')>('$lib/state/notam.svelte');
	return { ...real, filteredNotams: () => m.items };
});

vi.mock('$lib/state/data.svelte', async () => {
	const real =
		await vi.importActual<typeof import('$lib/state/data.svelte')>('$lib/state/data.svelte');
	return { ...real, getNavaids: () => m.navaids };
});

const { unserviceableNavaids } = await import('$lib/state/notamNavaidLinks.svelte');
const { drawnStateAt } = await import('$lib/state/notam.svelte');

const NOON_SUN = Date.UTC(2026, 8, 20, 12, 0); // Sunday 20 Sep 2026

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOON_SUN);
	m.navaids = [
		{ id: 'PON', ident: 'PON', type: 'VOR-DME', name: 'PONTOISE', lat: 49.097, lon: 2.035 } as unknown as Navaid,
	];
});

afterEach(() => {
	vi.useRealTimers();
	m.items = [];
});

function load(bcd: string): void {
	m.items = parseNotams(`A6000/26 NOTAMN
Q) LFFF/QNMAS/IV/BO/AE/000/999/4906N00202E025
A) LFFF ${bcd}
E) VOR/DME 'PON' 111.600MHZ U/S`).map((notam, index) => ({ notam, index }));
}

describe('navaid U/S dim', () => {
	it('is not drawn today for an outage dated next month', () => {
		load('B) 2610150000 C) 2610202359');
		expect(m.items[0].notam.serviceStatus).toBe('unserviceable');
		expect(drawnStateAt()).toEqual({ fromMs: NOON_SUN, toMs: NOON_SUN });
		expect(unserviceableNavaids().has('PON')).toBe(false);
		// In force now, it is.
		load('B) 2609200000 C) 2609202359');
		expect(unserviceableNavaids().has('PON')).toBe(true);
	});

	it("follows the outage's own schedule", () => {
		load('B) 2609010000 C) 2612312359\nD) MON-FRI 0700-1600');
		expect(unserviceableNavaids().has('PON')).toBe(false);
		// Monday noon, inside the schedule.
		vi.setSystemTime(NOON_SUN + 86_400_000);
		expect(unserviceableNavaids().has('PON')).toBe(true);
	});
});
