/* What the panels and the banner say while a dataset is being read again,
 * in the client runtime where deriveds and effects run (tests/env/webnode.ts).
 *
 * A country whose read failed is missing from a dataset that is otherwise
 * loaded. The detail panel read "loaded" as "answered" and told a pilot who
 * had selected an item of that country that it "could not be read": it is
 * loading, and fills in when the retry lands. The banner names the country
 * from its first retry that did not land it, and goes when it does. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INNSBRUCK, PARIS, failTimes, serve, serveCoverageSite, settle } from './helpers/coverageSite';

vi.mock('leaflet', () => ({ default: {} }));

let flushSync: () => void;
let retry: typeof import('$lib/state/dataRetry.svelte');
let stops: (() => void)[] = [];

beforeEach(() => {
	vi.resetModules();
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
	vi.setSystemTime(new Date('2026-09-27T12:00:00Z'));
	serveCoverageSite();
	serve('/data/at-obstacles.json', {
		fields: ['id', 'type', 'name', 'lat', 'lon', 'elev', 'hgt', 'lit', 'group'],
		rows: [['at:OB1', 'mast', 'MAST', 47.26, 11.35, 3500, 300, true, false]],
	});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	stops = [];
});

afterEach(() => {
	for (const stop of stops) {
		stop();
	}
	retry.resetDataRetryForTest();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function boot() {
	({ flushSync } = await import('svelte'));
	retry = await import('$lib/state/dataRetry.svelte');
	const cov = await import('$lib/state/coverage.svelte');
	const data = await import('$lib/state/data.svelte');
	const scope = await import('$lib/state/planScope.svelte');
	const ui = await import('$lib/state/ui.svelte');
	const head = await import('$lib/components/detail/detailHead.svelte');
	const host = await import('./helpers/derivedHost.svelte');
	cov.setCoverageViewport(PARIS);
	scope.planScope.extent = () => [INNSBRUCK];
	return { data, ui, head, host };
}

describe('an item of a country being read again', () => {
	it('is loading in the detail panel, then shown once the retry lands', async () => {
		failTimes('/data/at-obstacles.json', 1, 503);
		const { data, ui, head, host } = await boot();
		await data.ensureObstacles();
		ui.selectObstacle('at:OB1');
		const pending = host.mountDerived(() => head.detailPending());
		stops.push(pending.stop);
		flushSync();
		expect(pending.value()).toBe('loading');
		await vi.advanceTimersByTimeAsync(5_000);
		await settle();
		flushSync();
		expect(pending.value()).toBeNull();
		expect(data.selectedObstacle()?.name).toBe('MAST');
	});
});

describe('the banner', () => {
	it('names the country from its first retry that did not land it, and goes when it lands', async () => {
		failTimes('/data/at-obstacles.json', 2, 503);
		const { data, host } = await boot();
		await data.ensureObstacles();
		const shown = host.mountDerived(() => retry.bannerEntries());
		stops.push(shown.stop);
		flushSync();
		expect(shown.value()).toBeNull();
		await vi.advanceTimersByTimeAsync(5_000);
		await settle();
		flushSync();
		expect(shown.value()).toEqual([{ group: 'obstacles', parts: ['at'] }]);
		await vi.advanceTimersByTimeAsync(15_000);
		await settle();
		flushSync();
		expect(shown.value()).toBeNull();
	});
});
