/* What the airspace alerts say they are missing (state/airspaceAlert.svelte.ts
 * alertInputGaps), over a served site that fails (tests/helpers/coverageSite.ts).
 *
 * The evaluator grades the SUP AIP zones beside the airspaces (a ZRT, a TRA,
 * a TSA created by supplement), but the "incomplete" caveat read only the
 * airspace dataset's retries: a French supplement file answering a 503 took
 * those zones out of the alerts, and the band read clear over them. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PARIS, failTimes, serveCoverageSite } from './helpers/coverageSite';

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

describe('the airspace alerts', () => {
	it('say the airspace data is incomplete while a SUP AIP publisher is missing', async () => {
		retry = await import('$lib/state/dataRetry.svelte');
		const cov = await import('$lib/state/coverage.svelte');
		const data = await import('$lib/state/data.svelte');
		const alerts = await import('$lib/state/airspaceAlert.svelte');
		alerts.alertPrefs.enabled = true;
		cov.setCoverageViewport(PARIS);
		failTimes('/data/fr-supaip.json', 1, 503);
		await data.ensureAirspaces();
		await data.ensureSupaip();
		expect(alerts.alertInputGaps()?.partial).toBe(true);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(alerts.alertInputGaps()?.partial ?? false).toBe(false);
	});
});
