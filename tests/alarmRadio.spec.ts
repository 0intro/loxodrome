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

// The banner names the channel the band would set, through the same recipe:
// the RAI channel of a military approach, the civil VHF band, never guard.
// It named the first published row, and 43 French rows list UHF or guard
// first: "contact EVREUX - APPROCHE 121.500". Radios verbatim from the data.
describe('alarmRadio names the channel the band would set', () => {
	function row(key: string, rmk: string, freqs: [string, string][]): Airspace {
		return {
			id: key,
			key,
			name: key,
			type: 'CTR',
			source: 'fr',
			category: 'controlled',
			rmk,
			radio: freqs.map(([freq, call]) => ({ freq, unit: 'U', call })),
			ring: [],
		} as unknown as Airspace;
	}
	const on = (a: Airspace): VolumeAlert =>
		({ subject: 'volume', key: a.key, volume: { source: 'airspace', radios: a.radio } }) as unknown as VolumeAlert;

	beforeEach(() => {
		m.items = [];
	});

	it('names a military approach on its RAI channel (CTR EVREUX)', () => {
		const evreux = row('EVREUX', 'OAT/GAT procedures.#Deactivation announced by RAI 118.125 or by PARIS ACC FIC.', [
			['121.5', 'EVREUX - APPROCHE'],
			['243', 'EVREUX - APPROCHE'],
			['362.3', 'EVREUX - APPROCHE'],
			['118.125', 'EVREUX - APPROCHE'],
			['122.1', 'EVREUX - TOUR'],
		]);
		m.rows = [evreux];
		expect(alarmRadio(on(evreux))).toEqual({ unit: 'EVREUX - APPROCHE', freq: '118.125' });
	});

	it('never names guard or UHF listed first (CTA SALON 1, CTR LUXEUIL)', () => {
		const salon = row('SALON 1', 'Possible activation every day from 0500 to 2359.', [
			['243', 'SALON - APPROCHE'],
			['362.3', 'SALON - APPROCHE'],
			['135.15', 'SALON - APPROCHE'],
			['142.175', 'SALON - APPROCHE'],
		]);
		const luxeuil = row('LUXEUIL', 'OAT/GAT procedures.#\nDeactivation announced by RAI 129.925 MHz#\nActivity known on BASEL INFO.', [
			['282.025', 'LUXEUIL - APPROCHE'],
			['344.175', 'LUXEUIL - APPROCHE'],
			['121.5', 'LUXEUIL - APPROCHE'],
			['129.925', 'LUXEUIL - APPROCHE'],
			['123.3', 'LUXEUIL - TOUR'],
		]);
		m.rows = [salon, luxeuil];
		expect(alarmRadio(on(salon))).toEqual({ unit: 'SALON - APPROCHE', freq: '135.150' });
		expect(alarmRadio(on(luxeuil))).toEqual({ unit: 'LUXEUIL - APPROCHE', freq: '129.925' });
	});

	it('skips a UHF monitor listed before the unit to call (ED-D 100 BORKUM)', () => {
		const borkum = row('BORKUM', 'TIMSH', [
			['345.15', 'MAASTRICHT MONITOR'],
			['123.525', 'LANGEN INFORMATION'],
		]);
		m.rows = [borkum];
		expect(alarmRadio(on(borkum))).toEqual({ unit: 'LANGEN INFORMATION', freq: '123.525' });
	});

	it('names no channel when guard is all the row holds (CTR LONDON GATWICK)', () => {
		const gatwick = row('GATWICK', '', [['121.500', 'GATWICK DIRECTOR']]);
		m.rows = [gatwick];
		expect(alarmRadio(on(gatwick))).toBeNull();
	});

	it('reads a volume that is not an airspace row the same way', () => {
		const sup = {
			subject: 'volume',
			key: 'sup:1',
			volume: {
				source: 'supaip',
				radios: [
					{ freq: '257.8', unit: 'U', call: 'HYERES - APPROCHE' },
					{ freq: '120.1', unit: 'U', call: 'HYERES - APPROCHE' },
				],
			},
		} as unknown as VolumeAlert;
		expect(alarmRadio(sup)).toEqual({ unit: 'HYERES - APPROCHE', freq: '120.100' });
	});
});
