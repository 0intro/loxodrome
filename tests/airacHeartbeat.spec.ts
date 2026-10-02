/* The AIRAC reload banner watches the files this session LOADED
 * (state/data.svelte.ts, airacSwitchDue and the stamps loadCountryDatasets
 * writes), over a served site (tests/helpers/coverageSite.ts).
 *
 * Two defects made it answer about something else. Every pass re-stamped
 * the cell of a country it skipped as already loaded, from the slot the
 * picker would choose NOW, so a widening after an AIRAC date wrote "next"
 * over rows loaded from "current" and the banner that should have asked
 * for a reload never showed. And the heartbeat read every cell, a country
 * the map never loaded included, so a cycle arriving for a country outside
 * the view asked for a reload that would change nothing: that country loads
 * whichever file is in force whenever it is first wanted. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FOLIGNO, PARIS, asked, drain, hold, serve, serveCoverageSite, until } from './helpers/coverageSite';

const T = Date.parse('2026-09-27T12:00:00Z');
const iso = (ms: number): string => new Date(ms).toISOString();

beforeEach(() => {
	vi.resetModules();
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(T);
	serveCoverageSite();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

async function mods(): Promise<{
	cov: typeof import('$lib/state/coverage.svelte');
	data: typeof import('$lib/state/data.svelte');
}> {
	return {
		cov: await import('$lib/state/coverage.svelte'),
		data: await import('$lib/state/data.svelte'),
	};
}

describe('the AIRAC cells', () => {
	it('keep the slot a country was loaded from when a later pass runs past the date', async () => {
		// France's pre-release takes effect tomorrow (an effective date is read
		// as the UTC midnight of its own calendar day).
		const NEXT = '2026-09-28T00:00:00Z';
		serve('/data/fr-airports.next.meta.json', { effective: NEXT, bbox: [-5.2, 41.3, 9.6, 51.1] });
		const { cov, data } = await mods();
		cov.setCoverageViewport(PARIS);
		await data.ensureAirports();
		expect(data.dataState.airac.airports.fr?.slot).toBe('current');
		expect(data.airacSwitchDue(new Date())).toBe(false);

		// Two days on, the map moves to Italy: the widening's pass reads the
		// sidecars again and would pick the next slot for France, whose rows
		// it does not reload.
		vi.setSystemTime(T + 2 * 86_400_000);
		cov.setCoverageViewport(FOLIGNO);
		await data.extendCoverage();
		expect(data.dataState.airac.airports.fr).toEqual({
			effective: '2026-01-01T00:00:00Z',
			nextEffective: NEXT,
			slot: 'current',
		});
		expect(data.airacSwitchDue(new Date())).toBe(true);
	});

	it('are still stamped for a country outside the view, which About reports on', async () => {
		const { cov, data } = await mods();
		cov.setCoverageViewport(PARIS);
		await data.ensureAirports();
		expect(data.dataState.airac.airports.it?.slot).toBe('current');
	});
});

describe('airacSwitchDue', () => {
	it('ignores a country this session never loaded', async () => {
		const { cov, data } = await mods();
		cov.setCoverageViewport(PARIS);
		await data.ensureAirports();
		// Italy's next cycle is already in force, but Italy was never loaded:
		// it will load the file in force whenever the coverage first wants it.
		data.dataState.airac.airports.it = {
			effective: '2026-01-01T00:00:00Z',
			nextEffective: iso(T - 86_400_000),
			slot: 'current',
		};
		expect(data.airacSwitchDue(new Date())).toBe(false);
	});

	it('ignores a country of a dataset not published yet', async () => {
		// The first load commits France's airspaces while it still waits for
		// the FIR rings: France sits in the store and nothing shows it yet,
		// so its next cycle asks for no reload.
		const release = hold('/data/pruatlas-firs.json');
		const { cov, data } = await mods();
		cov.setCoverageViewport(PARIS);
		const first = data.ensureAirspaces();
		await until(() => asked.includes('/data/fr-airspaces.json'));
		await drain();
		expect(data.dataState.airspacesLoaded).toBe(false);
		data.dataState.airac.airspaces.fr = {
			effective: '2026-01-01T00:00:00Z',
			nextEffective: iso(T - 86_400_000),
			slot: 'current',
		};
		expect(data.airacSwitchDue(new Date())).toBe(false);
		release();
		await first;
		expect(data.airacSwitchDue(new Date())).toBe(true);
	});

	it('answers for a country this session loaded', async () => {
		const { cov, data } = await mods();
		cov.setCoverageViewport(PARIS);
		await data.ensureAirports();
		data.dataState.airac.airports.fr = {
			effective: '2026-01-01T00:00:00Z',
			nextEffective: iso(T - 86_400_000),
			slot: 'current',
		};
		expect(data.airacSwitchDue(new Date())).toBe(true);
	});
});
