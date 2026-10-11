/* The flights import waits for the reads it asks for.
 *
 * An import is a gesture, so every dataset read waiting for its retry is asked
 * again then and awaited, the plans resolving against what landed. The ensures
 * were called BEFORE the retry was asked, though: a first load waiting for its
 * retry refused at once, the wait gave up on that refusal, and the import went
 * on while the retry it had just started was still reading. A plan whose points
 * are all identifiers then resolved nothing, was left out of the catalog and
 * reported as unusable. The account's "download a copy" comes back in through
 * the same import. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { fail, fetched, hold, serveCoverageSite, settle, untilReal } from './helpers/coverageSite';

// The importer asks the Open-with dispatcher for a trace's altitude
// reference, and that module draws on the map; no trace rides here.
vi.mock('$lib/state/openFile.svelte', () => ({
	askTraceDatum: (): Promise<null> => Promise.resolve(null),
}));

/** A plan of two aerodromes named by their identifiers alone. */
const PLAN = ['version: 1', 'routes:', '  - waypoints:', '      - ident: LFPL', '      - ident: LIAF', ''].join('\n');

let store: Map<string, string>;

beforeEach(() => {
	store = new Map<string, string>();
	globalThis.indexedDB = new IDBFactory();
	vi.stubGlobal('localStorage', {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	});
	vi.stubGlobal('location', { search: '' });
	vi.resetModules();
	serveCoverageSite();
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
	const retry = await import('$lib/state/dataRetry.svelte');
	retry.resetDataRetryForTest();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('a flights import while the airports wait for their retry', () => {
	it('waits for the read it asks for, and files the plan', async () => {
		const data = await import('$lib/state/data.svelte');
		const { flightImport, runImportTexts } = await import('$lib/state/flightImport.svelte');
		const { getStoredPlans } = await import('$lib/state/flightsDb');
		// The first load fails: the airports now wait for their retry.
		fail('/data/airports.json', 503);
		await data.ensureAirports().catch(() => {});
		expect(fetched('/data/airports.json')).toBe(1);
		// The retry the import asks for is held mid-read.
		const release = hold('/data/airports.json');
		const run = runImportTexts([{ name: 'plan.yaml', text: PLAN }]);
		await untilReal(() => fetched('/data/airports.json') === 2);
		await settle(200);
		// Still importing: the plan waits for the aerodromes it names.
		expect(flightImport.running).toBe(true);
		release();
		await run;
		expect(flightImport.notices.map((n) => n.code)).not.toContain('planUnusable');
		const plans = await getStoredPlans();
		expect(plans).toHaveLength(1);
	});
});
