/* One engine inoperative (src/lib/aircraft/oneEngine.ts): the true airspeed
 * at Vyse, the climb gradient, the en-route net ceiling of CAT.POL.A.315
 * and the take-off and landing climb checks of CAT.POL.A.340, on the made-up
 * twin of tests/fixtures/aircraft-twin.yaml (its climb table: 190 ft/min at
 * sea level and -90 at 8000 ft, ISA, 1905 kg; 120 and -160 at ISA + 20;
 * 420 and 130 at 1542 kg, ISA). */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseAircraftYaml } from '$lib/aircraft/schema';
import { isaTemperatureC } from '$lib/aircraft/performance';
import {
	casToTasKt,
	climbGradientPct,
	densityRatio,
	oeiClimbAt,
	oeiLandingClimb,
	oeiNetCeiling,
	oeiNetGradientAt,
	oeiTakeoffClimb,
	OEI_CLIMB_GRADIENT_PCT,
	OEI_NET_MARGIN_PCT,
	type AirAt,
} from '$lib/aircraft/oneEngine';

const twin = parseAircraftYaml(readFileSync(new URL('./fixtures/aircraft-twin.yaml', import.meta.url), 'utf-8'));
const oei = twin.oneEngineInoperative!;
const isa = (offset = 0) => (altFt: number): AirAt => ({ pressureAltFt: altFt, temperatureC: isaTemperatureC(altFt) + offset });

describe('the air and the gradient', () => {
	it('reads the standard atmosphere', () => {
		expect(densityRatio(0, 15)).toBeCloseTo(1, 9);
		// ICAO: 0.8617 at 5000 ft, ISA.
		expect(densityRatio(5000, 15 - 9.906)).toBeCloseTo(0.8617, 3);
		expect(casToTasKt(91.3, 0, 15)).toBeCloseTo(91.3, 9);
		expect(casToTasKt(100, 5000, 15 - 9.906)).toBeCloseTo(107.7, 1);
	});

	it('takes the gradient as the rate over the true airspeed', () => {
		// 190 ft/min at 91.3 kt: 190 / (91.3 x 101.27) = 2.05 %.
		expect(climbGradientPct(190, 91.3)).toBeCloseTo(2.055, 3);
		// 0.5 % at 100 kt is 50.6 ft/min.
		expect(climbGradientPct(50.635, 100)).toBeCloseTo(0.5, 3);
	});
});

describe('the one-engine climb', () => {
	it('reads the climb table at Vyse, take-off falling back to it', () => {
		const c = oeiClimbAt(oei, 'enroute', 1905, 0, 15);
		expect(c !== null && c !== 'above' && [Math.round(c.rateFtMin), +c.tasKt.toFixed(1)]).toEqual([190, 91.3]);
		const t = oeiClimbAt(oei, 'takeoff', 1905, 0, 15);
		expect(t !== null && t !== 'above' && Math.round(t.rateFtMin)).toBe(190);
		expect(oeiClimbAt(oei, 'enroute', 1905, 9000, 0)).toBe('above');
		expect(oeiClimbAt({ ...oei, climb: undefined }, 'enroute', 1905, 0, 15)).toBeNull();
	});

	it('finds the net ceiling where the gross gradient falls to 0.5 %', () => {
		const c = oeiNetCeiling(oei, 1905, isa());
		expect(c?.kind).toBe('ceiling');
		const alt = c!.altFt;
		// The rate falls 35 ft/min per 1000 ft from 190: about 4000 ft at ISA.
		expect(alt).toBeGreaterThan(3500);
		expect(alt).toBeLessThan(4500);
		expect(oeiNetGradientAt(oei, 1905, isa()(alt))).toBeCloseTo(0, 6);
		expect(oeiNetGradientAt(oei, 1905, isa()(alt - 100))!).toBeGreaterThan(0);
		expect(oeiNetGradientAt(oei, 1905, isa()(alt + 100))!).toBeLessThan(0);
		// Hotter, lower: ISA + 20 starts at 120 ft/min.
		expect(oeiNetCeiling(oei, 1905, isa(20))!.altFt).toBeLessThan(alt - 1500);
		// Lighter, higher: at 1542 kg it holds to the table's top.
		const light = oeiNetCeiling(oei, 1542, isa());
		expect(light?.kind).toBe('above');
		expect(light!.altFt).toBeCloseTo(8000, 3);
		// A table that fails already at the bottom.
		const weak = { ...oei, climb: { ...oei.climb!, rows: oei.climb!.rows.map((r) => ({ ...r, massMax: r.massMax - 200, massMin: r.massMin - 450 })) } };
		expect(oeiNetCeiling(weak, 1905, isa())).toEqual({ kind: 'below', altFt: 0 });
		expect(oeiNetCeiling({ ...oei, climb: undefined }, 1905, isa())).toBeNull();
		expect(OEI_NET_MARGIN_PCT).toBe(0.5);
	});

	it('takes the first altitude the net gradient fails at, and says nothing above the table', () => {
		// Started higher up, the same ceiling.
		expect(oeiNetCeiling(oei, 1905, isa(), 1000)!.altFt).toBeCloseTo(oeiNetCeiling(oei, 1905, isa())!.altFt, 3);
		// A warm layer from 2000 to 3000 ft (ISA + 30: the rate below nil)
		// caps the ceiling at its base, whatever the air above it.
		const inversion = (altFt: number): AirAt => ({
			pressureAltFt: altFt,
			temperatureC: isaTemperatureC(altFt) + (altFt > 2000 && altFt < 3000 ? 30 : 0),
		});
		const c = oeiNetCeiling(oei, 1905, inversion);
		expect(c?.kind).toBe('ceiling');
		expect(c!.altFt).toBeCloseTo(2000, 3);
		// Asked from above the table's top: no answer.
		expect(oeiNetCeiling(oei, 1905, isa(), 9000)).toBeNull();
	});

	it('judges the take-off climb: positive at 400 ft, 0.75 % at 1500 ft (CAT.POL.A.340(a)(2))', () => {
		const std = oeiTakeoffClimb(oei, 1905, 0, 15);
		expect(std.checks.map((c) => [c.heightFt, c.ok])).toEqual([
			[400, true],
			[1500, true],
		]);
		expect(std.sufficient).toBe(true);
		// The 1500 ft rate: 190 - 35 x 1.5 = 137.5 ft/min.
		expect(std.checks[1].climb.rateFtMin).toBeCloseTo(137.5, 6);
		// ISA + 20 at sea level: 67.5 ft/min at 1500 ft, under 0.75 %.
		const hot = oeiTakeoffClimb(oei, 1905, 0, 35);
		expect(hot.checks[1].climb.gradientPct).toBeLessThan(OEI_CLIMB_GRADIENT_PCT);
		expect(hot.sufficient).toBe(false);
		// No table: nothing judged.
		expect(oeiTakeoffClimb({ ...oei, climb: undefined }, 1905, 0, 15)).toEqual({ checks: [], sufficient: null });
	});

	it('judges the landing climb at 1500 ft (CAT.POL.A.340(b)(2))', () => {
		expect(oeiLandingClimb(oei, 1905, 0, 15).sufficient).toBe(true);
		expect(oeiLandingClimb(oei, 1905, 0, 35).sufficient).toBe(false);
		expect(oeiLandingClimb(oei, 1905, 0, 15).checks.map((c) => c.heightFt)).toEqual([1500]);
	});
});
