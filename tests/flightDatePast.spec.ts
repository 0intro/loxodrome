/* A flight date already behind us (state/flightPrep.svelte.ts
 * isPastFlightDate, components/flightprep/chartsPrefetch.ts pastFlight).
 *
 * A dossier carries its date from one flight to the next: kept in storage,
 * or brought back by activating a stored plan. Behind us, it puts every timed
 * read on a flight already flown (the forecast winds, the sun, the night
 * reserve, the TEMSI / WINTEM window), and the charts went missing from the
 * print with no word said. So the catalog's Activate leaves such a date out
 * (a plan flown again is a new flight; the ETD stays, being a time of day),
 * every other load keeps it (a file is what it says, and a flight loaded back
 * from the logbook keeps the day it was flown), and the print hosts hold on
 * it: pastFlight is the one rule they share.
 *
 * Each case builds a fresh module graph over a fresh fake IndexedDB, the
 * tests/planStore.spec.ts harness; the clock is faked, Date alone. */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { isPastFlightDate } from '$lib/state/flightPrep.svelte';

const at = (day: number, h: number, m = 0): number => Date.UTC(2026, 9, day, h, m);
const NOW = at(2, 10);

/** A two-leg plan of free points, so no dataset has to resolve anything,
 *  with a dossier block dated `date` (and `extra` flight_prep lines). */
function plan(date: string | null, extra: readonly string[] = []): string {
	return [
		'version: 1',
		'routes:',
		'  - waypoints:',
		'      - name: ALPHA',
		'        lat: 48.5',
		'        lon: 2.5',
		'      - name: BRAVO',
		'        lat: 49',
		'        lon: 3',
		'flight_prep:',
		'  dossier:',
		...(date ? [`    flight_date: '${date}'`] : []),
		"    departure_time: '09:30'",
		...extra,
		'',
	].join('\n');
}

let store: Map<string, string>;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
	store = new Map<string, string>();
	globalThis.indexedDB = new IDBFactory();
	vi.stubGlobal('localStorage', {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	});
	vi.stubGlobal('location', { search: '' });
	vi.resetModules();
	// loadRoutesFromYaml waits for the aircraft library (a plan naming a
	// library plane must not find the fleet empty); none is served here, so
	// it loads empty rather than reading the network.
	vi.doMock('$lib/data/aircraft', async () => {
		const actual = await vi.importActual<typeof import('$lib/data/aircraft')>('$lib/data/aircraft');
		return { ...actual, loadCommittedAircraft: () => Promise.resolve([]) };
	});
	vi.doMock('$lib/state/data.svelte', async () => {
		const actual =
			await vi.importActual<typeof import('$lib/state/data.svelte')>('$lib/state/data.svelte');
		return { ...actual, ensureAirports: () => Promise.resolve([]), ensureNavaids: () => Promise.resolve([]) };
	});
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.doUnmock('$lib/state/data.svelte');
	vi.doUnmock('$lib/data/aircraft');
});

async function mods(): Promise<{
	active: typeof import('$lib/state/activePlan.svelte');
	load: typeof import('$lib/state/routeLoad.svelte');
	prep: typeof import('$lib/state/flightPrep.svelte');
	db: typeof import('$lib/state/flightsDb');
	charts: typeof import('$lib/components/flightprep/chartsPrefetch');
}> {
	return {
		active: await import('$lib/state/activePlan.svelte'),
		load: await import('$lib/state/routeLoad.svelte'),
		prep: await import('$lib/state/flightPrep.svelte'),
		db: await import('$lib/state/flightsDb'),
		charts: await import('$lib/components/flightprep/chartsPrefetch'),
	};
}

describe('isPastFlightDate', () => {
	it('is the UTC day before the present one, and nothing else', () => {
		expect(isPastFlightDate('2026-10-01', NOW)).toBe(true);
		expect(isPastFlightDate('2025-12-31', NOW)).toBe(true);
		expect(isPastFlightDate('2026-10-02', NOW)).toBe(false);
		expect(isPastFlightDate('2026-10-03', NOW)).toBe(false);
		expect(isPastFlightDate(null, NOW)).toBe(false);
		expect(isPastFlightDate('', NOW)).toBe(false);
	});

	it('turns at midnight UTC, whatever the local clock says', () => {
		expect(isPastFlightDate('2026-10-01', at(1, 23, 59))).toBe(false);
		expect(isPastFlightDate('2026-10-01', at(2, 0, 0))).toBe(true);
	});
});

