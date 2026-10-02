/* The map lattice's requests (state/windAloft.svelte.ts ensureWindGrid,
 * docs/wind-aloft.md "Map lattice and the request budget"): a cell is asked
 * for once per model run that covers it, holds a day of hours so the shown
 * hour rolling over asks for nothing, is never asked twice while a request
 * for it is out, and stays drawn through a failed refresh. Only Date is
 * faked; every ensure is handed its own `nowMs`. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/weather/openMeteo', async (orig) =>
	(await import('./helpers/fakeOpenMeteo')).withFakeColumns(await orig()),
);

import { fake } from './helpers/fakeOpenMeteo';
import { display } from '$lib/state/display.svelte';
import {
	ensureModelRun,
	ensureWindGrid,
	resetWindAloftForTest,
	windAloft,
	windGrid,
	windGridBarbs,
	type GridView,
} from '$lib/state/windAloft.svelte';

const MIN = 60_000;
const HOUR = 60 * MIN;
/** 09:40Z, an AROME run of 06Z known. */
const T0 = Date.UTC(2026, 9, 2, 9, 40);
const RUN = Date.UTC(2026, 9, 2, 6);
const AROME = [37.5, -12, 55.4, 16] as const;
const ARPEGE = [20, -32, 72, 42] as const;

/** A view `widthDeg` wide on a 1000 px map, centred on (lat, lon). */
function view(lat: number, lon: number, widthDeg: number): GridView {
	return {
		west: lon - widthDeg / 2,
		east: lon + widthDeg / 2,
		south: lat - widthDeg / 3,
		north: lat + widthDeg / 3,
		degPerPx: widthDeg / 1000,
		centerLat: lat,
		centerLon: lon,
	};
}

