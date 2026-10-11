/* The coverage gate widening what is loaded (state/data.svelte.ts,
 * extendCoverage), over a served site (tests/helpers/coverageSite.ts).
 *
 * A dataset's first load judges the gate once. The widening used to skip a
 * dataset whose first load was still running, so an area that moved during
 * it (the map settling on a restored view, a briefing landing) was lost
 * until the next move; it now waits behind that load. The plan's own areas
 * reach the gate beside the viewport, each as its own rectangle, and the
 * FAA airspace overlay is fetched once however many widenings ask.
 *
 * Real modules, a fresh graph per case; no effect runs in this project, so
 * each case calls extendCoverage where the watcher would. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	FOLIGNO,
	INNSBRUCK,
	KANSAS,
	PARIS,
	asked,
	drain,
	fetched,
	hold,
	serveCoverageSite,
	until,
} from './helpers/coverageSite';

beforeEach(() => {
	vi.resetModules();
	serveCoverageSite();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

async function mods(): Promise<{
	cov: typeof import('$lib/state/coverage.svelte');
	data: typeof import('$lib/state/data.svelte');
	scope: typeof import('$lib/state/planScope.svelte');
}> {
	return {
		cov: await import('$lib/state/coverage.svelte'),
		data: await import('$lib/state/data.svelte'),
		scope: await import('$lib/state/planScope.svelte'),
	};
}

describe('a first load still running', () => {
	it('is waited for when the area moves, and the new country loads once', async () => {
		const { cov, data } = await mods();
		cov.setCoverageViewport(PARIS);
		const release = hold('/data/fr-airports.json');
		const first = data.ensureAirports();
		// The gate has been judged over Paris once the French file is asked.
		await until(() => asked.includes('/data/fr-airports.json'));
		cov.setCoverageViewport(FOLIGNO);
		const widened = data.extendCoverage();
		release();
		await first;
		await widened;
		expect(fetched('/data/it-airports.json')).toBe(1);
		expect(data.airportByIdent('LIAF')?.runways).toHaveLength(2);
	});

	it('is waited for when a briefing forces a publisher in', async () => {
		const { cov, data } = await mods();
		cov.setCoverageViewport(PARIS);
		const release = hold('/data/fr-airports.json');
		const first = data.ensureAirports();
		await until(() => asked.includes('/data/fr-airports.json'));
		cov.setForcedPublishers(['it']);
		const widened = data.extendCoverage();
		release();
		await first;
		await widened;
		expect(fetched('/data/it-airports.json')).toBe(1);
	});

	it.each([
		['airspaces', 'ensureAirspaces', '/data/fr-airspaces.json', '/data/it-airspaces.json', FOLIGNO],
		['obstacles', 'ensureObstacles', '/data/fr-obstacles.json', '/data/at-obstacles.json', INNSBRUCK],
		['navaids', 'ensureNavaids', '/data/fr-navaids.json', '/data/it-navaids.json', FOLIGNO],
		['nature', 'ensureNature', '/data/fr-nature.json', '/data/it-nature.json', FOLIGNO],
	] as const)('is waited for over the %s too', async (_kind, ensure, held, target, area) => {
		const { cov, data } = await mods();
		cov.setCoverageViewport(PARIS);
		const release = hold(held);
		const first = data[ensure]();
		await until(() => asked.includes(held));
		cov.setCoverageViewport(area);
		const widened = data.extendCoverage();
		release();
		await first;
		await widened;
		expect(fetched(target)).toBe(1);
	});
});

describe('the widening', () => {
	it('starts no load nothing asked for', async () => {
		const { cov, data } = await mods();
		cov.setCoverageViewport(PARIS);
		await data.extendCoverage();
		await drain();
		expect(asked).toEqual([]);
	});

	it('asks for the FAA airspace overlay once, however many widenings run', async () => {
		const { cov, data } = await mods();
		cov.setCoverageViewport(PARIS);
		await data.ensureAirspaces();
		expect(fetched('/data/faa-airspaces.json')).toBe(0);
		cov.setCoverageViewport(KANSAS);
		await Promise.all([data.extendCoverage(), data.extendCoverage()]);
		expect(fetched('/data/faa-airspaces.json')).toBe(1);
	});

	it('publishes a country it read without waiting for the FAA overlay', async () => {
		// The widening published once every part had answered, so Italy,
		// read in a moment, waited for the four megabytes of the FAA overlay
		// the same widening had started.
		const { cov, data, scope } = await mods();
		cov.setCoverageViewport(PARIS);
		await data.ensureAirspaces();
		const rev = data.dataState.revision.airspaces;
		const release = hold('/data/faa-airspaces.json');
		cov.setCoverageViewport(FOLIGNO);
		scope.planScope.extent = () => [KANSAS];
		const widened = data.extendCoverage();
		await until(() => asked.includes('/data/faa-airspaces.json') && asked.includes('/data/it-airspaces.json'));
		await until(() => data.dataState.revision.airspaces > rev);
		release();
		await widened;
		expect(fetched('/data/faa-airspaces.json')).toBe(1);
	});

	it("loads the plan's country under a view of another", async () => {
		const { cov, data, scope } = await mods();
		cov.setCoverageViewport(FOLIGNO);
		await data.ensureAirports();
		expect(fetched('/data/fr-airports.json')).toBe(0);
		scope.planScope.extent = () => [PARIS];
		await data.extendCoverage();
		expect(fetched('/data/fr-airports.json')).toBe(1);
		expect(data.airportByIdent('LFPL')?.radios.map((r) => r.freq)).toEqual(['118.605']);

		// An edit that moves no rectangle (an altitude) asks for nothing.
		const before = asked.length;
		scope.planScope.extent = () => [{ ...PARIS }];
		await data.extendCoverage();
		expect(asked.length).toBe(before);
	});

	it('tests each area apart: a French view and an Italian aerodrome load no Austria', async () => {
		const { cov, data, scope } = await mods();
		cov.setCoverageViewport(PARIS);
		scope.planScope.extent = () => [{ minLat: 42.93, minLon: 12.71, maxLat: 42.93, maxLon: 12.71 }];
		await data.ensureAirports();
		expect(fetched('/data/fr-airports.json')).toBe(1);
		expect(fetched('/data/it-airports.json')).toBe(1);
		expect(fetched('/data/at-airports.json')).toBe(0);
	});
});

describe('the performance page', () => {
	it("brings in an added aerodrome's country, and its own AIP's runways", async () => {
		const { cov, data } = await mods();
		const { installFlightScope } = await import('$lib/state/flightScope');
		const { addManualAerodrome } = await import('$lib/state/flightPrep.svelte');
		installFlightScope();
		cov.setCoverageViewport(PARIS);
		await data.ensureAirports();
		expect(data.airportByIdent('LIAF')?.runways).toHaveLength(1);
		addManualAerodrome('LIAF');
		await data.extendCoverage();
		expect(fetched('/data/it-airports.json')).toBe(1);
		expect(data.airportByIdent('LIAF')?.runways).toHaveLength(2);
	});
});

describe('a flight', () => {
	it('brings in the country the aircraft is over, wherever the map and the plan are', async () => {
		// A diversion flown out of the plan with the map panned away left the
		// alerts without the country under the aircraft.
		const { cov, data } = await mods();
		const { installFlightScope } = await import('$lib/state/flightScope');
		const rec = await import('$lib/state/navRecording.svelte');
		installFlightScope();
		cov.setCoverageViewport(PARIS);
		await data.ensureAirspaces();
		expect(fetched('/data/it-airspaces.json')).toBe(0);
		rec.nav.recording = true;
		rec.nav.lastFix = { lat: 42.9, lon: 12.7, altFt: 3000, timeMs: 0, speedKt: 100, trackDeg: 90, accuracyM: 5 };
		await data.extendCoverage();
		expect(fetched('/data/it-airspaces.json')).toBe(1);
		// The position is snapped: a fix a few hundred metres on moves no area.
		const stamp = cov.coverageStamp();
		rec.nav.lastFix = { ...rec.nav.lastFix, lat: 42.93, lon: 12.73 };
		expect(cov.coverageStamp()).toBe(stamp);
		rec.nav.recording = false;
	});
});