describe('activating a stored plan', () => {
	it('leaves a date already behind us out, keeps the ETD, and says so', async () => {
		const { active, load, prep, db } = await mods();
		await db.putStoredPlan({ id: 'p1', yaml: plan('2026-09-28'), savedAtMs: 1000 });
		expect(
			await load.loadRoutesFromYaml(
				plan('2026-09-28'),
				{ id: 'p1', savedAtMs: 1000 },
				{ dropPastFlightDate: true },
			),
		).toBe(true);
		expect(prep.flightPrep.dossier.flightDate).toBeNull();
		expect(prep.dossierFlightDate()).toBe('2026-10-02');
		expect(prep.flightPrep.dossier.departureTime).toBe('09:30');
		expect(load.routeLoad.notice?.pastFlightDate).toBe('2026-09-28');
		// The copy as activated, not an edit: no unstored-changes dot, and no
		// Store either, since a stored past date is left out by every Activate
		// and storing the copy back changes nothing an Activate reads.
		expect(active.activePlanDirty()).toBe(false);
		expect(active.canStorePlan()).toBe(false);
	});

	it('keeps a date still ahead, and today', async () => {
		const { load, prep } = await mods();
		for (const date of ['2026-10-02', '2026-10-09']) {
			await load.loadRoutesFromYaml(plan(date), { id: 'p1', savedAtMs: 1000 }, { dropPastFlightDate: true });
			expect(prep.flightPrep.dossier.flightDate).toBe(date);
			expect(load.routeLoad.notice?.pastFlightDate).toBeNull();
		}
	});

	it('keeps the date for every other load: a file, a flight loaded back with its plan', async () => {
		const { load, prep } = await mods();
		await load.loadRoutesFromYaml(plan('2026-09-28'));
		expect(prep.flightPrep.dossier.flightDate).toBe('2026-09-28');
		await load.loadRoutesFromYaml(plan('2026-09-27'), { id: 'p1', savedAtMs: 1000 });
		expect(prep.flightPrep.dossier.flightDate).toBe('2026-09-27');
		expect(load.routeLoad.notice?.pastFlightDate).toBeNull();
	});
});

/* The fuel on board read for the flight a plan was stored for
 * (aircraft/onBoard.ts) goes the same way as its date: what the tanks held
 * then is not what they hold now. */
describe('the fuel on board read for a stored plan', () => {
	const READING = [
		'  mass_balance:',
		'    fuel_mode: full',
		'    refuel: false',
		'    on_board:',
		'      aircraft: F-GORQ',
		"      read_on: '2026-10-01'",
		'      last_refuel: full',
		'      flights:',
		"        - time: '00:45'",
	];

	it('is left out on Activate, the departure refuelled again, and said', async () => {
		const { active, load, prep, db } = await mods();
		const yaml = plan('2026-10-02', READING);
		await db.putStoredPlan({ id: 'p1', yaml, savedAtMs: 1000 });
		expect(
			await load.loadRoutesFromYaml(
				yaml,
				{ id: 'p1', savedAtMs: 1000 },
				{ dropPastFlightDate: true, dropOnBoard: true },
			),
		).toBe(true);
		expect(prep.flightPrep.mb.onBoard).toBeNull();
		expect(prep.flightPrep.mb.refuel).toBe(true);
		expect(load.routeLoad.notice?.onBoardDropped).toBe('2026-10-01');
		expect(load.routeLoad.notice?.pastFlightDate).toBeNull();
		// The copy as activated: no unstored-changes dot, and no Store.
		expect(active.activePlanDirty()).toBe(false);
		expect(active.canStorePlan()).toBe(false);
	});

	it('is kept by a file and by a flight loaded back with its plan', async () => {
		const { load, prep } = await mods();
		const yaml = plan('2026-10-02', READING);
		await load.loadRoutesFromYaml(yaml);
		expect(prep.flightPrep.mb.refuel).toBe(false);
		expect(prep.flightPrep.mb.onBoard).toMatchObject({
			aircraft: 'F-GORQ',
			readOn: '2026-10-01',
			last: { kind: 'full' },
			flights: [{ min: 45, addedL: null }],
		});
		expect(load.routeLoad.notice?.onBoardDropped).toBeNull();
		await load.loadRoutesFromYaml(yaml, { id: 'p1', savedAtMs: 1000 });
		expect(prep.flightPrep.mb.onBoard).not.toBeNull();
		expect(load.routeLoad.notice?.onBoardDropped).toBeNull();
	});
});

describe('pastFlight, the rule both print hosts hold on', () => {
	it('answers from the date alone: the stated ETD on it, else the day', async () => {
		const { prep, charts } = await mods();
		prep.flightPrep.dossier.flightDate = '2026-09-28';
		prep.flightPrep.dossier.departureTime = '09:30';
		expect(charts.pastFlight(NOW)).toEqual({ startMs: Date.UTC(2026, 8, 28, 9, 30), dayOnly: false });
		prep.flightPrep.dossier.departureTime = null;
		expect(charts.pastFlight(NOW)).toEqual({ startMs: Date.UTC(2026, 8, 28), dayOnly: true });
	});

	it('never holds a flight dated today or later with no time to end it', async () => {
		const { prep, charts } = await mods();
		for (const date of [null, '2026-10-02', '2026-10-05']) {
			prep.flightPrep.dossier.flightDate = date;
			prep.flightPrep.dossier.departureTime = null;
			expect(charts.pastFlight(NOW), String(date)).toBeNull();
		}
	});

	it('holds a flight dated today once its timeline has landed', async () => {
		const { load, prep, charts } = await mods();
		const aircraft = await import('$lib/state/aircraft.svelte');
		const { parseAircraftYaml } = await import('$lib/aircraft/schema');
		aircraft.importUserAircraft(
			parseAircraftYaml(readFileSync(new URL('../public/data/aircraft/f-gorq.yaml', import.meta.url), 'utf8')),
		);
		await load.loadRoutesFromYaml(plan(null));
		prep.flightPrep.dossier.departureTime = '08:00';
		// The timeline resolved (the fallback would start at the current hour).
		const { startMs, endMs } = charts.chartWindowMs();
		expect(startMs).toBe(at(2, 8));
		expect(endMs).toBeGreaterThan(startMs);
		expect(charts.pastFlight(endMs - 1)).toBeNull();
		expect(charts.pastFlight(endMs)).toEqual({ startMs, dayOnly: false });
	});
});

