/* The gate in a real effect loop (tests/env/webnode.ts runs the effects):
 * the alert effect asks for four datasets on every GPS fix, and while they
 * were down every fix asked the network again, flipping the band between
 * acquiring and lost. A failed read now waits for its retry, whoever asks. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PARIS, asked, failAlways, fetched, serveCoverageSite, settle } from './helpers/coverageSite';

const DOWN = [
	'/data/airports.json',
	'/data/fr-airspaces.json',
	'/data/fr-obstacles.json',
	'/data/fr-supaip.json',
	'/data/be-supaip.json',
	'/data/es-supaip.json',
];

let flushSync: () => void;
let retry: typeof import('$lib/state/dataRetry.svelte');

beforeEach(() => {
	vi.resetModules();
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
	vi.setSystemTime(new Date('2026-09-27T12:00:00Z'));
	serveCoverageSite();
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
	retry.resetDataRetryForTest();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('an effect asking for failed datasets on every fix', () => {
	it('asks the network nothing until the retries come due, then once each', async () => {
		({ flushSync } = await import('svelte'));
		retry = await import('$lib/state/dataRetry.svelte');
		const cov = await import('$lib/state/coverage.svelte');
		const data = await import('$lib/state/data.svelte');
		const { mountAlertEnsures } = await import('./helpers/dataRetryHosts.svelte');
		cov.setCoverageViewport(PARIS);
		const recover = DOWN.map((p) => failAlways(p, 503));
		const host = mountAlertEnsures();
		flushSync();
		await settle();
		const first = asked.length;
		for (let i = 0; i < 50; i++) {
			host.bump();
			flushSync();
			await settle(3);
		}
		expect(host.runs()).toBe(51);
		expect(asked.length).toBe(first);
		for (const r of recover) {
			r();
		}
		await vi.advanceTimersByTimeAsync(5_000);
		await settle();
		for (const p of DOWN) {
			expect(fetched(p), p).toBe(2);
		}
		expect(data.dataState.airportsLoaded).toBe(true);
		expect(data.dataState.airspacesLoaded).toBe(true);
		expect(data.dataState.obstaclesLoaded).toBe(true);
		expect(data.dataState.supaipLoaded).toBe(true);
		host.stop();
	});
});
