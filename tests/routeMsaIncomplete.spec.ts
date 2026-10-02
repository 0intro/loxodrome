/* An MSA read without some obstacles says so (state/routeMsa.svelte.ts
 * routeMsaIncomplete), over a served site that fails
 * (tests/helpers/coverageSite.ts).
 *
 * Missing obstacles can only raise an MSA. With a country of the obstacle
 * dataset being read again, the nav log's MSA column and the band's "MSA
 * leg" showed a figure that could be low with nothing beside it: only the
 * terrain alert's caveat said the data was incomplete. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INNSBRUCK, PARIS, failTimes, serve, serveCoverageSite } from './helpers/coverageSite';

let retry: typeof import('$lib/state/dataRetry.svelte');

beforeEach(() => {
	vi.resetModules();
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
	serveCoverageSite();
});

afterEach(() => {
	retry.resetDataRetryForTest();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('the route MSA', () => {
	it('is incomplete while a country of its obstacles near the pilot is being read again', async () => {
		retry = await import('$lib/state/dataRetry.svelte');
		const cov = await import('$lib/state/coverage.svelte');
		const scope = await import('$lib/state/planScope.svelte');
		const data = await import('$lib/state/data.svelte');
		const msa = await import('$lib/state/routeMsa.svelte');
		cov.setCoverageViewport(PARIS);
		scope.planScope.extent = () => [INNSBRUCK];
		failTimes('/data/at-obstacles.json', 1, 503);
		await data.ensureObstacles();
		const inAustria = { waypoints: [{ lat: 47.26, lon: 11.35 }, { lat: 47.4, lon: 11.6 }] };
		expect(msa.routeMsaIncomplete(inAustria, 5)).toBe(true);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(msa.routeMsaIncomplete(inAustria, 5)).toBe(false);
	});

	it("is complete for a route the missing country's obstacles cannot reach", async () => {
		// With the map on Austria and its obstacles failing, a French route's
		// nav log, on screen and on paper, and the band said its MSA was
		// incomplete.
		retry = await import('$lib/state/dataRetry.svelte');
		const cov = await import('$lib/state/coverage.svelte');
		const scope = await import('$lib/state/planScope.svelte');
		const data = await import('$lib/state/data.svelte');
		const msa = await import('$lib/state/routeMsa.svelte');
		cov.setCoverageViewport(INNSBRUCK);
		scope.planScope.extent = () => [PARIS];
		failTimes('/data/at-obstacles.json', 1, 503);
		await data.ensureObstacles();
		expect(retry.dataRetry.pending.map((p) => p.key)).toEqual(['obstacles:at']);
		const inFrance = { waypoints: [{ lat: 48.72, lon: 2.66 }, { lat: 48.59, lon: 2.52 }] };
		const inAustria = { waypoints: [{ lat: 47.26, lon: 11.35 }, { lat: 47.4, lon: 11.6 }] };
		expect(msa.routeMsaIncomplete(inFrance, 5)).toBe(false);
		expect(msa.routeMsaIncomplete(inAustria, 5)).toBe(true);
	});

	it("is judged on the missing country's own envelope within the route's corridor", async () => {
		// Judged on its registry box widened by the coverage gate's 1.5
		// degrees, six times the widest MSA corridor, Germany's obstacles
		// failing made a Paris route read incomplete (the box spans 4 to
		// 17 E), and the band underlined its MSA over Paris. Their envelope
		// begins at 5.8 E: a route coming within 5 NM of it is incomplete, one
		// 200 km off is not.
		retry = await import('$lib/state/dataRetry.svelte');
		const cov = await import('$lib/state/coverage.svelte');
		const data = await import('$lib/state/data.svelte');
		const msa = await import('$lib/state/routeMsa.svelte');
		serve('/data/de-obstacles.meta.json', { effective: '2026-01-01T00:00:00Z', bbox: [5.8, 47.2, 15.0, 55.1] });
		cov.setCoverageViewport({ minLat: 49.9, minLon: 8.4, maxLat: 50.2, maxLon: 8.8 });
		failTimes('/data/de-obstacles.json', 1, 503);
		await data.ensureObstacles();
		expect(retry.dataRetry.pending.map((p) => p.key)).toEqual(['obstacles:de']);
		const paris = { waypoints: [{ lat: 48.72, lon: 2.66 }, { lat: 48.59, lon: 2.52 }] };
		const toTheBorder = { waypoints: [{ lat: 49.2, lon: 5.5 }, { lat: 49.3, lon: 5.72 }] };
		expect(msa.routeMsaIncomplete(paris, 5)).toBe(false);
		expect(msa.routeMsaIncomplete(toTheBorder, 5)).toBe(true);
		expect(msa.routeMsaIncomplete(toTheBorder, 1)).toBe(false);
	});

	it('is incomplete everywhere while the dataset itself is missing', async () => {
		retry = await import('$lib/state/dataRetry.svelte');
		const cov = await import('$lib/state/coverage.svelte');
		const data = await import('$lib/state/data.svelte');
		const msa = await import('$lib/state/routeMsa.svelte');
		cov.setCoverageViewport(PARIS);
		failTimes('/data/fr-obstacles.json', 1, 503);
		await data.ensureObstacles().catch(() => {});
		expect(msa.routeMsaIncomplete({ waypoints: [{ lat: -30, lon: 150 }, { lat: -31, lon: 151 }] }, 5)).toBe(true);
	});
});
