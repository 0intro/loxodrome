/* The AIRAC heartbeat (the module-level effect at the end of
 * state/data.svelte.ts) in the client runtime, where module effects run:
 * on each minute tick it raises the reload banner for a superseded file this
 * session LOADED, and only for one (tests/airacHeartbeat.spec.ts pins the
 * rule itself). */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PARIS, failTimes, serve, serveCoverageSite, untilReal } from './helpers/coverageSite';

const T = Date.parse('2026-09-27T12:00:00Z');
const PASSED = new Date(T - 86_400_000).toISOString();

let flushSync: () => void;

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

async function boot(): Promise<{
	data: typeof import('$lib/state/data.svelte');
	notam: typeof import('$lib/state/notam.svelte');
}> {
	({ flushSync } = await import('svelte'));
	const cov = await import('$lib/state/coverage.svelte');
	const data = await import('$lib/state/data.svelte');
	const notam = await import('$lib/state/notam.svelte');
	cov.setCoverageViewport(PARIS);
	await data.ensureAirports();
	flushSync();
	return { data, notam };
}

describe('the AIRAC heartbeat', () => {
	it('asks for no reload for a country the session never loaded', async () => {
		const { data, notam } = await boot();
		data.dataState.airac.airports.it = { effective: '2026-01-01T00:00:00Z', nextEffective: PASSED, slot: 'current' };
		notam.notamState.tick++;
		flushSync();
		expect(data.dataState.airacSwitchPending).toBe(false);
	});

	it('reads again a next sidecar that did not answer, and asks for the reload its cycle brings', async () => {
		// At load the next sidecar failed: an unknown next cycle, which read as
		// none, so the country loaded now never asked for its reload.
		failTimes('/data/fr-airports.next.meta.json', 1, 'network');
		serve('/data/fr-airports.next.meta.json', { effective: PASSED, bbox: [-5.2, 41.3, 9.6, 51.1] });
		const { data, notam } = await boot();
		expect(data.dataState.airac.airports.fr?.nextEffective).toBeNull();
		expect(data.dataState.airacSwitchPending).toBe(false);
		notam.notamState.tick++;
		flushSync();
		await untilReal(() => data.dataState.airac.airports.fr?.nextEffective === PASSED);
		flushSync();
		expect(data.dataState.airac.airports.fr?.slot).toBe('current');
		expect(data.dataState.airacSwitchPending).toBe(true);
	});

	it('asks for one when a file the session loaded is superseded', async () => {
		const { data, notam } = await boot();
		data.dataState.airac.airports.fr = { effective: '2026-01-01T00:00:00Z', nextEffective: PASSED, slot: 'current' };
		notam.notamState.tick++;
		flushSync();
		expect(data.dataState.airacSwitchPending).toBe(true);
	});
});
