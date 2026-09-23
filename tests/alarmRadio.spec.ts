/* The alert banner's contact line (components/alertText.ts alarmRadio) is
 * resolved at the pose's own instant, the band's: a replay of a flight made
 * BEFORE a frequency change names the channel the flight had. It resolved at
 * drawnStateAt(), the wall clock, and printed the NEW channel beside a band
 * printing the old one. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseNotams } from '$lib/notam/parser';
import type { Notam } from '$lib/notam/types';
import type { Airspace } from '$lib/data/airspaces';
import type { VolumeAlert } from '$lib/nav/airspaceAlert';

const m = vi.hoisted(() => ({
	items: [] as { notam: Notam; index: number }[],
	rows: [] as Airspace[],
}));

vi.mock('$lib/state/notam.svelte', async () => {
	const real =
		await vi.importActual<typeof import('$lib/state/notam.svelte')>('$lib/state/notam.svelte');
	return { ...real, filteredNotams: () => m.items, notamsByIdent: () => new Map() };
});

vi.mock('$lib/state/data.svelte', async () => {
	const real =
		await vi.importActual<typeof import('$lib/state/data.svelte')>('$lib/state/data.svelte');
	return {
		...real,
		getAirspaces: () => m.rows,
		airspaceByKey: (k: string) => m.rows.find((r) => r.key === k) ?? null,
	};
});

const { alarmRadio } = await import('$lib/components/alertText');
const { resolveAirspaceRadios } = await import('$lib/state/freqOverride.svelte');
const { nav } = await import('$lib/state/navRecording.svelte');

const seine = {
	id: 'LFPM1',
	key: 'LFPM1|SEINE',
	name: 'SEINE',
	type: 'TMA',
	source: 'fr',
	category: 'controlled',
	radio: [{ freq: '118.000', unit: 'LFPM', call: 'SEINE - APPROCHE' }],
	ring: [],
} as unknown as Airspace;

const NOW = Date.UTC(2026, 8, 24, 12, 0); // after the change
const REPLAY = Date.UTC(2026, 8, 22, 12, 0); // the flight being replayed

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	m.rows = [seine];
	m.items = parseNotams(`A7777/26 NOTAMN
Q) LFFF/QATCF/IV/NBO/AE/000/195/4833N00239E030
A) LFFF B) 2609230000 C) 2612312359
E) TMA SEINE FREQ 118.050MHZ REPLACES 118.000MHZ`).map((notam, index) => ({ notam, index }));
	nav.playheadMs = REPLAY;
});

afterEach(() => {
	vi.useRealTimers();
	nav.playheadMs = 0;
});

describe('alarmRadio in a replay', () => {
	it('names the channel in force at the playhead, as the band does', () => {
		const alert = {
			subject: 'volume',
			key: seine.key,
			volume: { source: 'airspace', radios: seine.radio },
		} as unknown as VolumeAlert;
		// What the band resolves at the display instant:
		expect(
			resolveAirspaceRadios(seine, { fromMs: REPLAY, toMs: REPLAY }).radios.map((r) => r.freq),
		).toEqual(['118.000']);
		// What the banner says for the same instant:
		expect(alarmRadio(alert)?.freq).toBe('118.000');
		// And after the change, the new one.
		nav.playheadMs = NOW;
		expect(alarmRadio(alert)?.freq).toBe('118.050');
	});
});
