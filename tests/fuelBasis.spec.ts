/* The fuel page says what its figures were computed with
 * (flightprep/fuelBasis.ts): the wind its allowances read and the cruise it
 * burns at. NCO.OP.125(a) asks the fuel to take the meteorological
 * conditions into account, so a plan on a manual wind or its own speed says
 * so where its fuel is read, in the manual ink, with what the forecast would
 * change. */

import { describe, expect, it } from 'vitest';

import { fuelBasisLines, type CruiseBasis } from '$lib/components/flightprep/fuelBasis';
import type { WindBasis } from '$lib/components/flightprep/windBasis';
import type { Route } from '$lib/state/route.svelte';

const route = (id: string): Route => ({ id, name: null, selectedWaypointId: null, waypoints: [] });
const SHEET: CruiseBasis = {
	custom: false,
	setting: { isDefault: true, name: '75 % best power', speedKt: 122, consumptionLph: 40 },
	plane: 'F-GIRV',
	kt: 122,
	lph: 40,
};
const FORECAST: WindBasis = {
	kind: 'forecast',
	source: 'AROME 06:00Z 9 Oct',
	missed: [],
	missedWind: null,
	legs: 3,
	overrides: 0,
};
const lines = (bases: WindBasis[], cruise: CruiseBasis = SHEET): string[][] =>
	fuelBasisLines(
		bases.map((basis, i) => ({ route: route(`r${i}`), basis })),
		cruise,
	).map((l) => [l.text, l.ink]);

describe('what the fuel figures were computed with', () => {
	it('names the forecast and the sheet setting, quietly', () => {
		expect(lines([FORECAST])).toEqual([
			['Wind allowance from the forecast winds (AROME 06:00Z 9 Oct).', 'muted'],
			['Cruise 75 % best power, 122 kt, 40 L/h, from the F-GIRV sheet.', 'muted'],
		]);
	});

	it('says a manual wind is not the forecast, and what the forecast would change', () => {
		const manual: WindBasis = { kind: 'manual', wind: { dirDeg: 250, speedKt: 25 }, forecastDeltaMin: -2.6, legs: 3, overrides: 0 };
		expect(lines([manual, { ...manual, forecastDeltaMin: -0.2 }])[0]).toEqual([
			'Wind allowance from a manual wind 250°/25 kt, not the forecast. The forecast would take 3 min less.',
			'manual',
		]);
		expect(lines([{ ...manual, forecastDeltaMin: null }])[0]?.[0]).toBe(
			'Wind allowance from a manual wind 250°/25 kt, not the forecast.',
		);
	});

	it('counts the legs the forecast misses across the trips, and still air', () => {
		const missed: WindBasis = { ...FORECAST, missed: [2], missedWind: { dirDeg: 270, speedKt: 15 } };
		const none: WindBasis = { kind: 'none', legs: 2, overrides: 0 };
		expect(lines([missed, none])[0]).toEqual([
			'Wind allowance from the forecast winds (AROME 06:00Z 9 Oct). No forecast for 3 legs: they fly the manual wind 270°/15 kt.',
			'manual',
		]);
		expect(lines([none, none])[0]).toEqual(['No wind known: the trips are planned in still air.', 'manual']);
	});

	it('says the plan own cruise, and the default without a plane', () => {
		expect(lines([FORECAST], { ...SHEET, custom: true, kt: 135, lph: 28.75 })[1]).toEqual([
			'Cruise 135 kt, 28.8 L/h: the plan’s own figures.',
			'manual',
		]);
		expect(lines([FORECAST], { custom: false, setting: null, plane: null, kt: 100, lph: null })[1]?.[0]).toBe(
			'Cruise 100 kt by default, no aircraft selected.',
		);
	});
});
