/* A country that arrives LATE reaches what is waiting on it
 * (state/data.svelte.ts, state/referenceData.svelte.ts), in the client
 * runtime where effects and deriveds run (tests/env/webnode.ts).
 *
 * The coverage gate loads a country when something first wants it, and a
 * failed read is now read again later, so rows landing after a dataset's
 * first publish are ordinary. The selection lookups read only the dataset's
 * LOADED flag, which is already true by then: a panel opened on an Italian
 * aerodrome before Italy landed kept the baseline's row, and one opened on
 * an Italian obstacle stayed empty. The aerodrome facilities shared one
 * loaded flag between every publisher, so the second publisher's directory
 * never reached a panel already open. Each now reads a revision bumped on
 * every publish. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AIRPORT_HEADER, FOLIGNO, INNSBRUCK, PARIS, airport, runway, serve, serveCoverageSite } from './helpers/coverageSite';

let flushSync: () => void;
let stops: (() => void)[] = [];

beforeEach(() => {
	vi.resetModules();
	serveCoverageSite();
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
	ui: typeof import('$lib/state/ui.svelte');
	host: typeof import('./helpers/derivedHost.svelte');
}> {
	({ flushSync } = await import('svelte'));
	return {
		cov: await import('$lib/state/coverage.svelte'),
		data: await import('$lib/state/data.svelte'),
		ui: await import('$lib/state/ui.svelte'),
		host: await import('./helpers/derivedHost.svelte'),
	};
}

describe('a selection made before its country lands', () => {
	it('resolves the aerodrome to its own AIP row', async () => {
		const { cov, data, ui, host } = await boot();
		cov.setCoverageViewport(PARIS);
		await data.ensureAirports();
		ui.selectAirport('LIAF');
		const runways = host.mountDerived(() => data.selectedAirport()?.runways.length ?? null);
		stops.push(runways.stop);
		flushSync();
		expect(runways.value()).toBe(1); // the baseline's row
		cov.setCoverageViewport(FOLIGNO);
		await data.extendCoverage();
		flushSync();
		expect(runways.value()).toBe(2); // the Italian AIP's
	});

	it('resolves an obstacle only the late country holds', async () => {
		serve('/data/at-obstacles.json', {
			fields: ['id', 'type', 'name', 'lat', 'lon', 'elev', 'hgt', 'lit', 'group'],
			rows: [['at:OB1', 'mast', 'MAST', 47.26, 11.35, 3500, 300, true, false]],
		});
		const { cov, data, host } = await boot();
		cov.setCoverageViewport(PARIS);
		await data.ensureObstacles();
		const name = host.mountDerived(() => data.obstacleById('at:OB1')?.name ?? null);
		stops.push(name.stop);
		flushSync();
		expect(name.value()).toBeNull();
		cov.setCoverageViewport(INNSBRUCK);
		await data.extendCoverage();
		flushSync();
		expect(name.value()).toBe('MAST');
	});
});

describe('the aerodrome facilities of a second publisher', () => {
	it('reach a lookup already reading them', async () => {
		const rows = (ident: string) => ({
			fields: ['ident', 'site', 'arp', 'hours', 'fireCat', 'services', 'passenger', 'contact', 'directory'],
			itemFields: ['cat', 'text'],
			rows: [[ident, '', '', 'H24', '', [], [], [], []]],
		});
		serve('/data/fr-aerodrome-facilities.json', rows('LFPL'));
		serve('/data/be-aerodrome-facilities.json', rows('EBAD'));
		const { host } = await boot();
		const ref = await import('$lib/state/referenceData.svelte');
		await ref.ensureAerodromeFacilities('fr');
		const hours = host.mountDerived(() => ref.facilitiesForIdent('EBAD', 'be')?.hours ?? null);
		stops.push(hours.stop);
		flushSync();
		expect(hours.value()).toBeNull();
		await ref.ensureAerodromeFacilities('be');
		flushSync();
		expect(hours.value()).toBe('H24');
	});
});

describe('a route memo keyed on a dataset', () => {
	it('re-derives the transition altitude when a late country places a route aerodrome', async () => {
		// The memo keyed on the airports' LOADED flag, already true when Italy
		// landed: a plan into Foligno kept Lognes' 5000 ft after the Italian
		// AIP stated 3000 there, FL display and the transition-layer advisory
		// with it, until the next edit.
		serve('/data/fr-airports.json', { ...AIRPORT_HEADER, rows: [airport('LFPL', 48.7233, 2.6589, [runway('06', '24')], [], 5000)] });
		serve('/data/it-airports.json', {
			...AIRPORT_HEADER,
			rows: [airport('LIAF', 42.9322, 12.7101, [runway('03', '21'), runway('03G', '21G')], [], 3000)],
		});
		const { cov, data, host } = await boot();
		const route = await import('$lib/state/route.svelte');
		const ta = await import('$lib/state/transitionAlt.svelte');
		cov.setCoverageViewport(PARIS);
		await data.ensureAirports();
		route.addWaypointFromSnap({ lat: 48.7233, lon: 2.6589, kind: 'airport', refId: 'LFPL', ident: 'LFPL' });
		route.addWaypointFromSnap({ lat: 42.9322, lon: 12.7101, kind: 'airport', refId: 'LIAF', ident: 'LIAF' });
		const value = host.mountDerived(() => ta.autoTransitionAlt().valueFt);
		stops.push(value.stop);
		flushSync();
		expect(value.value()).toBe(5000);
		cov.setCoverageViewport(FOLIGNO);
		await data.extendCoverage();
		flushSync();
		expect(data.airportByIdent('LIAF')?.transitionAltFt).toBe(3000);
		expect(value.value()).toBe(3000);
	});
});
