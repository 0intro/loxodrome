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
 *  with a dossier block dated `date`. */
function plan(date: string | null): string {
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
