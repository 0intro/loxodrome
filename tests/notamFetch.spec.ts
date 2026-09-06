/* The NOTAM fetch view's two invariants, one per bug they were written for.
 *
 * 1. One briefing at a time, whichever source: the three fetch entry points
 *    (viewport, route via autorouter, route via SOFIA) all commit through
 *    notamState.rawText, so notamFetchBusy() makes them decline for each
 *    other, and a declined call leaves the running fetch's report alone.
 * 2. The status says WHICH fetch it describes: autorouter.lastKind for the two
 *    autorouter buttons (their errors share one record), and the briefing's own
 *    notamState.lastFetch for the summary, which a paste must not inherit.
 *
 * No network: every case below returns at a pre-flight guard, before the first
 * await. persist.ts swallows the missing localStorage, so importing the state
 * modules under node is a no-op. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fetchNotamsForRoute, fetchNotamsForViewport } from '$lib/autorouter/fetch';
import { autorouter } from '$lib/autorouter/state.svelte';
import { fetchRouteNotamsFromSofia } from '$lib/sofia/fetch';
import { sofia } from '$lib/sofia/state.svelte';
import { notamState, parseInput } from '$lib/state/notam.svelte';
import { notamFetchBusy } from '$lib/state/notamSource.svelte';

const proxyUrl = autorouter.proxyUrl;

function idle(): void {
	autorouter.fetching = null;
	autorouter.error = null;
	autorouter.lastKind = null;
	sofia.fetching = false;
	sofia.error = null;
	notamState.lastFetch = null;
	notamState.rawText = '';
}

beforeEach(idle);
afterEach(() => {
	idle();
	autorouter.proxyUrl = proxyUrl;
});

describe('notamFetchBusy', () => {
	it('is false at rest and true for a fetch of any source', () => {
		expect(notamFetchBusy()).toBe(false);

		autorouter.fetching = 'viewport';
		expect(notamFetchBusy()).toBe(true);

		autorouter.fetching = 'route';
		expect(notamFetchBusy()).toBe(true);

		autorouter.fetching = null;
		sofia.fetching = true;
		expect(notamFetchBusy()).toBe(true);
	});
});

describe('a fetch declines while another runs', () => {
	it('declines across sources, leaving the running fetch its status', async () => {
		sofia.fetching = true;
		await fetchNotamsForViewport();
		expect(autorouter.fetching).toBeNull();
		expect(autorouter.error).toBeNull();
		expect(autorouter.lastKind).toBeNull();
	});

	it('declines within the source', async () => {
		autorouter.fetching = 'route';
		await fetchNotamsForViewport();
		expect(autorouter.lastKind).toBeNull();
		expect(autorouter.error).toBeNull();
	});

	it('declines a SOFIA briefing while an autorouter fetch runs', async () => {
		autorouter.fetching = 'viewport';
		await fetchRouteNotamsFromSofia();
		expect(sofia.fetching).toBe(false);
		expect(sofia.error).toBeNull();
	});
});

describe('the autorouter status carries the kind that raised it', () => {
	it('stamps the kind even when a pre-flight guard fails before fetching', async () => {
		// No proxy: both fetches report before ever setting `fetching`, which
		// is why lastKind is stamped above the guards rather than beside it.
		autorouter.proxyUrl = '';

		await fetchNotamsForViewport();
		expect(autorouter.lastKind).toBe('viewport');
		expect(autorouter.error).not.toBeNull();
		expect(autorouter.fetching).toBeNull();

		await fetchNotamsForRoute();
		expect(autorouter.lastKind).toBe('route');
		expect(autorouter.fetching).toBeNull();
	});
});

describe('the fetch provenance belongs to the briefing', () => {
	it('is dropped by a fresh parse and kept by a reparse', () => {
		const landed = {
			source: 'sofia',
			kind: 'route',
			at: 1_700_000_000_000,
			count: 12,
			briefed: { from: 1_700_000_000_000, to: 1_700_086_340_000 },
		} as const;

		notamState.lastFetch = { ...landed };
		parseInput();
		expect(notamState.lastFetch).toBeNull();

		notamState.lastFetch = { ...landed };
		parseInput({ reparse: true });
		expect(notamState.lastFetch).toEqual(landed);
	});
});
