/* The retry banner names what is missing in the reading language: a chart
 * index that is no publisher (a held State's, Denmark's) by its region, as
 * the About dialog names it. The wording is describeMissing's, pinned in
 * tests/dataRetryText.spec.ts; what is pinned here is the component handing
 * it the region names at all. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';

afterEach(async () => {
	(await import('$lib/state/dataRetry.svelte')).resetDataRetryForTest();
	vi.restoreAllMocks();
});

describe('the data retry banner', () => {
	it('names a chart index by its region, in the reading language', async () => {
		const r = await import('$lib/state/dataRetry.svelte');
		const { i18n } = await import('$lib/state/i18n.svelte');
		const Banner = (await import('$lib/components/DataRetryBanner.svelte')).default;
		// A fact, announced at once.
		r.retryParts('charts', [{ part: 'dk', error: new Error('does not parse'), wanted: true }], () => new Promise(() => {}));
		i18n.locale = 'en';
		expect(render(Banner).body).toContain('Denmark');
		i18n.locale = 'fr';
		expect(render(Banner).body).toContain('Danemark');
		i18n.locale = 'en';
	});
});
