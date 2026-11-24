/* The next AIRAC slot's file, held for an offline session
 * (state/data.svelte.ts, data/meta.ts, docs/pwa.md), over a served site
 * (tests/helpers/coverageSite.ts).
 *
 * The loader reads only the slot it picks, and the service worker keeps only
 * what was read. An installed PWA last online before an AIRAC date and opened
 * offline after it picks the next slot from its kept sidecars, and the worker
 * holds no such file. A file loaded from its current slot whose next sidecar
 * names a cycle still to come therefore has its next file read once beside
 * it, under a controlling worker, the one cache that keeps it. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INNSBRUCK, drain, fetched, serve, serveCoverageSite } from './helpers/coverageSite';

const BOOT = Date.parse('2026-11-18T12:00:00Z');
const PAST = '2026-10-29T00:00:00Z';
const AHEAD = '2026-11-26T00:00:00Z';
const AT_BOX = [9.5, 46.3, 17.2, 49.1];

beforeEach(() => {
	vi.resetModules();
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(BOOT);
	serveCoverageSite();
});

afterEach(async () => {
	(await import('$lib/state/dataRetry.svelte')).resetDataRetryForTest();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

/** A page a service worker controls, or none: the Android shell, a dev
 *  server, a first visit. */
function worker(controlled: boolean): void {
	vi.stubGlobal('navigator', { serviceWorker: { controller: controlled ? {} : null } });
}

/** Austria's obstacles over Innsbruck, its sidecars stating these cycles. */
async function austria(current: string, next: string | undefined): Promise<void> {
	serve('/data/at-obstacles.meta.json', { effective: current, bbox: AT_BOX });
	serve('/data/at-obstacles.next.meta.json', next === undefined ? undefined : { effective: next, bbox: AT_BOX });
	const cov = await import('$lib/state/coverage.svelte');
	const data = await import('$lib/state/data.svelte');
	cov.setCoverageViewport(INNSBRUCK);
	await data.ensureObstacles();
	await drain();
	expect(fetched('/data/at-obstacles.json')).toBe(1);
}

describe('a country loaded from its current slot', () => {
	it('has its next file read once when the next cycle is still to come', async () => {
		worker(true);
		await austria(PAST, AHEAD);
		expect(fetched('/data/at-obstacles.next.json')).toBe(1);
	});

	it('reads no next file without a controlling worker, which would keep nothing', async () => {
		worker(false);
		await austria(PAST, AHEAD);
		expect(fetched('/data/at-obstacles.next.json')).toBe(0);
	});

	it('reads no next file when none is published, or the current slot has caught up', async () => {
		worker(true);
		await austria(PAST, undefined);
		expect(fetched('/data/at-obstacles.next.json')).toBe(0);
		vi.resetModules();
		serveCoverageSite();
		await austria(AHEAD, AHEAD);
		expect(fetched('/data/at-obstacles.next.json')).toBe(0);
	});
});

describe('a single-file set loaded from its current slot', () => {
	it('has its next file read once when the next cycle is still to come', async () => {
		worker(true);
		const { loadActiveSlot } = await import('$lib/data/meta');
		const rows = await loadActiveSlot(
			() => Promise.resolve({ effective: PAST }),
			() => Promise.resolve({ effective: AHEAD }),
			'/data/fr-fuel.json',
			'/data/fr-fuel.next.json',
			() => Promise.resolve(['row']),
		);
		await drain();
		expect(rows).toEqual(['row']);
		expect(fetched('/data/fr-fuel.next.json')).toBe(1);
	});
});
