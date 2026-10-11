/* Three small preferences stored only away from their defaults
 * (docs/preferences.md): the Weather tab's SOFIA chart zone, which used to
 * reset to France at every reload; the NOTAM source, which used to be written
 * on every pick, 'sofia' included, and whose stale default an older build
 * left behind is dropped at load; and the performance nomogram's reading,
 * which the printed page now follows too. The modules seed themselves at
 * evaluation, hence the re-import per case. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage, type MemoryStorage } from './helpers/storage';

let ls: MemoryStorage;

beforeEach(() => {
	vi.resetModules();
	ls = memoryStorage();
	vi.stubGlobal('localStorage', ls);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('the SOFIA chart zone', () => {
	it('is remembered away from France', async () => {
		const z = await import('$lib/state/sofiaCharts.svelte');
		expect(z.sofiaCharts.zone).toBe('FRANCE');
		z.setSofiaZone('EUR');
		expect(ls.getItem('loxodrome:sofia-zone')).toBe('EUR');
		vi.resetModules();
		const again = await import('$lib/state/sofiaCharts.svelte');
		expect(again.sofiaCharts.zone).toBe('EUR');
		again.setSofiaZone('FRANCE');
		expect(ls.dump()).toEqual({});
	});

	it('reads a zone SOFIA does not list as France', async () => {
		ls.setItem('loxodrome:sofia-zone', 'ATLANTIS');
		expect((await import('$lib/state/sofiaCharts.svelte')).sofiaCharts.zone).toBe('FRANCE');
	});
});

describe('the NOTAM source', () => {
	it('is stored only while it says autorouter', async () => {
		const n = await import('$lib/state/notamSource.svelte');
		n.setNotamSource('autorouter');
		expect(ls.getItem('loxodrome:notam-source')).toBe('autorouter');
		n.setNotamSource('sofia');
		expect(ls.dump()).toEqual({});
	});

	it('drops the stale default an older build stored', async () => {
		ls.setItem('loxodrome:notam-source', 'sofia');
		const n = await import('$lib/state/notamSource.svelte');
		expect(n.notamSource.source).toBe('sofia');
		expect(ls.dump()).toEqual({});
	});
});

describe('the nomogram reading', () => {
	it('is remembered away from the distance over 15 m', async () => {
		const f = await import('$lib/state/flightPrepModal.svelte');
		expect(f.flightPrepModal.nomogramMetric).toBe('distance15m');
		f.setNomogramMetric('groundRoll');
		expect(ls.getItem('loxodrome:perf-nomogram-metric')).toBe('groundRoll');
		vi.resetModules();
		const again = await import('$lib/state/flightPrepModal.svelte');
		expect(again.flightPrepModal.nomogramMetric).toBe('groundRoll');
		again.setNomogramMetric('distance15m');
		expect(ls.dump()).toEqual({});
	});
});

describe('the winds-aloft level', () => {
	const load = () => import('$lib/state/windAloft.svelte');

	it('reads back every level the Weather tab takes, 0 ft among them', async () => {
		const w = await load();
		expect(w.windAloft.levelFt).toBe(2500);
		for (const level of [0, 4500, 'sfc'] as const) {
			w.setWindLevel(level);
			vi.resetModules();
			expect((await load()).windAloft.levelFt).toBe(level);
		}
		w.setWindLevel(2500);
		expect(ls.dump()).toEqual({});
	});

	it('reads nothing stored, and nonsense, as the default', async () => {
		expect((await load()).windAloft.levelFt).toBe(2500);
		vi.resetModules();
		ls.setItem('loxodrome:wind-level', 'high');
		expect((await load()).windAloft.levelFt).toBe(2500);
		vi.resetModules();
		ls.setItem('loxodrome:wind-level', '-100');
		expect((await load()).windAloft.levelFt).toBe(2500);
	});
});
