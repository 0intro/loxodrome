/* The coverage watcher (state/data.svelte.ts, watchCoverage) in a real host
 * effect (tests/env/webnode.ts), over a served site
 * (tests/helpers/coverageSite.ts).
 *
 * The plan's areas reached the gate only through the map's move handler, so
 * a plan changed or restored under a still map loaded nothing until the map
 * moved: a boot onto a view of Italy with a French plan in store left LFPL
 * the baseline's row, with no tower. The watcher now wakes on the areas
 * themselves, and an aerodrome a late merge replaces re-renders where it is
 * read. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { FOLIGNO, PARIS, asked, fetched, hold, serveCoverageSite, until } from './helpers/coverageSite';

let stops: (() => void)[] = [];
let store: Map<string, string>;
/** The graph's own flushSync: vi.resetModules gives each case a fresh Svelte
 *  runtime, and a flushSync imported statically flushes another one. */
let flushSync: () => void;

beforeEach(() => {
	vi.resetModules();
	serveCoverageSite();
	store = new Map<string, string>();
	globalThis.indexedDB = new IDBFactory();
	vi.stubGlobal('localStorage', {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	});
	vi.stubGlobal('location', { search: '' });
	stops = [];
});

afterEach(() => {
	for (const stop of stops) {
		stop();
	}
	vi.unstubAllGlobals();
});

async function boot(): Promise<{
	cov: typeof import('$lib/state/coverage.svelte');
	data: typeof import('$lib/state/data.svelte');
	host: typeof import('./helpers/coverageWatchHost.svelte');
}> {
	({ flushSync } = await import('svelte'));
	const { installFlightScope } = await import('$lib/state/flightScope');
	installFlightScope();
	const host = await import('./helpers/coverageWatchHost.svelte');
	stops.push(host.mountCoverageWatch());
	return {
		cov: await import('$lib/state/coverage.svelte'),
		data: await import('$lib/state/data.svelte'),
		host,
	};
}

describe('the coverage watcher', () => {
	it("loads a route's country when the route changes, the map not moving", async () => {
		const { cov, data } = await boot();
		const route = await import('$lib/state/route.svelte');
		cov.setCoverageViewport(FOLIGNO);
		flushSync();
		await data.ensureAirports();
		expect(fetched('/data/fr-airports.json')).toBe(0);
		route.addWaypoint(48.72, 2.66);
		route.addWaypoint(48.9, 2.5);
		flushSync();
		await until(() => fetched('/data/fr-airports.json') === 1);
		await until(() => data.airportByIdent('LFPL')?.radios.length === 1);
	});

	it('loads the area a map moved to while the first load ran', async () => {
		const { cov, data } = await boot();
		cov.setCoverageViewport(PARIS);
		flushSync();
		const release = hold('/data/fr-airports.json');
		const first = data.ensureAirports();
		await until(() => asked.includes('/data/fr-airports.json'));
		cov.setCoverageViewport(FOLIGNO);
		flushSync();
		release();
		await first;
		await until(() => fetched('/data/it-airports.json') === 1);
	});

	it('re-renders an aerodrome the performance page reads when its country arrives', async () => {
		const { cov, data, host } = await boot();
		const { addManualAerodrome } = await import('$lib/state/flightPrep.svelte');
		cov.setCoverageViewport(PARIS);
		flushSync();
		await data.ensureAirports();
		const liaf = host.mountRunwayCount('LIAF');
		stops.push(liaf.stop);
		flushSync();
		expect(liaf.value()).toBe(1);
		addManualAerodrome('LIAF');
		flushSync();
		await until(() => {
			flushSync();
			return liaf.value() === 2;
		});
		expect(fetched('/data/it-airports.json')).toBe(1);
	});

	it('loads a stored plan\'s country when the boot restores it under a view of Italy', async () => {
		store.set(
			'loxodrome:routes',
			JSON.stringify({
				v: 1,
				activeIndex: 0,
				settings: {},
				yaml: [
					'version: 1',
					'routes:',
					'  - waypoints:',
					'      - ident: LFPL',
					'      - name: MELUN',
					'        lat: 48.61',
					'        lon: 2.67',
					'',
				].join('\n'),
				source: null,
			}),
		);
		const { cov, data } = await boot();
		const persist = await import('$lib/state/routePersist');
		cov.setCoverageViewport(FOLIGNO);
		flushSync();
		await persist.restoreRoutes();
		flushSync();
		await until(() => fetched('/data/fr-airports.json') === 1);
		await until(() => data.airportByIdent('LFPL')?.radios[0]?.freq === '118.605');
		persist.flushRoutesPersist();
	});
});