/* The weather typed for the flight a plan was stored for goes the same way:
 * that day's winds, QNH and temperatures are not today's. Its legs' own
 * winds, its manual wind (the source back on Forecast), the performance
 * page's typed weather and its QNH where nothing is observed; the runway
 * picked stays. */
describe('the weather typed for a stored plan', () => {
	const typed = (): string =>
		[
			'version: 1',
			'settings:',
			'  vfr: true',
			'  semi_circular: true',
			'  wind_dir: 250',
			'  wind_speed: 25',
			'  wind_forecast: false',
			'  temperature_tas: false',
			'routes:',
			'  - waypoints:',
			'      - name: ALPHA',
			'        lat: 48.5',
			'        lon: 2.5',
			'        leg: { altitude: 2500, auto: false, wind_dir: 100, wind_speed: 12 }',
			'      - name: BRAVO',
			'        lat: 49',
			'        lon: 3',
			'flight_prep:',
			'  dossier:',
			"    flight_date: '2026-10-02'",
			"    departure_time: '09:30'",
			'    qnh: 1019',
			'  performance:',
			'    aerodromes:',
			'    - icao: LFPL',
			'      qnh: 1021',
			'      takeoff: { temperature: 15, headwind: 5, wet: true, runway: "26" }',
			'      landing: { qnh: 1016, runway: "26" }',
			'',
		].join('\n');

	it('is left out on Activate, the runway kept, and said', async () => {
		const { active, load, prep, db } = await mods();
		const route = await import('$lib/state/route.svelte');
		const wind = await import('$lib/state/windAloft.svelte');
		const yaml = typed();
		await db.putStoredPlan({ id: 'p1', yaml, savedAtMs: 1000 });
		expect(
			await load.loadRoutesFromYaml(
				yaml,
				{ id: 'p1', savedAtMs: 1000 },
				{ dropPastFlightDate: true, dropOnBoard: true, dropTypedWeather: true },
			),
		).toBe(true);
		const wp = route.routes.list[0]?.waypoints[0];
		expect([wp?.windDirDeg, wp?.windSpeedKt]).toEqual([undefined, undefined]);
		expect([route.routeSettings.windDirDeg, route.routeSettings.windSpeedKt]).toEqual([null, null]);
		expect(wind.windAloft.useForecastForLegs).toBe(true);
		expect(prep.flightPrep.dossier.qnhHpa).toBeNull();
		expect(prep.flightPrep.perf.byIcao.LFPL?.takeoff).toEqual({
			qnhHpa: null,
			tempC: null,
			headwindKt: null,
			tailwindKt: null,
			wet: false,
			runwayEnd: '26',
		});
		expect(prep.flightPrep.perf.byIcao.LFPL?.landing.runwayEnd).toBe('26');
		expect(load.routeLoad.notice?.weatherDropped).toBe(true);
		// The copy as activated, not an edit.
		expect(active.activePlanDirty()).toBe(false);
	});

	it('is kept by a file and by a flight loaded back with its plan', async () => {
		const { load, prep } = await mods();
		const route = await import('$lib/state/route.svelte');
		await load.loadRoutesFromYaml(typed());
		expect([route.routeSettings.windDirDeg, route.routeSettings.windSpeedKt]).toEqual([250, 25]);
		expect(route.routes.list[0]?.waypoints[0]?.windDirDeg).toBe(100);
		expect(prep.flightPrep.dossier.qnhHpa).toBe(1019);
		expect(prep.flightPrep.perf.byIcao.LFPL?.takeoff.tempC).toBe(15);
		expect(load.routeLoad.notice?.weatherDropped).toBe(false);
		await load.loadRoutesFromYaml(typed(), { id: 'p1', savedAtMs: 1000 });
		expect(prep.flightPrep.perf.byIcao.LFPL?.takeoff.headwindKt).toBe(5);
		expect(load.routeLoad.notice?.weatherDropped).toBe(false);
	});

	it('says nothing when the plan held none', async () => {
		const { load } = await mods();
		await load.loadRoutesFromYaml(plan('2026-10-02'), { id: 'p1', savedAtMs: 1000 }, { dropTypedWeather: true });
		expect(load.routeLoad.notice?.weatherDropped).toBe(false);
	});
});
