/* The Route tab's folded Flight parameters say, on one line, what the plan
 * flies with (components/tabs/route/paramsSummary.ts): the automatic values
 * plain, every value the pilot set and what the plan should not fly
 * unnoticed standing out, so the fold never hides one. */

import { describe, expect, it } from 'vitest';

import { paramsSummary, partStandsOut, type ParamsSummaryInput } from '$lib/components/tabs/route/paramsSummary';

const AUTO: ParamsSummaryInput = {
	cruiseKt: 122,
	cruiseLph: 40,
	cruiseManual: false,
	cruisePlane: 'F-GIRV',
	cruiseSetting: null,
	cruiseLost: null,
	windSource: 'forecast',
	wind: null,
	missedLegs: [],
	legOverrides: 0,
	taFt: 5000,
	taManual: false,
	semicircular: true,
	tempTas: false,
};

describe('the folded flight parameters', () => {
	it('name the automatic values, none standing out', () => {
		const parts = paramsSummary(AUTO);
		expect(parts).toEqual([
			{ kind: 'cruise', kt: 122, lph: 40, source: 'plane', plane: 'F-GIRV', setting: null },
			{ kind: 'wind-forecast' },
			{ kind: 'ta', ft: 5000, manual: false },
			{ kind: 'semicircular', on: true },
		]);
		expect(parts.some(partStandsOut)).toBe(false);
	});

	it('name a speed without a plane as the default', () => {
		expect(paramsSummary({ ...AUTO, cruiseKt: 100, cruiseLph: null, cruisePlane: null })[0]).toEqual({
			kind: 'cruise',
			kt: 100,
			lph: null,
			source: 'default',
			plane: null,
			setting: null,
		});
	});

	it('make every value the pilot set stand out', () => {
		const parts = paramsSummary({
			...AUTO,
			cruiseKt: 140,
			cruiseManual: true,
			windSource: 'manual',
			wind: { dirDeg: 250, speedKt: 25 },
			legOverrides: 2,
			taFt: 6000,
			taManual: true,
			semicircular: false,
			tempTas: true,
		});
		expect(parts).toEqual([
			{ kind: 'cruise', kt: 140, lph: 40, source: 'plan', plane: null, setting: null },
			{ kind: 'wind-manual', wind: { dirDeg: 250, speedKt: 25 } },
			{ kind: 'leg-winds', count: 2 },
			{ kind: 'ta', ft: 6000, manual: true },
			{ kind: 'semicircular', on: false },
			{ kind: 'temp-tas' },
		]);
		expect(parts.map(partStandsOut)).toEqual([true, true, true, true, true, false]);
	});

	it('name the setting the plan picked, plain, and one the sheet lost, standing out', () => {
		const parts = paramsSummary({ ...AUTO, cruiseKt: 111, cruiseLph: 28.8, cruiseSetting: '65 % best economy' });
		expect(parts[0]).toEqual({ kind: 'cruise', kt: 111, lph: 28.8, source: 'plane', plane: 'F-GIRV', setting: '65 % best economy' });
		expect(partStandsOut(parts[0])).toBe(false);
		const lost = paramsSummary({ ...AUTO, cruiseLost: '75 %' });
		expect(lost[1]).toEqual({ kind: 'cruise-lost', name: '75 %' });
		expect(partStandsOut(lost[1])).toBe(true);
	});

	it('say the legs the forecast misses, and a Manual source with no wind', () => {
		const missed = paramsSummary({ ...AUTO, missedLegs: [3, 4] });
		expect(missed[2]).toEqual({ kind: 'wind-missed', legs: [3, 4] });
		expect(partStandsOut(missed[2])).toBe(true);
		const none = paramsSummary({ ...AUTO, windSource: 'manual' });
		expect(none[1]).toEqual({ kind: 'wind-none' });
		expect(partStandsOut(none[1])).toBe(true);
		// Missed legs are a Forecast source's: under Manual every leg flies the
		// typed wind.
		expect(paramsSummary({ ...AUTO, windSource: 'manual', missedLegs: [2] }).some((p) => p.kind === 'wind-missed')).toBe(
			false,
		);
	});
});
