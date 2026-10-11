/* The trip loads as the pages read them (components/flightprep/shared.ts), in
 * the client runtime where deriveds and effects really run
 * (tests/env/webnode.ts). A refuel ticked at a stop reaches the trip loads,
 * the performance page's mass for that aerodrome and the Overview's fuel at
 * each takeoff, the way a panel would see them change; and the print menu's
 * chart window, which reads no fuel, is not woken by any of it. */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
	const store = new Map<string, string>();
	vi.stubGlobal('localStorage', {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	});
	vi.resetModules();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

/** F-GORQ (100 L, 25 L/h, 100 kt) flying LFPL -> LFQH -> LFGP, two aboard. */
async function brienne() {
	const ac = await import('$lib/state/aircraft.svelte');
	const schema = await import('$lib/aircraft/schema');
	const route = await import('$lib/state/route.svelte');
	const prep = await import('$lib/state/flightPrep.svelte');
	// A path, not a URL off import.meta: the client environment has no `self`.
	const yaml = readFileSync('public/data/aircraft/f-gorq.yaml', 'utf-8');
	ac.selectAircraft(ac.addUserAircraft(schema.parseAircraftYaml(yaml)));
	const ap = (ident: string, lat: number, lon: number) =>
		route.addWaypointFromSnap({ kind: 'airport', refId: ident, ident, lat, lon });
	ap('LFPL', 48.82103, 2.62597);
	ap('LFQH', 47.84392, 4.58005);
	route.addRoute();
	ap('LFQH', 47.84392, 4.58005);
	ap('LFGP', 47.98019, 3.77558);
	prep.setMbLoad('Front seats', 160);
	prep.setMbLoad('Rear seats', 0);
	prep.setMbLoad('Baggage', 10);
	prep.setMb({ fuelMode: 'custom', customLitres: 40 });
	return { ac, prep };
}

describe('the trip loads, read the way the pages read them', () => {
	it('a refuel ticked at LFQH reaches the loads, the masses and the Overview', async () => {
		const { flushSync } = await import('svelte');
		const host = await import('./helpers/derivedHost.svelte');
		const { ac, prep } = await brienne();
		const shared = await import('$lib/components/flightprep/shared');
		const seen = host.mountDerived(() => {
			const fuel = shared.fuelComputation();
			const loads = shared.tripLoadsComputation(fuel);
			const massAt = shared.perfMasses(loads, ac.selectedAircraft());
			return {
				keys: loads?.stopKeys,
				start: loads?.loads.trips.map((tr) => tr.startL),
				lfqh: massAt('LFQH', 'takeoff'),
				lfqhLanding: massAt('LFQH', 'landing'),
				lfpl: massAt('LFPL', 'takeoff'),
				fuelAt: shared.dossierComputation(fuel, loads).fuelAtTakeoffMin,
			};
		});
		flushSync();
		const before = seen.value()!;
		expect(before.keys).toEqual([null, 'LFQH']);
		expect(before.start![0]).toBe(40);
		expect(before.lfqh).toMatchObject({ source: 'trip', trip: 1, via: 'departure' });
		// A landing is evaluated at the takeoff mass of the trip landing there.
		expect(before.lfqhLanding).toMatchObject({ source: 'trip', trip: 0, via: 'arrival' });
		expect(before.lfqhLanding.massKg).toBe(before.lfpl.massKg);

		prep.setStopRefuel('LFQH', true);
		flushSync();
		const after = seen.value()!;
		expect(after.start![1]).toBe(100);
		// 100 L at LFQH is heavier than what the 40 L brought there.
		expect(after.lfqh.massKg!).toBeGreaterThan(before.lfqh.massKg!);
		expect(after.lfqh.massKg!).toBeCloseTo(570 + 170 + 72, 6);
		expect(after.lfpl.massKg).toBe(before.lfpl.massKg);
		// The Overview's endurance at that takeoff: 100 L at 25 L/h.
		expect(after.fuelAt![1]).toBeCloseTo(240, 9);
		seen.stop();
	});

	it('times each performance column off the Overview: a take-off at its ETD, a landing at its ETA', async () => {
		const { flushSync } = await import('svelte');
		const host = await import('./helpers/derivedHost.svelte');
		const { prep } = await brienne();
		const shared = await import('$lib/components/flightprep/shared');
		const seen = host.mountDerived(() => {
			const fuel = shared.fuelComputation();
			const at = shared.perfInstants(fuel);
			return {
				lfpl: at('LFPL', 'takeoff'),
				lfqhLanding: at('LFQH', 'landing'),
				lfqh: at('LFQH', 'takeoff'),
				lfgp: at('LFGP', 'landing'),
				lfplLanding: at('LFPL', 'landing'),
				lfgpTakeoff: at('LFGP', 'takeoff'),
				manual: at('LFPO', 'takeoff'),
			};
		});
		flushSync();
		// No ETD stated: nothing times a column, the METAR alone speaks.
		expect(seen.value()).toMatchObject({ lfpl: null, lfqh: null, lfgp: null, lfplLanding: null, lfgpTakeoff: null });
		prep.setDossier({ flightDate: '2026-10-08', departureTime: '07:30' });
		flushSync();
		const v = seen.value()!;
		const etd = Date.parse('2026-10-08T07:30:00Z');
		expect(v.lfpl).toBe(etd);
		// The arrival at LFQH is the first trip's ETA, the next take-off its
		// ETA plus the ground stop: both after the ETD, in that order.
		expect(v.lfqhLanding!).toBeGreaterThan(etd);
		expect(v.lfqh!).toBeGreaterThanOrEqual(v.lfqhLanding!);
		expect(v.lfgp!).toBeGreaterThan(v.lfqh!);
		// A phase no trip flies there reads the aerodrome's other one, when
		// the plan is at that field: the landing back at LFPL its ETD, a
		// take-off from LFGP its ETA. Untimed, both read tonight's METAR for
		// tomorrow's flight.
		expect(v.lfplLanding).toBe(etd);
		expect(v.lfgpTakeoff).toBe(v.lfgp);
		// An aerodrome only added by hand has no time.
		expect(v.manual).toBeNull();
		seen.stop();
	});

	it("the print menu's chart window is not woken by the M&B inputs", async () => {
		const { flushSync } = await import('svelte');
		const host = await import('./helpers/derivedHost.svelte');
		const { prep } = await brienne();
		prep.setDossier({ departureTime: '07:30' });
		const charts = await import('$lib/components/flightprep/chartsPrefetch');
		const windows: { startMs: number; endMs: number }[] = [];
		const effect = host.mountEffect(() => {
			windows.push(charts.chartWindowMs());
		});
		flushSync();
		expect(effect.runs()).toBe(1);
		prep.setStopRefuel('LFQH', true);
		prep.setStopFuel('LFQH', { mode: 'custom', litres: 70 });
		prep.setStopLoad('LFQH', 'Rear seats', 80);
		prep.setMb({ fuelMode: 'max' });
		prep.setMbLoad('Baggage', 20);
		flushSync();
		expect(effect.runs()).toBe(1);
		// What it does follow still wakes it.
		prep.setDossier({ departureTime: '08:30' });
		flushSync();
		expect(effect.runs()).toBe(2);
		expect(windows[1].startMs - windows[0].startMs).toBe(3_600_000);
		effect.stop();
	});
});
