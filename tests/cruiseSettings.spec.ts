/* A plan flies one of its aircraft's cruise settings (aircraft/schema.ts
 * CruiseSetting, state/aircraft.svelte.ts): the sheet's default unless it
 * picks another, a speed coming with its own fuel flow, so planning faster
 * never plans the burn of the slower setting. Its own speed and fuel flow
 * (the Route tab's boxes) go over the setting's; a setting the sheet does not
 * hold flies the default, said. F-GIRV's sheet: default 122 kt / 40 L/h,
 * named "75 % best power", and three best-economy settings. */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage } from './helpers/storage';

beforeEach(() => {
	vi.resetModules();
	vi.stubGlobal('localStorage', memoryStorage({}));
});

afterEach(() => {
	vi.unstubAllGlobals();
});

async function withGirv() {
	const schema = await import('$lib/aircraft/schema');
	const aircraft = await import('$lib/state/aircraft.svelte');
	const route = await import('$lib/state/route.svelte');
	aircraft.importUserAircraft(schema.parseAircraftYaml(readFileSync('public/data/aircraft/f-girv.yaml', 'utf8')));
	return { aircraft, route };
}

describe('the cruise setting a plan flies', () => {
	it('is the sheet default first, then the manual others', async () => {
		const { aircraft } = await withGirv();
		expect(aircraft.cruiseSettings().map((s) => [s.isDefault, s.name, s.speedKt, s.consumptionLph])).toEqual([
			[true, '75 % best power', 122, 40],
			[false, '75 % best economy', 119, 33.3],
			[false, '65 % best economy', 111, 28.8],
			[false, '55 % best economy', 98, 23.8],
		]);
		expect(aircraft.automaticCruiseSpeedKt()).toBe(122);
		expect(aircraft.effectiveConsumptionLph()).toBe(40);
	});

	it('brings its speed and its fuel flow together', async () => {
		const { aircraft, route } = await withGirv();
		route.routeSettings.cruiseSetting = '65 % best economy';
		expect(aircraft.automaticCruiseSpeedKt()).toBe(111);
		expect(aircraft.effectiveCruiseSpeedKt()).toBe(111);
		expect(aircraft.effectiveConsumptionLph()).toBe(28.8);
		expect(aircraft.cruiseSettingLost()).toBeNull();
		// The default named by its own name is the default.
		route.routeSettings.cruiseSetting = '75 % best power';
		expect(aircraft.planCruiseSetting()?.isDefault).toBe(true);
	});

	it('takes the plan own figures over the setting, each on its own', async () => {
		const { aircraft, route } = await withGirv();
		route.routeSettings.cruiseSetting = '55 % best economy';
		route.routeSettings.cruiseSpeedKt = 105;
		expect(aircraft.effectiveCruiseSpeedKt()).toBe(105);
		expect(aircraft.effectiveConsumptionLph()).toBe(23.8);
		route.routeSettings.cruiseConsumptionLph = 26;
		expect(aircraft.effectiveConsumptionLph()).toBe(26);
	});

	it('flies the default for a setting the sheet does not hold, and says which', async () => {
		const { aircraft, route } = await withGirv();
		route.routeSettings.cruiseSetting = '2400 rpm';
		expect(aircraft.planCruiseSetting()?.isDefault).toBe(true);
		expect(aircraft.effectiveCruiseSpeedKt()).toBe(122);
		expect(aircraft.cruiseSettingLost()).toBe('2400 rpm');
	});

	it('is what the fuel plan burns, the journey log keeping the sheet', async () => {
		const { route } = await withGirv();
		const shared = await import('$lib/components/flightprep/shared');
		expect(shared.fuelComputation().consumptionLph).toBe(40);
		route.routeSettings.cruiseSetting = '65 % best economy';
		expect(shared.fuelComputation().consumptionLph).toBe(28.8);
	});
});