/** Every microtask of a request or a poll has run by the next macrotask. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function knownRun(model: Parameters<typeof ensureModelRun>[0], nowMs: number): Promise<void> {
	ensureModelRun(model, nowMs);
	await settle();
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(T0);
	fake.reset();
	resetWindAloftForTest();
	display.liveWeather = true;
	windAloft.showOnMap = true;
	windAloft.levelFt = 2500;
	windAloft.model = 'auto';
	windAloft.isotherm0 = false;
	windAloft.isobars = false;
	windAloft.animAnchorMs = null;
});

afterEach(() => {
	resetWindAloftForTest();
	vi.useRealTimers();
	windAloft.showOnMap = false;
	windAloft.model = 'auto';
});

describe('a still map', () => {
	it('asks once, then holds through two hours and two hour changes', async () => {
		fake.runMs = RUN;
		await knownRun('meteofrance_seamless', T0);
		const v = view(48.8, 2.3, 3);
		ensureWindGrid(v, T0, T0);
		await settle();
		expect(fake.calls).toBe(1);
		expect(windGrid.status).toBe('ok');
		// The next minutes, the next hour, the hour after it.
		for (const dt of [MIN, 30 * MIN, HOUR, 90 * MIN, 2 * HOUR]) {
			ensureWindGrid(v, T0 + dt, T0 + dt);
			await settle();
		}
		expect(fake.calls).toBe(1);
		expect(windGridBarbs(T0 + 2 * HOUR).length).toBeGreaterThan(0);
	});

	it('asks again for an hour past the day it holds', async () => {
		fake.runMs = RUN;
		await knownRun('meteofrance_seamless', T0);
		const v = view(48.8, 2.3, 3);
		ensureWindGrid(v, T0, T0);
		await settle();
		ensureWindGrid(v, T0 + 25 * HOUR, T0);
		await settle();
		expect(fake.calls).toBe(2);
	});

	it('asks a cell no run anchors again after an hour, not before (best_match)', async () => {
		windAloft.model = 'best_match';
		const v = view(48.8, 2.3, 3);
		ensureWindGrid(v, T0, T0);
		await settle();
		ensureWindGrid(v, T0, T0 + 59 * MIN);
		await settle();
		expect(fake.calls).toBe(1);
		ensureWindGrid(v, T0, T0 + 60 * MIN);
		await settle();
		expect(fake.calls).toBe(2);
	});
});

describe('a new model run', () => {
	it('asks again only for the cells its grid covers, once the whole cycle has landed', async () => {
		fake.runMs = RUN;
		fake.bboxes = {
			meteofrance_arome_france_hd: AROME,
			meteofrance_arome_france0025: AROME,
			meteofrance_arpege_europe: ARPEGE,
			meteofrance_arpege_world025: ARPEGE,
		};
		await knownRun('meteofrance_seamless', T0);
		// Astride AROME's south-west corner (37.5 N, 12 W).
		windAloft.model = 'meteofrance_seamless';
		const v = view(37.5, -12, 8);
		ensureWindGrid(v, T0, T0);
		await settle();
		expect(fake.calls).toBe(1);
		const all = fake.requests[0].points;
		const inside = all.filter((p) => p.lat >= AROME[0] && p.lon >= AROME[1]);
		expect(inside.length).toBeGreaterThan(0);
		expect(inside.length).toBeLessThan(all.length);
		// The 1.3 km twin publishes 09Z first: no cycle yet.
		fake.runs = { meteofrance_arome_france_hd: RUN + 3 * HOUR };
		await knownRun('meteofrance_seamless', T0 + 16 * MIN);
		ensureWindGrid(v, T0 + 16 * MIN, T0 + 16 * MIN);
		await settle();
		expect(fake.calls).toBe(1);
		// Then the 0.025 grid: the cycle is whole, AROME's cells are asked for.
		fake.runs = {
			meteofrance_arome_france_hd: RUN + 3 * HOUR,
			meteofrance_arome_france0025: RUN + 3 * HOUR,
		};
		await knownRun('meteofrance_seamless', T0 + 32 * MIN);
		ensureWindGrid(v, T0 + 32 * MIN, T0 + 32 * MIN);
		await settle();
		expect(fake.calls).toBe(2);
		expect(fake.requests[1].points).toEqual(inside);
	});
});

describe('moving the map', () => {
	it('asks for nothing zooming back out to cells it holds', async () => {
		fake.runMs = RUN;
		await knownRun('meteofrance_seamless', T0);
		const wide = view(48.8, 2.3, 6);
		ensureWindGrid(wide, T0, T0);
		await settle();
		const close = view(48.8, 2.3, 1.5);
		ensureWindGrid(close, T0, T0);
		await settle();
		const calls = fake.calls;
		ensureWindGrid(wide, T0, T0);
		await settle();
		expect(fake.calls).toBe(calls);
	});

	it('never asks twice for a cell a request in flight will answer', async () => {
		fake.runMs = RUN;
		await knownRun('meteofrance_seamless', T0);
		let release!: () => void;
		fake.hold = new Promise<void>((resolve) => (release = resolve));
		const v = view(48.8, 2.3, 3);
		ensureWindGrid(v, T0, T0);
		ensureWindGrid(v, T0 + MIN, T0 + MIN);
		expect(fake.calls).toBe(1);
		fake.hold = null;
		release();
		await settle();
		expect(windGrid.status).toBe('ok');
	});

	it('fetches a shown hour pinned past the model’s reach once, then holds it', async () => {
		windAloft.model = 'arome_france';
		fake.runMs = RUN;
		await knownRun('arome_france', T0);
		const v = view(48.8, 2.3, 3);
		const pinned = T0 + 60 * HOUR;
		ensureWindGrid(v, pinned, T0);
		await settle();
		ensureWindGrid(v, pinned, T0 + 10 * MIN);
		await settle();
		expect(fake.calls).toBe(1);
	});
});

describe('a refresh that fails', () => {
	it('keeps the barbs it held on the map, and says so', async () => {
		fake.runMs = RUN;
		await knownRun('meteofrance_seamless', T0);
		const v = view(48.8, 2.3, 3);
		ensureWindGrid(v, T0, T0);
		await settle();
		const held = windGridBarbs(T0).length;
		expect(held).toBeGreaterThan(0);
		// A new run lands, and its refresh cannot reach the network.
		fake.runMs = RUN + 3 * HOUR;
		await knownRun('meteofrance_seamless', T0 + 16 * MIN);
		fake.fail = true;
		ensureWindGrid(v, T0 + 16 * MIN, T0 + 16 * MIN);
		await settle();
		expect(fake.calls).toBe(2);
		expect(windGrid.status).toBe('error');
		expect(windGridBarbs(T0 + 16 * MIN).length).toBe(held);
		// Asked again at the failure's own pace, not at every tick.
		ensureWindGrid(v, T0 + 17 * MIN, T0 + 17 * MIN);
		await settle();
		expect(fake.calls).toBe(2);
	});
});
